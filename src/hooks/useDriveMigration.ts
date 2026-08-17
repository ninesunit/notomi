import { useCallback, useRef, useState } from 'react';
import { getDocs, updateDoc } from 'firebase/firestore';
import { paths } from '@/lib/paths';
import type { SourceDocument, Subject } from '@/lib/schema';
import {
  connectDrive,
  driveKey,
  findInFolder,
  isDriveConfigured,
  isDriveConnected,
  uploadToDrive,
} from '@/lib/driveUtils';
import { getDb } from '@/services/firebase';
import { ensureCourseFolder } from '@/services/driveStorage';
import { deleteR2File, isR2Configured, r2FileBlob } from '@/services/r2Storage';

/**
 * Moving a student's originals into their own Drive.
 *
 * One correction to the brief this implements: the originals are not in
 * Firebase Storage. Nothing in Notomi has ever written there — no part of the
 * app so much as imports firebase/storage — so a migration reading from it
 * would find nothing and delete nothing. Every original is in the shared R2
 * bucket, which is the free tier actually worth protecting, so that is what
 * this empties.
 *
 * The order of operations per file is the whole design, because a student will
 * close the tab halfway:
 *
 *   1. upload to Drive          — repeatable, guarded by a name lookup
 *   2. record the Drive id      — from here the app reads from Drive
 *   3. delete the R2 object     — the bucket is freed
 *   4. clear the R2 key         — the record stops mentioning a dead object
 *
 * Interrupted anywhere, the next run picks up exactly where it stopped and no
 * file is uploaded twice. Deletion is deliberately last: a copy of a lecture
 * costs nothing, and losing one costs a semester.
 */

export type MigrationPhase = 'idle' | 'scanning' | 'migrating' | 'done' | 'failed';

export type LegacyFile = {
  subjectId: string;
  subjectName: string;
  documentId: string;
  fileName: string;
  r2FileKey: string;
  sizeBytes: number;
  /** Already in Drive; only the old object is still to be removed. */
  cleanupOnly: boolean;
};

export type MigrationState = {
  phase: MigrationPhase;
  /** Files still to move, refreshed by each scan. */
  pending: LegacyFile[];
  total: number;
  completed: number;
  failed: number;
  currentName: string | null;
  message: string;
  error: string | null;
  /** Bytes removed from the shared bucket. */
  freedBytes: number;
  problems: { fileName: string; message: string }[];
};

const IDLE: MigrationState = {
  phase: 'idle',
  pending: [],
  total: 0,
  completed: 0,
  failed: 0,
  currentName: null,
  message: '',
  error: null,
  freedBytes: 0,
  problems: [],
};

