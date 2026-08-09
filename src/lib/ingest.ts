import * as DocumentPicker from 'expo-document-picker';
import {
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { AiError, extractMetadata } from './ai';
import { parseDueDate } from './dates';
import { getBucket, getDb } from './firebase';
import { stableId } from './ids';
import { materialsStoragePath, paths } from './paths';
import { ACCEPTED_MIME_TYPES, canonicalMimeType, extractText, ParseError } from './parse';
import { colorForSubject, type ExtractedMetadata } from './schema';

export type IngestStage =
  | 'picking'
  | 'reading'
  | 'extracting'
  | 'analyzing'
  | 'uploading'
  | 'saving'
  | 'done';

export const STAGE_LABELS: Record<IngestStage, string> = {
  picking: 'Choosing file…',
  reading: 'Reading file…',
  extracting: 'Extracting text on your device…',
  analyzing: 'Asking Gemini for the key details…',
  uploading: 'Uploading the original to Firebase…',
  saving: 'Saving to your library…',
  done: 'Done',
};

export type IngestProgress = { stage: IngestStage; fileName: string; index: number; total: number };

export type IngestResult = {
  documentId: string;
  subjectId: string;
  subjectName: string;
  fileName: string;
  deadlinesCreated: number;
  /** Set when the file was stored but Gemini could not analyse it. */
  warning?: string;
};

export type IngestOptions = {
  uid: string;
  /** Force everything into one subject (used from inside a subject folder). */
  subjectId?: string;
  onProgress?: (progress: IngestProgress) => void;
};

/** Opens the OS picker and ingests every file the user selected. */
export async function pickAndIngest(
  options: IngestOptions
): Promise<{ results: IngestResult[]; errors: { fileName: string; message: string }[] }> {
  options.onProgress?.({ stage: 'picking', fileName: '', index: 0, total: 0 });

  const picked = await DocumentPicker.getDocumentAsync({
    type: ACCEPTED_MIME_TYPES,
    multiple: true,
    copyToCacheDirectory: true,
  });

  if (picked.canceled || picked.assets.length === 0) {
    return { results: [], errors: [] };
  }

  const results: IngestResult[] = [];
  const errors: { fileName: string; message: string }[] = [];

  for (let index = 0; index < picked.assets.length; index += 1) {
    const asset = picked.assets[index];
    const report = (stage: IngestStage) =>
      options.onProgress?.({
        stage,
        fileName: asset.name,
        index: index + 1,
        total: picked.assets.length,
      });

    try {
      results.push(await ingestAsset(asset, options, report));
    } catch (error) {
      errors.push({ fileName: asset.name, message: describeIngestError(error) });
    }
  }

  options.onProgress?.({ stage: 'done', fileName: '', index: 0, total: 0 });
  return { results, errors };
}

function describeIngestError(error: unknown): string {
  if (error instanceof ParseError || error instanceof AiError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (/storage\/unauthorized/.test(message)) {
    return 'Cloud Storage rejected the upload. Deploy storage.rules and make sure Storage is enabled.';
  }
  if (/storage\/(retry-limit-exceeded|canceled)/.test(message)) {
    return 'Upload timed out. Check your connection and try again.';
  }
  if (/permission-denied/.test(message)) {
    return 'Firestore rejected the write. Deploy firestore.rules.';
  }
  return message;
}

async function ingestAsset(
  asset: DocumentPicker.DocumentPickerAsset,
  options: IngestOptions,
  report: (stage: IngestStage) => void
): Promise<IngestResult> {
  const { uid } = options;
  const db = getDb();

  report('reading');
  const bytes = await readAsset(asset);

  report('extracting');
  const { text, kind } = await extractText(bytes, asset.name, asset.mimeType ?? '');
  // Label the upload by what parsing proved it to be, not by what the OS
  // guessed, so storage.rules can stay strict about content types.
  const contentType = canonicalMimeType(kind);

  // Gemini failing must not cost the student their upload, so the document is
  // still saved with filename-derived defaults.
  report('analyzing');
  let metadata: ExtractedMetadata | null = null;
  let warning: string | undefined;
  try {
    metadata = await extractMetadata(text);
  } catch (error) {
    warning =
      error instanceof AiError
        ? `Saved, but Gemini could not analyse it: ${error.message}`
        : 'Saved, but automatic analysis failed.';
  }

  const fallbackName = asset.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const subjectName = metadata?.subjectName || fallbackName || 'Untitled subject';
  const moduleCode = metadata?.moduleCode ?? null;

  const subjectId =
    options.subjectId ?? (await findOrCreateSubject(uid, subjectName, moduleCode));

  const documentRef = doc(paths.documents(db, uid, subjectId));
  const storagePath = materialsStoragePath(uid, subjectId, documentRef.id, asset.name);

  report('uploading');
  let downloadUrl: string | null = null;
  try {
    const uploaded = await uploadBytes(ref(getBucket(), storagePath), bytes, {
      contentType,
      customMetadata: { originalName: asset.name, subjectId },
    });
    downloadUrl = await getDownloadURL(uploaded.ref);
  } catch (error) {
    // The extracted text is the part the AI features need; keep going without
    // the original binary rather than losing the whole ingest.
    warning = warning ?? `Saved the text, but the original file upload failed: ${describeIngestError(error)}`;
  }

  report('saving');
  await setDoc(documentRef, {
    title: metadata?.subjectName && moduleCode ? asset.name : fallbackName || asset.name,
    fileName: asset.name,
    mimeType: contentType,
    sizeBytes: asset.size ?? bytes.byteLength,
    text,
    charCount: text.length,
    storagePath,
    downloadUrl,
    moduleCode,
    summary: metadata?.summary ?? null,
    status: 'ready',
    error: warning ?? null,
    createdAt: serverTimestamp(),
  });

  await updateDoc(paths.subject(db, uid, subjectId), {
    documentCount: increment(1),
    updatedAt: serverTimestamp(),
    ...(moduleCode ? { moduleCode } : {}),
  });

  const deadlinesCreated = await saveDeadlines(
    uid,
    subjectId,
    subjectName,
    documentRef.id,
    metadata?.deadlines ?? []
  );

  return {
    documentId: documentRef.id,
    subjectId,
    subjectName,
    fileName: asset.name,
    deadlinesCreated,
    warning,
  };
}

/** Reads a picked file into memory. `file` is present on web, `uri` on native. */
async function readAsset(asset: DocumentPicker.DocumentPickerAsset): Promise<ArrayBuffer> {
  if (asset.file) return asset.file.arrayBuffer();
  const response = await fetch(asset.uri);
  return response.arrayBuffer();
}

/**
 * Groups uploads under one folder per course. The module code is the strongest
 * signal; the name is the fallback for material that never states a code.
 */
async function findOrCreateSubject(
  uid: string,
  subjectName: string,
  moduleCode: string | null
): Promise<string> {
  const db = getDb();
  const subjects = paths.subjects(db, uid);

  if (moduleCode) {
    const byCode = await getDocs(query(subjects, where('moduleCode', '==', moduleCode), limit(1)));
    if (!byCode.empty) return byCode.docs[0].id;
  }

  const byName = await getDocs(query(subjects, where('name', '==', subjectName), limit(1)));
  if (!byName.empty) {
    const existing = byName.docs[0];
    if (moduleCode && !existing.data().moduleCode) {
      await updateDoc(existing.ref, { moduleCode });
    }
    return existing.id;
  }

  const subjectId = stableId(uid, moduleCode || subjectName);
  await setDoc(
    doc(subjects, subjectId),
    {
      name: subjectName,
      moduleCode,
      color: colorForSubject(moduleCode || subjectName),
      documentCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  return subjectId;
}

/**
 * Task 6 requires syllabus deadlines to land in the same to-do list as manual
 * tasks. Ids are derived from the content so re-uploading a syllabus updates
 * the existing entries instead of duplicating them.
 */
async function saveDeadlines(
  uid: string,
  subjectId: string,
  subjectName: string,
  documentId: string,
  deadlines: { title: string; dueDate: string | null }[]
): Promise<number> {
  const dated = deadlines
    .map((deadline) => ({ ...deadline, due: parseDueDate(deadline.dueDate) }))
    .filter((deadline) => deadline.due !== null);

  if (dated.length === 0) return 0;

  const db = getDb();
  const refs = dated.map((deadline) => ({
    deadline,
    ref: paths.todo(db, uid, stableId(subjectId, deadline.title)),
  }));

  // Read first so an existing task keeps its completion state and any subtasks
  // the student added, while a new one gets the full schema.
  const existing = await Promise.all(refs.map(({ ref: todoRef }) => getDoc(todoRef)));

  const batch = writeBatch(db);
  for (let i = 0; i < refs.length; i += 1) {
    const { deadline, ref: todoRef } = refs[i];
    const shared = {
      title: deadline.title,
      dueDate: deadline.due,
      subjectId,
      subjectName,
      source: 'syllabus' as const,
      sourceDocumentId: documentId,
    };

    if (existing[i].exists()) {
      batch.update(todoRef, shared);
    } else {
      batch.set(todoRef, {
        ...shared,
        priority: 'medium',
        subTasks: [],
        isCompleted: false,
        completedAt: null,
        createdAt: serverTimestamp(),
      });
    }
  }

  await batch.commit();
  return dated.length;
}
