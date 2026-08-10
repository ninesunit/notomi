import { doc, getDocs, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { extractTimetable } from '@/lib/ai';
import { paths } from '@/lib/paths';
import {
  colorForSubject,
  DAY_FULL,
  parseClock,
  type ClassBlock,
  type ExtractedClass,
  type Subject,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { canonicalMimeType, classify, humanSize, ParseError, SIZE_LIMITS } from './fileProcessor';

/**
 * The weekly timetable.
 *
 * Blocks are stored flat under users/{uid}/classes with the day as an index and
 * times as minutes from midnight, which makes overlap checks and grid layout
 * plain arithmetic rather than date handling.
 */

export type ClassInput = {
  title: string;
  kind: string | null;
  subjectId: string | null;
  subjectName: string | null;
  day: number;
  startMinute: number;
  endMinute: number;
  venue: string | null;
  color: string;
};

export async function saveClass(
  uid: string,
  input: ClassInput,
  classId?: string
): Promise<string> {
  const db = getDb();
  const ref = classId ? paths.class(db, uid, classId) : doc(paths.classes(db, uid));

  const fields = {
    title: input.title.trim(),
    kind: input.kind?.trim() || null,
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    day: input.day,
    startMinute: input.startMinute,
    endMinute: input.endMinute,
    venue: input.venue?.trim() || null,
    color: input.color,
  };

  if (classId) await updateDoc(ref, fields);
  else await setDoc(ref, { ...fields, createdAt: serverTimestamp() });

  return ref.id;
}

export async function deleteClass(uid: string, classId: string): Promise<void> {
  const db = getDb();
  const { deleteDoc } = await import('firebase/firestore');
  await deleteDoc(paths.class(db, uid, classId));
}

export async function clearTimetable(uid: string): Promise<number> {
  const db = getDb();
  const snapshot = await getDocs(paths.classes(db, uid));
  if (snapshot.empty) return 0;

  for (let index = 0; index < snapshot.docs.length; index += 400) {
    const batch = writeBatch(db);
    for (const block of snapshot.docs.slice(index, index + 400)) batch.delete(block.ref);
    await batch.commit();
  }
  return snapshot.size;
}

/* ------------------------------------------------------------------ *
 * Screenshot import
 * ------------------------------------------------------------------ */

const DAY_LOOKUP: Record<string, number> = {};
DAY_FULL.forEach((name, index) => {
  DAY_LOOKUP[name.toLowerCase()] = index;
  DAY_LOOKUP[name.slice(0, 3).toLowerCase()] = index;
});
// Ambiguous single letters a schedule might use. T and S are deliberately
// absent: they could mean two different days, and guessing would be worse than
// dropping the row.
Object.assign(DAY_LOOKUP, { m: 0, tu: 1, w: 2, th: 3, r: 3, f: 4, sa: 5, su: 6 });

export function dayIndexFor(value: string): number | null {
  const key = value.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!key) return null;
  return DAY_LOOKUP[key] ?? DAY_LOOKUP[key.slice(0, 3)] ?? null;
}

export type ImportResult = {
  imported: number;
  skipped: number;
  blocks: ClassInput[];
};

/**
 * Turns what Gemini read off a screenshot into class blocks.
 *
 * Rows the model produced but we cannot trust — an unrecognisable day, a time
 * that will not parse, an end before its start — are dropped rather than
 * guessed at, and counted so the student knows the import was partial.
 */
export function toClassBlocks(entries: ExtractedClass[], subjects: Subject[]): ImportResult {
  const blocks: ClassInput[] = [];
  let skipped = 0;

  for (const entry of entries) {
    const day = dayIndexFor(entry.day);
    const startMinute = parseClock(entry.start);
    const endMinute = parseClock(entry.end);

    if (day === null || startMinute === null || endMinute === null || endMinute <= startMinute) {
      skipped += 1;
      continue;
    }

    const subject = matchSubject(entry.title, subjects);

    blocks.push({
      title: entry.title.trim(),
      kind: entry.kind?.trim() || null,
      subjectId: subject?.id ?? null,
      subjectName: subject?.name ?? null,
      day,
      startMinute,
      endMinute,
      venue: entry.venue?.trim() || null,
      color: subject?.color || colorForSubject(entry.title),
    });
  }

  return { imported: blocks.length, skipped, blocks };
}

/**
 * Links a scanned class to a subject the student already has, so the timetable
 * inherits its colour and the dashboard can cross-reference the two.
 */
function matchSubject(title: string, subjects: Subject[]): Subject | null {
  const haystack = title.toLowerCase();

  // A module code is the strongest signal — match it before anything fuzzy.
  const byCode = subjects.find(
    (subject) => subject.moduleCode && haystack.includes(subject.moduleCode.toLowerCase())
  );
  if (byCode) return byCode;

  const byName = subjects.find((subject) => haystack.includes(subject.name.toLowerCase()));
  return byName ?? null;
}

export async function saveClassBlocks(uid: string, blocks: ClassInput[]): Promise<void> {
  if (blocks.length === 0) return;
  const db = getDb();

  for (let index = 0; index < blocks.length; index += 400) {
    const batch = writeBatch(db);
    for (const block of blocks.slice(index, index + 400)) {
      batch.set(doc(paths.classes(db, uid)), { ...block, createdAt: serverTimestamp() });
    }
    await batch.commit();
  }
}

/** Reads a schedule image end to end: validate, OCR with Gemini, map to blocks. */
export async function scanTimetableImage(
  data: ArrayBuffer,
  fileName: string,
  mimeType: string,
  subjects: Subject[]
): Promise<ImportResult> {
  const kind = classify(fileName, mimeType);
  if (kind !== 'image') {
    throw new ParseError(
      `"${fileName}" is not an image. Upload a PNG, JPG or WEBP screenshot of your timetable.`
    );
  }
  if (data.byteLength > SIZE_LIMITS.image) {
    throw new ParseError(
      `That screenshot is ${humanSize(data.byteLength)}, over the ${humanSize(
        SIZE_LIMITS.image
      )} limit. Crop it to just the timetable and try again.`
    );
  }

  const entries = await extractTimetable(data, canonicalMimeType('image', mimeType));
  if (entries.length === 0) {
    throw new ParseError(
      'Gemini could not find any classes in that image. Make sure the whole grid is visible and the text is readable.'
    );
  }

  return toClassBlocks(entries, subjects);
}

/** Blocks for one day, earliest first. */
export function classesForDay(classes: ClassBlock[], day: number): ClassBlock[] {
  return classes
    .filter((block) => block.day === day)
    .sort((a, b) => a.startMinute - b.startMinute);
}

/** The next class today that has not finished yet. */
export function nextClass(classes: ClassBlock[], now = new Date()): ClassBlock | null {
  const day = (now.getDay() + 6) % 7;
  const minute = now.getHours() * 60 + now.getMinutes();
  return classesForDay(classes, day).find((block) => block.endMinute > minute) ?? null;
}
