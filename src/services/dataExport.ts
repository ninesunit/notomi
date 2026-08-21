import { collection, getDocs, type Firestore } from 'firebase/firestore';

import { downloadBlob } from '@/lib/download';
import { paths } from '@/lib/paths';
import { getDb } from '@/services/firebase';

/**
 * Everything Notomi holds about a student's studies, as one JSON file.
 *
 * The point is that leaving is possible. A study workspace accumulates a term's
 * worth of work, and a student who cannot get it out is not using the app, they
 * are stuck in it.
 *
 * Deliberately Firestore only: uploaded originals live in the student's own
 * Drive or R2 and are already theirs, so copying them into a JSON blob would
 * make a 300MB download of files they can already open.
 */

/** The top-level collections under users/{uid}. Mirrors guestCleanup's list. */
const USER_COLLECTIONS = [
  'semesters',
  'classes',
  'routines',
  'sessions',
  'todos',
  'weak_concepts',
  'attendance_logs',
  'shared_materials',
  'reelCards',
  'reel_cards',
  'note_canvases',
] as const;

type Row = Record<string, unknown> & { id: string };

async function rows(reference: ReturnType<typeof collection>): Promise<Row[]> {
  const snapshot = await getDocs(reference);
  return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
}

async function subjectTree(db: Firestore, uid: string): Promise<Row[]> {
  const subjects = await getDocs(paths.subjects(db, uid));

  return Promise.all(
    subjects.docs.map(async (subject) => {
      const [documents, flashcards, lectures, assignments, teachingPlan, chats] = await Promise.all(
        [
          rows(paths.documents(db, uid, subject.id)),
          rows(paths.flashcards(db, uid, subject.id)),
          rows(paths.lectures(db, uid, subject.id)),
          rows(paths.assignments(db, uid, subject.id)),
          rows(paths.teachingPlan(db, uid, subject.id)),
          rows(paths.chats(db, uid, subject.id)),
        ]
      );

      const conversations = await Promise.all(
        chats.map(async (chat) => ({
          ...chat,
          messages: await rows(paths.chatMessages(db, uid, subject.id, chat.id)),
        }))
      );

      return {
        id: subject.id,
        ...subject.data(),
        documents,
        flashcards,
        lectures,
        assignments,
        teachingPlan,
        chats: conversations,
      };
    })
  );
}

async function notebookTree(db: Firestore, uid: string): Promise<Row[]> {
  const notebooks = await getDocs(paths.noteNotebooks(db, uid));

  return Promise.all(
    notebooks.docs.map(async (notebook) => ({
      id: notebook.id,
      ...notebook.data(),
      pages: await rows(paths.noteNotebookPages(db, uid, notebook.id)),
    }))
  );
}

export type ExportSummary = { collections: number; documents: number };

/**
 * Builds the export and hands it to the browser, returning what was in it so
 * the caller can say something more useful than "done".
 */
export async function exportAcademicData(uid: string): Promise<ExportSummary> {
  const db = getDb();

  const [subjects, notebooks, topLevel] = await Promise.all([
    subjectTree(db, uid),
    notebookTree(db, uid),
    Promise.all(
      USER_COLLECTIONS.map(async (name) => [
        name,
        await rows(collection(db, 'users', uid, name)),
      ] as const)
    ),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    subjects,
    notebooks,
    ...Object.fromEntries(topLevel),
  };

  // Counted before stringifying, since the file is the only other place these
  // numbers exist and a student deserves to know the download was not empty.
  const nested = subjects.reduce(
    (total, subject) =>
      total +
      (['documents', 'flashcards', 'lectures', 'assignments', 'teachingPlan', 'chats'] as const)
        .map((key) => (Array.isArray(subject[key]) ? (subject[key] as unknown[]).length : 0))
        .reduce((sum, count) => sum + count, 0),
    0
  );
  const documents =
    subjects.length +
    notebooks.length +
    nested +
    topLevel.reduce((total, [, entries]) => total + entries.length, 0);

  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
    `notomi-export-${stamp}.json`
  );

  return { collections: USER_COLLECTIONS.length + 2, documents };
}
