import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import {
  Timestamp,
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
  type DocumentReference,
  type Firestore,
} from 'firebase/firestore';
import {
  AiError,
  extractMetadata,
  extractMetadataFromMedia,
  readDocument,
  summarizeDocument,
} from '@/lib/ai';
import { parseDueDate } from '@/lib/dates';
import { getDb } from '@/services/firebase';
import { stableId } from '@/lib/ids';
import { paths } from '@/lib/paths';
import {
  colorForSubject,
  type ExtractedDeadline,
  type ExtractedMetadata,
  type FileKind,
  type Semester,
  type SourceDocument,
  type Todo,
} from '@/lib/schema';
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
  'picking' | 'reading' | 'extracting' | 'uploading' | 'analyzing' | 'saving' | 'done';

export const STAGE_LABELS: Record<IngestStage, string> = {
  picking: 'Choosing file…',
  reading: 'Reading file…',
  extracting: 'Extracting text…',
  uploading: 'Saving the original…',
  analyzing: 'Pulling out the key details…',
  saving: 'Saving to your library…',
  done: 'Done',
};

/**
 * The extract step means different things per format, and the slow ones (OCR,
 * transcription) are exactly the ones a student needs told about.
 */
export function stageLabel(stage: IngestStage, kind?: FileKind | null): string {
  if (stage !== 'extracting' || !kind) return STAGE_LABELS[stage];
  if (kind === 'image') return 'Reading the text out of the image…';
  if (kind === 'audio' || kind === 'video') return `Transcribing the ${kind}…`;
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

export const MAX_BATCH_FILES = 10;
export const MAX_BATCH_BYTES = 25 * 1024 * 1024;

/** Shared limit for Library batches and schedule/calendar scans. */
export function validateMaterialBatch(files: MaterialFile[]): void {
  if (files.length > MAX_BATCH_FILES) {
    throw new ParseError(`Choose up to ${MAX_BATCH_FILES} files at a time.`);
  }

  const total = files.reduce((sum, file) => sum + (file.size ?? file.file?.size ?? 0), 0);
  if (total > MAX_BATCH_BYTES) {
    throw new ParseError(
      `Those files total ${humanSize(total)}. The maximum batch is ${humanSize(MAX_BATCH_BYTES)}.`
    );
  }

  for (const file of files) checkUploadSize(file);
}

/** Converts a browser drop into the same shape as expo-document-picker. */
export function materialFilesFromWeb(files: FileList | File[]): MaterialFile[] {
  return Array.from(files).map((file) => ({
    name: file.name,
    uri: URL.createObjectURL(file),
    mimeType: file.type || null,
    size: file.size,
    file,
  }));
}

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

  const fallbackTitle = file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();

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

/**
 * Opens the camera rather than a file browser.
 *
 * expo-document-picker cannot request the camera, and on a phone that is the
 * difference between "photograph this whiteboard" and "go find a photo of a
 * whiteboard". The `capture` attribute is what makes iOS and Android open the
 * camera directly; a desktop browser ignores it and shows a file dialog, which
 * is the right fallback.
 */
export async function captureImage(): Promise<MaterialFile[]> {
  if (Platform.OS !== 'web') return pickMaterials();

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.style.display = 'none';

    let settled = false;
    const finish = (files: MaterialFile[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      finish(
        file
          ? [
              {
                name: file.name || `capture-${Date.now()}.jpg`,
                uri: URL.createObjectURL(file),
                mimeType: file.type || 'image/jpeg',
                size: file.size,
                file,
              },
            ]
          : []
      );
    });

    // Cancel fires no event in most browsers; focus returning to the window is
    // the only signal, and it needs a beat for `change` to land first.
    window.addEventListener('focus', () => setTimeout(() => finish([]), 600), {
      once: true,
    });

    document.body.appendChild(input);
    input.click();
  });
}

