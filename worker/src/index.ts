/**
 * Notomi R2 broker.
 *
 * The web app is a static bundle, so credentials cannot safely live there.
 * This Worker uses an R2 binding for authenticated uploads and downloads.
 *
 * It also enforces ownership: a caller may only touch keys under
 * users/{their-firebase-uid}/, which the client alone could not guarantee.
 *
 *   PUT    /object?key=       upload an original file
 *   GET    /object?key=       download an original file
 *   DELETE /object?key=       delete an original file
 *   DELETE /user-data         delete every original owned by the caller
 *
 * It is also the only place a Google refresh token can live.
 *
 *   POST   /drive/link        trade an authorization code for a refresh token
 *   POST   /drive/token       mint a fresh Drive access token
 *   POST   /drive/unlink      revoke and forget the refresh token
 *
 * A browser OAuth flow returns an access token that dies after an hour and no
 * refresh token, which is why students had to reconnect Drive every time they
 * came back. Only a confidential client can hold a refresh token, and only
 * because its secret never leaves the server — so the exchange happens here,
 * the refresh token is stored here, and the browser only ever receives the
 * short-lived access token it already knew how to use.
 *
 * These routes stay off until GOOGLE_CLIENT_SECRET and the DRIVE_TOKENS KV
 * namespace are configured; without them the app falls back to reconnecting by
 * hand exactly as before.
 *
 * Every route requires a Firebase ID token in `Authorization: Bearer <token>`.
 */
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** The only scope this app ever asks for: files it created, nothing else. */
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GOOGLE_JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin);

  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : allowed[0] ?? '',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    // Ten minutes, not a day. A browser caches the preflight answer for this
    // long and will refuse a method the cached copy did not list — so when the
    // worker learned to accept POST, every browser that had talked to it for
    // R2 uploads kept rejecting /drive/* for a day, before the request ever
    // left the machine. Long caches are a false economy on an API that grows.
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

/* ----------------------------- token verify ----------------------------- */

type Jwk = { kid: string; n: string; e: string; alg: string; kty: string };
let jwkCache: { keys: Jwk[]; expires: number } | null = null;

async function fetchJwks(): Promise<Jwk[]> {
  if (jwkCache && jwkCache.expires > Date.now()) return jwkCache.keys;

  const res = await fetch(GOOGLE_JWK_URL);
  if (!res.ok) throw new Error('could not fetch Google signing keys');

  const body = (await res.json()) as { keys: Jwk[] };
  // Respect the cache lifetime Google advertises rather than refetching per call.
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') ?? '')?.[1];
  jwkCache = {
    keys: body.keys,
    expires: Date.now() + (maxAge ? Number(maxAge) : 3600) * 1000,
  };
  return body.keys;
}

const b64urlToBytes = (input: string): Uint8Array<ArrayBuffer> => {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/**
 * Verifies a Firebase ID token: RS256 signature against Google's published
 * keys, plus issuer/audience/expiry. Returns the uid.
 */
async function verifyIdToken(token: string, projectId: string): Promise<string> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as { kid: string; alg: string };
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as {
    aud: string;
    iss: string;
    sub: string;
    exp: number;
    auth_time?: number;
  };

  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');
  if (payload.aud !== projectId) throw new Error('token audience mismatch');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('token issuer mismatch');
  if (payload.exp * 1000 <= Date.now()) throw new Error('token expired');
  if (!payload.sub) throw new Error('token has no subject');

  const jwk = (await fetchJwks()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) throw new Error('bad token signature');

  return payload.sub;
}

/* ------------------------------- Drive link ------------------------------ */

/**
 * Whether the Drive routes are usable at all.
 *
 * Configuring this is a deliberate act — it puts a Google client secret on the
 * Worker — so the absence of one is treated as "not enabled" rather than as a
 * misconfiguration to complain about.
 */
function driveEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.DRIVE_TOKENS);
}

type GoogleTokens = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function googleToken(env: Env, form: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...form,
    }),
  });
  return (await res.json()) as GoogleTokens;
}

/**
 * A refresh token is not a bearer token for the caller's Drive — it is the
 * whole thing. Keys are namespaced by Firebase uid and only ever read for the
 * uid the request authenticated as, so one student's token cannot be minted
 * with another's session.
 */
