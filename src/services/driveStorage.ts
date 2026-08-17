import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { paths } from '@/lib/paths';
import type { Subject } from '@/lib/schema';
import {
  DriveError,
  WORKSPACE_FOLDER_NAME,
  driveKey,
  ensureFolder,
  fetchDriveBlob,
  isDriveConfigured,
  isDriveConnected,
  parseDriveKey,
  uploadToDrive,
  type DriveFile,
  type DriveFolderStore,
} from '@/lib/driveUtils';
import { getDb } from '@/services/firebase';

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

/** Drive is worth attempting only when it is set up and already authorised. */
export function canUseDrive(): boolean {
  return isDriveConfigured() && isDriveConnected();
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

/** A document's original, as the fields actually recorded on it. */
export function sourceKeyOf(document: {
  driveFileId?: string | null;
  r2FileKey?: string | null;
}): string {
  return document.driveFileId ? driveKey(document.driveFileId) : (document.r2FileKey ?? '');
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
