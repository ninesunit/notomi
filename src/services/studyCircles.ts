import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
  type Timestamp,
} from 'firebase/firestore';
import { paths } from '@/lib/paths';
import { getDb } from './firebase';
import type { ConversationMember, MessageAttachment } from './socialMessaging';

export type StudyCircle = {
  id: string;
  courseCode: string;
  courseName: string;
  universityId: string;
  universityName: string;
  ownerId: string;
  memberIds: string[];
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
};

export type CirclePost = {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  attachment: MessageAttachment | null;
  clientCreatedAt: number;
  createdAt: Timestamp | null;
};

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

export function circleIdFor(universityId: string, courseCode: string): string {
  return `${slug(universityId)}__${slug(courseCode)}`;
}

export async function openOrJoinCircle(input: {
  member: ConversationMember;
  courseCode: string;
  courseName: string;
  universityId: string;
  universityName: string;
}): Promise<string> {
  const courseCode = input.courseCode.trim().toUpperCase();
  if (!courseCode) throw new Error('This subject needs a course code before it can have a circle.');
  if (!input.universityId.trim()) throw new Error('Add your university to your profile first.');
  const db = getDb();
  const id = circleIdFor(input.universityId, courseCode);
  const ref = paths.circle(db, id);

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) {
      transaction.set(ref, {
        courseCode,
        courseName: input.courseName.trim().slice(0, 120),
        universityId: input.universityId,
        universityName: input.universityName.trim().slice(0, 120),
        ownerId: input.member.id,
        memberIds: [input.member.id],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return;
    }
    const circle = { id: snapshot.id, ...snapshot.data() } as StudyCircle;
    if (circle.memberIds.includes(input.member.id)) return;
    if (circle.memberIds.length >= 20) throw new Error('This course circle is full.');
    transaction.update(ref, {
      memberIds: [...circle.memberIds, input.member.id],
      updatedAt: serverTimestamp(),
    });
  });
  return id;
}

export async function loadCircle(circleId: string): Promise<StudyCircle | null> {
  const snapshot = await getDoc(paths.circle(getDb(), circleId));
  return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as StudyCircle) : null;
}

export async function sendCirclePost(input: {
  circleId: string;
  senderId: string;
  senderName: string;
  text: string;
  attachment?: MessageAttachment | null;
}): Promise<string> {
  const text = input.text.trim().slice(0, 1500);
  const attachment = input.attachment ?? null;
  if (!text && !attachment) throw new Error('Write a post or attach a shared item.');
  const ref = doc(paths.circlePosts(getDb(), input.circleId));
  await setDoc(ref, {
    senderId: input.senderId,
    senderName: input.senderName.slice(0, 60),
    text,
    attachment,
    clientCreatedAt: Date.now(),
    createdAt: serverTimestamp(),
  });
  return ref.id;
}
