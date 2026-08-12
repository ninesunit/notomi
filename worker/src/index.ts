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
 *
 * Every route requires a Firebase ID token in `Authorization: Bearer <token>`.
 */
export interface Env {
  MATERIALS: R2Bucket;
  R2_BUCKET: string;
  FIREBASE_PROJECT_ID: string;
  /** Comma-separated origins allowed to call this Worker. */
  ALLOWED_ORIGINS: string;
}

const GOOGLE_JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin);

  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : allowed[0] ?? '',
    'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
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

/* --------------------------------- main --------------------------------- */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, bucket: env.R2_BUCKET }, 200, cors);

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

    // ---- authorize: keys are namespaced by uid ----------------------------
    const prefix = `users/${uid}/`;
    const assertOwned = (key: string | null): key is string =>
      !!key && key.startsWith(prefix) && !key.includes('..');

    try {
      if (url.pathname === '/object') {
        const key = url.searchParams.get('key');
        if (!assertOwned(key)) return json({ error: 'not your object' }, 403, cors);

        if (request.method === 'PUT') {
          if (!request.body) return json({ error: 'empty upload' }, 400, cors);

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
