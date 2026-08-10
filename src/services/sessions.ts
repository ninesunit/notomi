import { addDoc, serverTimestamp } from 'firebase/firestore';
import { dayKey } from '@/lib/dates';
import { paths } from '@/lib/paths';
import type { StudySession } from '@/lib/schema';
import { getDb } from '@/services/firebase';

/**
 * Study session log.
 *
 * Every finished focus block, quiz and flashcard run writes one record. That
 * log is the only source for the streak — deriving it from "did anything
 * change today" would count opening the app as studying.
 */

export async function logSession(
  uid: string,
  input: {
    minutes: number;
    mode: StudySession['mode'];
    subjectId?: string | null;
    subjectName?: string | null;
  }
): Promise<void> {
  // Firestore rules cap this too; clamping here keeps a UI bug from becoming a
  // permission error the student sees.
  const minutes = Math.max(1, Math.min(600, Math.round(input.minutes)));

  await addDoc(paths.sessions(getDb(), uid), {
    minutes,
    mode: input.mode,
    subjectId: input.subjectId ?? null,
    subjectName: input.subjectName ?? null,
    dayKey: dayKey(new Date()),
    createdAt: serverTimestamp(),
  });
}

export type StreakSummary = {
  /** Consecutive days up to and including today (or yesterday, if today is idle). */
  current: number;
  longest: number;
  /** Whether anything has been logged today. */
  studiedToday: boolean;
  minutesToday: number;
  minutesThisWeek: number;
};

/**
 * A streak survives an unfinished today.
 *
 * Counting strictly back from today would show 0 every morning until the first
 * session, which reads as "you lost it" rather than "you have not started yet".
 * So the walk may begin at yesterday, and `studiedToday` carries the difference.
 */
export function summarizeStreak(sessions: StudySession[], now = new Date()): StreakSummary {
  const days = new Set(sessions.map((session) => session.dayKey).filter(Boolean));

  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
  const studiedToday = days.has(today);

  let current = 0;
  if (studiedToday || days.has(yesterday)) {
    const cursor = new Date(now);
    if (!studiedToday) cursor.setDate(cursor.getDate() - 1);
    while (days.has(dayKey(cursor))) {
      current += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  // Longest run over the whole history, walking the sorted distinct days.
  const sorted = [...days].sort();
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of sorted) {
    if (previous && isNextDay(previous, day)) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
    previous = day;
  }

  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  // Monday-first, matching the timetable.
  weekStart.setDate(weekStart.getDate() - ((now.getDay() + 6) % 7));
  const weekStartKey = dayKey(weekStart);

  let minutesToday = 0;
  let minutesThisWeek = 0;
  for (const session of sessions) {
    if (session.dayKey === today) minutesToday += session.minutes ?? 0;
    if (session.dayKey >= weekStartKey) minutesThisWeek += session.minutes ?? 0;
  }

  return { current, longest, studiedToday, minutesToday, minutesThisWeek };
}

/** Compares two YYYY-MM-DD keys without reparsing into local time twice. */
function isNextDay(previous: string, next: string): boolean {
  const date = new Date(`${previous}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return dayKey(date) === next;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export type SubjectStudy = {
  minutes: number;
  sessions: number;
  /** Minutes in the last seven days, which is what "am I keeping up" means. */
  minutesThisWeek: number;
  lastStudied: string | null;
};

/**
 * Study time per subject.
 *
 * Every focus block, quiz and flashcard run already records which subject it
 * belonged to; this is what turns that log into something a student can see.
 * Keyed by subject id, so a renamed subject keeps its history.
 */
export function studyBySubject(
  sessions: StudySession[],
  now = new Date()
): Map<string, SubjectStudy> {
  const weekAgo = dayKey(new Date(now.getTime() - 6 * 86_400_000));
  const out = new Map<string, SubjectStudy>();

  for (const session of sessions) {
    if (!session.subjectId) continue;

    const entry =
      out.get(session.subjectId) ??
      ({ minutes: 0, sessions: 0, minutesThisWeek: 0, lastStudied: null } as SubjectStudy);

    entry.minutes += session.minutes ?? 0;
    entry.sessions += 1;
    if (session.dayKey >= weekAgo) entry.minutesThisWeek += session.minutes ?? 0;
    if (!entry.lastStudied || session.dayKey > entry.lastStudied) {
      entry.lastStudied = session.dayKey;
    }

    out.set(session.subjectId, entry);
  }

  return out;
}

/** "today" / "yesterday" / "3 days ago" from a YYYY-MM-DD key. */
export function describeLastStudied(key: string | null, now = new Date()): string {
  if (!key) return 'Not studied yet';

  const today = dayKey(now);
  if (key === today) return 'Studied today';
  if (key === dayKey(new Date(now.getTime() - 86_400_000))) return 'Studied yesterday';

  const days = Math.round(
    (new Date(`${today}T00:00:00`).getTime() - new Date(`${key}T00:00:00`).getTime()) / 86_400_000
  );
  if (days < 7) return `Studied ${days} days ago`;
  if (days < 14) return 'Studied last week';
  return `Studied ${Math.floor(days / 7)} weeks ago`;
}
