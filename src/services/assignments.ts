import {
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Timestamp,
} from 'firebase/firestore';
import { breakDownAssignment } from '@/lib/ai';
import { dayKey, parseDueDate } from '@/lib/dates';
import { paths } from '@/lib/paths';
import {
  assignmentKind,
  type Assignment,
  type AssignmentBreakdown,
  type AssignmentKind,
  type AssignmentStep,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { extractText } from './fileProcessor';
import type { MaterialFile } from './ingestion';

/**
 * Tutorials, labs and assignments.
 *
 * A student drops in the brief; Gemini reads it into a plan and a deadline. The
 * deadline is mirrored into the ordinary to-do collection rather than kept
 * private to this feature, so it lands in the calendar and the dashboard
 * countdown like any other date — one deadline engine, not two.
 */

/** Steps need stable ids so ticking one does not re-key the rest. */
function withIds(steps: { title: string; detail: string | null }[]): AssignmentStep[] {
  return steps.map((step, index) => ({
    id: `s${index}-${step.title.slice(0, 24).replace(/[^\w]+/g, '-').toLowerCase()}`,
    title: step.title,
    detail: step.detail,
    isCompleted: false,
  }));
}

async function readBrief(file: MaterialFile): Promise<{ text: string; name: string }> {
  const bytes = file.file
    ? await file.file.arrayBuffer()
    : await (await fetch(file.uri)).arrayBuffer();

  const parsed = await extractText(bytes, file.name, file.mimeType ?? '');
  return { text: parsed.text, name: file.name };
}

export type AnalyseInput = {
  subjectId: string;
  subjectName: string;
  /** A picked file, or text pasted straight into the form. */
  file?: MaterialFile;
  text?: string;
};

/**
 * Reads a brief without saving anything.
 *
 * Kept separate from the write so the student can look at what Gemini made of
 * it — and fix the deadline it guessed — before it becomes a row and a to-do.
 */
export async function analyseBrief(
  input: AnalyseInput
): Promise<{ breakdown: AssignmentBreakdown; sourceText: string; fileName: string | null }> {
  let text = (input.text ?? '').trim();
  let fileName: string | null = null;

  if (input.file) {
    const read = await readBrief(input.file);
    text = read.text.trim();
    fileName = read.name;
  }

  if (!text) {
    throw new Error('There was no readable text in that brief. Paste the task description instead.');
  }

  const breakdown = await breakDownAssignment({
    subjectName: input.subjectName,
    text,
    fileName,
    today: dayKey(new Date()),
  });

  return { breakdown, sourceText: text, fileName };
}

export type SaveInput = {
  subjectId: string;
  subjectName: string;
  title: string;
  kind: AssignmentKind;
  brief: string | null;
  sourceText: string | null;
  sourceFileName: string | null;
  steps: AssignmentStep[];
  deliverables: string[];
  markingNotes: string | null;
  estimatedHours: number | null;
  dueDate: Timestamp | null;
};

/**
 * Writes the task and its mirrored to-do in one go.
 *
 * The to-do id is derived from the assignment id, so re-saving updates the same
 * row instead of stacking duplicates every time a deadline is corrected.
 */
export async function saveAssignment(
  uid: string,
  input: SaveInput,
  assignmentId?: string
): Promise<string> {
  const db = getDb();
  const ref = assignmentId
    ? paths.assignment(db, uid, input.subjectId, assignmentId)
    : doc(paths.assignments(db, uid, input.subjectId));

  const todoId = `assignment-${ref.id}`;

  const fields = {
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    title: input.title.trim() || 'Untitled task',
    kind: input.kind,
    brief: input.brief,
    sourceText: input.sourceText ? input.sourceText.slice(0, 800_000) : null,
    sourceFileName: input.sourceFileName,
    steps: input.steps,
    deliverables: input.deliverables,
    markingNotes: input.markingNotes,
    estimatedHours: input.estimatedHours,
    dueDate: input.dueDate,
    todoId: input.dueDate ? todoId : null,
    updatedAt: serverTimestamp(),
  };

  if (assignmentId) await updateDoc(ref, fields);
  else await setDoc(ref, { ...fields, status: 'todo', createdAt: serverTimestamp() });

  await syncTodo(uid, ref.id, { ...input, todoId });

  return ref.id;
}

/**
 * Mirrors the deadline into users/{uid}/todos.
 *
 * The steps become sub-tasks, which is what makes the to-do useful rather than
 * a bare title with a date on it.
 */
async function syncTodo(
  uid: string,
  assignmentId: string,
  input: SaveInput & { todoId: string }
): Promise<void> {
  const db = getDb();
  const ref = paths.todo(db, uid, input.todoId);

  if (!input.dueDate) {
    // A task with no date should not sit in the calendar claiming one.
    await deleteDoc(ref).catch(() => undefined);
    return;
  }

  await setDoc(
    ref,
    {
      title: input.title.trim() || 'Untitled task',
      dueDate: input.dueDate,
      isCompleted: false,
      subjectId: input.subjectId,
      subjectName: input.subjectName,
      priority: 'high',
      subTasks: input.steps.map((step) => ({
        id: step.id,
        title: step.title,
        isCompleted: step.isCompleted,
      })),
      source: 'syllabus',
      sourceDocumentId: assignmentId,
      createdAt: serverTimestamp(),
      completedAt: null,
    },
    // merge: a re-save must not clear a completion the student made on the
    // to-dos screen.
    { merge: true }
  );
}

export async function setAssignmentStatus(
  uid: string,
  subjectId: string,
  assignmentId: string,
  status: Assignment['status']
): Promise<void> {
  const db = getDb();
  await updateDoc(paths.assignment(db, uid, subjectId, assignmentId), {
    status,
    updatedAt: serverTimestamp(),
  });

  // Finishing the work finishes the deadline; the reverse reopens it.
  await updateDoc(paths.todo(db, uid, `assignment-${assignmentId}`), {
    isCompleted: status === 'done',
    completedAt: status === 'done' ? serverTimestamp() : null,
  }).catch(() => undefined);
}

export async function toggleStep(
  uid: string,
  assignment: Assignment,
  stepId: string
): Promise<void> {
  const db = getDb();
  const steps = assignment.steps.map((step) =>
    step.id === stepId ? { ...step, isCompleted: !step.isCompleted } : step
  );

  await updateDoc(paths.assignment(db, uid, assignment.subjectId, assignment.id), {
    steps,
    updatedAt: serverTimestamp(),
  });

  await updateDoc(paths.todo(db, uid, `assignment-${assignment.id}`), {
    subTasks: steps.map((step) => ({
      id: step.id,
      title: step.title,
      isCompleted: step.isCompleted,
    })),
  }).catch(() => undefined);
}

/** Deletes the task and the to-do it created. */
export async function deleteAssignment(
  uid: string,
  subjectId: string,
  assignmentId: string
): Promise<void> {
  const db = getDb();
  await deleteDoc(paths.assignment(db, uid, subjectId, assignmentId));
  await deleteDoc(paths.todo(db, uid, `assignment-${assignmentId}`)).catch(() => undefined);
}

/** Turns Gemini's reading of a brief into something saveable. */
export function toSaveInput(
  subjectId: string,
  subjectName: string,
  breakdown: AssignmentBreakdown,
  sourceText: string,
  fileName: string | null
): SaveInput {
  return {
    subjectId,
    subjectName,
    title: breakdown.title,
    kind: assignmentKind(breakdown.kind),
    brief: breakdown.summary || null,
    sourceText,
    sourceFileName: fileName,
    steps: withIds(breakdown.steps),
    deliverables: breakdown.deliverables,
    markingNotes: breakdown.markingNotes,
    estimatedHours: breakdown.estimatedHours,
    dueDate: parseDueDate(breakdown.dueDate, breakdown.dueTime),
  };
}

/** How much of the plan is ticked off, 0-1. Null when there are no steps. */
export function progressOf(assignment: Assignment): number | null {
  if (assignment.steps.length === 0) return null;
  const done = assignment.steps.filter((step) => step.isCompleted).length;
  return done / assignment.steps.length;
}
