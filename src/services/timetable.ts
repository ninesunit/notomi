import {
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { extractTimetable, extractTimetableFromText } from '@/lib/ai';
import { paths } from '@/lib/paths';
import {
  colorForSubject,
  DAY_FULL,
  minutesToClock,
  parseClock,
  parseCourseCode,
  tidyName,
  type ClassBlock,
  type ExtractedClass,
  type RoutineBlock,
  type Semester,
  type Subject,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import {
  canonicalMimeType,
  classify,
  downscaleImage,
  extractText,
  humanSize,
  ParseError,
  SIZE_LIMITS,
} from './fileProcessor';
import { MAX_BATCH_BYTES, type MaterialFile, validateMaterialBatch } from './ingestion';

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
  /** Section/session id: TC1L, TL2L, G3. Null where the schedule prints none. */
  section: string | null;
  subjectId: string | null;
  subjectName: string | null;
  day: number;
  startMinute: number;
  endMinute: number;
  venue: string | null;
  color: string;
  semesterId?: string | null;
  startDate?: Semester['startDate'];
  endDate?: Semester['endDate'];
};

export async function saveClass(uid: string, input: ClassInput, classId?: string): Promise<string> {
  const db = getDb();
  const ref = classId ? paths.class(db, uid, classId) : doc(paths.classes(db, uid));

  const fields = {
    title: input.title.trim(),
    kind: input.kind?.trim() || null,
    section: input.section?.trim().toUpperCase() || null,
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    day: input.day,
    startMinute: input.startMinute,
    endMinute: input.endMinute,
    venue: input.venue?.trim() || null,
    color: input.color,
    ...(input.semesterId !== undefined ? { semesterId: input.semesterId } : {}),
    ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
    ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
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

/**
 * Removes class blocks and nothing else.
 *
 * Subjects, their documents, notes, chats, flashcards and every semester in the
 * program structure are in other collections and are not touched — clearing a
 * timetable at the start of a new term must not take last term's record with
 * it, because the record is the thing a student keeps.
 *
 * Pass the ids currently on screen to clear just that term; pass nothing to
 * clear every block.
 */
export async function clearTimetable(uid: string, classIds?: string[]): Promise<number> {
  const db = getDb();

  const refs = classIds
    ? classIds.map((id) => paths.class(db, uid, id))
    : (await getDocs(paths.classes(db, uid))).docs.map((block) => block.ref);
  if (refs.length === 0) return 0;

  for (let index = 0; index < refs.length; index += 400) {
    const batch = writeBatch(db);
    for (const ref of refs.slice(index, index + 400)) batch.delete(ref);
    await batch.commit();
  }
  return refs.length;
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
Object.assign(DAY_LOOKUP, {
  m: 0,
  tu: 1,
  w: 2,
  th: 3,
  r: 3,
  f: 4,
  sa: 5,
  su: 6,
});

export function dayIndexFor(value: string): number | null {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
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
  /** Section/session id for this block: TC1L, TL2L, G3. */
  section: string;
  kind: string;
  day: number;
  start: string;
  end: string;
  venue: string;
  /** Set when this maps onto a subject the student already has. */
  existingSubjectId: string | null;
  /** Which uploaded file produced this row. */
  sourceFile: string;
  /** Existing academic/routine blocks this session overlaps. */
  conflicts: ImportConflict[];
};

export type ImportConflict = {
  type: 'class' | 'routine';
  id: string;
  title: string;
  startMinute: number;
  endMinute: number;
};

/**
 * One subject and every session detected for it.
 *
 * The scan produces rows — one per block on the screenshot — but a student
 * thinks in subjects: "CS2102, three sessions", not "eight classes". Grouping
 * before review means the code and the name are typed once instead of once per
 * block, which on a real timetable is the difference between two edits and
 * eight.
 */
export type ImportGroup = {
  /** Stable across edits, so re-keying a card does not remount it. */
  id: string;
  code: string;
  title: string;
  /** Set when this maps onto a subject the student already has. */
  existingSubjectId: string | null;
  include: boolean;
  sessions: ImportRow[];
};

/** Collapses scanned rows into one entry per course. */
export function groupImportRows(rows: ImportRow[]): ImportGroup[] {
  const groups = new Map<string, ImportGroup>();

  for (const row of rows) {
    // Keyed on the course code alone: two sections of one course are one
    // subject with two sessions, not two subjects.
    const key = (parseCourseCode(row.code).code || row.title.trim()).toLowerCase();
    const existing = groups.get(key);

    if (existing) {
      existing.sessions.push(row);
      // A later row may carry the detail an earlier one lacked.
      existing.code ||= row.code;
      existing.title ||= row.title;
      existing.existingSubjectId ??= row.existingSubjectId;
      continue;
    }

    groups.set(key, {
      id: `group-${key || row.id}`,
      code: row.code,
      title: row.title,
      existingSubjectId: row.existingSubjectId,
      include: true,
      sessions: [row],
    });
  }

  for (const group of groups.values()) {
    group.sessions.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  }

  return [...groups.values()];
}

/**
 * Back to flat rows for the commit.
 *
 * The subject-level fields are stamped onto every session, which is what makes
 * one edit at the top of a card apply to all of its blocks.
 */
export function flattenImportGroups(groups: ImportGroup[]): ImportRow[] {
  return groups.flatMap((group) =>
    group.sessions.map((session) => ({
      ...session,
      code: group.code,
      title: group.title,
      existingSubjectId: group.existingSubjectId,
      include: group.include && session.include,
    }))
  );
}

export type StagedImport = {
  rows: ImportRow[];
  /** Rows Gemini returned that could not be made sense of at all. */
  skipped: number;
  sourceFiles: string[];
};

/**
 * Turns what Gemini read off a screenshot into reviewable rows.
 *
 * Rows we cannot trust — an unrecognisable day, a time that will not parse, an
 * end before its start — are dropped rather than guessed at, and counted so the
 * student knows the scan was partial.
 */
export function toImportRows(
  entries: ExtractedClass[],
  subjects: Subject[],
  existingClasses: ClassBlock[] = [],
  routines: RoutineBlock[] = [],
  sourceFile = ''
): StagedImport {
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
    //
    // The section is split off here rather than left in the code: "LDCW6123
    // TC1L" and "LDCW6123 TL1L" are one course, and grouping on the raw string
    // made them two subjects with two library folders.
    const parsed = parseCourseCode(entry.code);
    const code = parsed.code;
    const section = (entry.section?.trim().toUpperCase() || parsed.section) ?? '';
    // Schedules print course names in block capitals; a library of those reads
    // like shouting, so the staged name is calmed before it is ever shown.
    const title = tidyName(entry.title?.trim() || '') || code || 'Untitled class';
    const existing = matchSubject(title, code, subjects);
    const conflicts: ImportConflict[] = [
      ...existingClasses
        .filter(
          (block) =>
            block.day === day && block.startMinute < endMinute && block.endMinute > startMinute
        )
        .map((block) => ({
          type: 'class' as const,
          id: block.id,
          title: block.subjectName || block.title,
          startMinute: block.startMinute,
          endMinute: block.endMinute,
        })),
      ...routines
        .filter(
          (block) =>
            block.day === day && block.startMinute < endMinute && block.endMinute > startMinute
        )
        .map((block) => ({
          type: 'routine' as const,
          id: block.id,
          title: block.title,
          startMinute: block.startMinute,
          endMinute: block.endMinute,
        })),
    ];

    rows.push({
      id: `row-${index}`,
      include: true,
      title,
      code,
      section,
      kind: entry.kind?.trim() ?? '',
      day,
      start: minutesToClock(startMinute),
      end: minutesToClock(endMinute),
      venue: entry.venue?.trim() ?? '',
      existingSubjectId: existing?.id ?? null,
      sourceFile,
      conflicts,
    });
  });

  return { rows, skipped, sourceFiles: sourceFile ? [sourceFile] : [] };
}

/**
 * Links a scanned class to a subject the student already has, so an import
 * onto an existing library adds classes rather than duplicate folders.
 */
function matchSubject(title: string, code: string, subjects: Subject[]): Subject | null {
  const normalisedCode = parseCourseCode(code).code.toLowerCase();

  // A module code is the strongest signal — match it before anything fuzzy.
  if (normalisedCode) {
    const byCode = subjects.find(
      (subject) =>
        subject.moduleCode &&
        parseCourseCode(subject.moduleCode).code.toLowerCase() === normalisedCode
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

  const semester = options.semesterId
    ? ((await getDoc(paths.semester(db, uid, options.semesterId))).data() as Semester | undefined)
    : undefined;

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
        attendanceAttended: 0,
        attendanceMissed: 0,
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

      // The block's name is the subject's name, not a concatenation of its
      // own: the subject owns the identity, and this copy is only a cache for
      // the readers that cannot join.
      const subjectName = lead.title.trim() || lead.code.trim();

      classes.push({
        title: subjectName,
        kind: row.kind.trim() || null,
        section: row.section.trim() || null,
        subjectId,
        subjectName,
        day: row.day,
        startMinute,
        endMinute,
        venue: row.venue.trim() || null,
        color,
        semesterId: options.semesterId,
        startDate: semester?.startDate ?? null,
        endDate: semester?.endDate ?? null,
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
      batch.set(doc(paths.classes(db, uid)), {
        ...block,
        createdAt: serverTimestamp(),
      });
    }
    await batch.commit();
  }
}

/** Reads a universal schedule batch and stages the merged sessions for review. */
export async function scanTimetableFiles(
  files: MaterialFile[],
  subjects: Subject[],
  existingClasses: ClassBlock[] = [],
  routines: RoutineBlock[] = []
): Promise<StagedImport> {
  validateMaterialBatch(files);

  const allRows: ImportRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let actualBytes = 0;

  for (const file of files) {
    const kind = classify(file.name, file.mimeType ?? '');
    if (kind !== 'pdf' && kind !== 'image' && kind !== 'pptx') {
      throw new ParseError(
        `"${file.name}" is not a supported schedule file. Use PDF, PNG, JPG, WEBP or PPTX.`
      );
    }

    const bytes = file.file
      ? await file.file.arrayBuffer()
      : await (await fetch(file.uri)).arrayBuffer();
    actualBytes += bytes.byteLength;
    if (actualBytes > MAX_BATCH_BYTES) {
      throw new ParseError(
        `The selected files are ${humanSize(actualBytes)} in total. The batch limit is ${humanSize(
          MAX_BATCH_BYTES
        )}.`
      );
    }

    let entries: ExtractedClass[];
    if (kind === 'pptx') {
      const parsed = await extractText(bytes, file.name, file.mimeType ?? '');
      entries = await extractTimetableFromText(parsed.text);
    } else if (kind === 'image') {
      const shrunk = await downscaleImage(bytes, canonicalMimeType('image', file.mimeType));
      entries = await extractTimetable(shrunk.data, shrunk.mimeType);
    } else {
      // Most exported schedules contain selectable text. Parsing that locally
      // turns a base64 PDF request into a small text request and avoids the
      // long multimodal timeout. Image-only print-to-PDF schedules retain the
      // original Gemini Vision fallback.
      try {
        const parsed = await extractText(bytes, file.name, file.mimeType ?? 'application/pdf');
        try {
          entries = await extractTimetableFromText(parsed.text);
          // A PDF can advertise a text layer that contains only page chrome,
          // broken font mappings or invisible glyphs. An empty structured
          // result is not success: retry against the rendered document.
          if (entries.length === 0) {
            entries = await extractTimetable(bytes, 'application/pdf');
          }
        } catch {
          entries = await extractTimetable(bytes, 'application/pdf');
        }
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
        entries = await extractTimetable(bytes, 'application/pdf');
      }
    }

    const staged = toImportRows(entries, subjects, existingClasses, routines, file.name);
    skipped += staged.skipped;
    for (const row of staged.rows) {
      const key = [
        parseCourseCode(row.code).code || row.title.toLowerCase(),
        row.day,
        row.start,
        row.end,
        row.venue.toLowerCase(),
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      allRows.push(row);
    }
  }

  if (allRows.length === 0) {
    throw new ParseError(
      'The files were read, but no complete class sessions were found. Include course labels, weekdays and start/end times.'
    );
  }

  return {
    rows: allRows,
    skipped,
    sourceFiles: files.map((file) => file.name),
  };
}

/** Backwards-compatible single-image entry point used by older callers. */
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
      'That image was read, but no classes were found in it. Crop the screenshot to just the ' +
        'timetable grid — including the day headers and the time column — and try again.'
    );
  }

  const staged = toImportRows(entries, subjects, [], [], fileName);
  if (staged.rows.length === 0) {
    throw new ParseError(
      `${entries.length} class${entries.length === 1 ? '' : 'es'} were found, but their days ` +
        'or times could not be made sense of. Add them by hand, or try a screenshot where the ' +
        'day headers and start/end times are clearly visible.'
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
/**
 * A class block joined to the subject it belongs to.
 *
 * The subject is the source of truth for a class's name, code and colour; the
 * copies stored on the block are a cache for the places that cannot join —
 * notifications, search, the calendar. Renaming a subject in the library
 * therefore changes every block on the timetable the moment the snapshot
 * arrives, with no migration and nothing to keep in step by hand.
 */
export type ResolvedClass = ClassBlock & {
  /** Module code, from the parent subject. */
  code: string | null;
  /** False when the block points at a subject that no longer exists. */
  linked: boolean;
};

/** Joins each block to its subject, leaving unlinked blocks marked as such. */
export function resolveClasses(classes: ClassBlock[], subjects: Subject[]): ResolvedClass[] {
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));

  return classes.map((block) => {
    const subject = block.subjectId ? byId.get(block.subjectId) : undefined;
    if (!subject) return { ...block, code: null, linked: false };

    return {
      ...block,
      // The join wins over the stored copy, which may be a rename behind.
      subjectName: subject.name,
      color: subject.color || block.color,
      code: subject.moduleCode,
      linked: true,
    };
  });
}

/** Only blocks whose subject is live, joined to it. */
export function academicClasses(classes: ClassBlock[], subjects: Subject[]): ResolvedClass[] {
  return resolveClasses(classes, subjects).filter((block) => block.linked);
}

/**
 * Pushes a renamed, recoloured or recoded subject down onto its blocks.
 *
 * The UI does not need this — it joins on render — but the notification
 * scheduler, the calendar and global search read stored fields, and a reminder
 * that names last week's title is a bug a student would notice. Cheap to keep
 * consistent, so it is kept consistent.
 */
export async function syncSubjectToClasses(
  uid: string,
  subject: { id: string; name: string; color: string }
): Promise<number> {
  const db = getDb();
  const snapshot = await getDocs(
    query(paths.classes(db, uid), where('subjectId', '==', subject.id))
  );
  if (snapshot.empty) return 0;

  const batch = writeBatch(db);
  for (const document of snapshot.docs) {
    batch.update(document.ref, {
      // The title tracks the subject too: under the relational model a block is
      // "this subject, this session type", not a free-text name of its own.
      title: subject.name,
      subjectName: subject.name,
      color: subject.color,
    });
  }
  await batch.commit();

  return snapshot.size;
}

/** Blocks whose subject is missing, so the UI can offer to link or remove them. */
export function unlinkedClasses(classes: ClassBlock[], subjects: Subject[]): ClassBlock[] {
  const live = new Set(subjects.map((subject) => subject.id));
  return classes.filter((block) => block.subjectId === null || !live.has(block.subjectId));
}

/** Blocks for one day, earliest first. Generic so a join is not lost here. */
export function classesForDay<T extends ClassBlock>(classes: T[], day: number): T[] {
  return classes.filter((block) => block.day === day).sort((a, b) => a.startMinute - b.startMinute);
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
