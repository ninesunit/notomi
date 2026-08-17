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
 *   broker  (default on web) — the app sends authenticated requests to a
 *           Cloudflare Worker whose R2 binding reads and writes the bucket.
 *           No R2 access key exists in the browser or Worker configuration.
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
export const PROFILE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const PROFILE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
  bytes?: ArrayBuffer,
  resolveFileUrl = true
): Promise<UploadResult> {
  const mode = r2Mode();
  if (mode === 'unconfigured') throw new R2Error(r2ConfigHint());

  const body = bytes ?? (await (await fetch(fileUri)).arrayBuffer());
  const fileKey = buildFileKey(userId, subjectId, fileName);

  // Keep the caller's buffer reusable. Browser APIs and PDF workers are
  // allowed to transfer ArrayBuffers; an owned upload copy prevents a later
  // stage (or a retry) from observing detached storage.
  const uploadBytes = new Uint8Array(body.byteLength);
  uploadBytes.set(new Uint8Array(body));

  if (mode === 'broker') {
    await brokerFetch(`/object?key=${encodeURIComponent(fileKey)}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: uploadBytes,
    });
  } else {
    try {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const client = await s3();
      await client.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: fileKey,
          Body: uploadBytes,
          ContentType: contentType,
        })
      );
    } catch (error) {
      throw new R2Error(describe(error), error);
    }
  }

  return { fileKey, fileUrl: resolveFileUrl ? await getR2FileUrl(fileKey) : '' };
}

export async function uploadProfileImage(
  fileUri: string,
  fileName: string,
  userId: string,
  contentType: string,
  bytes: ArrayBuffer
): Promise<UploadResult> {
  if (!R2_PUBLIC_BASE && !R2_WORKER_URL) {
    throw new R2Error('Profile image hosting is not configured for this build.');
  }
  if (!PROFILE_IMAGE_TYPES.has(contentType)) {
    throw new R2Error('Choose a JPEG, PNG or WebP profile image.');
  }
  if (bytes.byteLength > PROFILE_IMAGE_MAX_BYTES) {
    throw new R2Error('Profile images must be 2 MB or smaller.');
  }
  const uploaded = await uploadFileToR2(
    fileUri,
    fileName,
    userId,
    'profile',
    contentType,
    bytes,
    false
  );
  const fileUrl = R2_PUBLIC_BASE
    ? `${R2_PUBLIC_BASE}/${uploaded.fileKey}`
    : `${R2_WORKER_URL}/avatar?key=${encodeURIComponent(uploaded.fileKey)}`;
  return { ...uploaded, fileUrl };
}

/* ------------------------------------------------------------------ *
 * Read URL
 * ------------------------------------------------------------------ */

/**
 * The bytes of a stored original, without minting a URL for them.
 *
 * `getR2FileUrl` exists to put something in an `<iframe src>`, and in broker
 * mode it does that by creating an object URL that stays alive for an hour so
 * the viewer can still load it. That is right for viewing one file and wrong
 * for reading several hundred in a loop: the migration only wants the bytes,
 * and every object URL it never revoked held its blob in memory until the tab
 * ran out. Anything reading a file to re-upload it should call this instead.
 */
export async function r2FileBlob(fileKey: string): Promise<Blob> {
  if (R2_PUBLIC_BASE) {
    const res = await fetch(`${R2_PUBLIC_BASE}/${fileKey}`);
    if (!res.ok) throw new R2Error(`The original could not be read (${res.status}).`);
    return res.blob();
  }

  const mode = r2Mode();
  if (mode === 'unconfigured') throw new R2Error(r2ConfigHint());

  if (mode === 'broker') {
    const res = await brokerFetch(`/object?key=${encodeURIComponent(fileKey)}`);
    return res.blob();
  }

  // Direct mode signs a GET; the URL is used once and dropped.
  const url = await getR2FileUrl(fileKey, 300);
  const res = await fetch(url);
  if (!res.ok) throw new R2Error(`The original could not be read (${res.status}).`);
  return res.blob();
}

/**
 * A URL for viewing an uploaded material. Uses the bucket's public base when
 * one is configured, otherwise a short-lived presigned GET.
 */
export async function getR2FileUrl(fileKey: string, expiresInSeconds = 3600): Promise<string> {
  if (R2_PUBLIC_BASE) return `${R2_PUBLIC_BASE}/${fileKey}`;

  const mode = r2Mode();
  if (mode === 'unconfigured') throw new R2Error(r2ConfigHint());

  if (mode === 'broker') {
    const res = await brokerFetch(`/object?key=${encodeURIComponent(fileKey)}`);
    const blob = await res.blob();

    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const objectUrl = URL.createObjectURL(blob);
      setTimeout(() => URL.revokeObjectURL(objectUrl), Math.max(60, expiresInSeconds) * 1000);
      return objectUrl;
    }

    if (typeof FileReader !== 'undefined') {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new R2Error('Could not open the stored original.'));
        reader.readAsDataURL(blob);
      });
    }

    throw new R2Error('Opening stored originals is not supported on this platform.');
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

/** Deletes every original owned by the current user (guest-session cleanup). */
export async function deleteR2UserData(): Promise<void> {
  const mode = r2Mode();
  if (mode === 'unconfigured') return;
  if (mode !== 'broker') {
    // Direct browser credentials deliberately cannot list the whole bucket.
    // Production uses the authenticated broker, where ownership is enforced.
    return;
  }
  await brokerFetch('/user-data', { method: 'DELETE' });
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
