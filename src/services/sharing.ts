import { doc, serverTimestamp, setDoc, type Timestamp } from 'firebase/firestore';
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

export async function shareWithFriend(input: Omit<MaterialShare, 'id' | 'createdAt'>): Promise<void> {
  const content = input.content.trim();
  if (!content) throw new Error('There is no readable content to share.');
  if (content.length > 850_000) throw new Error('That item is too large to share as one read-only copy.');
  await setDoc(doc(paths.sharedMaterials(getDb(), input.recipientId)), {
    ...input,
    title: input.title.trim(),
    content,
    createdAt: serverTimestamp(),
  });
}
