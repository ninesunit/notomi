import { getDocs, orderBy, query, where } from 'firebase/firestore';

import { downloadBlob, safeFileName } from '@/lib/download';
import { toDate } from '@/lib/dates';
import { paths } from '@/lib/paths';
import type { ClassBlock, Semester, Todo } from '@/lib/schema';
import { getDb } from '@/services/firebase';

/**
 * The term, as a file any calendar app will open.
 *
 * Not a sync integration. A sync needs an account somewhere, a token to keep
 * fresh and something server-side to keep it fresh with — none of which this
 * app has, and none of which a student needs to see their timetable in the
 * calendar they already use. A file they open once does the same job for the
 * only thing that is actually stable about a term: where they have to be.
 *
 * Classes go out as weekly repeats bounded by the term, so one event carries a
 * semester of Mondays instead of fourteen copies of it. Deadlines go out as
 * all-day events, because a deadline is a date rather than an appointment.
 */

/** RFC 5545 wants CRLF, and folds anything past 75 octets. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let index = 75; index < line.length; index += 74) {
    parts.push(` ${line.slice(index, index + 74)}`);
  }
  return parts.join('\r\n');
}

/** Commas, semicolons and newlines are structural in a property value. */
function escape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * Local wall-clock, with no timezone and no Z.
 *
 * A 9am lecture is 9am where the student is, and stays 9am if they travel. The
 * alternative is emitting UTC, which silently moves every class when the
 * university's clocks change and this app has no timezone database to consult.
 */
function floating(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}00`
  );
}

function dateOnly(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function stamp(): string {
  const now = new Date();
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

/** The first date on or after `from` that falls on `day` (0 = Monday). */
function firstOccurrence(from: Date, day: number): Date {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const current = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() + ((day - current + 7) % 7));
  return start;
}

function at(date: Date, minutes: number): Date {
  const out = new Date(date);
  out.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return out;
}

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function classEvent(block: ClassBlock, term: Semester, uid: string): string[] {
  const start = toDate(term.startDate ?? null);
  const until = toDate(term.teachingEndDate ?? null) ?? toDate(term.endDate ?? null);
  if (!start || !until) return [];

  const first = firstOccurrence(start, block.day);
  if (first > until) return [];

  const lastMoment = new Date(until);
  lastMoment.setHours(23, 59, 59, 0);

  const label = [block.title, block.section].filter(Boolean).join(' · ');
  const description = [block.kind, block.subjectName].filter(Boolean).join(' · ');

  return [
    'BEGIN:VEVENT',
    `UID:${block.id}-${uid}@notomi`,
    `DTSTAMP:${stamp()}`,
    `DTSTART:${floating(at(first, block.startMinute))}`,
    `DTEND:${floating(at(first, block.endMinute))}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${DAYS[block.day]};UNTIL=${floating(lastMoment)}`,
    fold(`SUMMARY:${escape(label)}`),
    ...(description ? [fold(`DESCRIPTION:${escape(description)}`)] : []),
    ...(block.venue ? [fold(`LOCATION:${escape(block.venue)}`)] : []),
    'END:VEVENT',
  ];
}

function deadlineEvent(todo: Todo, uid: string): string[] {
  const due = toDate(todo.dueDate);
  if (!due) return [];

  // All-day, and exclusive: a deadline is the day it is due, not an hour of it.
  const next = new Date(due);
  next.setDate(next.getDate() + 1);

  return [
    'BEGIN:VEVENT',
    `UID:${todo.id}-${uid}@notomi`,
    `DTSTAMP:${stamp()}`,
    `DTSTART;VALUE=DATE:${dateOnly(due)}`,
    `DTEND;VALUE=DATE:${dateOnly(next)}`,
    fold(`SUMMARY:${escape([todo.subjectName, todo.title].filter(Boolean).join(' · '))}`),
    ...(todo.kind ? [fold(`DESCRIPTION:${escape(todo.kind)}`)] : []),
    'END:VEVENT',
  ];
}

export type CalendarExportSummary = { classes: number; deadlines: number };

/**
 * Builds the file and hands it to the browser. Returns what went in, so the
 * caller can say something better than "downloaded".
 */
export async function exportTermCalendar(
  uid: string,
  term: Semester
): Promise<CalendarExportSummary> {
  const db = getDb();

  const [classSnapshot, todoSnapshot] = await Promise.all([
    getDocs(query(paths.classes(db, uid), where('semesterId', '==', term.id))),
    getDocs(query(paths.todos(db, uid), orderBy('dueDate', 'asc'))),
  ]);

  const blocks = classSnapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as ClassBlock);
  const todos = todoSnapshot.docs
    .map((entry) => ({ id: entry.id, ...entry.data() }) as Todo)
    .filter((todo) => !todo.isCompleted && todo.dueDate);

  const events: string[] = [];
  let classes = 0;
  for (const block of blocks) {
    const lines = classEvent(block, term, uid);
    if (lines.length > 0) {
      events.push(...lines);
      classes += 1;
    }
  }
  for (const todo of todos) {
    const lines = deadlineEvent(todo, uid);
    if (lines.length > 0) events.push(...lines);
  }

  const calendar = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Notomi//Notomi//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${escape(`Notomi · ${term.name}`)}`),
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');

  downloadBlob(
    new Blob([calendar], { type: 'text/calendar;charset=utf-8' }),
    `${safeFileName(term.name, 'notomi-term')}.ics`
  );

  return { classes, deadlines: todos.length };
}
