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
import { AiError, extractMetadata, summarizeDocument } from '@/lib/ai';
import { parseDueDate } from '@/lib/dates';
import { getDb } from '@/services/firebase';
import { stableId } from '@/lib/ids';
import { paths } from '@/lib/paths';
import { colorForSubject, type ExtractedDeadline, type ExtractedMetadata, type FileKind } from '@/lib/schema';
import {
  ACCEPTED_MIME_TYPES,
  canonicalMimeType,
  classify,
  extractText,
  humanSize,
  ParseError,
  SIZE_LIMITS,
  type ParsedFile,
} from './fileProcessor';
import { deleteR2File, isR2Configured, r2ConfigHint, R2Error, uploadFileToR2 } from './r2Storage';

/**
 * The ingestion pipeline.
 *
 * Extract text (locally where the format allows, via Gemini for images and
 * media), push the original to Cloudflare R2, then write text and metadata to
 * Firestore and let Gemini summarise it. The file's bytes only ever go to R2
 * and — for images and A/V — to Gemini; the text goes to Firestore and Gemini.
 */

export type IngestStage =
  | 'picking'
  | 'reading'
  | 'extracting'
  | 'uploading'
  | 'analyzing'
  | 'saving'
  | 'done';

export const STAGE_LABELS: Record<IngestStage, string> = {
  picking: 'Choosing file…',
  reading: 'Reading file…',
  extracting: 'Extracting text…',
  uploading: 'Uploading the original to Cloudflare R2…',
  analyzing: 'Asking Gemini for the key details…',
  saving: 'Saving to your library…',
  done: 'Done',
};

/**
 * The extract step means different things per format, and the slow ones (OCR,
 * transcription) are exactly the ones a student needs told about.
 */
export function stageLabel(stage: IngestStage, kind?: FileKind | null): string {
  if (stage !== 'extracting' || !kind) return STAGE_LABELS[stage];
  if (kind === 'image') return 'Reading the image with Gemini OCR…';
  if (kind === 'audio' || kind === 'video') return `Transcribing the ${kind} with Gemini…`;
  return 'Extracting text on your device…';
}

/** Ordered for progress bars. `picking`/`done` are not real work. */
export const STAGE_ORDER: IngestStage[] = [
  'reading',
  'extracting',
  'uploading',
  'analyzing',
  'saving',
];

export type IngestProgress = {
  stage: IngestStage;
  /** What the file turned out to be; drives the wording of the extract stage. */
  kind: FileKind | null;
  fileName: string;
  index: number;
  total: number;
};

export type IngestResult = {
  documentId: string;
  subjectId: string;
  subjectName: string;
  fileName: string;
  deadlinesCreated: number;
  /** Set when the document was saved but part of the pipeline degraded. */
  warning?: string;
};

export type MaterialFile = {
  name: string;
  uri: string;
  mimeType?: string | null;
  size?: number | null;
  /** Present on web; avoids a re-fetch of a blob URI. */
  file?: File | null;
};

/**
 * A parse, done once. Extraction for images and A/V costs a Gemini call, so the
 * result is threaded through the pipeline rather than recomputed when a file
 * has to be classified before it can be filed.
 */
type PreparedFile = {
  bytes: ArrayBuffer;
  parsed: ParsedFile;
  metadata: ExtractedMetadata | null;
  /** Set when metadata extraction failed, so it is not retried per stage. */
  metadataError?: string;
};

export { ACCEPTED_MIME_TYPES };

/**
 * Rejects an oversized file before a byte is read. The picker reports a size on
 * every platform, and reading a 400 MB video into memory just to refuse it is
 * how a browser tab dies.
 */
export function checkUploadSize(file: MaterialFile): void {
  const kind = classify(file.name, file.mimeType ?? '');
  if (kind === 'unknown' || !file.size) return;

  const limit = SIZE_LIMITS[kind];
  if (file.size > limit) {
    throw new ParseError(
      `"${file.name}" is ${humanSize(file.size)}, over the ${humanSize(limit)} limit for ` +
        `${kind} files. ${
          kind === 'video' || kind === 'audio'
            ? 'Trim the recording or split it into shorter parts.'
            : 'Try compressing or splitting it.'
        }`
    );
  }
}

/* ------------------------------------------------------------------ *
 * Single-file pipeline
 * ------------------------------------------------------------------ */

/**
 * Runs one file end to end into a known subject.
 *
 *   1. extract text (fileProcessor — locally, or via Gemini for images and A/V)
 *   2. upload the original binary to R2 (r2Storage)
 *   3. write the document to users/{userId}/subjects/{subjectId}/documents
 *   4. summarise with Gemini and fan deadlines out into the to-do list
 *
 * Each stage degrades on its own: a Gemini outage or an unconfigured bucket
 * still leaves the student with readable, searchable text.
 */