const driveKeyFor = (uid: string) => `drive:${uid}`;

async function handleDrive(
  path: string,
  request: Request,
  env: Env,
  uid: string,
  cors: Record<string, string>
): Promise<Response | null> {
  if (!path.startsWith('/drive/')) return null;
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);
  if (!driveEnabled(env)) {
    // 501 rather than 500: the client reads this as "fall back to connecting
    // by hand", which is a working state, not a failure.
    return json({ error: 'drive linking is not enabled on this worker' }, 501, cors);
  }

  if (path === '/drive/link') {
    const body = (await request.json().catch(() => ({}))) as { code?: string; redirectUri?: string };
    if (!body.code) return json({ error: 'missing authorization code' }, 400, cors);

    const tokens = await googleToken(env, {
      code: body.code,
      grant_type: 'authorization_code',
      // 'postmessage' is what the popup code flow uses; there is no redirect.
      redirect_uri: body.redirectUri || 'postmessage',
    });

    if (!tokens.refresh_token) {
      // Google withholds it when the account has already granted consent and
      // the request did not force the dialog. Saying so is more useful than
      // "link failed", because the fix is to re-consent.
      return json(
        {
          error:
            tokens.error_description ??
            tokens.error ??
            'Google did not return a refresh token. Re-run the consent screen.',
        },
        400,
        cors
      );
    }

    // Refuse a grant that is wider than this app has any business holding.
    const granted = (tokens.scope ?? '').split(' ').filter(Boolean);
    if (granted.some((scope) => scope.startsWith('https://www.googleapis.com/auth/drive') && scope !== DRIVE_SCOPE)) {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(tokens.refresh_token)}`, {
        method: 'POST',
      }).catch(() => undefined);
      return json({ error: 'that grant covers more than this app asks for' }, 400, cors);
    }

    await env.DRIVE_TOKENS.put(driveKeyFor(uid), tokens.refresh_token);
    return json(
      {
        linked: true,
        accessToken: tokens.access_token ?? '',
        expiresIn: tokens.expires_in ?? 3600,
      },
      200,
      cors
    );
  }

  if (path === '/drive/token') {
    const refresh = await env.DRIVE_TOKENS.get(driveKeyFor(uid));
    if (!refresh) return json({ error: 'drive is not linked' }, 404, cors);

    const tokens = await googleToken(env, {
      refresh_token: refresh,
      grant_type: 'refresh_token',
    });

    if (!tokens.access_token) {
      // The student revoked access from their Google account page, or the
      // token expired through disuse. Forget it so the app offers to relink
      // rather than retrying a credential that will never work again.
      if (tokens.error === 'invalid_grant') await env.DRIVE_TOKENS.delete(driveKeyFor(uid));
      return json(
        { error: tokens.error_description ?? tokens.error ?? 'could not refresh access' },
        401,
        cors
      );
    }

    return json(
      { accessToken: tokens.access_token, expiresIn: tokens.expires_in ?? 3600 },
      200,
      cors
    );
  }

  if (path === '/drive/unlink') {
    const refresh = await env.DRIVE_TOKENS.get(driveKeyFor(uid));
    if (refresh) {
      // Told to Google as well as forgotten here, so "disconnect" means the
      // grant is gone rather than merely unused.
      await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(refresh)}`, {
        method: 'POST',
      }).catch(() => undefined);
      await env.DRIVE_TOKENS.delete(driveKeyFor(uid));
    }
    return json({ unlinked: true }, 200, cors);
  }

  return json({ error: 'not found' }, 404, cors);
}

