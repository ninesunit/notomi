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
