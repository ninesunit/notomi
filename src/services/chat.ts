import {
  deleteDoc,
  doc,
  getDocs,
  increment,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import type { ChatRecord } from '@/lib/schema';

/**
 * Persistent chat history.
 *
 * Conversations live at
 * users/{uid}/subjects/{subjectId}/chats/{chatId}/messages/{messageId} so a
 * student can close the tab mid-question and pick the thread back up on
 * another device.
 */

export async function createChat(
  uid: string,
  subjectId: string,
  options: { documentId?: string | null; title?: string } = {}
): Promise<string> {
  const db = getDb();
  const ref = doc(paths.chats(db, uid, subjectId));

  await setDoc(ref, {
    title: options.title?.trim() || 'New conversation',
    documentId: options.documentId ?? null,
    messageCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return ref.id;
}

/**
 * Appends one turn. The parent's counter and timestamp move with it so the
 * history list can sort and label itself without reading every message.
 */
export async function appendMessage(
  uid: string,
  subjectId: string,
  chatId: string,
  sender: ChatRecord['sender'],
  text: string
): Promise<void> {
  const db = getDb();
  const messages = paths.chatMessages(db, uid, subjectId, chatId);

  await setDoc(doc(messages), {
    sender,
    text,
    createdAt: serverTimestamp(),
  });

  await updateDoc(paths.chat(db, uid, subjectId, chatId), {
    messageCount: increment(1),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Names an untitled thread after its opening question — the same trick every
 * chat UI uses, and far more useful than "New conversation" in a list of ten.
 */
export async function titleFromFirstMessage(
  uid: string,
  subjectId: string,
  chatId: string,
  question: string
): Promise<void> {
  const trimmed = question.trim().replace(/\s+/g, ' ');
  const title = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  if (!title) return;

  const db = getDb();
  await updateDoc(paths.chat(db, uid, subjectId, chatId), { title });
}

/** Empties a thread but keeps it, so the student stays on the same screen. */
export async function clearChat(uid: string, subjectId: string, chatId: string): Promise<void> {
  const db = getDb();
  const snapshot = await getDocs(paths.chatMessages(db, uid, subjectId, chatId));

  // Firestore caps a batch at 500 writes; a long thread needs several.
  const chunks: (typeof snapshot.docs)[] = [];
  for (let index = 0; index < snapshot.docs.length; index += 400) {
    chunks.push(snapshot.docs.slice(index, index + 400));
  }

  for (const chunk of chunks) {
    const batch = writeBatch(db);
    for (const document of chunk) batch.delete(document.ref);
    await batch.commit();
  }

  await updateDoc(paths.chat(db, uid, subjectId, chatId), {
    messageCount: 0,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteChat(uid: string, subjectId: string, chatId: string): Promise<void> {
  await clearChat(uid, subjectId, chatId);
  const db = getDb();
  await deleteDoc(paths.chat(db, uid, subjectId, chatId));
}