/* --------------------------------- main --------------------------------- */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      // Which of driveEnabled()'s three requirements are actually present at
      // runtime. Booleans only — never the values — because this route takes
      // no authentication. Without it a 501 says "one of three things is
      // missing" and leaves you checking two dashboard pages and a CLI to
      // find out which, when the worker knew all along.
      return json(
        {
          ok: true,
          bucket: env.R2_BUCKET,
          drive: {
            clientId: Boolean(env.GOOGLE_CLIENT_ID),
            clientSecret: Boolean(env.GOOGLE_CLIENT_SECRET),
            tokenStore: Boolean(env.DRIVE_TOKENS),
            enabled: driveEnabled(env),
          },
        },
        200,
        cors
      );
    }

    // Profile images are deliberately public, but only objects in the narrow
    // users/{uid}/profile/ namespace can pass this route. Course materials,
    // notes and schedule uploads remain behind Firebase authentication.
    if (url.pathname === '/avatar' && request.method === 'GET') {
      const key = url.searchParams.get('key') ?? '';
      const isProfileImage = /^users\/[A-Za-z0-9_-]{1,128}\/profile\/[A-Za-z0-9._-]{1,120}$/.test(key);
      if (!isProfileImage) return json({ error: 'not found' }, 404, cors);

      const object = await env.MATERIALS.get(key);
      if (!object) return json({ error: 'not found' }, 404, cors);
      const contentType = object.httpMetadata?.contentType ?? '';
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
        return json({ error: 'not found' }, 404, cors);
      }

      const headers = new Headers(cors);
      object.writeHttpMetadata(headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'public, max-age=86400, immutable');
      headers.set('Content-Disposition', 'inline');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(object.body, { status: 200, headers });
    }

    // ---- authenticate -----------------------------------------------------
    const authHeader = request.headers.get('Authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return json({ error: 'missing bearer token' }, 401, cors);

    let uid: string;
    try {
      uid = await verifyIdToken(token, env.FIREBASE_PROJECT_ID);
    } catch (error) {
      return json({ error: `invalid token: ${(error as Error).message}` }, 401, cors);
    }

    // Drive linking is authenticated the same way and scoped to the same uid.
    const driveResponse = await handleDrive(url.pathname, request, env, uid, cors).catch(
      (error: unknown) => json({ error: (error as Error).message }, 500, cors)
    );
    if (driveResponse) return driveResponse;

    // ---- authorize: keys are namespaced by uid ----------------------------
    const prefix = `users/${uid}/`;
    const assertOwned = (key: string | null): key is string =>
      !!key && key.startsWith(prefix) && !key.includes('..');

    try {
      if (url.pathname === '/user-data' && request.method === 'DELETE') {
        let cursor: string | undefined;
        let deleted = 0;
        do {
          const page = await env.MATERIALS.list({ prefix, cursor, limit: 1000 });
          const keys = page.objects.map((object) => object.key);
          if (keys.length) {
            await env.MATERIALS.delete(keys);
            deleted += keys.length;
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);

        return json({ deleted }, 200, cors);
      }

      if (url.pathname === '/object') {
        const key = url.searchParams.get('key');
        if (!assertOwned(key)) return json({ error: 'not your object' }, 403, cors);

        if (request.method === 'PUT') {
          if (!request.body) return json({ error: 'empty upload' }, 400, cors);
          if (key.includes('/profile/')) {
            const contentType = request.headers.get('Content-Type') ?? '';
            const contentLength = Number(request.headers.get('Content-Length') ?? '0');
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
              return json({ error: 'profile images must be JPEG, PNG or WebP' }, 415, cors);
            }
            if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > 2 * 1024 * 1024) {
              return json({ error: 'profile images must be 2 MB or smaller' }, 413, cors);
            }
          }

          const uploaded = await env.MATERIALS.put(key, request.body, {
            httpMetadata: {
              contentType: request.headers.get('Content-Type') || 'application/octet-stream',
            },
          });
          if (!uploaded) return json({ error: 'upload failed' }, 500, cors);

          return json(
            { fileKey: uploaded.key, size: uploaded.size, etag: uploaded.httpEtag },
            200,
            cors
          );
        }

        if (request.method === 'GET') {
          const object = await env.MATERIALS.get(key);
          if (!object) return json({ error: 'not found' }, 404, cors);

          const headers = new Headers(cors);
          object.writeHttpMetadata(headers);
          headers.set('ETag', object.httpEtag);
          headers.set('Cache-Control', 'private, no-store');
          headers.set('Content-Disposition', 'inline');
          return new Response(object.body, { status: 200, headers });
        }

        if (request.method === 'DELETE') {
          await env.MATERIALS.delete(key);
          return json({ deleted: key }, 200, cors);
        }
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (error) {
      return json({ error: (error as Error).message }, 500, cors);
    }
  },
};
