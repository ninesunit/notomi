/*
 * What the daily allowance does, proved rather than asserted.
 *
 * Notomi has no test framework and adding one would be a dependency for a
 * single file, so this runs on node alone:
 *
 *     npm run test:budget
 *
 * budget.ts is written to stay importable that way — no imports of its own and
 * no constructor parameter properties, which `--experimental-strip-types`
 * cannot handle.
 *
 * It is this module that gets a test and not another because this one decides
 * whether every AI feature in the app is allowed to run. A mistake here does
 * not degrade something; it turns the reader, the importer, the quiz and the
 * copilot off at once, silently, for everybody. The scenario that matters most
 * is the last one anybody would try by hand: that a spent allowance comes back
 * the next day.
 */

/* Exercises budget.ts the way ai.ts drives it. Each scenario gets a fresh
   module instance via a cache-busting import, because the counters are
   deliberately module-scoped. */
let version = 0;
let now = Date.UTC(2026, 7, 21, 10, 0, 0);
const realNow = Date.now;
Date.now = () => now;

function freshEnv() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return store;
}
const load = async () => { version += 1; return import(`../src/lib/budget.ts?v=${version}`); };

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ok   ', name); }
  else { fail += 1; console.log('  FAIL  ', name, extra); }
};
/** Claim, reporting the refusal code or null when allowed. Does not release. */
const claim = (b, w = 'standard') => { try { b.claimAiRequest(w); return null; } catch (e) { return e.code; } };
/** A complete request: claim then release, as runWithModelFallback does. */
const request = (b, w = 'standard') => { const c = claim(b, w); if (c === null) b.releaseAiRequest(); return c; };

/* 1 — the per-minute window */
{
  freshEnv();
  const b = await load();
  const first = request(b), second = request(b), third = request(b);
  check('two requests a minute are allowed', first === null && second === null);
  check('the third in the same minute is refused', third === 'AI_RATE_LIMITED', `got ${third}`);
  now += 61_000;
  check('and allowed again a minute later', request(b) === null);
}

/* 2 — the daily allowance */
{
  freshEnv();
  const b = await load();
  const limit = b.AI_BUDGET.standardPerDay;
  const codes = [];
  for (let i = 0; i < limit + 2; i += 1) { codes.push(request(b)); now += 61_000; }
  check(`the first ${limit} requests are allowed`, codes.slice(0, limit).every((c) => c === null), JSON.stringify(codes));
  check('past the daily limit it refuses', codes[limit] === 'AI_DAILY_LIMIT', `got ${codes[limit]}`);
  check('and keeps refusing', codes[limit + 1] === 'AI_DAILY_LIMIT');
  const snap = b.usageSnapshot();
  check('usage reports what was spent', snap.ai.standard === limit, JSON.stringify(snap.ai));
  check('heavy budget is untouched by standard use', snap.ai.heavy === 0);
}

/* 3 — heavy is a separate, smaller purse */
{
  freshEnv();
  const b = await load();
  const codes = [];
  for (let i = 0; i < b.AI_BUDGET.heavyPerDay + 1; i += 1) { codes.push(request(b, 'heavy')); now += 61_000; }
  check('heavy requests spend the heavy budget', codes.slice(0, -1).every((c) => c === null));
  check('and are refused past it', codes.at(-1) === 'AI_DAILY_LIMIT', `got ${codes.at(-1)}`);
  check('while ordinary requests still work', request(b, 'standard') === null);
}

/* 4 — one at a time */
{
  freshEnv();
  const b = await load();
  check('the first claim holds the lock', claim(b) === null);
  check('a second while it runs is refused', claim(b) === 'AI_BUSY');
  b.releaseAiRequest();
  now += 61_000;
  check('and allowed once released', request(b) === null);
}

/* 5 — continuations ride along free */
{
  freshEnv();
  const b = await load();
  request(b, 'standard');
  const before = b.usageSnapshot().ai.standard;
  const codes = [request(b, 'continuation'), request(b, 'continuation'), request(b, 'continuation')];
  check('continuations are never rate limited', codes.every((c) => c === null), JSON.stringify(codes));
  check('and spend no daily units', b.usageSnapshot().ai.standard === before);
}

/* 6 — the circuit breaker */
{
  freshEnv();
  const b = await load();
  for (let i = 0; i < b.AI_BUDGET.breakerTrip; i += 1) b.recordUpstreamRefusal();
  check('enough refusals open the breaker', claim(b) === 'AI_CIRCUIT_OPEN');
  check('and the snapshot says so', b.usageSnapshot().pausedUntil !== null);
  now += b.AI_BUDGET.breakerCooldownMs + 1000;
  check('it closes again after the cooldown', request(b) === null);
}

/* 7 — a success clears the strikes before they trip it */
{
  freshEnv();
  const b = await load();
  for (let i = 0; i < b.AI_BUDGET.breakerTrip - 1; i += 1) b.recordUpstreamRefusal();
  b.recordUpstreamSuccess();
  b.recordUpstreamRefusal();
  check('one good answer resets the count', request(b) === null);
}

/* 8 — a new day returns the allowance */
{
  const store = freshEnv();
  const b = await load();
  for (let i = 0; i < b.AI_BUDGET.standardPerDay; i += 1) { request(b); now += 61_000; }
  check('the allowance is spent', request(b) === 'AI_DAILY_LIMIT');
  check('yesterday is persisted', store.get('notomi:usage-v1')?.includes('"aiStandard"'));
  now += 24 * 60 * 60 * 1000;
  check('tomorrow it is back', request(b) === null);
  check('and the counters restart', b.usageSnapshot().ai.standard === 1);
}

/* 9 — a record from yesterday is replaced, not carried */
{
  const store = freshEnv();
  store.set('notomi:usage-v1', JSON.stringify({ day: '1999-01-01', aiStandard: 99, aiHeavy: 99 }));
  const b = await load();
  check('a stale record does not lock the student out', request(b) === null);
  check('and its counts are discarded', b.usageSnapshot().ai.standard === 1);
}

/* 10 — storage refusing writes must not break anything */
{
  freshEnv();
  globalThis.localStorage.setItem = () => { throw new Error('private browsing'); };
  const b = await load();
  check('private browsing still allows requests', request(b) === null);
  check('and still counts them in memory', b.usageSnapshot().ai.standard === 1);
}

/* 11 — Firestore counters */
{
  freshEnv();
  const b = await load();
  b.recordReads(12); b.recordReads(0); b.recordReads(-4); b.recordWrites(3);
  const snap = b.usageSnapshot();
  check('reads accumulate and ignore nonsense', snap.firestore.reads === 12, JSON.stringify(snap.firestore));
  check('writes accumulate', snap.firestore.writes === 3);
}

/* 12 — the wait description */
{
  freshEnv();
  const b = await load();
  check('seconds read as seconds', b.describeWait(30) === 'in 30 seconds', b.describeWait(30));
  check('minutes read as minutes', b.describeWait(600) === 'in 10 minutes', b.describeWait(600));
  check('hours read as hours', b.describeWait(4 * 3600) === 'in 4 hours', b.describeWait(4 * 3600));
}

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
