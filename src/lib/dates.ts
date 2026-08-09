import { Timestamp } from 'firebase/firestore';

export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function toDate(value: Timestamp | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof (value as Timestamp).toDate === 'function') return (value as Timestamp).toDate();
  return null;
}

/**
 * Parses the ISO-ish dates Gemini returns. Anything unparseable becomes null
 * rather than silently landing on 1970.
 */
export function parseDueDate(input: string | null | undefined): Timestamp | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    // Local noon keeps the calendar day stable across time zones.
    const date = new Date(Number(y), Number(m) - 1, Number(d), 12, 0, 0);
    return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : Timestamp.fromDate(parsed);
}

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'someday';

export function bucketFor(due: Date | null, now = new Date()): DueBucket {
  if (!due) return 'someday';
  const today = startOfDay(now).getTime();
  const dueDay = startOfDay(due).getTime();
  if (dueDay < today) return 'overdue';
  if (dueDay === today) return 'today';
  return 'upcoming';
}

export function formatDue(due: Date | null, now = new Date()): string {
  if (!due) return 'No date';

  const days = Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days < 7) return `In ${days} days`;

  return due.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: due.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export function formatDateTime(value: Timestamp | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Leitner-style spacing: 1, 3, 7, 16, 35 days. */
export function nextReviewDate(box: number, from = new Date()): Timestamp {
  const intervals = [1, 3, 7, 16, 35];
  const days = intervals[Math.min(box, intervals.length - 1)];
  const next = new Date(from);
  next.setDate(next.getDate() + days);
  return Timestamp.fromDate(next);
}
