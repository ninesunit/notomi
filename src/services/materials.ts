import { deleteDoc, doc, getDoc, increment, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { paths } from '@/lib/paths';
import type { SourceDocument } from '@/lib/schema';
import { getDb } from '@/services/firebase';

/**
 * How a subject's materials are grouped and ordered.
 *
 * Two things were wrong for students. The model often cannot tell which chapter
 * a bare slide deck belongs to, so everything piled into "Ungrouped" with no way
 * to correct it — a label the app chose and the student could not. And within a
 * group the order was whatever Firestore returned, so lect10 sat between lect1
 * and lect2 the way string sorting always does.
 *
 * Both are fixed by letting the student's answer win: an explicit chapter beats
 * the model's guess, and an explicit position beats the number in the filename,
 * which in turn beats the title. Nothing is overwritten by a later upload.
 */

export const UNGROUPED = 'Ungrouped';

/** The group a document belongs to: the student's label, else the model's. */
export function chapterOf(document: SourceDocument): string {
  const chosen = document.chapter?.trim();
  if (chosen) return chosen;
  const code = document.moduleCode?.trim();
  return code || UNGROUPED;
}

/**
 * The number in "Lecture 10", "lect2", "wk03 - intro", "Topic 4.pdf".
 *
 * Read from the filename rather than the title because the title is often the
 * model's prose ("Introduction to Pointers") while the filename is what the
 * lecturer numbered. Returns null when there is no number to find, which sorts
 * such files after the numbered ones rather than pretending they are zero.
 */
export function lectureNumber(document: SourceDocument): number | null {
  const source = `${document.fileName ?? ''} ${document.title ?? ''}`;

  // A leading label followed by digits is the strongest signal.
  const labelled = /\b(?:lect(?:ure)?|lec|wk|week|topic|chapter|chap|ch|part|unit|session)\s*[-_. ]?(\d{1,3})\b/i.exec(
    source
  );
  if (labelled) return Number(labelled[1]);

  // Otherwise the first standalone number, ignoring anything that looks like a
  // course code (LDCW6123) or a year (2026).
  const cleaned = source.replace(/\b[a-z]{2,}\d{3,}\b/gi, ' ').replace(/\b(19|20)\d{2}\b/g, ' ');
  const bare = /\b(\d{1,3})\b/.exec(cleaned);
  return bare ? Number(bare[1]) : null;
}

/**
 * Student order first, then the lecturer's numbering, then the title.
 *
 * Sorting on the number rather than the string is the whole point: "lect10"
 * belongs after "lect9", and every string sort in existence disagrees.
 */
export function sortMaterials(documents: SourceDocument[]): SourceDocument[] {
  return [...documents].sort((a, b) => {
    const orderA = typeof a.order === 'number' ? a.order : null;
    const orderB = typeof b.order === 'number' ? b.order : null;
    if (orderA !== null || orderB !== null) {
      if (orderA === null) return 1;
      if (orderB === null) return -1;
      if (orderA !== orderB) return orderA - orderB;
    }

    const numberA = lectureNumber(a);
    const numberB = lectureNumber(b);
    if (numberA !== null || numberB !== null) {
      if (numberA === null) return 1;
      if (numberB === null) return -1;
      if (numberA !== numberB) return numberA - numberB;
    }

    return (a.title || a.fileName || '').localeCompare(b.title || b.fileName || '');
  });
}

/** Groups sorted by name, with the catch-all bucket always last. */
export function groupMaterials(documents: SourceDocument[]): [string, SourceDocument[]][] {
  const groups = new Map<string, SourceDocument[]>();
  for (const document of documents) {
    const key = chapterOf(document);
    const bucket = groups.get(key);
    if (bucket) bucket.push(document);
    else groups.set(key, [document]);
  }

  return [...groups.entries()]
    .map(([name, entries]) => [name, sortMaterials(entries)] as [string, SourceDocument[]])
    .sort(([a], [b]) =>
      a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b, undefined, { numeric: true })
    );
}

