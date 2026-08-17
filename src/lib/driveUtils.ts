import { Platform } from 'react-native';

/**
 * Google Drive, entirely from the browser.
 *
 * Student files are large and numerous, and nobody's free tier survives being
 * the middleman for them. So Notomi never touches the bytes: the browser talks
 * straight to Google, and what comes back here is an id. No bandwidth, no
 * storage, no server.
 *
 * The scope is drive.file and only drive.file. Notomi can see what it created
 * and what the student hands it through the picker — never the rest of their
 * Drive. That single choice has a consequence worth stating loudly, because it
 * shapes the whole folder design: **a drive.file app cannot search for folders
 * it did not create.** Asking Drive "is there a Notomi Workspace folder?"
 * returns nothing useful. Folder ids are therefore remembered in Firestore and
 * verified before use, never discovered by name.
 *
 * Nothing here is persisted that shouldn't be. The access token lives in a
 * module variable for its hour and is never written to storage, so a shared
 * computer keeps no key to anyone's Drive.
 */

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/**
 * The OAuth client Firebase Auth already registered for Google sign-in. It
 * carries the right authorised origins, so there is no second client to keep
 * in step.
 */
export const DRIVE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? '';

/** Browser API key, used only as the Picker's developer key. */
export const DRIVE_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_API_KEY ?? '';

/**
 * The Picker needs the project number to hand a drive.file app access to what
 * the student selects. Firebase's messaging sender id *is* the project number,
 * so this costs no extra configuration in the normal case.
 */
export const DRIVE_APP_ID =
  process.env.EXPO_PUBLIC_GOOGLE_APP_ID ||
  process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ||
  '';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const PICKER_SRC = 'https://apis.google.com/js/api.js';

export const WORKSPACE_FOLDER_NAME = 'Notomi Workspace';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Above this, a single POST is a bad bet; use a resumable session instead. */
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;

/** Renewed a minute early, so a token cannot expire mid-upload. */
const EXPIRY_MARGIN_MS = 60_000;

export function isDriveConfigured(): boolean {
  return Platform.OS === 'web' && DRIVE_CLIENT_ID.length > 0;
}

/** What is missing, in words a student could act on. */
export function driveConfigHint(): string {
  if (Platform.OS !== 'web') return 'Drive is available in the browser app.';
  if (!DRIVE_CLIENT_ID) return 'Drive is not set up for this build.';
  if (!DRIVE_API_KEY) return 'Drive uploads work, but importing needs more setup.';
  return '';
}

export class DriveError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ *
 * Script loading
 * ------------------------------------------------------------------ */

const scripts = new Map<string, Promise<void>>();

/** Loads a Google script once, and hands every later caller the same promise. */
function loadScript(src: string): Promise<void> {
  if (Platform.OS !== 'web') return Promise.reject(new DriveError('Not a browser.'));

  const existing = scripts.get(src);
  if (existing) return existing;

  const pending = new Promise<void>((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.async = true;
    tag.defer = true;
    tag.onload = () => resolve();
    tag.onerror = () => {
      // A failed load must not be cached, or a flaky connection would disable
      // Drive for the rest of the session.
      scripts.delete(src);
      reject(new DriveError('Could not reach Google. Check your connection.'));
    };
    document.head.appendChild(tag);
  });

  scripts.set(src, pending);
  return pending;
}

/* ------------------------------------------------------------------ *
 * Access tokens
 * ------------------------------------------------------------------ */

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type TokenClient = { requestAccessToken: (options?: { prompt?: string }) => void };

let tokenClient: TokenClient | null = null;
/** Memory only, deliberately. Nothing is left behind on a shared machine. */
let accessToken: string | null = null;
let expiresAt = 0;
let inFlight: Promise<string> | null = null;

declare global {
  interface Window {
    google?: any;
    gapi?: any;
  }
}

function tokenIsLive(): boolean {
  return Boolean(accessToken) && Date.now() < expiresAt - EXPIRY_MARGIN_MS;
}

export function isDriveConnected(): boolean {
  return tokenIsLive();
}

export function disconnectDrive(): void {
  const token = accessToken;
  accessToken = null;
  expiresAt = 0;
  // Best effort: revoking is a courtesy to the student, and a failure here
  // must not stop the local session being forgotten.
  if (token && Platform.OS === 'web') {
    try {
      window.google?.accounts?.oauth2?.revoke?.(token, () => undefined);
    } catch {
      /* Already gone. */
    }
  }
}

async function ensureTokenClient(): Promise<TokenClient> {
  if (tokenClient) return tokenClient;
  await loadScript(GIS_SRC);

  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new DriveError('Google sign-in did not load.');

  // The callback is rebound per request; this instance is only the transport.
  tokenClient = oauth2.initTokenClient({
    client_id: DRIVE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: () => undefined,
  }) as TokenClient;
  return tokenClient;
}

