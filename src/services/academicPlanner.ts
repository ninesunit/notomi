import { Timestamp, increment, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { extractAcademicCalendar, generateExamRevisionPlan } from '@/lib/ai';
import { parseDueDate, toDate } from '@/lib/dates';
import { stableId } from '@/lib/ids';
import { paths } from '@/lib/paths';
import type {
  ExtractedAcademicTerm,
  RevisionPlanItem,
  Semester,
  Subject,
  Todo,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { canonicalMimeType, classify, ParseError } from './fileProcessor';
import type { MaterialFile } from './ingestion';

const DAY_MS = 86_400_000;

function timestamp(iso: string | null): Timestamp | null {
  if (!iso) return null;
  const date = new Date(`${iso}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

function isoDate(value: Semester['startDate'] | Todo['dueDate']): string | null {
  const date = toDate(value);
  if (!date) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function analyseAcademicCalendar(
  file: MaterialFile
): Promise<ExtractedAcademicTerm[]> {
  const kind = classify(file.name, file.mimeType ?? '');
  if (kind !== 'pdf' && kind !== 'image') {
    throw new ParseError('Use an official academic calendar in PDF, PNG, JPG or WEBP format.');
  }

  const bytes = file.file
    ? await file.file.arrayBuffer()
    : await (await fetch(file.uri)).arrayBuffer();
  return extractAcademicCalendar(bytes, canonicalMimeType(kind, file.mimeType));
}

function normalise(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

export type CalendarImportOutcome = {
  created: number;
  updated: number;
  currentTerm: string | null;
};

/** Saves reviewed calendar boundaries into the existing Semester parent records. */
export async function commitAcademicCalendar(
  uid: string,
  terms: ExtractedAcademicTerm[],
  existing: Semester[],
  sourceName: string
): Promise<CalendarImportOutcome> {
  if (terms.length === 0) throw new ParseError('Select at least one academic term to import.');

  const db = getDb();
  const now = new Date();
  const active = terms.find((term) => {
    const start = timestamp(term.startDate)?.toDate();
    const end = timestamp(term.endDate)?.toDate();
    return !!start && !!end && start <= now && now <= end;
  });
  const maxOrder = existing.reduce(
    (highest, semester) => Math.max(highest, semester.order ?? 0),
    -1
  );
  const batch = writeBatch(db);
  let created = 0;
  let updated = 0;

  if (active) {
    for (const semester of existing) {
      if (semester.isCurrent)
        batch.update(paths.semester(db, uid, semester.id), {
          isCurrent: false,
        });
    }
  }

  terms.forEach((term, index) => {
    const year = Number(term.startDate.slice(0, 4));
    const match = existing.find((semester) => {
      const sameCode = term.code && normalise(semester.term) === normalise(term.code);
      const sameName = normalise(semester.name) === normalise(term.name);
      const sameStart = isoDate(semester.startDate) === term.startDate;
      return sameStart || (semester.year === year && (sameCode || sameName));
    });
    const id =
      match?.id ?? stableId(uid, 'academic-calendar', term.code || term.name, term.startDate);
    const ref = paths.semester(db, uid, id);
    const fields = {
      name: term.name,
      year,
      term: term.code || term.name,
      isCurrent: active
        ? term === active
        : (match?.isCurrent ?? (existing.length === 0 && index === 0)),
      order: match?.order ?? maxOrder + index + 1,
      startDate: timestamp(term.startDate),
      teachingEndDate: timestamp(term.teachingEndDate),
      teachingWeeks: term.teachingWeeks,
      studyLeaveStart: timestamp(term.studyLeaveStart),
      studyLeaveEnd: timestamp(term.studyLeaveEnd),
      examStart: timestamp(term.examStart),
      examEnd: timestamp(term.examEnd),
      endDate: timestamp(term.endDate),
      calendarSourceName: sourceName,
    };

    if (match) {
      batch.update(ref, fields);
      updated += 1;
    } else {
      batch.set(ref, {
        ...fields,
        gpaTarget: null,
        createdAt: serverTimestamp(),
      });
      created += 1;
    }
  });

  await batch.commit();
  return { created, updated, currentTerm: active?.name ?? null };
}

export function findActiveSemester(semesters: Semester[], now = new Date()): Semester | null {
  return (
    semesters.find((semester) => {
      const start = toDate(semester.startDate);
      const end = toDate(semester.endDate);
      return !!start && !!end && start <= now && now <= end;
    }) ??
    semesters.find((semester) => semester.isCurrent) ??
    null
  );
}

export type BurnoutWeek = {
  index: number;
  start: Date;
  end: Date;
  workload: number;
  tasks: number;
};

/** A deterministic workload series; the UI only decides how to colour it. */
export function buildBurnoutWeeks(semester: Semester | null, todos: Todo[]): BurnoutWeek[] {
  if (!semester) return [];
  const start = toDate(semester.startDate);
  const anchoredEnd = toDate(semester.examEnd) ?? toDate(semester.endDate);
  if (!start) return [];
  const count = Math.max(
    1,
    Math.min(
      30,
      anchoredEnd
        ? Math.ceil((anchoredEnd.getTime() - start.getTime() + DAY_MS) / (7 * DAY_MS))
        : (semester.teachingWeeks ?? 14)
    )
  );

  return Array.from({ length: count }, (_, index) => {
    const weekStart = new Date(start);
    weekStart.setDate(start.getDate() + index * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const due = todos.filter((todo) => {
      const date = toDate(todo.dueDate);
      return !todo.isCompleted && !!date && date >= weekStart && date <= weekEnd;
    });
    const workload = due.reduce((sum, todo) => {
      const priority = todo.priority === 'high' ? 3 : todo.priority === 'medium' ? 2 : 1;
      const kind = /exam|project|presentation/.test(todo.kind ?? '') ? 2 : 0;
      return sum + priority + kind + Math.min(3, todo.subTasks?.length ?? 0);
    }, 0);
    return {
      index,
      start: weekStart,
      end: weekEnd,
      workload,
      tasks: due.length,
    };
  });
}

export type AttendanceSummary = {
  attended: number;
  missed: number;
  held: number;
  planned: number;
  percentage: number | null;
  safeSkips: number;
};

export function attendanceSummary(
  subject: Subject,
  weeklySessions: number,
  semester: Semester | null
): AttendanceSummary {
  const attended = Math.max(0, subject.attendanceAttended ?? 0);
  const missed = Math.max(0, subject.attendanceMissed ?? 0);
  const held = attended + missed;
  const planned = Math.max(0, weeklySessions * (semester?.teachingWeeks ?? 14));
  const maxAbsences = Math.max(0, planned - Math.ceil(planned * 0.8));
  return {
    attended,
    missed,
    held,
    planned,
    percentage: held > 0 ? (attended / held) * 100 : null,
    safeSkips: Math.max(0, maxAbsences - missed),
  };
}

export async function recordAttendance(
  uid: string,
  subjectId: string,
  outcome: 'attended' | 'missed'
): Promise<void> {
  const db = getDb();
  await updateDoc(paths.subject(db, uid, subjectId), {
    [outcome === 'attended' ? 'attendanceAttended' : 'attendanceMissed']: increment(1),
    updatedAt: serverTimestamp(),
  });
}

export async function createExamRevisionPlan(
  uid: string,
  semester: Semester,
  subjects: Subject[],
  todos: Todo[]
): Promise<RevisionPlanItem[]> {
  const studyLeaveStart = isoDate(semester.studyLeaveStart);
  const studyLeaveEnd = isoDate(semester.studyLeaveEnd);
  if (!studyLeaveStart || !studyLeaveEnd) {
    throw new ParseError('Import an academic calendar with a Study Leave window first.');
  }

  const exams = todos
    .filter((todo) => todo.subjectId && (/exam/i.test(todo.kind ?? '') || /exam/i.test(todo.title)))
    .map((todo) => {
      const subject = subjects.find((entry) => entry.id === todo.subjectId);
      const examDate = isoDate(todo.dueDate);
      return subject && examDate
        ? {
            id: subject.id,
            name: subject.name,
            creditHours: subject.creditHours || 1,
            examDate,
          }
        : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (exams.length === 0) {
    throw new ParseError(
      'No dated exam tasks were found. Upload a syllabus or add exam dates first.'
    );
  }

  const unique = [...new Map(exams.map((exam) => [exam.id, exam])).values()];
  const plan = await generateExamRevisionPlan({
    studyLeaveStart,
    studyLeaveEnd,
    subjects: unique,
  });
  const db = getDb();
  const batch = writeBatch(db);
  for (const item of plan) {
    const subject = subjects.find((entry) => entry.id === item.subjectId);
    if (!subject) continue;
    const ref = paths.todo(
      db,
      uid,
      stableId('exam-plan', semester.id, item.subjectId, item.date, item.title)
    );
    batch.set(
      ref,
      {
        title: `Revision: ${subject.name} - ${item.title}`,
        dueDate: parseDueDate(item.date),
        isCompleted: false,
        subjectId: subject.id,
        subjectName: subject.name,
        priority: 'high',
        subTasks: [{ id: stableId(item.focus), title: item.focus, isCompleted: false }],
        source: 'planner',
        sourceDocumentId: null,
        kind: 'revision',
        plannedMinutes: item.minutes,
        createdAt: serverTimestamp(),
        completedAt: null,
      },
      { merge: true }
    );
  }

  await batch.commit();
  return plan;
}
