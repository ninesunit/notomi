import { getFirebaseAuth } from '@/services/firebase';

/**
 * What a student is allowed to spend, and what happens when they have.
 *
 * Notomi runs on free allowances. They are per project, not per student, so
 * one person on a bad afternoon can spend a whole cohort's day — and the way
 * that usually happens is not deliberate: a failed request retried in a loop,
 * ten files dropped at once, a stuck spinner tapped six times.
 *
 * So the limits that matter most here are not the daily ones. They are the
 * concurrency lock and the per-minute rate, because those are what turn a
 * mistake into a storm. The daily caps are a backstop.
 *
 * Everything is local to the device. A determined person can clear it, which
 * is fine: this exists to stop accidents, not attacks. The provider's own
 * limits remain the real ceiling, and `noteOverload` is how this module hears
 * about them.
 */

export type QuotaCode =
  /** Today's allowance is spent. */
  | 'AI_DAILY_LIMIT'
  /** The provider has been failing; we have stopped asking for a while. */
  | 'AI_CIRCUIT_OPEN';

/**
 * A refusal that carries enough for the UI to say something true: which limit,
 * when it lifts, and a reference a student can quote without leaking anything
 * about what they were working on.
 */
export class AiQuotaError extends Error {
  readonly code: QuotaCode;
  readonly retryAfterSeconds: number;
  readonly requestId: string;

  constructor(code: QuotaCode, message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'AiQuotaError';
    this.code = code;
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    this.requestId = requestId();
  }
}

export function isQuotaError(error: unknown): error is AiQuotaError {
  return error instanceof AiQuotaError;
}

/** Heavy means a file went up: vision, transcription, a whole document. */
export type Weight = 'standard' | 'heavy';

/**
 * The dial.
 *
 * Serialising is what actually stops a storm: one request at a time means a
 * loop that fires a hundred calls gets a queue, not a hundred calls. The
 * per-minute rate paces that queue. Six rather than the two the review
 * suggested, because a ten-file upload is a supported thing to do and two a
 * minute would make it take five minutes.
 *
 * The daily caps are set higher than the free-tier review suggested (5 and 2),
 * because five requests is one upload and three questions — a normal Tuesday,
 * not abuse — and a limit that fires on ordinary use teaches students to
 * distrust the app rather than to pace themselves. They are one edit away if
 * the provider's real allowance turns out to be tighter than it looks.
 */
export const AI_LIMITS = {
  concurrent: 1,
  perMinute: 6,
  standardPerDay: 25,
  heavyPerDay: 6,
  /** Consecutive provider overloads before we stop asking at all. */
  breakerAfter: 3,
  breakerCooldownMs: 5 * 60_000,
} as const;

/** Guests are a product tour, not an unbounded way around the shared quota. */
const GUEST_AI_LIMITS = {
  standardPerDay: 8,
  heavyPerDay: 2,
} as const;

const KEY = 'notomi:ai-budget-v1';

function identity(): { key: string; guest: boolean } {
  try {
    const current = getFirebaseAuth().currentUser;
    return {
      key: `${KEY}:${current?.uid ?? 'signed-out'}`,
      guest: current?.isAnonymous === true,
    };
  } catch {
    return { key: `${KEY}:signed-out`, guest: false };
  }
}

function dailyCaps(): { standard: number; heavy: number } {
  return identity().guest
    ? { standard: GUEST_AI_LIMITS.standardPerDay, heavy: GUEST_AI_LIMITS.heavyPerDay }
    : { standard: AI_LIMITS.standardPerDay, heavy: AI_LIMITS.heavyPerDay };
}

type Ledger = {
  /** Local calendar day, so the reset lands at the student's midnight. */
  day: string;
  standard: number;
  heavy: number;
  /** Epoch ms of recent starts, trimmed to the last minute. */
  recent: number[];
  failures: number;
  blockedUntil: number;
};

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function empty(): Ledger {
  return { day: today(), standard: 0, heavy: 0, recent: [], failures: 0, blockedUntil: 0 };
}

function read(): Ledger {
  if (typeof localStorage === 'undefined') return empty();
  try {
    const raw = localStorage.getItem(identity().key);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Ledger;
    // A new day is a fresh allowance; the breaker is not a daily thing and
    // carries over, because a provider outage does not end at midnight.
    if (parsed.day !== today()) {
      return { ...empty(), blockedUntil: parsed.blockedUntil ?? 0, failures: parsed.failures ?? 0 };
    }
    return { ...empty(), ...parsed };
  } catch {
    return empty();
  }
}

function write(ledger: Ledger): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(identity().key, JSON.stringify(ledger));
  } catch {
    /* Private mode. The in-flight lock below still holds for the session. */
  }
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

