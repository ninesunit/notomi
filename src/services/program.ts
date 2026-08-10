import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import type { Semester, Subject } from '@/lib/schema';

/**
 * Semester bookkeeping for the program planner.
 *
 * A semester is a thin record; the real content is which subjects point at it,
 * so every mutation here has to keep those pointers honest.
 */

export type SemesterInput = {
  name: string;
  year: number;
  term: string;
  gpaTarget?: number | null;
};

export async function createSemester(
  uid: string,
  input: SemesterInput,
  existing: Semester[]
): Promise<string> {
  const db = getDb();
  const ref = doc(paths.semesters(db, uid));

  await setDoc(ref, {
    name: input.name.trim(),
    year: input.year,
    term: input.term,
    gpaTarget: input.gpaTarget ?? null,
    // The first semester a student creates is the one they are in.
    isCurrent: existing.length === 0,
    order: existing.reduce((highest, semester) => Math.max(highest, semester.order ?? 0), -1) + 1,
    createdAt: serverTimestamp(),
  });

  return ref.id;
}

export async function updateSemester(
  uid: string,
  semesterId: string,
  patch: Partial<SemesterInput>
): Promise<void> {
  const db = getDb();
  await updateDoc(paths.semester(db, uid, semesterId), {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.year !== undefined ? { year: patch.year } : {}),
    ...(patch.term !== undefined ? { term: patch.term } : {}),
    ...(patch.gpaTarget !== undefined ? { gpaTarget: patch.gpaTarget } : {}),
  });
}

/**
 * Deleting a semester must not orphan its subjects — they go back to the
 * unassigned pile rather than pointing at a record that no longer exists.
 */
export async function deleteSemester(
  uid: string,
  semesterId: string,
  subjects: Subject[]
): Promise<void> {
  const db = getDb();
  const batch = writeBatch(db);

  for (const subject of subjects) {
    if (subject.semesterId === semesterId) {
      batch.update(paths.subject(db, uid, subject.id), { semesterId: null });
    }
  }
  await batch.commit();
  await deleteDoc(paths.semester(db, uid, semesterId));
}

/** Exactly one semester is current, so setting one clears the rest. */
export async function setCurrentSemester(
  uid: string,
  semesterId: string,
  semesters: Semester[]
): Promise<void> {
  const db = getDb();
  const batch = writeBatch(db);

  for (const semester of semesters) {
    const shouldBeCurrent = semester.id === semesterId;
    if (!!semester.isCurrent === shouldBeCurrent) continue;
    batch.update(paths.semester(db, uid, semester.id), { isCurrent: shouldBeCurrent });
  }

  await batch.commit();
}

/**
 * Swaps a semester with its neighbour. Orders are rewritten across the whole
 * list so a set imported with duplicate or missing orders self-heals.
 */
export async function moveSemester(
  uid: string,
  semesters: Semester[],
  semesterId: string,
  direction: -1 | 1
): Promise<void> {
  const ordered = [...semesters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const index = ordered.findIndex((semester) => semester.id === semesterId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ordered.length) return;

  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];

  const db = getDb();
  const batch = writeBatch(db);
  ordered.forEach((semester, position) => {
    if (semester.order === position) return;
    batch.update(paths.semester(db, uid, semester.id), { order: position });
  });
  await batch.commit();
}

export async function assignSubject(
  uid: string,
  subjectId: string,
  semesterId: string | null
): Promise<void> {
  const db = getDb();
  await updateDoc(paths.subject(db, uid, subjectId), {
    semesterId,
    updatedAt: serverTimestamp(),
  });
}

export async function setSubjectCredits(
  uid: string,
  subjectId: string,
  creditHours: number
): Promise<void> {
  const db = getDb();
  await updateDoc(paths.subject(db, uid, subjectId), {
    creditHours: Math.max(0, Math.min(30, creditHours)),
    updatedAt: serverTimestamp(),
  });
}

export async function setSubjectGrade(
  uid: string,
  subjectId: string,
  grade: string | null
): Promise<void> {
  const db = getDb();
  await updateDoc(paths.subject(db, uid, subjectId), {
    grade,
    updatedAt: serverTimestamp(),
  });
}

/** Sorts by explicit order, then newest-looking term as a tiebreak. */
export function sortSemesters(semesters: Semester[]): Semester[] {
  return [...semesters].sort((a, b) => {
    const byOrder = (a.order ?? 0) - (b.order ?? 0);
    if (byOrder !== 0) return byOrder;
    return (a.year ?? 0) - (b.year ?? 0);
  });
}

/**
 * What a student needs to average over their remaining credits to land on a
 * target GPA. Returns null when there is nothing left to earn.
 */
export function requiredAverage(
  targetGpa: number,
  earnedPoints: number,
  gradedCredits: number,
  remainingCredits: number
): number | null {
  if (remainingCredits <= 0) return null;
  const total = targetGpa * (gradedCredits + remainingCredits);
  return (total - earnedPoints) / remainingCredits;
}
