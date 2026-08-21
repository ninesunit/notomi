import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { paths } from '@/lib/paths';
import type { StorageProvider, Subject } from '@/lib/schema';
import {
  DriveError,
  WORKSPACE_FOLDER_NAME,
  deleteDriveFile,
  driveKey,
  ensureFolder,
  fetchDriveBlob,
  isDriveConfigured,
  isDriveConnected,
  isDriveLinked,
  parseDriveKey,
  uploadToDrive,
  type DriveFile,
  type DriveFolderStore,
} from '@/lib/driveUtils';
import { getDb } from '@/services/firebase';
import { getR2FileUrl } from '@/services/r2Storage';

/**
 * Where Drive meets Notomi's own records.
 *
 * driveUtils knows Google and nothing else; this file knows that a course is a
 * subject, that folder ids belong in Firestore, and that R2 is still the
 * fallback when a student has not connected their Drive. Keeping the two apart
 * means the Google half can be tested without a database and the storage
 * decision lives in one readable place.
 */

/* ------------------------------------------------------------------ *
 * Remembering folders
 * ------------------------------------------------------------------ */

/** The workspace folder id, kept on the user document. */
function workspaceStore(uid: string): DriveFolderStore {
  const reference = paths.user(getDb(), uid);
  return {
    read: async () => {
      const snapshot = await getDoc(reference);
      const value = snapshot.data()?.driveRootFolderId;
      return typeof value === 'string' && value ? value : null;
    },
    // merge, because the user document is shared with unrelated settings.
    write: async (folderId) => {
      await setDoc(reference, { driveRootFolderId: folderId }, { merge: true });
    },
  };
}

/** "Notomi Workspace" at the root of the student's Drive. */
export async function ensureWorkspaceFolder(uid: string): Promise<string> {
  return ensureFolder(WORKSPACE_FOLDER_NAME, workspaceStore(uid));
}

/**
 * "Notomi Workspace / CPT6123", created on demand.
 *
 * Named by course code where there is one, because that is what a student
 * scanning their own Drive will look for. The subject is read once and used
 * for both the remembered folder id and the name, so adding Drive costs a
 * single extra read per upload batch rather than one per file.
 */
export async function ensureCourseFolder(uid: string, subjectId: string): Promise<string> {
  const reference = paths.subject(getDb(), uid, subjectId);
  const snapshot = await getDoc(reference);
  const subject = snapshot.data() as Subject | undefined;

  const cached =
    typeof subject?.driveFolderId === 'string' && subject.driveFolderId
      ? subject.driveFolderId
      : null;
  const name = (subject?.moduleCode || subject?.name || 'Course').trim();

  const root = await ensureWorkspaceFolder(uid);
  return ensureFolder(
    name,
    {
      read: async () => cached,
      write: async (folderId) => {
        await updateDoc(reference, { driveFolderId: folderId });
      },
    },
    root
  );
}

/* ------------------------------------------------------------------ *
 * Storing an original
 * ------------------------------------------------------------------ */

export type StoredOriginal = {
  /** Where the bytes went, or 'none' when nothing kept them. */
  target: 'drive' | 'none';
  driveFileId: string;
  /** The canvas and reader resolve originals through this one string. */
  sourceKey: string;
  webViewLink: string | null;
};

/**
 * Whether an upload should go to Drive.
 *
 * Deliberately asks whether the student has *linked* Drive, not whether a token
 * happens to be live this second. Tokens last an hour and are never written
 * down, so a check for a live one would quietly send a student's afternoon
 * uploads to the shared bucket instead — which is exactly the outcome linking
 * Drive was meant to prevent. A stale token is a thing to renew, not a reason
 * to store their files somewhere else.
 */
export function canUseDrive(): boolean {
  return isDriveConfigured() && (isDriveConnected() || isDriveLinked());
}

/**
 * Puts one original in the student's Drive.
 *
 * Deliberately does not fall back to R2 itself — the caller owns that choice,
 * and burying it here would make a failed Drive upload look like a success
 * with a different receipt.
 */
export async function storeOriginalInDrive(
  uid: string,
  subjectId: string,
  file: { blob: Blob; name: string; mimeType: string }
): Promise<StoredOriginal> {
  const folderId = await ensureCourseFolder(uid, subjectId);
  const uploaded = await uploadToDrive(file.blob, file.name, file.mimeType, folderId);
  return {
    target: 'drive',
    driveFileId: uploaded.fileId,
    sourceKey: driveKey(uploaded.fileId),
    webViewLink: uploaded.webViewLink,
  };
}

/* ------------------------------------------------------------------ *
 * Reading an original back
 * ------------------------------------------------------------------ */

/**
 * The bytes behind a stored key, whichever service holds them.
 *
 * Returns null for keys this module does not own, so callers can hand a key
 * here first and keep their existing path for everything else. That is what
 * lets Drive reach the canvas without rewriting how the canvas loads files.
 */
export async function blobFromDriveKey(key: string | null | undefined): Promise<Blob | null> {
  const fileId = parseDriveKey(key);
  if (!fileId) return null;
  return fetchDriveBlob(fileId);
}