/**
 * A live access token.
 *
 * Tries silently first. Google only answers a silent request when the student
 * has already granted the scope and still has a session, which is the common
 * case after the first time — so consent is asked for once, not every hour.
 */
export async function getAccessToken(interactive = false): Promise<string> {
  if (!isDriveConfigured()) throw new DriveError(driveConfigHint());
  if (tokenIsLive()) return accessToken as string;
  // Concurrent uploads must not each open their own consent popup.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const client = await ensureTokenClient();

    const request = (prompt: string) =>
      new Promise<string>((resolve, reject) => {
        (client as any).callback = (response: TokenResponse) => {
          if (response.access_token) {
            accessToken = response.access_token;
            expiresAt = Date.now() + (response.expires_in ?? 3600) * 1000;
            resolve(response.access_token);
            return;
          }
          reject(
            new DriveError(
              response.error === 'access_denied'
                ? 'Notomi was not given access to your Drive.'
                : (response.error_description ?? 'Google did not return access.')
            )
          );
        };
        try {
          client.requestAccessToken({ prompt });
        } catch (caught) {
          reject(caught instanceof Error ? caught : new DriveError(String(caught)));
        }
      });

    if (interactive) return request('consent');

    try {
      return await request('');
    } catch {
      // Silent renewal failed — the student has to see the dialog.
      return request('consent');
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Opens the consent dialog. Call this from a real tap: popups need one. */
export async function connectDrive(): Promise<void> {
  await getAccessToken(true);
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

async function driveFetch(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await getAccessToken();
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });

  // A token revoked in another tab reads as 401. Re-ask once, then give up.
  if (response.status === 401 && retry) {
    accessToken = null;
    expiresAt = 0;
    return driveFetch(url, init, false);
  }

  return response;
}

async function driveJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await driveFetch(url, init);
  if (!response.ok) throw await driveError(response);
  return (await response.json()) as T;
}

async function driveError(response: Response): Promise<DriveError> {
  let detail = '';
  let reason = '';
  try {
    const body = await response.json();
    detail = body?.error?.message ?? '';
    reason = body?.error?.errors?.[0]?.reason ?? '';
  } catch {
    /* Not every failure has a JSON body. */
  }

  // Two different 403s that must never be confused: a full Drive is fixed by
  // deleting something, a rate limit by waiting. Telling a student to wait
  // while their Drive is full leaves them stuck for good.
  if (
    response.status === 403 &&
    (reason === 'storageQuotaExceeded' || /storage quota|drive storage/i.test(detail))
  ) {
    return new DriveError('Your Google Drive is full. Free up space and try again.', 403);
  }
  if (
    (response.status === 403 || response.status === 429) &&
    (/rateLimit|userRateLimit/i.test(reason) || /rate limit/i.test(detail))
  ) {
    return new DriveError('Google is rate limiting this account. Try again shortly.', 403);
  }
  if (response.status === 403) {
    return new DriveError(detail || 'Google refused that request.', 403);
  }
  if (response.status === 404) {
    return new DriveError('That file is no longer in Drive.', 404);
  }
  return new DriveError(detail || `Drive returned ${response.status}.`, response.status);
}

/* ------------------------------------------------------------------ *
 * The key scheme
 * ------------------------------------------------------------------ */

/**
 * Drive ids are stored in the same string fields R2 keys already use, marked
 * with a prefix. R2 keys have no prefix, so every existing record keeps
 * resolving exactly as it did — which is what lets the canvas learn about
 * Drive in two lines instead of a migration.
 */
export const DRIVE_KEY_PREFIX = 'gdrive:';

export function driveKey(fileId: string): string {
  return `${DRIVE_KEY_PREFIX}${fileId}`;
}

export function isDriveKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(DRIVE_KEY_PREFIX);
}

export function parseDriveKey(key: string | null | undefined): string | null {
  return isDriveKey(key) ? (key as string).slice(DRIVE_KEY_PREFIX.length) : null;
}

/* ------------------------------------------------------------------ *
 * Folders
 * ------------------------------------------------------------------ */

export type DriveFolderStore = {
  /** The id remembered from last time, if any. */
  read: () => Promise<string | null>;
  /** Called only when a folder had to be created. */
  write: (folderId: string) => Promise<void>;
};

/** Confirms a remembered folder is still there and not in the bin. */
async function folderIsUsable(folderId: string): Promise<boolean> {
  try {
    const found = await driveJson<{ id: string; trashed?: boolean }>(
      `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,trashed`
    );
    return Boolean(found.id) && found.trashed !== true;
  } catch (caught) {
    if (caught instanceof DriveError && (caught.status === 404 || caught.status === 403)) {
      return false;
    }
    throw caught;
  }
}

