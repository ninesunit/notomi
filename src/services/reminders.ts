import { Platform } from 'react-native';
import { toDate } from '@/lib/dates';
import { DAY_FULL, minutesToLabel, type ClassBlock, type RoutineBlock, type Todo } from '@/lib/schema';

/** Class and deadline reminder calculation shared by local and push delivery. */

export type ReminderPrefs = {
  enabled: boolean;
  classes: boolean;
  routines: boolean;
  deadlines: boolean;
  /** How long before a class the reminder fires. */
  leadMinutes: number;
};

export const DEFAULT_PREFS: ReminderPrefs = {
  enabled: false,
  classes: true,
  routines: false,
  deadlines: true,
  leadMinutes: 15,
};

export const LEAD_OPTIONS = [5, 10, 15, 30, 60];

const PREFS_KEY = 'notomi:reminders';
/** Occurrences already notified, so a reload does not fire them again. */
const FIRED_KEY = 'notomi:reminders:fired';

export function loadPrefs(): ReminderPrefs {
  if (Platform.OS !== 'web') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ReminderPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: ReminderPrefs): void {
  if (Platform.OS !== 'web') return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* Private mode; the preference just does not persist. */
  }
}

/* ------------------------------------------------------------------ *
 * Permission
 * ------------------------------------------------------------------ */

export function supportsNotifications(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && 'Notification' in window;
}

export type PermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

export function permissionState(): PermissionState {
  if (!supportsNotifications()) return 'unsupported';
  return Notification.permission as Exclude<PermissionState, 'unsupported'>;
}

/**
 * Must be called from inside a user gesture — Safari ignores a permission
 * request that did not come from a tap, and silently leaves it at "default".
 */
export async function requestPermission(): Promise<PermissionState> {
  if (!supportsNotifications()) return 'unsupported';
  try {
    return (await Notification.requestPermission()) as PermissionState;
  } catch {
    return permissionState();
  }
}

/**
 * Shows a notification through the service worker where one is registered.
 *
 * An installed iOS PWA only supports the service-worker form; `new
 * Notification()` throws there. Desktop browsers accept either, so the SW path
 * is tried first everywhere and the constructor is the fallback.
 */
