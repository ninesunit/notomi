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
export function parseDueDate(
  input: string | null | undefined,
  time?: string | null
): Timestamp | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // A stated time is used verbatim; otherwise end of day, which is what
  // "due on the 14th" means to a student far more often than midnight.
  const parsedTime = /^(\d{1,2}):(\d{2})$/.exec((time ?? '').trim());
  const hour = parsedTime ? Math.min(23, Number(parsedTime[1])) : 23;
  const minute = parsedTime ? Math.min(59, Number(parsedTime[2])) : 59;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const date = new Date(Number(y), Number(m) - 1, Number(d), hour, minute, 0, 0);
    return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsedTime) parsed.setHours(hour, minute, 0, 0);
  return Timestamp.fromDate(parsed);
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

/* ------------------------------------------------------------------ *
 * Calendar grid
 * ------------------------------------------------------------------ */

export type CalendarCell = {
  date: Date;
  inMonth: boolean;
  isToday: boolean;
  key: string;
};

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Stable per-day key for grouping deadlines and for React lists. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

export function addMonths(date: Date, delta: number): Date {
  // Set the day to 1 first: adding a month to the 31st would otherwise skip.
  const next = new Date(date.getFullYear(), date.getMonth() + delta, 1);
  return next;
}

export function monthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * Six weeks of cells covering `month`, padded with neighbouring days.
 *
 * Always 42 cells so the grid does not change height as the user pages
 * through months — a jumping layout makes scanning dates harder.
 */
export function monthGrid(month: Date, weekStartsOn: 0 | 1 = 1): CalendarCell[] {
  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (firstOfMonth.getDay() - weekStartsOn + 7) % 7;

  const start = new Date(firstOfMonth);
  start.setDate(firstOfMonth.getDate() - offset);

  const today = new Date();
  const cells: CalendarCell[] = [];

  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      date,
      inMonth: date.getMonth() === month.getMonth(),
      isToday: isSameDay(date, today),
      key: dayKey(date),
    });
  }

  return cells;
}

export function weekdayLabels(weekStartsOn: 0 | 1 = 1): string[] {
  // Anchored to a known Sunday so the names come from the user's locale.
  const sunday = new Date(2024, 0, 7);
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(sunday);
    date.setDate(sunday.getDate() + ((i + weekStartsOn) % 7));
    return date.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3);
  });
}

/* ------------------------------------------------------------------ *
 * Countdown
 * ------------------------------------------------------------------ */

export type Countdown = {
  overdue: boolean;
  days: number;
  hours: number;
  minutes: number;
  /** Compact form for a card: "3d 4h", "2h 15m", "12m". */
  short: string;
  /** Sentence form: "in 3 days", "4 hours overdue". */
  long: string;
  /** 0-1 urgency, saturating at two weeks out. Drives colour. */
  urgency: number;
};

export function countdown(due: Date | null, now = new Date()): Countdown | null {
  if (!due) return null;

  const deltaMs = due.getTime() - now.getTime();
  const overdue = deltaMs < 0;
  const abs = Math.abs(deltaMs);

  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);

  const short = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  const unit = days > 0 ? `${days} day${days === 1 ? '' : 's'}` : hours > 0 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const long = overdue ? `${unit} overdue` : `in ${unit}`;

  const TWO_WEEKS = 14 * 86_400_000;
  const urgency = overdue ? 1 : Math.max(0, Math.min(1, 1 - deltaMs / TWO_WEEKS));

  return { overdue, days, hours, minutes, short, long, urgency };
}

/** Leitner-style spacing: 1, 3, 7, 16, 35 days. */
export function nextReviewDate(box: number, from = new Date()): Timestamp {
  const intervals = [1, 3, 7, 16, 35];
  const days = intervals[Math.min(box, intervals.length - 1)];
  const next = new Date(from);
  next.setDate(next.getDate() + days);
  return Timestamp.fromDate(next);
}
