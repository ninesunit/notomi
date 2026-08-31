import {
  doc,
  serverTimestamp,
  setDoc,
  writeBatch,
  type Timestamp,
} from 'firebase/firestore';
import { paths } from '@/lib/paths';
import { getDb } from './firebase';
import { sendMessageNotification } from './pushReminders';
import type { ShareKind } from './sharing';

export type ConversationMember = {
  id: string;
  displayName: string;
  username: string;
  color: string;
};

export type MessageAttachment = {
  shareId: string;
  kind: ShareKind;
  title: string;
  subjectName: string;
};

export type SocialConversation = {
  id: string;
  memberIds: string[];
  members: ConversationMember[];
  lastMessage: string;
  lastSenderId: string;
  lastMessageAt: Timestamp | null;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
};

export type SocialMessage = {
  id: string;
  senderId: string;
  text: string;
  attachment: MessageAttachment | null;
  clientCreatedAt: number;
  createdAt: Timestamp | null;
};

export type ConversationRead = {
  id: string;
  lastReadAt: Timestamp | null;
};

export function conversationIdFor(left: string, right: string): string {
  return [left, right].sort().join('__');
}

export function otherMember(
  conversation: SocialConversation,
  uid: string
): ConversationMember | null {
  return conversation.members.find((member) => member.id !== uid) ?? null;
}

function boundedMember(member: ConversationMember): ConversationMember {
  return {
    id: member.id.slice(0, 128),
    displayName: member.displayName.trim().slice(0, 60) || 'Student',
    username: member.username.trim().slice(0, 24),
    color: member.color.slice(0, 24) || '#B4552D',
  };
}

export async function sendFriendMessage(input: {
  sender: ConversationMember;
  recipient: ConversationMember;
  text?: string;
  attachment?: MessageAttachment | null;
}): Promise<string> {
  const text = (input.text ?? '').trim().slice(0, 2000);
  const attachment = input.attachment
    ? {
        shareId: input.attachment.shareId.slice(0, 128),
        kind: input.attachment.kind,
        title: input.attachment.title.trim().slice(0, 200),
        subjectName: input.attachment.subjectName.trim().slice(0, 200),
      }
    : null;
  if (!text && !attachment) throw new Error('Write a message or attach a shared item.');

  const db = getDb();
  const conversationId = conversationIdFor(input.sender.id, input.recipient.id);
  const conversationRef = paths.conversation(db, conversationId);
  const messageRef = doc(paths.conversationMessages(db, conversationId));
  const preview = text || `Shared ${attachment?.title ?? 'a study item'}`;
  const batch = writeBatch(db);
  const sender = boundedMember(input.sender);
  const recipient = boundedMember(input.recipient);

  batch.set(
    conversationRef,
    {
      memberIds: [input.sender.id, input.recipient.id].sort(),
      members: [sender, recipient],
      lastMessage: preview.slice(0, 200),
      lastSenderId: input.sender.id,
      lastMessageAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  batch.set(messageRef, {
    senderId: input.sender.id,
    text,
    attachment,
    clientCreatedAt: Date.now(),
    createdAt: serverTimestamp(),
  });
  await batch.commit();

  void sendMessageNotification({
    recipientId: input.recipient.id,
    conversationId,
    senderName: input.sender.displayName,
    preview,
  });
  return conversationId;
}

export async function markConversationRead(uid: string, conversationId: string): Promise<void> {
  await setDoc(
    paths.conversationRead(getDb(), uid, conversationId),
    { lastReadAt: serverTimestamp() },
    { merge: true }
  );
}