/**
 * Where a document's original actually is, in one place.
 *
 * The rule — Drive if there is a Drive id, otherwise R2, otherwise nowhere —
 * used to be written out separately everywhere it was needed, which is three
 * chances for them to drift apart. It reads the recorded field when there is
 * one and falls back to the ids for documents saved before that field existed,
 * so no backfill is required and both kinds answer the same.
 */
export function storageOf(document: {
  storageProvider?: StorageProvider | null;
  driveFileId?: string | null;
  r2FileKey?: string | null;
}): StorageProvider {
  if (document.storageProvider) return document.storageProvider;
  if (document.driveFileId) return 'google_drive';
  return document.r2FileKey ? 'r2' : 'none';
}

/** How a student should hear it. */
export const STORAGE_LABELS: Record<StorageProvider, string> = {
  google_drive: 'Your Google Drive',
  r2: 'Notomi storage',
  none: 'Not stored',
};

/** A document's original, as the fields actually recorded on it. */
export function sourceKeyOf(document: {
  storageProvider?: StorageProvider | null;
  driveFileId?: string | null;
  r2FileKey?: string | null;
}): string {
  return storageOf(document) === 'google_drive'
    ? driveKey(document.driveFileId as string)
    : (document.r2FileKey ?? '');
}

/**
 * The bytes of a stored original, from wherever it lives.
 *
 * A Drive document's `r2FileUrl` holds its *view* link — a Google web page, not
 * the file — so anything that needs the actual bytes has to ask Drive for them
 * rather than fetch that url and get HTML back. Returns null when nothing kept
 * the original, which every caller already has to handle.
 */
export async function originalBytes(document: {
  storageProvider?: StorageProvider | null;
  driveFileId?: string | null;
  r2FileKey?: string | null;
  r2FileUrl?: string | null;
}): Promise<Blob | null> {
  if (storageOf(document) === 'google_drive') {
    return fetchDriveBlob(document.driveFileId as string).catch(() => null);
  }

  const url = document.r2FileKey
    ? await getR2FileUrl(document.r2FileKey).catch(() => '')
    : (document.r2FileUrl ?? '');
  if (!url) return null;

  const response = await fetch(url).catch(() => null);
  return response?.ok ? response.blob() : null;
}

/* ------------------------------------------------------------------ *
 * Removing what Notomi put there
 * ------------------------------------------------------------------ */

/**
 * Deletes a document's original from Drive, if that is where it lives.
 *
 * Best effort on purpose: a student deleting a file in Notomi is telling us
 * their intent, and a Drive that is offline, full or disconnected must not
 * block the Firestore records they actually asked to remove. The worst case is
 * a file left in their own Drive, which they can see and delete themselves —
 * the reverse, refusing the delete, would be a bug they cannot work around.
 */
export async function removeOriginalFromDrive(document: {
  driveFileId?: string | null;
}): Promise<void> {
  if (!document.driveFileId || !canUseDrive()) return;
  await deleteDriveFile(document.driveFileId).catch(() => undefined);
}

/**
 * Removes a subject's whole course folder.
 *
 * Deleting the folder is what a student means by deleting the course: leaving
 * an empty "CPT6123" behind in their Drive after they removed the subject is
 * litter Notomi made and did not clean up. Only ever the folder this app
 * created and recorded — never one it merely found.
 */
export async function removeCourseFolder(uid: string, subjectId: string): Promise<void> {
  if (!canUseDrive()) return;

  try {
    const snapshot = await getDoc(paths.subject(getDb(), uid, subjectId));
    const folderId = (snapshot.data() as Subject | undefined)?.driveFolderId;
    if (!folderId) return;
    await deleteDriveFile(folderId).catch(() => undefined);
  } catch {
    /* The subject is going away regardless; this is tidying, not the task. */
  }
}

/* ------------------------------------------------------------------ *
 * Importing what the picker returned
 * ------------------------------------------------------------------ */

export type ImportedDriveFile = DriveFile & { sourceKey: string };

/**
 * Records files chosen through the picker against a subject.
 *
 * Picked files stay where the student put them — moving another folder's file
 * into the Notomi workspace would be a surprising thing for an app to do with
 * a scope this narrow. Only the id is kept.
 */
export async function rememberPickedFiles(
  uid: string,
  subjectId: string,
  files: DriveFile[]
): Promise<ImportedDriveFile[]> {
  if (files.length === 0) return [];

  const db = getDb();
  const stamped = files.map((file) => ({ ...file, sourceKey: driveKey(file.fileId) }));

  await Promise.all(
    stamped.map((file) =>
      setDoc(doc(paths.documents(db, uid, subjectId), file.fileId), {
        title: file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.size,
        // Text extraction is a separate, opt-in step: importing should not
        // silently spend an AI call on a file the student only wanted to see.
        rawText: '',
        charCount: 0,
        r2FileKey: '',
        r2FileUrl: file.webViewLink ?? '',
        driveFileId: file.fileId,
        moduleCode: null,
        summary: null,
        notes: null,
        notesGeneratedAt: null,
        sourceKind: /pdf/i.test(file.mimeType) ? 'pdf' : 'image',
        status: 'ready',
        createdAt: new Date(),
      })
    )
  );

  return stamped;
}

export { DriveError };