export async function pickMaterials(): Promise<MaterialFile[]> {
  if (Platform.OS === 'web') {
    const files = await pickMaterialsFromWeb();
    validateMaterialBatch(files);
    return files;
  }

  const picked = await DocumentPicker.getDocumentAsync({
    type: ACCEPTED_MIME_TYPES,
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (picked.canceled) return [];

  const files = picked.assets.map((asset) => ({
    name: asset.name,
    uri: asset.uri,
    mimeType: asset.mimeType,
    size: asset.size,
    file: asset.file ?? null,
  }));
  validateMaterialBatch(files);
  return files;
}

/**
 * Expo's native picker remains the right implementation on iOS and Android.
 * On web, own the input so the batch contract is explicit and consistent:
 * `multiple` is set as a DOM property and extension fallbacks keep files whose
 * operating system reports an empty MIME type selectable.
 */
function pickMaterialsFromWeb(): Promise<MaterialFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = [
      ...ACCEPTED_MIME_TYPES,
      '.pdf',
      '.docx',
      '.pptx',
      '.txt',
      '.md',
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.mp4',
      '.mp3',
      '.m4a',
    ].join(',');
    input.style.display = 'none';

    let settled = false;
    const selectedFiles = () =>
      input.files?.length ? materialFilesFromWeb(input.files) : [];
    const finish = (files: MaterialFile[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', handleFocus);
      input.remove();
      resolve(files);
    };
    const handleFocus = () => {
      // Some browsers do not emit `cancel`; give `change` time to run first.
      window.setTimeout(() => finish(selectedFiles()), 500);
    };

    input.addEventListener('change', () => finish(selectedFiles()), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    window.addEventListener('focus', handleFocus, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** Opens the OS picker and ingests everything selected. */
export async function pickAndIngest(options: IngestOptions): Promise<{
  results: IngestResult[];
  errors: { fileName: string; message: string }[];
}> {
  options.onProgress?.({
    stage: 'picking',
    kind: null,
    fileName: '',
    index: 0,
    total: 0,
  });

  const files = await pickMaterials();
  if (files.length === 0) return { results: [], errors: [] };

  return ingestFiles(files, options);
}

export async function ingestFiles(
  files: MaterialFile[],
  options: IngestOptions
): Promise<{
  results: IngestResult[];
  errors: { fileName: string; message: string }[];
}> {
  validateMaterialBatch(files);
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
      results.push(await processUploadedMaterial(file, subjectId, options.uid, report, prepared));
    } catch (error) {
      errors.push({ fileName: file.name, message: describeIngestError(error) });
    }
  }

  options.onProgress?.({
    stage: 'done',
    kind: null,
    fileName: '',
    index: 0,
    total: 0,
  });
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
  let parsed: ParsedFile;
  try {
    parsed = await extractText(bytes, file.name, file.mimeType ?? '');
  } catch (error) {
    if (kind !== 'pdf') throw error;
    // Scanned PDFs and stale cached pdf.js workers bypass client parsing and
    // go to Gemini as the original document. This is the reliable path for
    // print-to-PDF schedules and photocopied syllabuses.
    const text = await readDocument(bytes, 'application/pdf');
    if (!text) throw error;
    parsed = { text, pageCount: null, kind: 'pdf' };
  }

  report('analyzing', parsed.kind);
  try {
    const mediaKind = parsed.kind === 'pdf' || parsed.kind === 'image';
    const metadata = mediaKind
      ? await extractMetadataFromMedia(bytes, canonicalMimeType(parsed.kind, file.mimeType))
      : await extractMetadata(parsed.text);
    return { bytes, parsed, metadata };
  } catch (error) {
    // Large raw media can exceed inline request limits. Its extracted text is
    // still a complete fallback for routing and syllabus dates.
    try {
      return { bytes, parsed, metadata: await extractMetadata(parsed.text) };
    } catch {
      /* Report the original media failure below; it is usually more specific. */
    }
    return {
      bytes,
      parsed,
      metadata: null,
      metadataError:
        error instanceof AiError
          ? `Could not analyse it: ${error.message}`
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
  const fallback = file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
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
  if (/permission-denied/.test(message))
    return 'Firestore rejected the write. Deploy firestore.rules.';
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
    if (!byCode.empty) {
      const existing = byCode.docs[0];
      if (!existing.data().semesterId) {
        const semesterId = await currentSemesterId(uid);
        if (semesterId)
          await updateDoc(existing.ref, {
            semesterId,
            updatedAt: serverTimestamp(),
          });
      }
      return existing.id;
    }
  }

  const byName = await getDocs(query(subjects, where('name', '==', subjectName), limit(1)));
  if (!byName.empty) {
    const existing = byName.docs[0];
    const patch: Record<string, unknown> = {};
    if (moduleCode && !existing.data().moduleCode) patch.moduleCode = moduleCode;
    if (!existing.data().semesterId) patch.semesterId = await currentSemesterId(uid);
    if (Object.values(patch).some((value) => value !== null)) {
      await updateDoc(existing.ref, { ...patch, updatedAt: serverTimestamp() });
    }
    return existing.id;
  }

  const semesterId = await currentSemesterId(uid);
  const subjectId = stableId(uid, moduleCode || subjectName);
  await setDoc(
    doc(subjects, subjectId),
    {
      name: subjectName,
      moduleCode,
      color: colorForSubject(moduleCode || subjectName),
      emoji: null,
      tag: null,
      documentCount: 0,
      // Imported calendar anchors give new material a term immediately.
      semesterId,
      creditHours: 0,
      grade: null,
      attendanceAttended: 0,
      attendanceMissed: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  return subjectId;
}

async function currentSemesterId(uid: string): Promise<string | null> {
  const db = getDb();
  const snapshot = await getDocs(paths.semesters(db, uid));
  const semesters = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as Semester);
  const now = new Date();
  return (
    semesters.find((semester) => {
      const start = semester.startDate?.toDate?.();
      const end = semester.endDate?.toDate?.();
      return !!start && !!end && start <= now && now <= end;
    })?.id ??
    semesters.find((semester) => semester.isCurrent)?.id ??
    null
  );
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
  const milestones = dated.flatMap((deadline) =>
    (deadline.milestones ?? []).map((milestone) => ({
      parent: deadline,
      milestone,
      due: Timestamp.fromMillis(
        deadline.due!.toMillis() - milestone.weeksBeforeDue * 7 * 24 * 60 * 60 * 1000
      ),
      ref: paths.todo(db, uid, stableId(subjectId, deadline.title, 'milestone', milestone.title)),
    }))
  );
  const existingMilestones = await Promise.all(milestones.map(({ ref }) => getDoc(ref)));

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

  for (let i = 0; i < milestones.length; i += 1) {
    const { parent, milestone, due, ref } = milestones[i];
    const shared = {
      title: `${parent.title}: ${milestone.title}`,
      dueDate: due,
      subjectId,
      subjectName,
      source: 'syllabus' as const,
      sourceDocumentId: documentId,
      kind: 'milestone',
    };
    if (existingMilestones[i].exists()) batch.update(ref, shared);
    else {
      batch.set(ref, {
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
  return dated.length + milestones.length;
}

/**
 * Removes a document and everything derived from it.
 *
 * An upload fans out: the original lands in R2, deadlines become to-dos, notes
 * and chats hang off the document. Deleting only the document row left those
 * behind as orphans — a to-do the student could not explain and could not
 * remove from its source. Every derived record now goes with it.
 */
export async function deleteMaterial(
  uid: string,
  subjectId: string,
  documentId: string,
  r2FileKey: string | null
): Promise<void> {
  const db = getDb();

  // The object store is best-effort: a missing or unreachable R2 must not
  // strand the Firestore records the student is actually trying to remove.
  if (r2FileKey) await deleteR2File(r2FileKey).catch(() => undefined);

  const [derivedTodos, derivedChats, flashcards] = await Promise.all([
    getDocs(query(paths.todos(db, uid), where('sourceDocumentId', '==', documentId))),
    getDocs(query(paths.chats(db, uid, subjectId), where('documentId', '==', documentId))),
    getDocs(
      query(paths.flashcards(db, uid, subjectId), where('sourceDocumentId', '==', documentId))
    ),
  ]);

  // Chat messages are a subcollection, so they have to be listed before their
  // parent goes — a deleted Firestore document does not take its children.
  const messageRefs = (
    await Promise.all(
      derivedChats.docs.map((chat) =>
        getDocs(paths.chatMessages(db, uid, subjectId, chat.id)).then((snapshot) =>
          snapshot.docs.map((message) => message.ref)
        )
      )
    )
  ).flat();

  await commitDeletes(db, [
    ...messageRefs,
    ...derivedChats.docs.map((chat) => chat.ref),
    ...derivedTodos.docs.map((todo) => todo.ref),
    ...flashcards.docs.map((card) => card.ref),
    paths.document(db, uid, subjectId, documentId),
  ]);

  await updateDoc(paths.subject(db, uid, subjectId), {
    documentCount: increment(-1),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Removes a subject and every document, to-do, chat, flashcard and weak
 * concept underneath it.
 */
export async function deleteSubject(uid: string, subjectId: string): Promise<void> {
  const db = getDb();

  const [documents, chats, flashcards, subjectTodos, weak] = await Promise.all([
    getDocs(paths.documents(db, uid, subjectId)),
    getDocs(paths.chats(db, uid, subjectId)),
    getDocs(paths.flashcards(db, uid, subjectId)),
    getDocs(query(paths.todos(db, uid), where('subjectId', '==', subjectId))),
    getDocs(query(paths.weakConcepts(db, uid), where('subjectId', '==', subjectId))),
  ]);

  await Promise.all(
    documents.docs
      .map((document) => (document.data() as SourceDocument).r2FileKey)
      .filter(Boolean)
      .map((key) => deleteR2File(key).catch(() => undefined))
  );

  const messageRefs = (
    await Promise.all(
      chats.docs.map((chat) =>
        getDocs(paths.chatMessages(db, uid, subjectId, chat.id)).then((snapshot) =>
          snapshot.docs.map((message) => message.ref)
        )
      )
    )
  ).flat();

  await commitDeletes(db, [
    ...messageRefs,
    ...chats.docs.map((chat) => chat.ref),
    ...documents.docs.map((document) => document.ref),
    ...flashcards.docs.map((card) => card.ref),
    ...subjectTodos.docs.map((todo) => todo.ref),
    ...weak.docs.map((concept) => concept.ref),
    paths.subject(db, uid, subjectId),
  ]);

  // Timetable blocks survive, but must stop pointing at a subject that is gone.
  const classes = await getDocs(query(paths.classes(db, uid), where('subjectId', '==', subjectId)));
  if (!classes.empty) {
    const batch = writeBatch(db);
    for (const block of classes.docs) {
      batch.update(block.ref, { subjectId: null, subjectName: null });
    }
    await batch.commit();
  }
}

/**
 * Deletes refs in batches. Firestore caps a batch at 500 writes, and a subject
 * with a long chat history clears that easily.
 */
async function commitDeletes(db: Firestore, refs: DocumentReference[]): Promise<void> {
  for (let index = 0; index < refs.length; index += 400) {
    const batch = writeBatch(db);
    for (const ref of refs.slice(index, index + 400)) batch.delete(ref);
    await batch.commit();
  }
}

/**
 * Removes syllabus to-dos whose source document no longer exists.
 *
 * Cascade deletion keeps new uploads clean, but accounts that deleted material
 * before it existed still carry orphans. This sweeps them, costing one read per
 * distinct source document rather than one per to-do.
 */
export async function sweepOrphanedTodos(uid: string): Promise<number> {
  const db = getDb();

  const snapshot = await getDocs(query(paths.todos(db, uid), where('source', '==', 'syllabus')));
  if (snapshot.empty) return 0;

  const bySource = new Map<string, DocumentReference[]>();
  for (const todo of snapshot.docs) {
    const data = todo.data() as Todo;
    // A syllabus to-do with no traceable origin cannot be verified, so it is
    // left alone rather than guessed at.
    if (!data.sourceDocumentId || !data.subjectId) continue;
    const key = `${data.subjectId}/${data.sourceDocumentId}`;
    bySource.set(key, [...(bySource.get(key) ?? []), todo.ref]);
  }
  if (bySource.size === 0) return 0;

  const checks = await Promise.all(
    [...bySource.keys()].map(async (key) => {
      const [subjectId, documentId] = key.split('/');
      const exists = (await getDoc(paths.document(db, uid, subjectId, documentId))).exists();
      return { key, exists };
    })
  );

  const orphaned = checks
    .filter((check) => !check.exists)
    .flatMap((check) => bySource.get(check.key) ?? []);

  if (orphaned.length > 0) await commitDeletes(db, orphaned);
  return orphaned.length;
}