async function createFolder(name: string, parentId?: string): Promise<string> {
  const created = await driveJson<{ id: string }>(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  return created.id;
}

/**
 * Finds or creates a folder, remembering the answer.
 *
 * The remembered id is the source of truth because searching cannot be: under
 * drive.file, a name query only ever returns folders this app made, so a
 * student who empties their bin would otherwise strand every later upload.
 * Search is still worth one attempt as a repair step — it recovers the folder
 * when Firestore lost the id but Drive kept the folder.
 */
export async function ensureFolder(
  name: string,
  store: DriveFolderStore,
  parentId?: string
): Promise<string> {
  const remembered = await store.read();
  if (remembered && (await folderIsUsable(remembered))) return remembered;

  const escaped = name.replace(/'/g, "\\'");
  const query = [
    `name='${escaped}'`,
    `mimeType='${FOLDER_MIME}'`,
    'trashed=false',
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ].join(' and ');

  try {
    const found = await driveJson<{ files?: { id: string }[] }>(
      `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1&spaces=drive`
    );
    const existing = found.files?.[0]?.id;
    if (existing) {
      await store.write(existing);
      return existing;
    }
  } catch {
    // Search is the optimisation, not the mechanism. Fall through and create.
  }

  const created = await createFolder(name, parentId);
  await store.write(created);
  return created;
}

/* ------------------------------------------------------------------ *
 * Uploading
 * ------------------------------------------------------------------ */

export type DriveFile = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  webViewLink: string | null;
};

const UPLOAD_FIELDS = 'id,name,mimeType,size,webViewLink';

function toDriveFile(raw: {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string | number;
  webViewLink?: string;
}): DriveFile {
  return {
    fileId: raw.id,
    name: raw.name ?? 'Untitled',
    mimeType: raw.mimeType ?? 'application/octet-stream',
    size: Number(raw.size ?? 0) || 0,
    webViewLink: raw.webViewLink ?? null,
  };
}

/** One request carrying metadata and bytes together. Good below a few MB. */
async function uploadMultipart(
  blob: Blob,
  name: string,
  mimeType: string,
  folderId: string
): Promise<DriveFile> {
  const boundary = `notomi${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const metadata = { name, parents: [folderId] };

  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--\r\n`,
  ]);

  const response = await driveFetch(
    `${DRIVE_UPLOAD}?uploadType=multipart&fields=${UPLOAD_FIELDS}`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!response.ok) throw await driveError(response);
  return toDriveFile(await response.json());
}

/**
 * Two steps: open a session, then send the bytes to it.
 *
 * Larger files justify the extra round trip — the session url can be retried
 * without re-sending what already arrived, and a big single POST that fails
 * halfway has to start over.
 */
async function uploadResumable(
  blob: Blob,
  name: string,
  mimeType: string,
  folderId: string
): Promise<DriveFile> {
  const start = await driveFetch(
    `${DRIVE_UPLOAD}?uploadType=resumable&fields=${UPLOAD_FIELDS}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify({ name, parents: [folderId] }),
    }
  );
  if (!start.ok) throw await driveError(start);

  const session = start.headers.get('Location');
  if (!session) throw new DriveError('Google did not open an upload session.');

  // The session url carries its own authorisation; no bearer token needed.
  const sent = await fetch(session, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: blob,
  });
  if (!sent.ok) throw await driveError(sent);
  return toDriveFile(await sent.json());
}

export async function uploadToDrive(
  blob: Blob,
  name: string,
  mimeType: string,
  folderId: string
): Promise<DriveFile> {
  const type = mimeType || blob.type || 'application/octet-stream';
  return blob.size >= RESUMABLE_THRESHOLD
    ? uploadResumable(blob, name, type, folderId)
    : uploadMultipart(blob, name, type, folderId);
}

export type UploadProgress = {
  /** 1-based, so it reads as "2 of 5" without arithmetic at the call site. */
  index: number;
  total: number;
  name: string;
  phase: 'uploading' | 'done' | 'failed';
};

export type BulkUploadResult = {
  uploaded: DriveFile[];
  failed: { name: string; message: string }[];
};

/**
 * Uploads a batch one at a time.
 *
 * Sequential on purpose: parallel uploads from a phone on campus wifi trip
 * Drive's per-user rate limit, and the failure mode is a confusing partial
 * batch rather than a slower one. One file failing does not stop the rest.
 */
export async function uploadManyToDrive(
  files: { blob: Blob; name: string; mimeType: string }[],
  folderId: string,
  onProgress?: (progress: UploadProgress) => void
): Promise<BulkUploadResult> {
  const uploaded: DriveFile[] = [];
  const failed: { name: string; message: string }[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const entry = files[index];
    const step = (phase: UploadProgress['phase']) =>
      onProgress?.({ index: index + 1, total: files.length, name: entry.name, phase });

    step('uploading');
    try {
      uploaded.push(await uploadToDrive(entry.blob, entry.name, entry.mimeType, folderId));
      step('done');
    } catch (caught) {
      failed.push({
        name: entry.name,
        message: caught instanceof Error ? caught.message : String(caught),
      });
      step('failed');
    }
  }

  return { uploaded, failed };
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/** The raw bytes, for anything that renders a file rather than links to it. */
export async function fetchDriveBlob(fileId: string): Promise<Blob> {
  const response = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`
  );
  if (!response.ok) throw await driveError(response);
  return response.blob();
}

