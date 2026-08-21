import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  where,
  writeBatch,
  type DocumentReference,
  type Firestore,
} from 'firebase/firestore';
import { paths } from '@/lib/paths';
import { clearAiResponseCacheForUser } from '@/lib/aiCache';
import { getDb } from '@/services/firebase';
import { deleteR2UserData } from './r2Storage';

const USER_COLLECTIONS = [
  'semesters',
  'classes',
  'routines',
  'sessions',
  'todos',
  'weak_concepts',
  'attendance_logs',
  'shared_materials',
  'shares_sent',
  'blocked',
  'reelCards',
  'reel_cards',
  'note_canvases',
] as const;

async function deleteRefs(db: Firestore, refs: DocumentReference[]): Promise<void> {
  for (let offset = 0; offset < refs.length; offset += 400) {
    const batch = writeBatch(db);
    refs.slice(offset, offset + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

async function collectSubjectTree(db: Firestore, uid: string): Promise<DocumentReference[]> {
  const refs: DocumentReference[] = [];
  const subjects = await getDocs(paths.subjects(db, uid));
  for (const subject of subjects.docs) {
    const nested = await Promise.all([
      getDocs(paths.documents(db, uid, subject.id)),
      getDocs(paths.flashcards(db, uid, subject.id)),
      getDocs(paths.lectures(db, uid, subject.id)),
      getDocs(paths.assignments(db, uid, subject.id)),
      // Missing until now, which meant deleting a guest workspace left every
      // week of every teaching plan behind, under a subject that no longer
      // existed. Nothing could reach them and nothing would ever clean them up.
      getDocs(paths.teachingPlan(db, uid, subject.id)),
      getDocs(paths.chats(db, uid, subject.id)),
    ]);
    nested.slice(0, 5).forEach((snapshot) =>
      snapshot.docs.forEach((entry) => refs.push(entry.ref))
    );
    for (const chat of nested[5].docs) {
      const messages = await getDocs(paths.chatMessages(db, uid, subject.id, chat.id));
      messages.docs.forEach((entry) => refs.push(entry.ref));
      refs.push(chat.ref);
    }
    refs.push(subject.ref);
  }
  return refs;
}

async function collectNotebookTree(db: Firestore, uid: string): Promise<DocumentReference[]> {
  const refs: DocumentReference[] = [];
  const notebooks = await getDocs(paths.noteNotebooks(db, uid));
  for (const notebook of notebooks.docs) {
    const pages = await getDocs(paths.noteNotebookPages(db, uid, notebook.id));
    pages.docs.forEach((entry) => refs.push(entry.ref));
    refs.push(notebook.ref);
  }
  return refs;
}

async function cleanSocialData(db: Firestore, uid: string): Promise<void> {
  const friendSnapshot = await getDocs(collection(db, 'users', uid, 'friends'));
  const reciprocal = friendSnapshot.docs.map((friend) =>
    doc(db, 'users', friend.id, 'friends', uid)
  );
  await deleteRefs(db, reciprocal).catch((error) =>
    console.warn('[guest-cleanup] A reciprocal friend record could not be removed.', error)
  );
  await deleteRefs(db, friendSnapshot.docs.map((friend) => friend.ref));

  const rooms = await getDocs(
    query(collection(db, 'arena_rooms'), where('memberIds', 'array-contains', uid))
  ).catch(() => null);
  if (rooms) {
    for (const room of rooms.docs) {
      const data = room.data() as { hostId?: string; memberIds?: string[] };
      if (data.hostId === uid) {
        const members = Array.isArray(data.memberIds) ? data.memberIds : [uid];
        await deleteRefs(
          db,
          members.flatMap((memberId) => [
            doc(db, 'arena_rooms', room.id, 'players', memberId),
            doc(db, 'arena_rooms', room.id, 'decks', memberId),
          ])
        );
        await deleteDoc(room.ref);
      } else {
        await deleteRefs(db, [
          doc(db, 'arena_rooms', room.id, 'players', uid),
          doc(db, 'arena_rooms', room.id, 'decks', uid),
        ]).catch(() => undefined);
      }
    }
  }

  const ghosts = await getDocs(
    query(collection(db, 'arena_ghosts'), where('ownerId', '==', uid))
  ).catch(() => null);
  if (ghosts) await deleteRefs(db, ghosts.docs.map((entry) => entry.ref));

  const sprints = await getDocs(
    query(collection(db, 'sprints'), where('memberIds', 'array-contains', uid))
  ).catch(() => null);
  if (sprints) {
    await deleteRefs(
      db,
      sprints.docs.filter((entry) => entry.data().ownerId === uid).map((entry) => entry.ref)
    );
  }

  await deleteRefs(db, [
    doc(db, 'profiles', uid),
    doc(db, 'busy', uid),
    doc(db, 'presence', uid),
  ]);
}

/**
 * Removes the complete temporary workspace while the anonymous credential is
 * still valid. Firebase Auth is deleted by the caller only after this resolves.
 */
export async function deleteGuestWorkspace(uid: string): Promise<void> {
  const db = getDb();
  await Promise.all([deleteR2UserData(), clearAiResponseCacheForUser(uid)]);

  const [subjectRefs, notebookRefs, topLevelSnapshots] = await Promise.all([
    collectSubjectTree(db, uid),
    collectNotebookTree(db, uid),
    Promise.all(
      USER_COLLECTIONS.map((name) => getDocs(collection(db, 'users', uid, name)))
    ),
  ]);

  const topLevelRefs = topLevelSnapshots.flatMap((snapshot) =>
    snapshot.docs.map((entry) => entry.ref)
  );
  await deleteRefs(db, [...subjectRefs, ...notebookRefs, ...topLevelRefs]);
  await cleanSocialData(db, uid);
  await deleteDoc(paths.user(db, uid));
}
