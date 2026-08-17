/**
 * Is the deployed Worker actually able to hold a Drive grant?
 *
 * The distinction that matters is invisible from the browser until a student
 * presses Connect and it silently falls back to the hourly flow:
 *
 *   501  the client secret or the KV namespace did not stick
 *   404  configured correctly; this account simply has no grant yet
 *
 * A real signed-in account is needed because every /drive/* route is scoped to
 * the caller's uid, so this signs up a throwaway user and deletes it after.
 * No Google consent, no client secret, nothing written to Drive.
 */
import { readFile } from 'node:fs/promises';

const WORKER = process.env.WORKER_URL ?? 'https://notomi.filazliakim.workers.dev';
const API_KEY = 'AIzaSyDKRIGm43ggmTOfi5rQ5g_wCmg3n8Cu2xU';
const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/* ----------------------------- reachable? ----------------------------- */

console.log('— the worker —');

let health;
try {
  health = await fetch(`${WORKER}/health`);
} catch (caught) {
  console.log(`FAIL  the worker is unreachable — ${caught.message}`);
  console.log('\nNothing below can be trusted, so this stops here. Run it from a');
  console.log('network that can reach workers.dev.');
  process.exit(1);
}

const healthBody = await health.json().catch(() => ({}));
if (!health.ok) {
  console.log(`FAIL  /health answered ${health.status}`);

  // A 404 on a route that needs no authentication almost always means the
  // request reached Cloudflare and found no worker of that name — so the most
  // useful next thing is to go and look for it. `wrangler.toml` names the
  // worker this repo deploys; if that name is not the one in the URL, the
  // deploy went somewhere nobody is calling.
  // Cloudflare stamps every response it serves, including its own 404s. If
  // those headers are present the request reached Cloudflare and there is
  // genuinely no worker on that hostname; if they are absent, something
  // between here and Cloudflare answered instead and the worker is fine.
  const ray = health.headers.get('cf-ray');
  const server = health.headers.get('server');
  console.log(`\n  server: ${server ?? '(none)'}   cf-ray: ${ray ?? '(none)'}`);
  console.log(
    ray
      ? '  → reached Cloudflare, which has no worker answering on this hostname'
      : '  → never reached Cloudflare; a proxy or network in between replied'
  );

  if (health.status === 404 && ray) {
    const configured = await readFile(new URL('./wrangler.toml', import.meta.url), 'utf8')
      .then((toml) => /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null)
      .catch(() => null);

    const host = new URL(WORKER).hostname;
    const subdomain = host.split('.').slice(1).join('.');
    const calling = host.split('.')[0];

    console.log(`\n  the URL calls the worker named  "${calling}"`);
    if (configured) console.log(`  wrangler.toml deploys one named "${configured}"`);

    if (configured && configured !== calling) {
      const other = `https://${configured}.${subdomain}`;
      const probe = await fetch(`${other}/health`).catch(() => null);
      console.log(`\n  probing ${other}/health → ${probe ? probe.status : 'unreachable'}`);
      if (probe?.ok) {
        console.log(`\n  Found it. Everything was deployed to "${configured}" while the app`);
        console.log(`  calls "${calling}". Set name = "${calling}" in wrangler.toml, deploy`);
        console.log('  again, and re-add the secret — Worker secrets do not follow a rename.');
      }
    } else {
      console.log('\n  The names agree, so the worker exists but its workers.dev route');
      console.log('  does not. A route is a per-worker setting that outlives a deploy —');
      console.log('  turned off in the dashboard, or lost when a worker was deleted and');
      console.log('  recreated — so deploying succeeds and the hostname still 404s.');
      console.log('\n  wrangler.toml now sets workers_dev = true, so:');
      console.log('    npx wrangler deploy');
      console.log('\n  If it still 404s, check Workers & Pages > notomi > Settings >');
      console.log('  Domains & Routes and enable the workers.dev route there.');
    }
  } else {
    console.log('\n  /health takes no authentication, so a non-200 here means the request');
    console.log('  never reached the Worker — a proxy or network policy in the way rather');
    console.log('  than anything about the configuration.');
  }

  console.log('\nEverything below would be measuring that instead, so this stops here.');
  process.exit(1);
}
check(true, 'the worker is up', JSON.stringify(healthBody));

