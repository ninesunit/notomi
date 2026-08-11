import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';
import { orderBy, query } from 'firebase/firestore';
import { paths } from '@/lib/paths';
import type { ClassBlock, RoutineBlock, Subject, Todo } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { resolveClasses } from '@/services/timetable';
import {
  DEFAULT_PREFS,
  fireDue,
  loadPrefs,
  permissionState,
  requestPermission,
  savePrefs,
  upcomingReminders,
  type PermissionState,
  type Reminder,
  type ReminderPrefs,
} from '@/services/reminders';
import { useUid } from './useAuth';
import { useCollection } from './useFirestore';

/**
 * Reminders, scheduled app-wide.
 *
 * This lives in the workspace shell rather than on the dashboard because a
 * student with the timetable open still wants to be told their next class is in
 * fifteen minutes. One provider owns the timer, the permission state and the
 * preference, and the dashboard card is only a view of it.
 */

type ReminderState = {
  prefs: ReminderPrefs;
  update: (patch: Partial<ReminderPrefs>) => void;
  permission: PermissionState;
  /** Asks for permission and turns reminders on if it is granted. */
  enable: () => Promise<PermissionState>;
  /** Everything due in the next day and a half, soonest first. */
  upcoming: Reminder[];
};

const Context = createContext<ReminderState | null>(null);

/** How often the scheduler looks for something to fire. */
const TICK_MS = 30_000;

export function ReminderProvider({ children }: { children: ReactNode }) {
  const uid = useUid();
  const db = getDb();

  const [prefs, setPrefs] = useState<ReminderPrefs>(() => loadPrefs());
  const [permission, setPermission] = useState<PermissionState>(() => permissionState());
  /** Bumped on every tick so `upcoming` recomputes against the wall clock. */
  const [now, setNow] = useState(() => new Date());

  const classes = useCollection<ClassBlock>(paths.classes(db, uid), [uid]);
  const routines = useCollection<RoutineBlock>(paths.routines(db, uid), [uid]);
  const todos = useCollection<Todo>(query(paths.todos(db, uid), orderBy('dueDate', 'asc')), [uid]);
  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);

  /**
   * Joined, not filtered: a block with no subject is still a class the student
   * put on their timetable and still deserves a nudge, but one that has a
   * subject should be announced by the subject's current name.
   */
  const named = useMemo(
    () => resolveClasses(classes.data, subjects.data),
    [classes.data, subjects.data]
  );

  const upcoming = useMemo(
    () =>
      upcomingReminders(
        { classes: named, routines: routines.data, todos: todos.data },
        prefs,
        now
      ),
    [named, routines.data, todos.data, prefs, now]
  );

  // The clock, kept separate from the firing so that a page showing "in 12 min"
  // stays honest even when notifications are switched off.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!prefs.enabled || permission !== 'granted') return;
    void fireDue(upcoming, now);
  }, [upcoming, now, prefs.enabled, permission]);

  /**
   * A backgrounded tab has its timers throttled to once a minute or worse, so
   * coming back to the app is also a moment to catch up on anything missed.
   */
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(new Date());
    });
    return () => subscription.remove();
  }, []);

  const update = useCallback((patch: Partial<ReminderPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  const enable = useCallback(async () => {
    const result = await requestPermission();
    setPermission(result);
    // Turning it on without permission would leave a switch that does nothing.
    if (result === 'granted') update({ enabled: true });
    return result;
  }, [update]);

  const value = useMemo<ReminderState>(
    () => ({ prefs, update, permission, enable, upcoming }),
    [prefs, update, permission, enable, upcoming]
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useReminders(): ReminderState {
  const value = useContext(Context);
  if (value) return value;

  // Outside the provider — a screen rendered before the shell — reminders are
  // simply inert rather than a crash.
  return {
    prefs: DEFAULT_PREFS,
    update: () => undefined,
    permission: 'unsupported',
    enable: async () => 'unsupported',
    upcoming: [],
  };
}
