import { Timestamp, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';

import { paths } from '@/lib/paths';
import { getDb } from '@/services/firebase';

export const DEMO_IDS = {
  semester: 'demo-semester',
  subject: 'demo-intro-cs',
  document: 'demo-study-guide',
  classes: ['demo-class-lecture', 'demo-class-lab'],
  routines: ['demo-routine-study'],
  todos: ['demo-task-reading', 'demo-task-lab', 'demo-task-quiz'],
} as const;

const DEMO_TEXT = `
# Introduction to Computer Science

An algorithm is a finite, unambiguous sequence of steps that transforms input
into output. Good algorithms are correct, terminate, and use time and memory
carefully.

Variables give names to values. Conditionals choose which instruction runs;
loops repeat instructions; functions package a reusable operation. Together
these ideas form the control flow of a program.

Binary represents information with two states, 0 and 1. Eight bits form a byte.
Text, images and instructions all become patterns of bits before a computer can
store or process them.
`.trim();

function atDay(offset: number, hour: number): Timestamp {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(hour, 0, 0, 0);
  return Timestamp.fromDate(date);
}
function mondayOfThisWeek(): Date {
  const date = new Date();
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Six small records and one local-text source are enough to demonstrate the
 * whole loop without an upload, an AI request or an original file in R2.
 */
export async function loadDemoSemester(uid: string): Promise<void> {
  const db = getDb();
  const batch = writeBatch(db);
  const start = mondayOfThisWeek();
  const end = new Date(start);
  end.setDate(end.getDate() + 14 * 7 - 1);

  batch.set(paths.semester(db, uid, DEMO_IDS.semester), {
    name: 'Demo Semester',
    year: start.getFullYear(),
    term: 'Demo',
    isCurrent: true,
    order: -1,
    startDate: Timestamp.fromDate(start),
    teachingEndDate: Timestamp.fromDate(end),
    endDate: Timestamp.fromDate(end),
    teachingWeeks: 14,
    calendarSourceName: null,
    createdAt: serverTimestamp(),
    demo: true,
  });

  batch.set(paths.subject(db, uid, DEMO_IDS.subject), {
    name: 'Introduction to Computer Science',
    moduleCode: 'DEMO101',
    color: '#2E6F5E',
    emoji: null,
    icon: 'monitor',
    tag: 'Sample',
    documentCount: 1,
    semesterId: DEMO_IDS.semester,
    creditHours: 3,
    grade: null,
    attendanceAttended: 0,
    attendanceMissed: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    demo: true,
  });

  batch.set(paths.document(db, uid, DEMO_IDS.subject, DEMO_IDS.document), {
    title: 'How computing works',
    fileName: 'DEMO101 Sample Notes.txt',
    mimeType: 'text/plain',
    sizeBytes: new TextEncoder().encode(DEMO_TEXT).byteLength,
    rawText: DEMO_TEXT,
    charCount: DEMO_TEXT.length,
    storageProvider: 'none',
    storageState: 'ready',
    r2FileKey: '',
    r2FileUrl: '',
    driveFileId: null,
    chapter: 'Getting started',
    order: 0,
    moduleCode: 'DEMO101',
    summary: 'Algorithms, control flow and binary representation in one short sample.',
    notes: null,
    notesGeneratedAt: null,
    sourceKind: 'text',
    status: 'ready',
    error: null,
    createdAt: serverTimestamp(),
    demo: true,
  });

  const classes = [
    { id: DEMO_IDS.classes[0], day: 0, startMinute: 9 * 60, endMinute: 10 * 60 + 30, kind: 'Lecture', venue: 'Learning Hall 2' },
    { id: DEMO_IDS.classes[1], day: 2, startMinute: 11 * 60, endMinute: 12 * 60 + 30, kind: 'Lab', venue: 'Computing Lab 1' },
  ];
  for (const item of classes) {
    batch.set(paths.class(db, uid, item.id), {
      title: 'Introduction to Computer Science',
      kind: item.kind,
      section: 'D1',
      subjectId: DEMO_IDS.subject,
      subjectName: 'Introduction to Computer Science',
      day: item.day,
      startMinute: item.startMinute,
      endMinute: item.endMinute,
      venue: item.venue,
      color: '#2E6F5E',
      semesterId: DEMO_IDS.semester,
      startDate: Timestamp.fromDate(start),
      endDate: Timestamp.fromDate(end),
      createdAt: serverTimestamp(),
      demo: true,
    });
  }

  batch.set(paths.routine(db, uid, DEMO_IDS.routines[0]), {
    title: 'Weekly review',
    category: 'study',
    day: 4,
    startMinute: 15 * 60,
    endMinute: 16 * 60,
    venue: 'Library',
    color: '#4C5FA8',
    createdAt: serverTimestamp(),
    demo: true,
  });

  const tasks = [
    { id: DEMO_IDS.todos[0], title: 'Review algorithms and control flow', days: 3, priority: 'medium' },
    { id: DEMO_IDS.todos[1], title: 'Complete binary representation lab', days: 7, priority: 'high' },
    { id: DEMO_IDS.todos[2], title: 'Prepare for the first retrieval quiz', days: 12, priority: 'low' },
  ];
  for (const item of tasks) {
    batch.set(paths.todo(db, uid, item.id), {
      title: item.title,
      dueDate: atDay(item.days, 17),
      isCompleted: false,
      subjectId: DEMO_IDS.subject,
      subjectName: 'Introduction to Computer Science',
      priority: item.priority,
      subTasks: [],
      source: 'syllabus',
      sourceDocumentId: DEMO_IDS.document,
      kind: 'assignment',
      createdAt: serverTimestamp(),
      completedAt: null,
      demo: true,
    });
  }

  await batch.commit();
}

/** Deletes only records that still carry the demo marker. */
export async function clearDemoSemester(uid: string): Promise<void> {
  const db = getDb();
  const refs = [
    paths.document(db, uid, DEMO_IDS.subject, DEMO_IDS.document),
    ...DEMO_IDS.todos.map((id) => paths.todo(db, uid, id)),
    ...DEMO_IDS.classes.map((id) => paths.class(db, uid, id)),
    ...DEMO_IDS.routines.map((id) => paths.routine(db, uid, id)),
    paths.subject(db, uid, DEMO_IDS.subject),
    paths.semester(db, uid, DEMO_IDS.semester),
  ];
  const snapshots = await Promise.all(refs.map((ref) => getDoc(ref)));
  const batch = writeBatch(db);
  for (const snapshot of snapshots) {
    if (snapshot.exists() && snapshot.data().demo === true) batch.delete(snapshot.ref);
  }
  await batch.commit();
}
