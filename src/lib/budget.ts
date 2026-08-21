/**
 * What Notomi is allowed to spend today.
 *
 * Every service the app runs on has a hard daily ceiling — Gemini's free
 * requests-per-day, Firestore's 50,000 reads and 20,000 writes, Cloudflare's
 * 100,000 dynamic requests. None of them degrade gracefully on their own: they
 * serve every request normally and then, at some point in the afternoon, start
 * refusing all of them. For whoever is studying at that moment the app simply
 * stops working, and it stays stopped until midnight UTC.
 *
 * This module is the thing that makes that not happen. It keeps a running
 * count of what has been spent, refuses the request that would go over, and —
 * this is the part that matters — refuses it with a specific reason and a time
 * the allowance comes back, so the screen can say "you have used today's five
 * AI requests, they reset at 08:00" instead of "could not reach AI service".
 *
 * Three deliberate limitations, stated rather than hidden:
 *
 *   1. It is client-side. Counters live in localStorage, so a determined
 *      student can clear them. That is fine — this exists to stop ordinary use
 *      from exhausting a shared quota, not to stop an adversary. The
 *      authoritative limiter belongs in the Worker, in front of the model, and
 *      this module's shape is deliberately the one a Durable Object would
 *      expose so that move is a swap rather than a rewrite.
 *   2. The Firestore figures are estimates. They count documents this client
 *      saw, which is close to what was billed but not identical — a listener
 *      re-delivering from cache costs nothing, and a query the SDK served
 *      offline costs nothing either. They are for noticing a screen that reads
 *      four hundred documents, not for reconciling a bill.
 *   3. The day is the device's local day, not the quota's UTC day. A student
 *      in UTC+8 gets their allowance back at 08:00, not midnight. Anchoring to
 *      UTC would be more accurate and much stranger to be told about.
 */

/* ------------------------------------------------------------------ *
 * The allowance
 * ------------------------------------------------------------------ */

/**
 * The per-student daily allowance.
 *
 * These are the free-tier design targets, and they are tight on purpose: at
 * 100 daily active students, five requests each is roughly 500 calls against a
 * project-wide Gemini allowance that also has to cover retries and imports.
 *
 * Both can be raised from the environment without a code change once the real
 * Gemini limits are known — EXPO_PUBLIC_AI_USER_DAILY_LIMIT and
 * EXPO_PUBLIC_AI_USER_HEAVY_LIMIT. Nothing needs to be set for the app to run.
 */
