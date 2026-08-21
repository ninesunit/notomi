import { collection, doc, type Firestore } from 'firebase/firestore';

/**
 * Every path is rooted at users/{uid}, which is what makes the security rules
 * a single ownership check.
 */
export const paths = {
  user: (db: Firestore, uid: string) => doc(db, 'users', uid),
  subjects: (db: Firestore, uid: string) => collection(db, 'users', uid, 'subjects'),
  subject: (db: Firestore, uid: string, subjectId: string) =>
    doc(db, 'users', uid, 'subjects', subjectId),
  documents: (db: Firestore, uid: string, subjectId: string) =>
    collection(db, 'users', uid, 'subjects', subjectId, 'documents'),
  document: (db: Firestore, uid: string, subjectId: string, documentId: string) =>
    doc(db, 'users', uid, 'subjects', subjectId, 'documents', documentId),
  semesters: (db: Firestore, uid: string) => collection(db, 'users', uid, 'semesters'),
  semester: (db: Firestore, uid: string, semesterId: string) =>
    doc(db, 'users', uid, 'semesters', semesterId),

  chats: (db: Firestore, uid: string, subjectId: string) =>
    collection(db, 'users', uid, 'subjects', subjectId, 'chats'),
  chat: (db: Firestore, uid: string, subjectId: string, chatId: string) =>
    doc(db, 'users', uid, 'subjects', subjectId, 'chats', chatId),
  chatMessages: (db: Firestore, uid: string, subjectId: string, chatId: string) =>
    collection(db, 'users', uid, 'subjects', subjectId, 'chats', chatId, 'messages'),

  flashcards: (db: Firestore, uid: string, subjectId: string) =>
    collection(db, 'users', uid, 'subjects', subjectId, 'flashcards'),
  flashcard: (db: Firestore, uid: string, subjectId: string, cardId: string) =>
    doc(db, 'users', uid, 'subjects', subjectId, 'flashcards', cardId),

  /** One entry per class attended, filed under the subject it belongs to. */
  lectures: (db: Firestore, uid: string, subjectId: string) =>
    collection(db, 'users', uid, 'subjects', subjectId, 'lectures'),
  lecture: (db: Firestore, uid: string, subjectId: string, lectureId: string) =>
    doc(db, 'users', uid, 'subjects', subjectId, 'lectures', lectureId),

  /** Week-by-week teaching plan for a subject. */
  teachingPlan: (db: Firestore, uid: string, subjectId: string) =>
    collection(db, 'users', uid, 'subjects', subjectId, 'plan'),
  teachingPlanWeek: (db: Firestore, uid: string, subjectId: string, weekId: string) =>
    doc(db, 'users', uid, 'subjects', subjectId, 'plan', weekId),

  assignments: (db: Firestore, uid: string, subjectId: string) =>
    collection(db, 'users', uid, 'subjects', subjectId, 'assignments'),
  assignment: (db: Firestore, uid: string, subjectId: string, assignmentId: string) =>
    doc(db, 'users', uid, 'subjects', subjectId, 'assignments', assignmentId),

  classes: (db: Firestore, uid: string) => collection(db, 'users', uid, 'classes'),
  class: (db: Firestore, uid: string, classId: string) =>
    doc(db, 'users', uid, 'classes', classId),

  /** Non-academic overlay: gym, study blocks, commutes. */
  routines: (db: Firestore, uid: string) => collection(db, 'users', uid, 'routines'),
  routine: (db: Firestore, uid: string, routineId: string) =>
    doc(db, 'users', uid, 'routines', routineId),

  attendanceLogs: (db: Firestore, uid: string) =>
    collection(db, 'users', uid, 'attendance_logs'),
  attendanceLog: (db: Firestore, uid: string, logId: string) =>
    doc(db, 'users', uid, 'attendance_logs', logId),

  sessions: (db: Firestore, uid: string) => collection(db, 'users', uid, 'sessions'),
  session: (db: Firestore, uid: string, sessionId: string) =>
    doc(db, 'users', uid, 'sessions', sessionId),

  todos: (db: Firestore, uid: string) => collection(db, 'users', uid, 'todos'),
  todo: (db: Firestore, uid: string, todoId: string) => doc(db, 'users', uid, 'todos', todoId),
  weakConcepts: (db: Firestore, uid: string) => collection(db, 'users', uid, 'weak_concepts'),
  weakConcept: (db: Firestore, uid: string, conceptId: string) =>
    doc(db, 'users', uid, 'weak_concepts', conceptId),

  arenaRooms: (db: Firestore) => collection(db, 'arena_rooms'),
  arenaRoom: (db: Firestore, roomId: string) => doc(db, 'arena_rooms', roomId),
  arenaPlayers: (db: Firestore, roomId: string) =>
    collection(db, 'arena_rooms', roomId, 'players'),
  arenaPlayer: (db: Firestore, roomId: string, uid: string) =>
    doc(db, 'arena_rooms', roomId, 'players', uid),
  arenaDeck: (db: Firestore, roomId: string, uid: string) =>
    doc(db, 'arena_rooms', roomId, 'decks', uid),
  arenaGhosts: (db: Firestore) => collection(db, 'arena_ghosts'),
  arenaGhost: (db: Firestore, ghostId: string) => doc(db, 'arena_ghosts', ghostId),

  sprints: (db: Firestore) => collection(db, 'sprints'),
  sprint: (db: Firestore, sprintId: string) => doc(db, 'sprints', sprintId),

  sharedMaterials: (db: Firestore, uid: string) =>
    collection(db, 'users', uid, 'shared_materials'),
  sharedMaterial: (db: Firestore, uid: string, shareId: string) =>
    doc(db, 'users', uid, 'shared_materials', shareId),

  /**
   * The sender's own record of what they have sent.
   *
   * A share is written straight into the recipient's tree, which is what keeps
   * the inbox a single owner-scoped query. The cost is that the sender has no
   * way to find their own sent copies again — and "you cannot take back what
   * you shared" is not an acceptable answer to a student who shared the wrong
   * file. This is a pointer, not a second copy: an id, a name and a title.
   */
  sentShares: (db: Firestore, uid: string) => collection(db, 'users', uid, 'shares_sent'),
  sentShare: (db: Firestore, uid: string, shareId: string) =>
    doc(db, 'users', uid, 'shares_sent', shareId),

  /**
   * Review cards. Still named for the feed they were built for, because
   * renaming the collection would mean migrating every card a student already
   * has to gain nothing this comment cannot say.
   */
  reelCards: (db: Firestore, uid: string) => collection(db, 'users', uid, 'reelCards'),
  reelCard: (db: Firestore, uid: string, cardId: string) =>
    doc(db, 'users', uid, 'reelCards', cardId),
  noteCanvases: (db: Firestore, uid: string) =>
    collection(db, 'users', uid, 'note_canvases'),
  noteCanvas: (db: Firestore, uid: string, canvasId: string) =>
    doc(db, 'users', uid, 'note_canvases', canvasId),
  noteNotebooks: (db: Firestore, uid: string) =>
    collection(db, 'users', uid, 'note_notebooks'),
  noteNotebook: (db: Firestore, uid: string, notebookId: string) =>
    doc(db, 'users', uid, 'note_notebooks', notebookId),
  noteNotebookPages: (db: Firestore, uid: string, notebookId: string) =>
    collection(db, 'users', uid, 'note_notebooks', notebookId, 'pages'),
  noteNotebookPage: (db: Firestore, uid: string, notebookId: string, pageId: string) =>
    doc(db, 'users', uid, 'note_notebooks', notebookId, 'pages', pageId),
};

export function materialsStoragePath(
  uid: string,
  subjectId: string,
  documentId: string,
  fileName: string
): string {
  // Keep the original name readable but strip anything that would break a path.
  const safeName = fileName.replace(/[^\w.\-]+/g, '_').slice(-80);
  return `materials/${uid}/${subjectId}/${documentId}-${safeName}`;
}