/**
 * Looks for a file this app already put in a folder.
 *
 * Search is normally useless under drive.file, but not here: these are files
 * Notomi created, so it can see them. That makes it the resume point for a
 * migration interrupted between the upload and the record of it — without this
 * check, closing the tab at the wrong moment leaves a second copy behind.
 */
export async function findInFolder(folderId: string, name: string): Promise<DriveFile | null> {
  const escaped = name.replace(/'/g, "\\'");
  const query = `name='${escaped}' and '${folderId}' in parents and trashed=false`;

  try {
    const found = await driveJson<{ files?: { id: string }[] }>(
      `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(${UPLOAD_FIELDS})&pageSize=1&spaces=drive`
    );
    const first = found.files?.[0];
    return first ? toDriveFile(first as Parameters<typeof toDriveFile>[0]) : null;
  } catch {
    // Treated as "not there": re-uploading is recoverable, refusing is not.
    return null;
  }
}

export async function getDriveFileMeta(fileId: string): Promise<DriveFile | null> {
  try {
    return toDriveFile(
      await driveJson(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${UPLOAD_FIELDS}`
      )
    );
  } catch (caught) {
    if (caught instanceof DriveError && caught.status === 404) return null;
    throw caught;
  }
}

/** Removes a file Notomi put there. Never touches anything it did not create. */
export async function deleteDriveFile(fileId: string): Promise<void> {
  const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
  });
  // Already gone is the outcome we wanted.
  if (!response.ok && response.status !== 404) throw await driveError(response);
}

/* ------------------------------------------------------------------ *
 * The Picker
 * ------------------------------------------------------------------ */

export const PICKER_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
];

async function ensurePicker(): Promise<void> {
  await loadScript(PICKER_SRC);
  if (window.google?.picker) return;

  await new Promise<void>((resolve, reject) => {
    if (!window.gapi) {
      reject(new DriveError('Google APIs did not load.'));
      return;
    }
    window.gapi.load('picker', {
      callback: () => resolve(),
      onerror: () => reject(new DriveError('The Google picker did not load.')),
    });
  });
}

/**
 * The student's own file browser, run by Google.
 *
 * This is the only way a drive.file app can reach a file it did not create:
 * picking one is the grant. The app id matters — without it Google has no way
 * to extend access to this app, and every later read of the chosen file fails
 * with a 404 that looks like a bug.
 */
export async function pickFromDrive(
  options: { mimeTypes?: string[]; multiple?: boolean } = {}
): Promise<DriveFile[]> {
  if (!isDriveConfigured()) throw new DriveError(driveConfigHint());
  if (!DRIVE_API_KEY) {
    throw new DriveError('Importing from Drive is not set up for this build.');
  }

  const token = await getAccessToken();
  await ensurePicker();
  const picker = window.google.picker;

  return new Promise<DriveFile[]>((resolve, reject) => {
    try {
      const view = new picker.DocsView(picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)
        .setMimeTypes((options.mimeTypes ?? PICKER_MIME_TYPES).join(','));

      const builder = new picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(DRIVE_API_KEY)
        .addView(view)
        .setCallback((data: any) => {
          if (data.action === picker.Action.PICKED) {
            resolve(
              (data.docs ?? []).map((doc: any) =>
                toDriveFile({
                  id: doc.id,
                  name: doc.name,
                  mimeType: doc.mimeType,
                  size: doc.sizeBytes,
                  webViewLink: doc.url,
                })
              )
            );
          } else if (data.action === picker.Action.CANCEL) {
            // Closing the picker is an ordinary choice, not a failure.
            resolve([]);
          }
        });

      if (DRIVE_APP_ID) builder.setAppId(DRIVE_APP_ID);
      if (options.multiple !== false) {
        builder.enableFeature(picker.Feature.MULTISELECT_ENABLED);
      }

      builder.build().setVisible(true);
    } catch (caught) {
      reject(caught instanceof Error ? caught : new DriveError(String(caught)));
    }
  });
}
