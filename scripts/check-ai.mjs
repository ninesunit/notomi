/**
 * Is the deployed app actually able to reach the AI?
 *
 * The e2e suites run against the emulators, where attestation is switched off
 * entirely, so nothing in the test suite can see this class of failure. Twice
 * now the AI has gone down for a reason no test could catch:
 *
 *   1. the client offered an Enterprise attestation token while the web app is
 *      registered for ordinary reCAPTCHA — refused at the exchange with a 400
 *   2. the exchange refused a genuine token outright — 403 "App attestation
 *      failed", which means the site key in the bundle and the secret stored
 *      in the console are not two halves of the same reCAPTCHA key pair, or
 *      the site the bundle is served from is not on that key's domain list
 *
 * Both surface to a student as "the AI is not available", which is what makes
 * them expensive: the message blames the AI, and the AI is fine. This script
 * reads the live bundle and asks the attestation service directly, so the
 * answer takes a second instead of an afternoon.
 *
 *   node scripts/check-ai.mjs
 *
 * No credentials needed. Nothing is written. Set GOOGLE_APPLICATION_CREDENTIALS
 * to additionally report which provider the console has registered and whether
 * enforcement is on.
 */
const SITE = process.env.NOTOMI_SITE ?? 'https://notomii.web.app';
const APP_CHECK = 'https://content-firebaseappcheck.googleapis.com/v1';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const note = (text) => console.log(`      ${text}`);

/* --------------------------- read the live bundle --------------------------- */

console.log('— the deployed bundle —');

let indexHtml;
try {
  const res = await fetch(SITE, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  indexHtml = await res.text();
} catch (caught) {
  console.log(`FAIL  ${SITE} is unreachable — ${caught.message}`);
  console.log('\nEverything below reads the bundle, so this stops here. Run it from a');
  console.log('network that can reach the site.');
  process.exit(1);
}

const entryPath = indexHtml.match(/\/_expo\/static\/js\/web\/entry-[a-f0-9]+\.js/)?.[0];
check(Boolean(entryPath), 'the page names an entry bundle', entryPath ?? 'none found in index.html');
if (!entryPath) process.exit(1);

const bundle = await fetch(`${SITE}${entryPath}`).then((r) => r.text());

// Minification rewrites the template literal, so match the provider by the
// constructor the bundle actually calls rather than by any log string.
const usesV3 = /ReCaptchaV3Provider\s*\(/.test(bundle);
const usesEnterprise = /ReCaptchaEnterpriseProvider\s*\(/.test(bundle);
const shipped = usesV3 && !usesEnterprise ? 'v3' : usesEnterprise && !usesV3 ? 'enterprise' : null;

check(
  shipped !== null,
  'the bundle commits to exactly one attestation provider',
  shipped ?? 'both or neither survived minification — the ternary was not folded'
);

const projectId = bundle.match(/projectId:"([^"]+)"/)?.[1];
const appId = bundle.match(/appId:"([^"]+)"/)?.[1];
const siteKey = bundle.match(/"(6L[A-Za-z0-9_-]{38})"/)?.[1];

check(projectId === 'notomii', 'the bundle points at the live project', projectId ?? 'no projectId');
check(Boolean(appId), 'the bundle carries an app id', appId ?? 'none');
check(Boolean(siteKey), 'the bundle carries a reCAPTCHA site key', siteKey ? `${siteKey.slice(0, 12)}…` : 'none');
note(`provider shipped: ${shipped ?? 'unknown'}`);

if (!appId || !siteKey || !shipped) {
  console.log('\nWithout an app id, a site key and one provider there is nothing to ask');
  console.log('the attestation service about.');
  process.exit(1);
}

/* ------------------- does the exchange accept that provider? ------------------ */

console.log('\n— the attestation exchange —');

/**
 * A deliberately invalid token. The point is not to pass attestation — it is
 * to find out how far the request gets, which is what separates the failures:
 *
 *   400  this app is not registered for this provider (wrong provider shipped)
 *   403  registered, and the token was judged — the only status a real token
 *        could ever succeed from
 *   404  no such exchange for this app
 */
const probe = async (provider) => {
  const method = provider === 'enterprise' ? 'exchangeRecaptchaEnterpriseToken' : 'exchangeRecaptchaV3Token';
  const field = provider === 'enterprise' ? 'recaptcha_enterprise_token' : 'recaptcha_v3_token';
  const res = await fetch(`${APP_CHECK}/projects/${projectId}/apps/${appId}:${method}?key=${bundle.match(/apiKey:"([^"]+)"/)?.[1]}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: `${SITE}/` },
    body: JSON.stringify({ [field]: 'probe-not-a-real-token' }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, message: body?.error?.message ?? '' };
};

const shippedResult = await probe(shipped);

if (/blocked/i.test(shippedResult.message)) {
  check(false, 'the API key may call the attestation service', shippedResult.message.slice(0, 120));
  note('The key has API restrictions that leave out the App Check API.');
} else {
  check(true, 'the API key may call the attestation service');
}

check(
  shippedResult.status === 403,
  `the app is registered for the provider it ships (${shipped})`,
  shippedResult.status === 403
    ? 'registered — a rejected probe token is exactly right here'
    : shippedResult.status === 400
      ? `NOT registered for ${shipped} — this is the failure that takes every AI feature down`
      : `unexpected ${shippedResult.status} ${shippedResult.message.slice(0, 120)}`
);

// If the shipped provider is not registered, say which one is, rather than
// leaving the reader to guess between two options.
if (shippedResult.status !== 403) {
  const other = shipped === 'v3' ? 'enterprise' : 'v3';
  const otherResult = await probe(other);
  if (otherResult.status === 403) {
    note(`The app IS registered for "${other}".`);
    note(`Fix: set EXPO_PUBLIC_APP_CHECK_PROVIDER=${other} and redeploy.`);
  } else {
    note(`Neither provider is registered (${shipped}: ${shippedResult.status}, ${other}: ${otherResult.status}).`);
    note('Register the web app under App Check before enforcement is switched on.');
  }
}

/* ------------------- registration and enforcement, if allowed ---------------- */

if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.log('\n— the console —');
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const { token } = await (await auth.getClient()).getAccessToken();
    const get = async (path) =>
      (await fetch(`https://firebaseappcheck.googleapis.com/v1/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      })).json();

    const v3 = await get(`projects/${projectId}/apps/${appId}/recaptchaV3Config`);
    const ent = await get(`projects/${projectId}/apps/${appId}/recaptchaEnterpriseConfig`);
    note(`v3 secret registered: ${Boolean(v3.siteSecretSet)}`);
    note(`enterprise site key registered: ${Boolean(ent.siteKey)}`);

    const services = await get(`projects/${projectId}/services`);
    for (const service of services.services ?? []) {
      const name = service.name.split('/').pop();
      if (!/firebaseml|vertexai/.test(name)) continue;
      const enforced = service.enforcementMode === 'ENFORCED';
      note(`${name}: ${service.enforcementMode}`);
      if (enforced && shippedResult.status !== 403) {
        check(false, 'enforcement is on while attestation is broken', 'every AI feature is down');
      }
    }
  } catch (caught) {
    note(`could not read the console: ${caught.message}`);
  }
}

console.log(
  `\n${failures === 0 ? 'The AI path is configured correctly.' : `${failures} FAILED — see above.`}`
);
process.exit(failures === 0 ? 0 : 1);