function envLimit(name: string, fallback: number): number {
  const raw =
    name === 'EXPO_PUBLIC_AI_USER_DAILY_LIMIT'
      ? process.env.EXPO_PUBLIC_AI_USER_DAILY_LIMIT
      : process.env.EXPO_PUBLIC_AI_USER_HEAVY_LIMIT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const AI_BUDGET = {
  /** Ordinary requests: a reader question, a quiz, a summary. */
  standardPerDay: envLimit('EXPO_PUBLIC_AI_USER_DAILY_LIMIT', 5),
  /** Whole-file analyses: a timetable import, a scanned PDF, a transcription. */
  heavyPerDay: envLimit('EXPO_PUBLIC_AI_USER_HEAVY_LIMIT', 2),
  /** Requests started within any rolling minute. */
  perMinute: 2,
  /** How many may be in flight at once. One, so a double tap cannot spend two. */
  concurrent: 1,
  /**
   * Consecutive upstream rate-limit refusals before the app stops asking.
   *
   * Past this it is not a hiccup, it is an exhausted project quota, and
   * continuing to retry turns one student's bad afternoon into everyone's.
   */
  breakerTrip: 3,
  /** How long the breaker stays open once tripped. */
  breakerCooldownMs: 10 * 60_000,
} as const;

export type AiWeight =
  /** A reader question, a quiz, a summary. Spends one of the daily requests. */
  | 'standard'
  /** A whole file sent for analysis. Spends one of the smaller heavy budget. */
  | 'heavy'
  /**
   * A follow-up round inside an operation the student has already paid for —
   * the second model call after a tool request, or a schema retry.
   *
   * It is a real upstream request and so it still respects the breaker and the
   * one-at-a-time lock, but it does not spend another daily unit. Charging for
   * it would mean one question that happened to need a tool cost four of five
   * requests, which would teach students to avoid the feature rather than to
   * use it sparingly.
   */
  | 'continuation';

/* ------------------------------------------------------------------ *
 * The refusal
 * ------------------------------------------------------------------ */

export type QuotaCode =
  /** Today's allowance for this weight is spent. */
  | 'AI_DAILY_LIMIT'
  /** Too many requests in the last minute. */
  | 'AI_RATE_LIMITED'
  /** Another request is already running for this student. */
  | 'AI_BUSY'
  /** Upstream refused repeatedly; the app has stopped asking for a while. */
  | 'AI_CIRCUIT_OPEN';

/**
 * A refusal Notomi made itself, before any network call.
 *
 * Separate from AiError because it means something different to a screen: not
 * "this failed", but "this did not happen, here is when it can". A screen that
 * catches one of these should keep the student's input, show the reset time,
 * and offer the thing that still works — never a retry loop.
 */
export class QuotaError extends Error {
  readonly name = 'QuotaError';

  constructor(
    readonly code: QuotaCode,
    message: string,
    /** Whole seconds until this particular refusal stops applying. */
    readonly retryAfterSeconds: number
  ) {
    super(message);
  }
}

export function isQuotaError(error: unknown): error is QuotaError {
  return error instanceof QuotaError;
}

/* ------------------------------------------------------------------ *
 * Where the counts live
 * ------------------------------------------------------------------ */

const STORE_KEY = 'notomi:usage-v1';

type DayRecord = {
  /** Local calendar day this record belongs to, as YYYY-MM-DD. */
  day: string;
  aiStandard: number;
  aiHeavy: number;
  /** Start times of recent requests, for the per-minute window. */
  recent: number[];
  firestoreReads: number;
  firestoreWrites: number;
  /** Consecutive upstream rate-limit refusals. */
  strikes: number;
  /** When the circuit breaker reopens; 0 when closed. */
  breakerUntil: number;
};

function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function empty(): DayRecord {
  return {
    day: today(),
    aiStandard: 0,
    aiHeavy: 0,
    recent: [],
    firestoreReads: 0,
    firestoreWrites: 0,
    strikes: 0,
    breakerUntil: 0,
  };
}

/**
 * The counters, held in memory and mirrored to localStorage.
 *
 * In memory because these are read on every Firestore snapshot and parsing
 * JSON that often would be its own performance problem; mirrored because a
 * reload during an exam-week afternoon must not hand back a fresh allowance.
 */
let record: DayRecord | null = null;

function load(): DayRecord {
  if (record && record.day === today()) return record;

  if (typeof localStorage === 'undefined') {
    record = empty();
    return record;
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<DayRecord> | null;
    // A record from yesterday is not corrected, it is replaced: the whole
    // point of a daily allowance is that it comes back.
    record =
      parsed && parsed.day === today()
        ? { ...empty(), ...parsed, day: today(), recent: parsed.recent ?? [] }
        : empty();
  } catch {
    record = empty();
  }
  return record;
}

function save(): void {
  if (!record || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(record));
  } catch {
    /* Private browsing rejects the write; the in-memory count still holds for
       this session, which is the case that matters most. */
  }
}

/** Seconds until the local day rolls over and the allowance returns. */
function secondsUntilReset(): number {
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((midnight.getTime() - Date.now()) / 1000));
}

/* ------------------------------------------------------------------ *
 * Asking permission
 * ------------------------------------------------------------------ */

/** Requests started but not yet finished. Process-local, so a reload clears it. */
let inFlight = 0;

/**
 * May an AI request run right now?
 *
 * Throws rather than returning false, because every caller of this would
 * otherwise have to invent the same throw, and one of them would forget.
 */
