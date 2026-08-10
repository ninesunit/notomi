import { doc, getDocs, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { extractTimetable } from '@/lib/ai';
import { paths } from '@/lib/paths';
import {
  colorForSubject,
  DAY_FULL,
  minutesToClock,
  parseClock,
  type ClassBlock,
  type ExtractedClass,
  type RoutineBlock,
  type Subject,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import {
  canonicalMimeType,
  classify,
  downscaleImage,
  humanSize,
  ParseError,
  SIZE_LIMITS,
} from './fileProcessor';

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

/**
 * One extracted class, staged for review.
 *
 * Vision output is good but not authoritative — a smudged room number or a
 * misread column is common — so nothing is written until a student has seen
 * these rows and said yes. Every field is editable and every row can be
 * excluded.
 */
export type ImportRow = {
  id: string;
  include: boolean;
  title: string;
  code: string;
  kind: string;
  day: number;
  start: string;
  end: string;
  venue: string;
  /** Set when this maps onto a subject the student already has. */
  existingSubjectId: string | null;
};

export type StagedImport = {
  rows: ImportRow[];
  /** Rows Gemini returned that could not be made sense of at all. */
  skipped: number;
};

/**
 * Turns what Gemini read off a screenshot into reviewable rows.
 *
 * Rows we cannot trust — an unrecognisable day, a time that will not parse, an
 * end before its start — are dropped rather than guessed at, and counted so the
 * student knows the scan was partial.
 */
export function toImportRows(entries: ExtractedClass[], subjects: Subject[]): StagedImport {
  const rows: ImportRow[] = [];
  let skipped = 0;

  entries.forEach((entry, index) => {
    const day = dayIndexFor(entry.day);
    const startMinute = parseClock(entry.start);
    const endMinute = parseClock(entry.end);

    if (day === null || startMinute === null || endMinute === null || endMinute <= startMinute) {
      skipped += 1;
      return;
    }

    // Many schedules print a code and a session type but no course name. The
    // code is then the subject's identity, and the student renames it later if
    // they want — inventing a title here would be worse than showing the code.
    const code = entry.code?.trim() ?? '';
    const title = entry.title?.trim() || code || 'Untitled class';
    const existing = matchSubject(title, code, subjects);

    rows.push({
      id: `row-${index}`,
      include: true,
      title,
      code,
      kind: entry.kind?.trim() ?? '',
      day,
      start: minutesToClock(startMinute),
      end: minutesToClock(endMinute),
      venue: entry.venue?.trim() ?? '',
      existingSubjectId: existing?.id ?? null,
    });
  });

  return { rows, skipped };
}

/**
 * Links a scanned class to a subject the student already has, so an import
 * onto an existing library adds classes rather than duplicate folders.
 */
function matchSubject(title: string, code: string, subjects: Subject[]): Subject | null {
  const normalisedCode = code.replace(/\s+/g, '').toLowerCase();

  // A module code is the strongest signal — match it before anything fuzzy.
  if (normalisedCode) {
    const byCode = subjects.find(
      (subject) =>
        subject.moduleCode &&
        subject.moduleCode.replace(/\s+/g, '').toLowerCase() === normalisedCode
    );
    if (byCode) return byCode;
  }

  const haystack = title.toLowerCase();
  return (
    subjects.find(
      (subject) =>
        subject.name.toLowerCase() === haystack ||
        (subject.name.length > 4 && haystack.includes(subject.name.toLowerCase()))
    ) ?? null
  );
}

export type ImportOutcome = {
  subjectsCreated: number;
  subjectsReused: number;
  classesAdded: number;
};

/**
 * Commits a reviewed import across all three systems at once.
 *
 * A scanned schedule is the one moment where a student's library, timetable and
 * program structure can all be populated from a single action, so it does all
 * three rather than leaving two of them to be filled in by hand. Rows for the
 * same course become one subject with several class blocks.
 */
export async function commitImport(
  uid: string,
  rows: ImportRow[],
  options: { semesterId: string | null }
): Promise<ImportOutcome> {
  const db = getDb();
  const included = rows.filter((row) => row.include);
  if (included.length === 0) return { subjectsCreated: 0, subjectsReused: 0, classesAdded: 0 };

  // Group by course so "CS2040 Lecture" and "CS2040 Tutorial" share one folder.
  const groups = new Map<string, ImportRow[]>();
  for (const row of included) {
    const key = (row.code.trim() || row.title.trim()).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  let subjectsCreated = 0;
  let subjectsReused = 0;
  const classes: ClassInput[] = [];

  for (const rowsForCourse of groups.values()) {
    const lead = rowsForCourse[0];
    const color = colorForSubject(lead.code || lead.title);

    let subjectId = lead.existingSubjectId;
    if (subjectId) {
      subjectsReused += 1;
      // An import into an existing folder still files it under the chosen term.
      if (options.semesterId) {
        await updateDoc(paths.subject(db, uid, subjectId), {
          semesterId: options.semesterId,
          updatedAt: serverTimestamp(),
        });
      }
    } else {
      const ref = doc(paths.subjects(db, uid));
      await setDoc(ref, {
        name: lead.title.trim() || lead.code.trim(),
        moduleCode: lead.code.trim() || null,
        color,
        emoji: null,
        tag: null,
        documentCount: 0,
        semesterId: options.semesterId,
        creditHours: 0,
        grade: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      subjectId = ref.id;
      subjectsCreated += 1;
    }

    for (const row of rowsForCourse) {
      const startMinute = parseClock(row.start);
      const endMinute = parseClock(row.end);
      if (startMinute === null || endMinute === null || endMinute <= startMinute) continue;

      classes.push({
        title: [row.code.trim(), row.title.trim()].filter(Boolean).join(' ').trim(),
        kind: row.kind.trim() || null,
        subjectId,
        subjectName: lead.title.trim() || lead.code.trim(),
        day: row.day,
        startMinute,
        endMinute,
        venue: row.venue.trim() || null,
        color,
      });
    }
  }

  await saveClassBlocks(uid, classes);
  return { subjectsCreated, subjectsReused, classesAdded: classes.length };
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

/** Reads a schedule image: validate, OCR with Gemini, stage for review. */
export async function scanTimetableImage(
  data: ArrayBuffer,
  fileName: string,
  mimeType: string,
  subjects: Subject[]
): Promise<StagedImport> {
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

  // Shrunk first: a full-page screenshot is often several megabytes, and the
  // inline request budget is the most common reason a scan fails outright.
  const shrunk = await downscaleImage(data, canonicalMimeType('image', mimeType));
  const entries = await extractTimetable(shrunk.data, shrunk.mimeType);

  if (entries.length === 0) {
    throw new ParseError(
      'Gemini read that image but found no classes in it. Crop the screenshot to just the ' +
        'timetable grid — including the day headers and the time column — and try again.'
    );
  }

  const staged = toImportRows(entries, subjects);
  if (staged.rows.length === 0) {
    throw new ParseError(
      `Gemini found ${entries.length} class${entries.length === 1 ? '' : 'es'} but could not ` +
        'make sense of the days or times. Add them by hand, or try a screenshot where the day ' +
        'headers and start/end times are clearly visible.'
    );
  }

  return staged;
}

/* ------------------------------------------------------------------ *
 * Routines: the non-academic overlay
 * ------------------------------------------------------------------ */

export type RoutineInput = {
  title: string;
  category: string;
  day: number;
  startMinute: number;
  endMinute: number;
  venue: string | null;
  color: string;
};

export async function saveRoutine(
  uid: string,
  input: RoutineInput,
  routineId?: string
): Promise<string> {
  const db = getDb();
  const ref = routineId ? paths.routine(db, uid, routineId) : doc(paths.routines(db, uid));

  const fields = {
    title: input.title.trim(),
    category: input.category,
    day: input.day,
    startMinute: input.startMinute,
    endMinute: input.endMinute,
    venue: input.venue?.trim() || null,
    color: input.color,
  };

  if (routineId) await updateDoc(ref, fields);
  else await setDoc(ref, { ...fields, createdAt: serverTimestamp() });

  return ref.id;
}

export async function deleteRoutine(uid: string, routineId: string): Promise<void> {
  const db = getDb();
  const { deleteDoc } = await import('firebase/firestore');
  await deleteDoc(paths.routine(db, uid, routineId));
}

/**
 * The academic timetable, filtered to subjects that still exist.
 *
 * A block whose subject was deleted is stale — it would render a class for a
 * course the student no longer has. Blocks are only shown once they are linked
 * to a live subject, which is what keeps the grid and the library in step.
 */
export function academicClasses(classes: ClassBlock[], subjects: Subject[]): ClassBlock[] {
  const live = new Set(subjects.map((subject) => subject.id));
  return classes.filter((block) => block.subjectId !== null && live.has(block.subjectId));
}

/** Blocks whose subject is missing, so the UI can offer to link or remove them. */
export function unlinkedClasses(classes: ClassBlock[], subjects: Subject[]): ClassBlock[] {
  const live = new Set(subjects.map((subject) => subject.id));
  return classes.filter((block) => block.subjectId === null || !live.has(block.subjectId));
}

/** Blocks for one day, earliest first. */
export function classesForDay(classes: ClassBlock[], day: number): ClassBlock[] {
  return classes
    .filter((block) => block.day === day)
    .sort((a, b) => a.startMinute - b.startMinute);
}

export function routinesForDay(routines: RoutineBlock[], day: number): RoutineBlock[] {
  return routines
    .filter((block) => block.day === day)
    .sort((a, b) => a.startMinute - b.startMinute);
}

/** The next class today that has not finished yet. */
export function nextClass(classes: ClassBlock[], now = new Date()): ClassBlock | null {
  const day = (now.getDay() + 6) % 7;
  const minute = now.getHours() * 60 + now.getMinutes();
  return classesForDay(classes, day).find((block) => block.endMinute > minute) ?? null;
}
