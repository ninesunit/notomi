import { doc, getDocs, query, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { paths } from '@/lib/paths';
import { parseCourseCode, type ClassBlock, type Subject, type Todo } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { graph, graphAll, isConnected } from '@/services/microsoft';
import { academicClasses, type ResolvedClass } from '@/services/timetable';

/**
 * The two things Microsoft 365 is actually worth connecting for.
 *
 * Classes go out to a calendar of their own — never the student's default one,
 * so nothing Notomi writes can bury a dentist appointment, and disconnecting is
 * a single delete. Assignments come back from Teams into the same task list
 * everything else lands in.
 *
 * Both directions are idempotent. Every sync can be run twice with no second
 * copy of anything, because that is the only way a background pull is safe.
 */

const CALENDAR_KEY = 'notomi.ms.calendar';
const CALENDAR_NAME = 'Notomi — Classes';

/** Weeks of recurrence to publish. Long enough for a term, short enough to redo. */
const TERM_WEEKS = 18;

const GRAPH_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export type SyncReport = {
  created: number;
  updated: number;
  pulled: number;
  /** Classes whose Outlook event has been deleted by hand. */
  orphaned: number;
  messages: string[];
};

function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Local wall-clock in the shape Graph wants — no zone suffix; timeZone rides alongside. */
function stamp(date: Date, minutes: number): string {
  const withTime = new Date(date);
  withTime.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${withTime.getFullYear()}-${pad(withTime.getMonth() + 1)}-${pad(withTime.getDate())}` +
    `T${pad(withTime.getHours())}:${pad(withTime.getMinutes())}:00`
  );
}

function isoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The next occurrence of a Monday-indexed weekday, today included. */
function nextOccurrence(day: number, from = new Date()): Date {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const current = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() + ((day - current + 7) % 7));
  return start;
}

/* ------------------------------------------------------------------ *
 * The calendar
 * ------------------------------------------------------------------ */

type GraphCalendar = { id: string; name: string };

/**
 * Finds or creates the dedicated calendar.
 *
 * The id is cached per device but always re-checked against Graph: a student
 * who deletes the calendar in Outlook would otherwise get every sync failing
 * with a 404 they cannot act on.
 */
async function calendarId(): Promise<string> {
  const cached = readCache(CALENDAR_KEY);
  if (cached) {
    try {
      const found = await graph<GraphCalendar>(`/me/calendars/${cached}`);
      if (found?.id) return found.id;
    } catch {
      writeCache(CALENDAR_KEY, null);
    }
  }

  const existing = await graphAll<GraphCalendar>('/me/calendars?$select=id,name');
  const match = existing.find((entry) => entry.name === CALENDAR_NAME);
  if (match) {
    writeCache(CALENDAR_KEY, match.id);
    return match.id;
  }

  const created = await graph<GraphCalendar>('/me/calendars', {
    method: 'POST',
    body: { name: CALENDAR_NAME },
  });
  writeCache(CALENDAR_KEY, created.id);
  return created.id;
}

function readCache(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeCache(key: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    /* Nothing depends on the cache surviving. */
  }
}

type GraphEvent = {
  id: string;
  subject?: string;
  location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  recurrence?: { pattern?: { daysOfWeek?: string[] } } | null;
};

function eventBody(block: ResolvedClass) {
  const first = nextOccurrence(block.day);
  const until = new Date(first);
  until.setDate(until.getDate() + TERM_WEEKS * 7);

  const label = block.subjectName || block.title;
  const code = block.code ? `${parseCourseCode(block.code).code} · ` : '';

  return {
    subject: `${label}${block.section ? ` (${block.section})` : ''}`,
    body: {
      contentType: 'text',
      content: `${code}${block.kind ?? 'Class'}${block.venue ? ` · ${block.venue}` : ''}`,
    },
    location: block.venue ? { displayName: block.venue } : undefined,
    start: { dateTime: stamp(first, block.startMinute), timeZone: timeZone() },
    end: { dateTime: stamp(first, block.endMinute), timeZone: timeZone() },
    recurrence: {
      pattern: { type: 'weekly', interval: 1, daysOfWeek: [GRAPH_DAYS[block.day]] },
      range: { type: 'endDate', startDate: isoDate(first), endDate: isoDate(until), recurrenceTimeZone: timeZone() },
    },
    // Survives a duplicate submission caused by a retry on a flaky connection.
    transactionId: `notomi-${block.id}`,
  };
}

/**
 * Publishes every academic class, then reads the calendar back.
 *
 * The read-back is the two-way half: whatever the events say now wins, because
 * a change made in Outlook is a change the student made on purpose — and one
 * they will not think to repeat in Notomi.
 */
export async function syncCalendar(uid: string): Promise<SyncReport> {
  const db = getDb();
  const report: SyncReport = { created: 0, updated: 0, pulled: 0, orphaned: 0, messages: [] };

  const [classSnapshot, subjectSnapshot] = await Promise.all([
    getDocs(paths.classes(db, uid)),
    getDocs(paths.subjects(db, uid)),
  ]);

  const subjects = subjectSnapshot.docs.map(
    (entry) => ({ id: entry.id, ...entry.data() }) as Subject
  );
  const blocks = academicClasses(
    classSnapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as ClassBlock),
    subjects
  );

  if (blocks.length === 0) {
    report.messages.push('No classes on the timetable yet.');
    return report;
  }

  const calendar = await calendarId();

  for (const block of blocks) {
    const payload = eventBody(block);

    if (block.msEventId) {
      try {
        await graph(`/me/calendars/${calendar}/events/${block.msEventId}`, {
          method: 'PATCH',
          body: payload,
        });
        report.updated += 1;
        continue;
      } catch {
        // Deleted in Outlook. Forget the id and fall through to a fresh create,
        // which is what a student who wants their timetable there expects.
        report.orphaned += 1;
      }
    }

    const created = await graph<{ id: string }>(`/me/calendars/${calendar}/events`, {
      method: 'POST',
      body: payload,
    });
    await updateDoc(paths.class(db, uid, block.id), { msEventId: created.id });
    report.created += 1;
  }

  report.pulled = await pullCalendar(uid, calendar, blocks);
  return report;
}

/**
 * Reads the published events back and applies any change made in Outlook.
 *
 * Only day, time and room can move — the subject a class belongs to is a Notomi
 * relationship, and renaming an event should not silently re-file a term's
 * notes under a different subject.
 */
async function pullCalendar(
  uid: string,
  calendar: string,
  blocks: ResolvedClass[]
): Promise<number> {
  const db = getDb();
  const events = await graphAll<GraphEvent>(
    `/me/calendars/${calendar}/events?$select=id,subject,location,start,end,recurrence&$top=100`
  );
  const byId = new Map(events.map((event) => [event.id, event]));

  let changed = 0;

  for (const block of blocks) {
    const event = block.msEventId ? byId.get(block.msEventId) : undefined;
    if (!event) continue;

    const patch: Record<string, unknown> = {};

    const startMinutes = minutesOf(event.start?.dateTime);
    const endMinutes = minutesOf(event.end?.dateTime);
    if (startMinutes !== null && startMinutes !== block.startMinute) {
      patch.startMinute = startMinutes;
    }
    if (endMinutes !== null && endMinutes !== block.endMinute) {
      patch.endMinute = endMinutes;
    }

    const weekday = event.recurrence?.pattern?.daysOfWeek?.[0]?.toLowerCase();
    const day = weekday ? GRAPH_DAYS.indexOf(weekday) : -1;
    if (day >= 0 && day !== block.day) patch.day = day;

    const venue = event.location?.displayName?.trim() || null;
    if (venue !== (block.venue ?? null)) patch.venue = venue;

    // A start after its end means the two edits arrived half-applied; leaving
    // the block alone beats writing a class that renders inside-out.
    const nextStart = (patch.startMinute as number) ?? block.startMinute;
    const nextEnd = (patch.endMinute as number) ?? block.endMinute;
    if (nextStart >= nextEnd) continue;

    if (Object.keys(patch).length > 0) {
      await updateDoc(paths.class(db, uid, block.id), patch);
      changed += 1;
    }
  }

  return changed;
}

function minutesOf(dateTime: string | undefined): number | null {
  if (!dateTime) return null;
  // Graph returns "2026-08-11T09:00:00.0000000" in the requested zone, with no
  // offset. Parsing the clock text directly avoids a UTC reinterpretation.
  const match = /T(\d{2}):(\d{2})/.exec(dateTime);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Removes everything Notomi put in the calendar, and the calendar with it. */
export async function removeCalendar(uid: string): Promise<void> {
  const db = getDb();
  const cached = readCache(CALENDAR_KEY);
  if (cached) {
    await graph(`/me/calendars/${cached}`, { method: 'DELETE' }).catch(() => undefined);
    writeCache(CALENDAR_KEY, null);
  }

  const snapshot = await getDocs(paths.classes(db, uid));
  await Promise.all(
    snapshot.docs
      .filter((entry) => entry.data().msEventId)
      .map((entry) => updateDoc(entry.ref, { msEventId: null }))
  );
}

/* ------------------------------------------------------------------ *
 * Teams assignments
 * ------------------------------------------------------------------ */

type EducationClass = { id: string; displayName?: string; classCode?: string; mailNickname?: string };
type EducationAssignment = {
  id: string;
  displayName?: string;
  dueDateTime?: string;
  status?: string;
  webUrl?: string;
};

/**
 * Matches a Teams class to a subject in the library.
 *
 * The course code is the only reliable join — a class in Teams is called
 * whatever the professor typed — so the name is a fallback, not the rule.
 */
export function matchSubject(
  entry: EducationClass,
  subjects: Subject[]
): Subject | null {
  const code = parseCourseCode(entry.classCode || entry.mailNickname || '').code.toLowerCase();
  if (code) {
    const byCode = subjects.find(
      (subject) => parseCourseCode(subject.moduleCode).code.toLowerCase() === code
    );
    if (byCode) return byCode;
  }

  const name = (entry.displayName ?? '').toLowerCase().trim();
  if (!name) return null;

  // The display name usually carries the code somewhere inside it.
  const embedded = parseCourseCode(name).code.toLowerCase();
  if (embedded) {
    const found = subjects.find(
      (subject) => parseCourseCode(subject.moduleCode).code.toLowerCase() === embedded
    );
    if (found) return found;
  }

  return (
    subjects.find((subject) => subject.name.toLowerCase() === name) ??
    subjects.find(
      (subject) =>
        name.includes(subject.name.toLowerCase()) || subject.name.toLowerCase().includes(name)
    ) ??
    null
  );
}

export type AssignmentPull = {
  added: number;
  skipped: number;
  unmatched: string[];
};

/**
 * Pulls assigned work out of Teams and into the task list.
 *
 * Only work that is still assigned and still has a deadline: a task with no due
 * date is noise in a list sorted by deadline, and one already handed back is
 * finished business.
 */
export async function pullAssignments(uid: string): Promise<AssignmentPull> {
  const db = getDb();
  const result: AssignmentPull = { added: 0, skipped: 0, unmatched: [] };

  const [subjectSnapshot, todoSnapshot] = await Promise.all([
    getDocs(paths.subjects(db, uid)),
    getDocs(query(paths.todos(db, uid))),
  ]);

  const subjects = subjectSnapshot.docs.map(
    (entry) => ({ id: entry.id, ...entry.data() }) as Subject
  );
  const seen = new Set(
    todoSnapshot.docs
      .map((entry) => (entry.data() as Todo).externalId)
      .filter((value): value is string => Boolean(value))
  );

  const classes = await graphAll<EducationClass>(
    '/education/me/classes?$select=id,displayName,classCode,mailNickname'
  );

  for (const entry of classes) {
    const subject = matchSubject(entry, subjects);

    const assignments = await graphAll<EducationAssignment>(
      `/education/classes/${entry.id}/assignments?$select=id,displayName,dueDateTime,status,webUrl`
    ).catch(() => [] as EducationAssignment[]);

    for (const assignment of assignments) {
      if (assignment.status !== 'assigned') continue;
      if (!assignment.dueDateTime || !assignment.displayName) continue;
      if (seen.has(assignment.id)) {
        result.skipped += 1;
        continue;
      }

      const due = new Date(assignment.dueDateTime);
      if (Number.isNaN(due.getTime()) || due.getTime() < Date.now()) continue;

      if (!subject && !result.unmatched.includes(entry.displayName ?? entry.id)) {
        result.unmatched.push(entry.displayName ?? entry.id);
      }

      const ref = doc(paths.todos(db, uid));
      await setDoc(ref, {
        title: assignment.displayName.slice(0, 500),
        dueDate: due,
        isCompleted: false,
        subjectId: subject?.id ?? null,
        subjectName: subject?.name ?? null,
        // Coursework with a date on it is not a "maybe today" item.
        priority: 'high',
        subTasks: [],
        source: 'microsoft',
        sourceDocumentId: null,
        externalId: assignment.id,
        externalUrl: assignment.webUrl ?? null,
        createdAt: serverTimestamp(),
        completedAt: null,
      });

      seen.add(assignment.id);
      result.added += 1;
    }
  }

  return result;
}

const LAST_PULL_KEY = 'notomi.ms.lastPull';
/** Professors post work in office hours, not in seconds. Six hours is plenty. */
const PULL_EVERY = 6 * 60 * 60 * 1000;

/**
 * The quiet version, run when the app opens.
 *
 * The timestamp is written *before* the request, not after: a tenant that
 * refuses education scopes would otherwise fail, skip the write, and try again
 * on every single navigation for the rest of the session.
 */
export async function backgroundPull(uid: string): Promise<AssignmentPull | null> {
  if (!isConnected()) return null;

  const last = Number(readCache(LAST_PULL_KEY) ?? 0);
  if (Number.isFinite(last) && Date.now() - last < PULL_EVERY) return null;
  writeCache(LAST_PULL_KEY, String(Date.now()));

  try {
    return await pullAssignments(uid);
  } catch {
    // Nothing to say. A student who did not ask for this right now should not
    // be shown an error about it.
    return null;
  }
}

/** A one-line account of what a sync did, for the screen and the log. */
export function describeSync(report: SyncReport): string {
  const parts: string[] = [];
  if (report.created) parts.push(`${report.created} class${report.created === 1 ? '' : 'es'} published`);
  if (report.updated) parts.push(`${report.updated} kept up to date`);
  if (report.pulled) parts.push(`${report.pulled} changed in Outlook and pulled back`);
  if (report.orphaned) parts.push(`${report.orphaned} recreated`);
  return parts.length ? `${parts.join(', ')}.` : 'Everything was already in step.';
}