/* ------------------------------------------------------------------ *
 * Writing the student's answer back
 * ------------------------------------------------------------------ */

/** Renames a whole group in one commit, so the list never half-moves. */
export async function renameChapter(
  uid: string,
  subjectId: string,
  documents: SourceDocument[],
  nextName: string
): Promise<void> {
  const clean = nextName.trim().slice(0, 80);
  if (!clean) throw new Error('A chapter needs a name.');
  if (documents.length === 0) return;

  const db = getDb();
  const batch = writeBatch(db);
  for (const document of documents) {
    batch.update(paths.document(db, uid, subjectId, document.id), { chapter: clean });
  }
  await batch.commit();
}

/** Moves one document out of its group and into another. */
export async function setChapter(
  uid: string,
  subjectId: string,
  documentId: string,
  chapter: string | null
): Promise<void> {
  const db = getDb();
  await updateDoc(paths.document(db, uid, subjectId, documentId), {
    // Null clears the override and hands the grouping back to the model.
    chapter: chapter?.trim() ? chapter.trim().slice(0, 80) : null,
  });
}

/**
 * Moves a document one place within its group.
 *
 * The whole group is renumbered rather than just the pair swapped: half the
 * documents typically have no position yet, and giving every one an explicit
 * index is what stops the next move fighting the filename numbering.
 */
export async function moveMaterial(
  uid: string,
  subjectId: string,
  documents: SourceDocument[],
  documentId: string,
  direction: -1 | 1
): Promise<void> {
  const ordered = sortMaterials(documents);
  const index = ordered.findIndex((entry) => entry.id === documentId);
  if (index < 0) return;

  const target = index + direction;
  if (target < 0 || target >= ordered.length) return;

  const moved = [...ordered];
  [moved[index], moved[target]] = [moved[target], moved[index]];

  const db = getDb();
  const batch = writeBatch(db);
  moved.forEach((entry, position) => {
    batch.update(paths.document(db, uid, subjectId, entry.id), { order: position });
  });
  await batch.commit();
}

/** Drops every manual position so the lecturer's numbering takes over again. */
export async function clearManualOrder(
  uid: string,
  subjectId: string,
  documents: SourceDocument[]
): Promise<void> {
  const db = getDb();
  const batch = writeBatch(db);
  for (const document of documents) {
    batch.update(paths.document(db, uid, subjectId, document.id), { order: null });
  }
  await batch.commit();
}

/**
 * Files a document into a different subject.
 *
 * Documents live in a subcollection of their subject, so moving one is a copy
 * and a delete rather than a field change. The Drive original is deliberately
 * left where it is: re-parenting it would cost an extra round trip on a slow
 * connection to fix something nobody is looking at, and the file resolves by
 * id regardless of which folder holds it.
 */
export async function moveMaterialToSubject(
  uid: string,
  fromSubjectId: string,
  toSubjectId: string,
  documentId: string
): Promise<string> {
  if (fromSubjectId === toSubjectId) return documentId;

  const db = getDb();
  const source = paths.document(db, uid, fromSubjectId, documentId);
  const snapshot = await getDoc(source);
  if (!snapshot.exists()) throw new Error('That material is no longer there.');

  const target = doc(paths.documents(db, uid, toSubjectId));
  await setDoc(target, {
    ...snapshot.data(),
    // The chapter was a guess made in the old folder; the new subject regroups.
    chapter: null,
    order: null,
  });
  await deleteDoc(source);

  await Promise.all([
    updateDoc(paths.subject(db, uid, toSubjectId), { documentCount: increment(1) }).catch(
      () => undefined
    ),
    updateDoc(paths.subject(db, uid, fromSubjectId), { documentCount: increment(-1) }).catch(
      () => undefined
    ),
  ]);

  return target.id;
}