export async function processUploadedMaterial(
  file: MaterialFile,
  subjectId: string,
  userId: string,
  onProgress?: (stage: IngestStage, kind?: FileKind) => void,
  prepared?: PreparedFile
): Promise<IngestResult> {
  const db = getDb();
  const report = (stage: IngestStage, kind?: FileKind) => onProgress?.(stage, kind);

  const ready = prepared ?? (await prepareFile(file, report));
  const { bytes, parsed } = ready;
  const { text, kind } = parsed;
  const contentType = canonicalMimeType(kind, file.mimeType);

  const documentRef = doc(paths.documents(db, userId, subjectId));
  const warnings: string[] = [];

  report('uploading');
  let r2FileKey = '';
  let r2FileUrl = '';
  if (isR2Configured()) {
    try {
      const uploaded = await uploadFileToR2(
        file.uri,
        file.name,
        userId,
        subjectId,
        contentType,
        bytes
      );
      r2FileKey = uploaded.fileKey;
      r2FileUrl = uploaded.fileUrl;
    } catch (error) {
      warnings.push(
        error instanceof R2Error
          ? `Original not stored: ${error.message}`
          : `Original not stored: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    warnings.push(`Original not stored — ${r2ConfigHint()}`);
  }

  report('analyzing');
  let metadata = ready.metadata;
  let fallbackSummary: string | null = null;

  if (!metadata) {
    if (ready.metadataError) warnings.push(ready.metadataError);

    // Structured extraction is the harder ask. If the schema defeated it, a
    // plain summary usually still works, so the student is not left with a
    // blank card.
    try {
      fallbackSummary = await summarizeDocument(text);
    } catch {
      /* Both AI paths are down; the text itself is still saved. */
    }
  }

  const fallbackTitle = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

  report('saving');
  await setDoc(documentRef, {
    title: fallbackTitle || file.name,
    fileName: file.name,
    mimeType: contentType,
    sizeBytes: file.size ?? bytes.byteLength,
    rawText: text,
    charCount: text.length,
    sourceKind: kind,
    r2FileKey,
    r2FileUrl,
    moduleCode: metadata?.moduleCode ?? null,
    summary: metadata?.summary ?? fallbackSummary,
    // Notes are generated on demand from the reader — they are a much larger
    // generation than a summary and not every upload needs them.
    notes: null,
    notesGeneratedAt: null,
    status: 'ready',
    error: warnings.join(' ') || null,
    createdAt: serverTimestamp(),
  });

  const subjectSnap = await getDoc(paths.subject(db, userId, subjectId));
  const subjectName = (subjectSnap.data()?.name as string) ?? metadata?.subjectName ?? 'Subject';

  await updateDoc(paths.subject(db, userId, subjectId), {
    documentCount: increment(1),
    updatedAt: serverTimestamp(),
    ...(metadata?.moduleCode && !subjectSnap.data()?.moduleCode
      ? { moduleCode: metadata.moduleCode }
      : {}),
  });

  const deadlinesCreated = await saveDeadlines(
    userId,
    subjectId,
    subjectName,
    documentRef.id,
    metadata?.deadlines ?? []
  );

  return {
    documentId: documentRef.id,
    subjectId,
    subjectName,
    fileName: file.name,
    deadlinesCreated,
    warning: warnings.join(' ') || undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Picker flow
 * ------------------------------------------------------------------ */

export type IngestOptions = {
  uid: string;
  /** Pin uploads to one subject; otherwise Gemini decides where they belong. */
  subjectId?: string;
  onProgress?: (progress: IngestProgress) => void;
};

export async function pickMaterials(): Promise<MaterialFile[]> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: ACCEPTED_MIME_TYPES,
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (picked.canceled) return [];

  return picked.assets.map((asset) => ({
    name: asset.name,
    uri: asset.uri,
    mimeType: asset.mimeType,
    size: asset.size,
    file: asset.file ?? null,
  }));
}

/** Opens the OS picker and ingests everything selected. */
export async function pickAndIngest(
  options: IngestOptions
): Promise<{ results: IngestResult[]; errors: { fileName: string; message: string }[] }> {
  options.onProgress?.({ stage: 'picking', kind: null, fileName: '', index: 0, total: 0 });

  const files = await pickMaterials();
  if (files.length === 0) return { results: [], errors: [] };

  return ingestFiles(files, options);
}

export async function ingestFiles(
  files: MaterialFile[],
  options: IngestOptions
): Promise<{ results: IngestResult[]; errors: { fileName: string; message: string }[] }> {
  const results: IngestResult[] = [];
  const errors: { fileName: string; message: string }[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const report = (stage: IngestStage, kind?: FileKind) =>
      options.onProgress?.({
        stage,
        kind: kind ?? null,
        fileName: file.name,
        index: index + 1,
        total: files.length,
      });

    try {
      // Without a fixed subject the file has to be read and analysed before it
      // can be filed, so the whole prepare step is done once and handed on.
      const prepared = await prepareFile(file, report);
      const subjectId = options.subjectId ?? (await subjectForFile(file, prepared, options.uid));
      results.push(
        await processUploadedMaterial(file, subjectId, options.uid, report, prepared)
      );
    } catch (error) {
      errors.push({ fileName: file.name, message: describeIngestError(error) });
    }
  }

  options.onProgress?.({ stage: 'done', kind: null, fileName: '', index: 0, total: 0 });
  return { results, errors };
}

/**
 * Reads and parses a file, then asks Gemini what it is. Runs at most once per
 * upload — for an image or a lecture recording, extraction *is* a Gemini call.
 */
async function prepareFile(
  file: MaterialFile,
  report: (stage: IngestStage, kind?: FileKind) => void
): Promise<PreparedFile> {
  checkUploadSize(file);

  report('reading');
  const bytes = await readFileBytes(file);

  const kind = classify(file.name, file.mimeType ?? '');
  report('extracting', kind === 'unknown' ? undefined : kind);
  const parsed = await extractText(bytes, file.name, file.mimeType ?? '');

  report('analyzing', parsed.kind);
  try {
    return { bytes, parsed, metadata: await extractMetadata(parsed.text) };
  } catch (error) {
    return {
      bytes,
      parsed,
      metadata: null,
      metadataError:
        error instanceof AiError
          ? `Gemini could not analyse it: ${error.message}`
          : 'Automatic analysis failed.',
    };
  }
}

/**
 * Picks the folder a loose upload belongs in. Gemini names the subject when it
 * can; otherwise the filename does.
 */
async function subjectForFile(
  file: MaterialFile,
  prepared: PreparedFile,
  uid: string
): Promise<string> {
  const fallback = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return findOrCreateSubject(
    uid,
    prepared.metadata?.subjectName || fallback || 'Untitled subject',
    prepared.metadata?.moduleCode ?? null
  );
}

export function describeIngestError(error: unknown): string {
  if (error instanceof ParseError || error instanceof AiError || error instanceof R2Error) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/permission-denied/.test(message)) return 'Firestore rejected the write. Deploy firestore.rules.';
  return message;
}

async function readFileBytes(file: MaterialFile): Promise<ArrayBuffer> {
  if (file.file) return file.file.arrayBuffer();
  const response = await fetch(file.uri);
  return response.arrayBuffer();
}

/* ------------------------------------------------------------------ *
 * Subjects and deadlines
 * ------------------------------------------------------------------ */

export async function findOrCreateSubject(
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
    if (moduleCode && !existing.data().moduleCode) await updateDoc(existing.ref, { moduleCode });
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
      // Unfiled until the program planner assigns it a semester.
      semesterId: null,
      creditHours: 0,
      grade: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  return subjectId;
}

/**
 * Syllabus deadlines land in the same to-do collection as manual tasks. Ids are
 * derived from the content so re-uploading a syllabus updates its entries
 * rather than duplicating them, and a completed task is not resurrected.
 */
async function saveDeadlines(
  uid: string,
  subjectId: string,
  subjectName: string,
  documentId: string,
  deadlines: ExtractedDeadline[]
): Promise<number> {
  const dated = deadlines
    .map((deadline) => ({
      ...deadline,
      due: parseDueDate(deadline.dueDate, deadline.dueTime),
    }))
    .filter((deadline) => deadline.due !== null);

  if (dated.length === 0) return 0;

  const db = getDb();
  const refs = dated.map((deadline) => ({
    deadline,
    ref: paths.todo(db, uid, stableId(subjectId, deadline.title)),
  }));
  const existing = await Promise.all(refs.map(({ ref }) => getDoc(ref)));

  const batch = writeBatch(db);
  for (let i = 0; i < refs.length; i += 1) {
    const { deadline, ref } = refs[i];
    const shared = {
      title: deadline.title,
      dueDate: deadline.due,
      subjectId,
      subjectName,
      source: 'syllabus' as const,
      sourceDocumentId: documentId,
      kind: deadline.kind ?? null,
    };

    if (existing[i].exists()) batch.update(ref, shared);
    else {
      // Exams and projects carry more weight than a weekly reading, so they
      // arrive already flagged rather than all landing on "medium".
      const heavyweight = ['exam', 'project', 'presentation'].includes(deadline.kind ?? '');
      batch.set(ref, {
        ...shared,
        priority: heavyweight ? 'high' : 'medium',
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

/** Removes a document and its R2 object. */
export async function deleteMaterial(
  uid: string,
  subjectId: string,
  documentId: string,
  r2FileKey: string | null
): Promise<void> {
  const db = getDb();
  if (r2FileKey) await deleteR2File(r2FileKey).catch(() => undefined);
  const { deleteDoc } = await import('firebase/firestore');
  await deleteDoc(paths.document(db, uid, subjectId, documentId));
  await updateDoc(paths.subject(db, uid, subjectId), { documentCount: increment(-1) });
}
