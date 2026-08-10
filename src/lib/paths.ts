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

  classes: (db: Firestore, uid: string) => collection(db, 'users', uid, 'classes'),
  class: (db: Firestore, uid: string, classId: string) =>
    doc(db, 'users', uid, 'classes', classId),

  /** Non-academic overlay: gym, study blocks, commutes. */
  routines: (db: Firestore, uid: string) => collection(db, 'users', uid, 'routines'),
  routine: (db: Firestore, uid: string, routineId: string) =>
    doc(db, 'users', uid, 'routines', routineId),

  sessions: (db: Firestore, uid: string) => collection(db, 'users', uid, 'sessions'),
  session: (db: Firestore, uid: string, sessionId: string) =>
    doc(db, 'users', uid, 'sessions', sessionId),

  todos: (db: Firestore, uid: string) => collection(db, 'users', uid, 'todos'),
  todo: (db: Firestore, uid: string, todoId: string) => doc(db, 'users', uid, 'todos', todoId),
  weakConcepts: (db: Firestore, uid: string) => collection(db, 'users', uid, 'weak_concepts'),
  weakConcept: (db: Firestore, uid: string, conceptId: string) =>
    doc(db, 'users', uid, 'weak_concepts', conceptId),
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
