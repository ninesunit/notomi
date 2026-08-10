import { Platform } from 'react-native';
import type { S3Client } from '@aws-sdk/client-s3';
import { getFirebaseAuth } from '@/services/firebase';

/**
 * Cloudflare R2 storage for original study materials.
 *
 * R2 speaks the S3 API, so this is an ordinary S3Client pointed at
 * https://{ACCOUNT_ID}.r2.cloudflarestorage.com with region "auto".
 *
 * Two transports, because where the signing key lives decides which is safe:
 *
 *   broker  (default on web) — the app asks a Cloudflare Worker for a
 *           short-lived presigned URL and PUTs/GETs R2 directly. The R2 secret
 *           lives in Worker secrets and never reaches the browser.
 *
 *   direct  (native / local dev) — this module signs requests itself with
 *           EXPO_PUBLIC_R2_ACCESS_KEY_ID / _SECRET_ACCESS_KEY.
 *
 * Direct mode is refused in a production web build on purpose. Expo inlines
 * every EXPO_PUBLIC_* value into the JavaScript bundle it serves, so shipping
 * the secret that way would hand full read/write/delete on the bucket to
 * anyone who opens the site and reads the source.
 */

export const R2_ACCOUNT_ID = process.env.EXPO_PUBLIC_R2_ACCOUNT_ID ?? '';
export const R2_BUCKET = process.env.EXPO_PUBLIC_R2_BUCKET ?? 'notomi-materials';
export const R2_WORKER_URL = (process.env.EXPO_PUBLIC_R2_WORKER_URL ?? '').replace(/\/$/, '');
export const R2_PUBLIC_BASE = (process.env.EXPO_PUBLIC_R2_PUBLIC_URL ?? '').replace(/\/$/, '');

const R2_ACCESS_KEY_ID = process.env.EXPO_PUBLIC_R2_ACCESS_KEY_ID ?? '';
const R2_SECRET_ACCESS_KEY = process.env.EXPO_PUBLIC_R2_SECRET_ACCESS_KEY ?? '';

export const R2_ENDPOINT = R2_ACCOUNT_ID
  ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  : '';

export type R2Mode = 'broker' | 'direct' | 'unconfigured';

export class R2Error extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'R2Error';
  }
}

const isWeb = Platform.OS === 'web';
const isDevBuild = __DEV__;

export function r2Mode(): R2Mode {
  if (R2_WORKER_URL) return 'broker';
  if (R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    // Signing in the client is only acceptable where the credential is not
    // being served to the public.
    if (isWeb && !isDevBuild) return 'unconfigured';
    return 'direct';
  }
  return 'unconfigured';
}

export function isR2Configured(): boolean {
  return r2Mode() !== 'unconfigured';
}

/** Explains precisely what is missing, so setup is not a guessing game. */
export function r2ConfigHint(): string {
  if (R2_WORKER_URL) return '';
  if (isWeb && !isDevBuild && R2_ACCESS_KEY_ID) {
    return (
      'R2 keys are present but refused in a production web build: EXPO_PUBLIC_* values ship ' +
      'inside the bundle, so the bucket secret would be public. Deploy the Worker in worker/ ' +
      'and set EXPO_PUBLIC_R2_WORKER_URL instead.'
    );
  }
  return (
    'R2 is not configured. Set EXPO_PUBLIC_R2_WORKER_URL to your deployed Worker (recommended), ' +
    'or EXPO_PUBLIC_R2_ACCOUNT_ID + EXPO_PUBLIC_R2_ACCESS_KEY_ID + EXPO_PUBLIC_R2_SECRET_ACCESS_KEY ' +
    'for local development.'
  );
}

/* ------------------------------------------------------------------ *
 * Direct S3 client
 * ------------------------------------------------------------------ */

let clientRef: S3Client | null = null;

/**
 * The S3 SDK is ~700KB and is only needed in direct mode, which production web
 * builds refuse. Loading it lazily keeps it out of the bundle every student
 * downloads; broker mode uses plain fetch against a presigned URL.
 */
