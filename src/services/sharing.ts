import {
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  type Timestamp,
} from 'firebase/firestore';
import { paths } from '@/lib/paths';
import { getDb } from './firebase';

export type ShareKind = 'material' | 'summary' | 'flashcards';

export type MaterialShare = {
  id: string;
  senderId: string;
  senderName: string;
  recipientId: string;
  recipientName: string;
  kind: ShareKind;
  subjectId: string;
  subjectName: string;
  title: string;
  content: string;
  sourceFileName: string | null;
  createdAt: Timestamp | null;
};

/** What the sender keeps: enough to recognise a share and take it back. */
export type SentShare = {
  id: string;
  recipientId: string;
  recipientName: string;
  title: string;
  subjectName: string;
  kind: ShareKind;
  createdAt: Timestamp | null;
};

export async function shareWithFriend(input: Omit<MaterialShare, 'id' | 'createdAt'>): Promise<void> {
  const content = input.content.trim();
  if (!content) throw new Error('There is no readable content to share.');
  if (content.length > 850_000) throw new Error('That item is too large to share as one read-only copy.');
  const db = getDb();
  const copy = doc(paths.sharedMaterials(db, input.recipientId));
  await setDoc(copy, {
    ...input,
    title: input.title.trim(),
    content,
    createdAt: serverTimestamp(),
  });

  /*
   * The receipt, under the same id as the copy so revoking is one lookup.
   *
   * Written second and allowed to fail: if this write is lost the recipient
   * still has what they were sent, which is the outcome that matters. The
   * reverse order would risk a receipt for a share that never arrived — an
   * "unshare" button that removes nothing is worse than no button.
   */
  await setDoc(paths.sentShare(db, input.senderId, copy.id), {
    recipientId: input.recipientId,
    recipientName: input.recipientName,
    title: input.title.trim(),
    subjectName: input.subjectName,
    kind: input.kind,
    createdAt: serverTimestamp(),
  }).catch(() => undefined);
}

/** Everything this account has sent, newest first. Bounded; not a listener. */
export async function sentShares(uid: string, cap = 50): Promise<SentShare[]> {
  const snapshot = await getDocs(
    query(paths.sentShares(getDb(), uid), orderBy('createdAt', 'desc'), limit(cap))
  );
  return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as SentShare);
}

/**
 * Takes a shared copy back.
 *
 * Deletes the recipient's copy first: the receipt is the only way to find that
 * copy again, so dropping it first would strand the thing it points at. If the
 * recipient already deleted it their side, that delete is a no-op and the
 * receipt still goes — either way the student ends up with an accurate list.
 */
export async function revokeShare(uid: string, share: SentShare): Promise<void> {
  const db = getDb();
  await deleteDoc(paths.sharedMaterial(db, share.recipientId, share.id));
  await deleteDoc(paths.sentShare(db, uid, share.id));
}