export function useDriveMigration(uid: string) {
  const [state, setState] = useState<MigrationState>(IDLE);
  const cancelled = useRef(false);

  const patch = useCallback((next: Partial<MigrationState>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);

  /* ---------------------------- Phase 1: scan ---------------------------- */

  const scan = useCallback(async (): Promise<LegacyFile[]> => {
    patch({ phase: 'scanning', message: 'Scanning your files…', error: null });

    try {
      const db = getDb();
      const subjects = await getDocs(paths.subjects(db, uid));
      const found: LegacyFile[] = [];

      for (const subject of subjects.docs) {
        const data = subject.data() as Subject;
        const documents = await getDocs(paths.documents(db, uid, subject.id));

        for (const entry of documents.docs) {
          const record = entry.data() as SourceDocument;
          if (!record.r2FileKey) continue;

          found.push({
            subjectId: subject.id,
            subjectName: data.name ?? 'Course',
            documentId: entry.id,
            fileName: record.fileName || record.title || 'Untitled',
            r2FileKey: record.r2FileKey,
            sizeBytes: record.sizeBytes ?? 0,
            // An id already recorded means the copy landed; only the old
            // object is outstanding.
            cleanupOnly: Boolean(record.driveFileId),
          });
        }
      }

      patch({
        phase: 'idle',
        pending: found,
        total: found.length,
        completed: 0,
        failed: 0,
        problems: [],
        freedBytes: 0,
        message: found.length
          ? `${found.length} file${found.length === 1 ? '' : 's'} still in shared storage.`
          : 'Nothing to move — every file is already in your Drive.',
      });
      return found;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      patch({ phase: 'failed', error: message, message: '' });
      return [];
    }
  }, [patch, uid]);

  /* ------------------------ Phases 2–4: move it -------------------------- */

  const start = useCallback(async () => {
    cancelled.current = false;

    if (!isDriveConfigured()) {
      patch({ phase: 'failed', error: 'Google Drive is not set up for this build.' });
      return;
    }
    if (!isR2Configured()) {
      patch({ phase: 'failed', error: 'The old storage is unreachable, so nothing can be moved.' });
      return;
    }

    // Consent before the first file rather than in the middle of the batch.
    if (!isDriveConnected()) {
      patch({ phase: 'migrating', message: 'Waiting for Google…' });
      try {
        await connectDrive();
      } catch (caught) {
        patch({
          phase: 'failed',
          error: caught instanceof Error ? caught.message : String(caught),
        });
        return;
      }
    }

    const work = state.pending.length ? state.pending : await scan();
    if (work.length === 0) {
      patch({ phase: 'done', message: 'Nothing to move.' });
      return;
    }

    patch({
      phase: 'migrating',
      total: work.length,
      completed: 0,
      failed: 0,
      freedBytes: 0,
      problems: [],
      error: null,
    });

    const db = getDb();
    const folders = new Map<string, string>();
    let completed = 0;
    let failed = 0;
    let freed = 0;
    const problems: { fileName: string; message: string }[] = [];

    for (const file of work) {
      if (cancelled.current) break;

      patch({
        currentName: file.fileName,
        message: `Migrating “${file.fileName}” (${completed + failed + 1} of ${work.length})…`,
      });

      try {
        const reference = paths.document(db, uid, file.subjectId, file.documentId);

        if (!file.cleanupOnly) {
          /* Phase 2: the course folder, created once per subject per run. */
          let folderId = folders.get(file.subjectId);
          if (!folderId) {
            folderId = await ensureCourseFolder(uid, file.subjectId);
            folders.set(file.subjectId, folderId);
          }

          /* Phase 3: fetch from the old bucket, upload to Drive. */
          // Resume point: a copy already there is the one a previous run made.
          let uploaded = await findInFolder(folderId, file.fileName);
          if (!uploaded) {
            // Bytes, not a URL: a viewing URL keeps its blob alive for an hour,
            // and several hundred of those in a row is how a full migration ran
            // the tab out of memory partway through.
            const blob = await r2FileBlob(file.r2FileKey);
            uploaded = await uploadToDrive(
              blob,
              file.fileName,
              blob.type || 'application/octet-stream',
              folderId
            );
          }

          /* Phase 4a: record it. From here the app reads from Drive. */
          await updateDoc(reference, {
            driveFileId: uploaded.fileId,
            r2FileUrl: uploaded.webViewLink ?? '',
          });
        }

        /* Phase 4b: free the shared bucket, then forget the dead key. */
        await deleteR2File(file.r2FileKey);
        await updateDoc(reference, { r2FileKey: '' });

        freed += file.sizeBytes;
        completed += 1;
      } catch (caught) {
        failed += 1;
        problems.push({
          fileName: file.fileName,
          message: caught instanceof Error ? caught.message : String(caught),
        });
      }

      patch({ completed, failed, freedBytes: freed, problems });
    }

    // Re-scan so the list reflects reality rather than this run's bookkeeping.
    const left = await scan();

    patch({
      phase: cancelled.current ? 'idle' : 'done',
      currentName: null,
      completed,
      failed,
      freedBytes: freed,
      problems,
      pending: left,
      message: cancelled.current
        ? `Stopped. ${completed} file${completed === 1 ? '' : 's'} moved.`
        : failed === 0
          ? `Migration complete. ${completed} file${completed === 1 ? '' : 's'} now in your Drive.`
          : `${completed} moved, ${failed} could not be. Nothing was deleted for those.`,
    });
  }, [patch, scan, state.pending, uid]);

  const cancel = useCallback(() => {
    // Takes effect between files: stopping mid-upload would be the one moment
    // a file exists in neither place.
    cancelled.current = true;
    patch({ message: 'Stopping after this file…' });
  }, [patch]);

  const reset = useCallback(() => {
    cancelled.current = false;
    setState(IDLE);
  }, []);

  return { state, scan, start, cancel, reset };
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