async function s3(): Promise<S3Client> {
  const { S3Client: Client } = await import('@aws-sdk/client-s3');
  if (!clientRef) {
    clientRef = new Client({
      region: 'auto',
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return clientRef;
}

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

/** Object key layout: users/{userId}/{subjectId}/{fileName}. */
export function buildFileKey(userId: string, subjectId: string, fileName: string): string {
  const safe = fileName.replace(/[^\w.\-]+/g, '_').slice(-100);
  return `users/${userId}/${subjectId}/${Date.now()}-${safe}`;
}

async function idToken(): Promise<string> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new R2Error('You must be signed in to upload materials.');
  return user.getIdToken();
}

async function brokerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await idToken();
  const res = await fetch(`${R2_WORKER_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new R2Error(`Storage broker returned ${res.status}. ${detail.slice(0, 200)}`);
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * Upload
 * ------------------------------------------------------------------ */

export type UploadResult = { fileKey: string; fileUrl: string };

/**
 * Uploads the original binary to R2 at users/{userId}/{subjectId}/{fileName}.
 *
 * `fileUri` accepts a blob/file URI (web) or a filesystem URI (native); the
 * bytes are read here so both platforms take the same path.
 */
export async function uploadFileToR2(
  fileUri: string,
  fileName: string,
  userId: string,
  subjectId: string,
  contentType = 'application/octet-stream',
  bytes?: ArrayBuffer
): Promise<UploadResult> {
  const mode = r2Mode();
  if (mode === 'unconfigured') throw new R2Error(r2ConfigHint());

  const body = bytes ?? (await (await fetch(fileUri)).arrayBuffer());
  const fileKey = buildFileKey(userId, subjectId, fileName);

  if (mode === 'broker') {
    // Ask the Worker to presign a PUT, then send the bytes straight to R2 so
    // the file never transits the Worker.
    const signed = await brokerFetch('/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileKey, contentType, subjectId }),
    });
    const { uploadUrl } = (await signed.json()) as { uploadUrl: string };

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(body),
    });
    if (!put.ok) {
      throw new R2Error(`R2 rejected the upload (${put.status}). Check the bucket CORS policy.`);
    }
  } else {
    try {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const client = await s3();
      await client.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: fileKey,
          Body: new Uint8Array(body),
          ContentType: contentType,
        })
      );
    } catch (error) {
      throw new R2Error(describe(error), error);
    }
  }

  return { fileKey, fileUrl: await getR2FileUrl(fileKey) };
}

/* ------------------------------------------------------------------ *
 * Read URL
 * ------------------------------------------------------------------ */

/**
 * A URL for viewing an uploaded material. Uses the bucket's public base when
 * one is configured, otherwise a short-lived presigned GET.
 */
export async function getR2FileUrl(fileKey: string, expiresInSeconds = 3600): Promise<string> {
  if (R2_PUBLIC_BASE) return `${R2_PUBLIC_BASE}/${fileKey}`;

  const mode = r2Mode();
  if (mode === 'unconfigured') throw new R2Error(r2ConfigHint());

  if (mode === 'broker') {
    const res = await brokerFetch(
      `/presign-download?key=${encodeURIComponent(fileKey)}&expires=${expiresInSeconds}`
    );
    const { downloadUrl } = (await res.json()) as { downloadUrl: string };
    return downloadUrl;
  }

  try {
    const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([
      import('@aws-sdk/client-s3'),
      import('@aws-sdk/s3-request-presigner'),
    ]);
    return await getSignedUrl(
      await s3(),
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: fileKey }),
      { expiresIn: expiresInSeconds }
    );
  } catch (error) {
    throw new R2Error(describe(error), error);
  }
}

/* ------------------------------------------------------------------ *
 * Delete
 * ------------------------------------------------------------------ */

export async function deleteR2File(fileKey: string): Promise<void> {
  const mode = r2Mode();
  if (mode === 'unconfigured') return;

  if (mode === 'broker') {
    await brokerFetch(`/object?key=${encodeURIComponent(fileKey)}`, { method: 'DELETE' });
    return;
  }

  try {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await s3();
    await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: fileKey }));
  } catch (error) {
    throw new R2Error(describe(error), error);
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/CORS|Failed to fetch|NetworkError/i.test(message)) {
    return `R2 refused the browser request. Add this origin to the bucket's CORS policy. (${message})`;
  }
  if (/SignatureDoesNotMatch|InvalidAccessKeyId/i.test(message)) {
    return 'R2 credentials are wrong. Check the access key id and secret.';
  }
  if (/NoSuchBucket/i.test(message)) return `R2 bucket "${R2_BUCKET}" does not exist.`;
  return message;
}