export function claimAiRequest(weight: AiWeight): void {
  const usage = load();
  const now = Date.now();
  const chargeable = weight !== 'continuation';

  if (usage.breakerUntil > now) {
    throw new QuotaError(
      'AI_CIRCUIT_OPEN',
      'The AI service turned several requests away in a row, so Notomi has stopped asking for a few minutes. Everything else still works.',
      Math.ceil((usage.breakerUntil - now) / 1000)
    );
  }

  if (inFlight >= AI_BUDGET.concurrent) {
    throw new QuotaError(
      'AI_BUSY',
      'One AI request is already running. Wait for it to finish, or cancel it first.',
      5
    );
  }

  usage.recent = usage.recent.filter((at) => now - at < 60_000);
  if (chargeable && usage.recent.length >= AI_BUDGET.perMinute) {
    const oldest = Math.min(...usage.recent);
    throw new QuotaError(
      'AI_RATE_LIMITED',
      'That is a lot of AI requests in a row. Give it a moment.',
      Math.max(1, Math.ceil((60_000 - (now - oldest)) / 1000))
    );
  }

  const spent = weight === 'heavy' ? usage.aiHeavy : usage.aiStandard;
  const allowed = weight === 'heavy' ? AI_BUDGET.heavyPerDay : AI_BUDGET.standardPerDay;
  if (chargeable && spent >= allowed) {
    throw new QuotaError(
      'AI_DAILY_LIMIT',
      weight === 'heavy'
        ? `You have used today's ${allowed} file analyses. Your schedule, tasks, notes and everything already processed still work — and you can always add a class or a task by hand.`
        : `You have used today's ${allowed} AI requests. Everything already generated stays available, and the rest of Notomi is unaffected.`,
      secondsUntilReset()
    );
  }

  // Counted at the start, not the end. A request that is refused upstream
  // still cost the project its share of the per-minute allowance, and a
  // student who could retry for free would find the ceiling by hitting it.
  if (chargeable) {
    usage.recent.push(now);
    if (weight === 'heavy') usage.aiHeavy += 1;
    else usage.aiStandard += 1;
  }
  inFlight += 1;
  save();
}

/** Every claimed request must release, success or failure. */
export function releaseAiRequest(): void {
  inFlight = Math.max(0, inFlight - 1);
}

/** An upstream refusal. Enough of them in a row and the app stops asking. */
export function recordUpstreamRefusal(): void {
  const usage = load();
  usage.strikes += 1;
  if (usage.strikes >= AI_BUDGET.breakerTrip) {
    usage.breakerUntil = Date.now() + AI_BUDGET.breakerCooldownMs;
    usage.strikes = 0;
  }
  save();
}

/** A success closes the breaker's count; one good answer means it is back. */
export function recordUpstreamSuccess(): void {
  const usage = load();
  if (usage.strikes === 0 && usage.breakerUntil === 0) return;
  usage.strikes = 0;
  usage.breakerUntil = 0;
  save();
}

/* ------------------------------------------------------------------ *
 * Firestore
 * ------------------------------------------------------------------ */

/**
 * Estimated documents read. Called from the shared query hooks rather than
 * from every call site, which covers the listeners that account for most of
 * a session's reads.
 */
export function recordReads(count: number): void {
  if (count <= 0) return;
  load().firestoreReads += count;
  save();
}

export function recordWrites(count: number): void {
  if (count <= 0) return;
  load().firestoreWrites += count;
  save();
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

export type UsageSnapshot = {
  day: string;
  ai: { standard: number; standardLimit: number; heavy: number; heavyLimit: number };
  firestore: { reads: number; writes: number };
  /** Null when the breaker is closed. */
  pausedUntil: Date | null;
  resetsInSeconds: number;
};

/** What Settings shows, and what a support conversation can start from. */
export function usageSnapshot(): UsageSnapshot {
  const usage = load();
  return {
    day: usage.day,
    ai: {
      standard: usage.aiStandard,
      standardLimit: AI_BUDGET.standardPerDay,
      heavy: usage.aiHeavy,
      heavyLimit: AI_BUDGET.heavyPerDay,
    },
    firestore: { reads: usage.firestoreReads, writes: usage.firestoreWrites },
    pausedUntil: usage.breakerUntil > Date.now() ? new Date(usage.breakerUntil) : null,
    resetsInSeconds: secondsUntilReset(),
  };
}

/** "in 4 hours", "in 45 seconds" — for telling a student when to come back. */
export function describeWait(seconds: number): string {
  if (seconds < 90) return `in ${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} hour${hours === 1 ? '' : 's'}`;
}
