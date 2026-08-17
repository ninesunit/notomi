import { Timestamp, getDocs, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { extractTeachingPlanFromText, type ExtractedTeachingPlan } from '@/lib/ai';
import { stableId } from '@/lib/ids';
import { paths } from '@/lib/paths';
import { toDate } from '@/lib/dates';
import type { Semester, Subject, TeachingPlanWeek } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { classify, extractText, ParseError } from './fileProcessor';
import type { MaterialFile } from './ingestion';

/**
 * Teaching plans, turned into dates.
 *
 * A plan says "Week 5: Pointers, Assignment 1 due". On its own that is a table
 * a student still has to translate; against the semester's start date it is a
 * calendar entry. So the two halves are deliberately separate here: the plan
 * stores week numbers exactly as printed, and the date is computed from the
 * term whenever it is needed. Re-import a corrected academic calendar and every
 * week moves with it, rather than staying wrong until the plan is uploaded
 * again.
 */

const DAY_MS = 86_400_000;

/** Monday of a teaching week, counted from the semester's first day. */
export function weekStart(semester: Semester | null, week: number): Date | null {
  const start = toDate(semester?.startDate ?? null);
  if (!start || week < 1) return null;

  const monday = new Date(start);
  // Terms rarely begin on a Monday; week 1 is the week containing day one.
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  return new Date(monday.getTime() + (week - 1) * 7 * DAY_MS);
}

/** Which teaching week a date falls in, or null outside the term. */
export function weekOf(semester: Semester | null, when: Date = new Date()): number | null {
  const first = weekStart(semester, 1);
  if (!first) return null;

  const elapsed = Math.floor((when.getTime() - first.getTime()) / (7 * DAY_MS)) + 1;
  if (elapsed < 1) return null;

  const end = toDate(semester?.endDate ?? null);
  if (end && when.getTime() > end.getTime() + 7 * DAY_MS) return null;
  return elapsed;
}

/** The Friday of a teaching week — where an undated weekly deadline lands. */
function weekDeadline(semester: Semester | null, week: number): Date | null {
  const monday = weekStart(semester, week);
  if (!monday) return null;
  const friday = new Date(monday.getTime() + 4 * DAY_MS);
  friday.setHours(17, 0, 0, 0);
  return friday;
}

/* ------------------------------------------------------------------ *
 * Reading one
 * ------------------------------------------------------------------ */

export async function analyseTeachingPlan(file: MaterialFile): Promise<ExtractedTeachingPlan> {
  const kind = classify(file.name, file.mimeType ?? '');
  if (kind !== 'pdf' && kind !== 'docx' && kind !== 'text') {
    throw new ParseError('Use the teaching plan as a PDF or Word document.');
  }

  const bytes = file.file
    ? await file.file.arrayBuffer()
    : await (await fetch(file.uri)).arrayBuffer();

  const parsed = await extractText(bytes, file.name, file.mimeType ?? 'application/pdf');
  if (parsed.text.trim().length < 200) {
    throw new ParseError('That document has too little text to read as a teaching plan.');
  }

  const plan = await extractTeachingPlanFromText(parsed.text);
  if (plan.weeks.length === 0) {
    throw new ParseError('No weekly schedule was found in that document.');
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 * Storing it
 * ------------------------------------------------------------------ */

export type TeachingPlanOutcome = {
  weeks: number;
  deadlines: number;
};

/**
 * Writes the plan against its subject, and the assessments into the to-do
 * collection the calendar already reads.
 *
 * Ids are derived from the subject and week, so re-uploading a corrected plan
 * updates the same rows instead of stacking a second copy of the semester.
 */
export async function commitTeachingPlan(
  uid: string,
  subject: Subject,
  semester: Semester | null,
  plan: ExtractedTeachingPlan,
  sourceFileName: string
): Promise<TeachingPlanOutcome> {
  const db = getDb();
  const batch = writeBatch(db);
  let deadlines = 0;

  for (const entry of plan.weeks) {
    const weekId = stableId(subject.id, `week-${entry.week}`);
    const monday = weekStart(semester, entry.week);

    batch.set(
      paths.teachingPlanWeek(db, uid, subject.id, weekId),
      {
        week: entry.week,
        topic: entry.topic,
        activity: entry.activity || null,
        assessment: entry.assessment || null,
        // Stored for reference; the date shown is always recomputed from the
        // term, so a corrected academic calendar moves the whole plan.
        printedDate: entry.dueDate ? Timestamp.fromDate(new Date(`${entry.dueDate}T12:00:00`)) : null,
        startsOn: monday ? Timestamp.fromDate(monday) : null,
        subjectId: subject.id,
        subjectName: subject.name,
        sourceFileName,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    if (!entry.assessment) continue;

    // A printed date beats a computed one; otherwise the end of that teaching
    // week is the honest guess, and it is marked as such in the title.
    const due = entry.dueDate
      ? new Date(`${entry.dueDate}T17:00:00`)
      : weekDeadline(semester, entry.week);
    if (!due) continue;

    batch.set(
      paths.todo(db, uid, stableId(subject.id, `plan-${entry.week}`)),
      {
        title: `${entry.assessment} — ${subject.name}`,
        dueDate: Timestamp.fromDate(due),
        isCompleted: false,
        subjectId: subject.id,
        subjectName: subject.name,
        priority: 'high',
        subTasks: [],
        source: 'syllabus',
        sourceDocumentId: null,
        createdAt: serverTimestamp(),
        completedAt: null,
      },
      // merge, so re-importing never resurrects something already ticked off.
      { merge: true }
    );
    deadlines += 1;
  }

  await batch.commit();
  return { weeks: plan.weeks.length, deadlines };
}

/** This week's row for a subject, for the dashboard. */
export async function currentWeekPlan(
  uid: string,
  subjectId: string,
  semester: Semester | null,
  now = new Date()
): Promise<TeachingPlanWeek | null> {
  const week = weekOf(semester, now);
  if (!week) return null;

  const snapshot = await getDocs(paths.teachingPlan(getDb(), uid, subjectId));
  const rows = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as TeachingPlanWeek);
  return rows.find((row) => row.week === week) ?? null;
}

export async function clearTeachingPlan(uid: string, subjectId: string): Promise<void> {
  const db = getDb();
  const snapshot = await getDocs(paths.teachingPlan(db, uid, subjectId));
  if (snapshot.empty) return;

  const batch = writeBatch(db);
  for (const entry of snapshot.docs) batch.delete(entry.ref);
  await batch.commit();
}

export { setDoc };