/* --------------------------- a real caller ---------------------------- */

const email = `drivecheck${Date.now()}@notomi.test`;
const signUp = await fetch(`${IDENTITY}/accounts:signUp?key=${API_KEY}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'hunter2pass', returnSecureToken: true }),
}).then((r) => r.json());

if (!signUp.idToken) {
  console.log(`\ncould not sign in to check: ${JSON.stringify(signUp)}`);
  process.exit(1);
}
console.log(`\n— signed in as a throwaway account —`);

const call = async (path) => {
  const res = await fetch(`${WORKER}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signUp.idToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/* ------------------------- is Drive enabled? -------------------------- */

console.log('\n— drive routes —');

const token = await call('/drive/token');

// 404 is the single status that means "configured, and this account has no
// grant yet". Asserting "not 501" would have passed on a proxy's 403 and
// called a blocked request a success.
check(
  token.status === 404,
  'the worker can hold a Drive grant, and has none for a new account',
  token.status === 404
    ? 'exactly right'
    : token.status === 501
      ? 'still 501 — GOOGLE_CLIENT_SECRET or the DRIVE_TOKENS binding did not stick'
      : `unexpected ${token.status} ${JSON.stringify(token.body)}`
);

// Unlink must be harmless when there is nothing to unlink — a student pressing
// Disconnect twice should not see an error.
const unlink = await call('/drive/unlink');
check(unlink.status === 200, 'unlinking with no grant is a no-op', `${unlink.status}`);

// A missing code must be refused rather than half-storing anything.
const badLink = await fetch(`${WORKER}/drive/link`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${signUp.idToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
check(badLink.status === 400, 'linking without a code is refused', `${badLink.status}`);

/* --------------------------- the preflight ---------------------------- */

// Node's fetch ignores CORS entirely, so every check above would pass against
// a worker no browser can call. The preflight is what a browser sends first,
// and what it answers decides whether the request is ever made — which is why
// "Failed to fetch" in the app looked like nothing at all from here.
console.log('\n— cross-origin —');

const preflight = await fetch(`${WORKER}/drive/link`, {
  method: 'OPTIONS',
  headers: {
    Origin: 'https://notomii.web.app',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type',
  },
});

const allowOrigin = preflight.headers.get('access-control-allow-origin');
const allowMethods = preflight.headers.get('access-control-allow-methods') ?? '';
const allowHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
const maxAge = Number(preflight.headers.get('access-control-max-age') ?? '0');

check(preflight.status === 204 || preflight.ok, 'the preflight is answered', `${preflight.status}`);
check(
  allowOrigin === 'https://notomii.web.app',
  'the app origin is allowed',
  allowOrigin ?? '(none)'
);
check(allowMethods.includes('POST'), 'POST is allowed', allowMethods || '(none)');
check(
  allowHeaders.includes('authorization') && allowHeaders.includes('content-type'),
  'the headers the app sends are allowed',
  allowHeaders || '(none)'
);
check(
  maxAge <= 3600,
  'the preflight is not cached for long',
  `${maxAge}s — a browser refuses methods the cached copy omitted, so a long cache outlives the fix`
);

/* ------------------------ and only for you ---------------------------- */

console.log('\n— scoping —');

const noAuth = await fetch(`${WORKER}/drive/token`, { method: 'POST', body: '{}' });
check(noAuth.status === 401, 'an unauthenticated caller gets nothing', `${noAuth.status}`);

const badAuth = await fetch(`${WORKER}/drive/token`, {
  method: 'POST',
  headers: { Authorization: 'Bearer not-a-real-token' },
  body: '{}',
});
check(badAuth.status === 401, 'and neither does a forged token', `${badAuth.status}`);

/* ------------------------------ cleanup ------------------------------- */

await fetch(`${IDENTITY}/accounts:delete?key=${API_KEY}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ idToken: signUp.idToken }),
});
console.log('\ntest account removed.');

console.log(`\n${failures === 0 ? 'Drive linking is live and correctly scoped.' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
