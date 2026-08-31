import {
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Timestamp,
} from 'firebase/firestore';
import { paths } from '@/lib/paths';
import { getDb } from './firebase';

export type SocialInboxType = 'availability' | 'share' | 'sprint' | 'circle';
export type SocialInboxStatus = 'new' | 'accepted' | 'declined';

export type SocialInboxItem = {
  id: string;
  senderId: string;
  senderName: string;
  recipientId: string;
  type: SocialInboxType;
  title: string;
  body: string;
  status: SocialInboxStatus;
  payload: Record<string, unknown>;
  createdAt: Timestamp | null;
  readAt: Timestamp | null;
};

/**
 * A bounded, actionable notification written directly into the recipient's
 * account. The security rules permit this only between accepted friends.
 */
export async function createSocialInboxItem(input: {
  senderId: string;
  senderName: string;
  recipientId: string;
  type: SocialInboxType;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
}): Promise<string> {
  const ref = doc(paths.socialInbox(getDb(), input.recipientId));
  await setDoc(ref, {
    ...input,
    title: input.title.trim().slice(0, 160),
    body: input.body.trim().slice(0, 600),
    payload: input.payload ?? {},
    status: 'new',
    createdAt: serverTimestamp(),
    readAt: null,
  });
  return ref.id;
}

export async function updateSocialInboxItem(
  uid: string,
  itemId: string,
  patch: { status?: SocialInboxStatus; read?: boolean }
): Promise<void> {
  await updateDoc(paths.socialInboxItem(getDb(), uid, itemId), {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.read ? { readAt: serverTimestamp() } : {}),
  });
}