export async function notify(title: string, body: string, tag: string): Promise<boolean> {
  if (permissionState() !== 'granted') return false;

  const options: NotificationOptions = {
    body,
    tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // Two reminders for the same class must replace, never stack.
    data: { url: '/' },
  };

  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      await registration.showNotification(title, options);
      return true;
    }
  } catch {
    /* Fall through to the constructor. */
  }

  try {
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * What is due to fire
 * ------------------------------------------------------------------ */

export type Reminder = {
  /** Stable across reloads: kind, block and the exact occurrence. */
  id: string;
  title: string;
  body: string;
  /** When the notification should appear. */
  at: Date;
  /** When the thing itself starts. */
  starts: Date;
  kind: 'class' | 'routine' | 'deadline';
};

/**
 * The next occurrence of a weekly block at or after `from`.
 *
 * Blocks are stored as a weekday plus minutes from midnight, so this is
 * arithmetic on the current week rather than date parsing.
 */
export function nextOccurrence(
  block: { day: number; startMinute: number },
  from = new Date()
): Date {
  const today = (from.getDay() + 6) % 7;
  const daysAhead = (block.day - today + 7) % 7;

  const candidate = new Date(from);
  candidate.setDate(candidate.getDate() + daysAhead);
  candidate.setHours(Math.floor(block.startMinute / 60), block.startMinute % 60, 0, 0);

  // Only the daysAhead === 0 case can land in the past — today's class already
  // started — and that one belongs to next week.
  if (candidate.getTime() < from.getTime()) candidate.setDate(candidate.getDate() + 7);

  return candidate;
}

/** Every reminder that should fire between now and `withinHours` from now. */
export function upcomingReminders(
  input: {
    classes: ClassBlock[];
    routines: RoutineBlock[];
    todos: Todo[];
  },
  prefs: ReminderPrefs,
  now = new Date(),
  withinHours = 36
): Reminder[] {
  if (!prefs.enabled) return [];

  const horizon = now.getTime() + withinHours * 3_600_000;
  const out: Reminder[] = [];
  const lead = prefs.leadMinutes * 60_000;

  const addBlock = (
    block: ClassBlock | RoutineBlock,
    kind: 'class' | 'routine',
    body: string
  ) => {
    const first = nextOccurrence(block, now);

    // Local delivery asks for 36 hours and normally produces one occurrence.
    // Background push asks for four weeks, so expand the same recurring block
    // here instead of making extra Firestore documents or scheduled functions.
    for (let startsAt = first.getTime(); startsAt - lead <= horizon; startsAt += 7 * 86_400_000) {
      const starts = new Date(startsAt);
      const at = new Date(startsAt - lead);
      if (at.getTime() < now.getTime() - 10 * 60_000) continue;
      out.push({
        id: `${kind}:${block.id}:${starts.getTime()}`,
        // subjectName is the joined value where the caller resolved it.
        title: ('subjectName' in block && block.subjectName) || block.title,
        body,
        at,
        starts,
        kind,
      });
    }
  };

  if (prefs.classes) {
    for (const block of input.classes) {
      addBlock(
        block,
        'class',
        [
          `${DAY_FULL[block.day]} ${minutesToLabel(block.startMinute)}`,
          block.venue,
          block.kind,
        ]
          .filter(Boolean)
          .join(' · ')
      );
    }
  }

  if (prefs.routines) {
    for (const block of input.routines) {
      addBlock(block, 'routine', `${minutesToLabel(block.startMinute)} · routine`);
    }
  }

  if (prefs.deadlines) {
    for (const todo of input.todos) {
      if (todo.isCompleted) continue;
      const due = toDate(todo.dueDate);
      if (!due) continue;

      // Two warnings: one the day before, one an hour out. A single reminder at
      // the deadline itself is useless.
      for (const [label, offset] of [
        ['tomorrow', 24 * 3_600_000],
        ['in an hour', 3_600_000],
      ] as const) {
        const at = new Date(due.getTime() - offset);
        if (at.getTime() < now.getTime() || at.getTime() > horizon) continue;
        out.push({
          id: `deadline:${todo.id}:${at.getTime()}`,
          title: `Due ${label}: ${todo.title}`,
          body: [todo.subjectName, due.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })]
            .filter(Boolean)
            .join(' · '),
          at,
          starts: due,
          kind: 'deadline',
        });
      }
    }
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/* ------------------------------------------------------------------ *
 * Firing
 * ------------------------------------------------------------------ */

function loadFired(): Record<string, number> {
  if (Platform.OS !== 'web') return {};
  try {
    return JSON.parse(localStorage.getItem(FIRED_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function saveFired(fired: Record<string, number>): void {
  if (Platform.OS !== 'web') return;
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(fired));
  } catch {
    /* Nothing to do; at worst a reminder repeats after a reload. */
  }
}

/**
 * Fires anything now due and records it.
 *
 * A reminder more than ten minutes stale is dropped rather than shown: waking a
 * laptop at midnight should not replay the morning's classes.
 */
export async function fireDue(reminders: Reminder[], now = new Date()): Promise<number> {
  if (permissionState() !== 'granted') return 0;

  const fired = loadFired();
  let count = 0;

  for (const reminder of reminders) {
    const delta = now.getTime() - reminder.at.getTime();
    if (delta < 0 || delta > 10 * 60_000) continue;
    if (fired[reminder.id]) continue;

    if (await notify(reminder.title, reminder.body, reminder.id)) {
      fired[reminder.id] = now.getTime();
      count += 1;
    }
  }

  // Keep a day of history, no more: the key is unbounded otherwise.
  const cutoff = now.getTime() - 86_400_000;
  for (const [id, at] of Object.entries(fired)) {
    if (at < cutoff) delete fired[id];
  }

  saveFired(fired);
  return count;
}

/** "in 12 min", "in 3 h", "Thu 09:00" — for the dashboard card. */
export function describeWhen(at: Date, now = new Date()): string {
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 60 * 12) return `in ${Math.round(minutes / 60)} h`;
  return at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