export function subscribeToBudget(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function requestId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/** Deliberately not persisted: an in-flight request cannot outlive the tab. */
let inFlight = 0;

export type BudgetStatus = {
  standardLeft: number;
  heavyLeft: number;
  /** Local midnight, when the daily counters clear. */
  resetsAt: Date;
  /** Non-null while the breaker is open. */
  blockedUntil: Date | null;
  busy: boolean;
};

export function budgetStatus(): BudgetStatus {
  const ledger = read();
  const caps = dailyCaps();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  return {
    standardLeft: Math.max(0, caps.standard - ledger.standard),
    heavyLeft: Math.max(0, caps.heavy - ledger.heavy),
    resetsAt: midnight,
    blockedUntil: ledger.blockedUntil > Date.now() ? new Date(ledger.blockedUntil) : null,
    busy: inFlight > 0,
  };
}

/**
 * Claims a slot. Queues rather than refusing where queueing is the honest
 * answer, and refuses where it is not.
 *
 * Being busy and being too quick are both temporary and both the caller's own
 * doing — a batch of ten files should pace itself, not fail on the third. A
 * spent daily allowance and a failing provider are neither, so those throw
 * straight away rather than parking someone in a queue that cannot move.
 *
 * Returns the release, which the caller must run in a `finally`: a lock that
 * leaks on a thrown error is worse than no lock, because it strands the
 * student until they reload.
 */
export async function reserve(weight: Weight): Promise<() => void> {
  refuseIfClosed(weight);

  const ahead = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  inFlight += 1;

  try {
    await ahead;
    await waitOutRate();
    // Re-checked on the way out of the queue: the allowance may have gone
    // while this request was waiting for its turn.
    refuseIfClosed(weight);
    spend(weight);
  } catch (error) {
    inFlight = Math.max(0, inFlight - 1);
    release();
    throw error;
  }

  let done = false;
  return () => {
    if (done) return;
    done = true;
    inFlight = Math.max(0, inFlight - 1);
    release();
    for (const listener of listeners) listener();
  };
}

/** The queue is one-deep by construction: concurrency is one. */
let tail: Promise<void> = Promise.resolve();

/** The two refusals that waiting cannot fix. */
function refuseIfClosed(weight: Weight): void {
  const ledger = read();
  const caps = dailyCaps();
  const now = Date.now();

  if (ledger.blockedUntil > now) {
    throw new AiQuotaError(
      'AI_CIRCUIT_OPEN',
      'The AI service has been failing, so Notomi has stopped asking for a few minutes. Everything else still works.',
      (ledger.blockedUntil - now) / 1000
    );
  }

  const used = weight === 'heavy' ? ledger.heavy : ledger.standard;
  const cap = weight === 'heavy' ? caps.heavy : caps.standard;
  if (used >= cap) {
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    throw new AiQuotaError(
      'AI_DAILY_LIMIT',
      weight === 'heavy'
        ? 'You have used today\u2019s file analyses. Your schedule, tasks, notes and everything already processed still work.'
        : 'You have used today\u2019s AI questions. Everything else in Notomi still works.',
      (midnight.getTime() - now) / 1000
    );
  }
}

/** Sleeps only as long as the minute window actually requires. */
async function waitOutRate(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const recent = read().recent.filter((at) => now - at < 60_000);
    if (recent.length < AI_LIMITS.perMinute) return;
    await new Promise((resolve) => setTimeout(resolve, 60_000 - (now - recent[0]) + 50));
  }
}

function spend(weight: Weight): void {
  const ledger = read();
  const now = Date.now();
  write({
    ...ledger,
    recent: [...ledger.recent.filter((at) => now - at < 60_000), now],
    standard: ledger.standard + (weight === 'standard' ? 1 : 0),
    heavy: ledger.heavy + (weight === 'heavy' ? 1 : 0),
  });
}

/**
 * The provider said it was overloaded or out of quota.
 *
 * Distinct from the per-model cooldowns in ai.ts, which route around one model
 * that is busy. This is the case where routing has run out of places to go: a
 * few of those in a row and continuing to ask is just noise on a service that
 * has already said no.
 */
export function noteOverload(): void {
  const ledger = read();
  const failures = ledger.failures + 1;
  write({
    ...ledger,
    failures,
    blockedUntil:
      failures >= AI_LIMITS.breakerAfter ? Date.now() + AI_LIMITS.breakerCooldownMs : ledger.blockedUntil,
  });
}

/** One success is enough to believe the service is back. */
export function noteSuccess(): void {
  const ledger = read();
  if (ledger.failures === 0 && ledger.blockedUntil === 0) return;
  write({ ...ledger, failures: 0, blockedUntil: 0 });
}
