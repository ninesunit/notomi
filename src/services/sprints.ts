import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
  type Timestamp,
} from 'firebase/firestore';
import { generateSprintPlan } from '@/lib/ai';
import { paths } from '@/lib/paths';
import { getDb } from './firebase';
import { uploadFileToR2 } from './r2Storage';
import { busyPath, type BusyInterval } from './social';
import type { MaterialFile } from './ingestion';
import { createSocialInboxItem } from './socialInbox';

export type SprintMember = { id: string; name: string; freeHours: number };
export type SprintAttachment = {
  fileName: string;
  fileKey: string;
  ownerId: string;
  attachedAtMillis: number;
};
export type SprintTask = {
  id: string;
  title: string;
  detail: string;
  assigneeId: string;
  assigneeName: string;
  estimatedHours: number;
  completed: boolean;
  attachments: SprintAttachment[];
};
export type GroupSprint = {
  id: string;
  ownerId: string;
  title: string;
  subjectId: string;
  subjectName: string;
  memberIds: string[];
  members: SprintMember[];
  tasks: SprintTask[];
  guidelines: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
};

function countFreeHours(intervals: BusyInterval[]): number {
  const weekdayBusy = intervals
    .filter((interval) => interval.day >= 0 && interval.day <= 4)
    .reduce((minutes, interval) => {
      const start = Math.max(interval.start, 8 * 60);
      const end = Math.min(interval.end, 20 * 60);
      return minutes + Math.max(0, end - start);
    }, 0);
  return Math.max(0, Math.round((60 * 5 * 12 - weekdayBusy) / 60));
}

export async function sprintAvailability(
  members: { id: string; name: string }[]
): Promise<SprintMember[]> {
  const db = getDb();
  return Promise.all(
    members.map(async (member) => {
      const snapshot = await getDoc(busyPath(db, member.id));
      const intervals = snapshot.exists() ? ((snapshot.data().intervals ?? []) as BusyInterval[]) : [];
      return { ...member, freeHours: countFreeHours(intervals) };
    })
  );
}

export async function createGroupSprint(input: {
  uid: string;
  title: string;
  subjectId: string;
  subjectName: string;
  members: { id: string; name: string }[];
  guidelines: string;
}): Promise<string> {
  const guidelines = input.guidelines.trim();
  if (guidelines.length < 80) throw new Error('Paste enough of the project brief to delegate it fairly.');
  const members = await sprintAvailability(input.members);
  const generated = await generateSprintPlan({ guidelines, members });
  if (!generated.length) throw new Error('No usable project milestones were generated.');
  const names = new Map(members.map((member) => [member.id, member.name]));
  const tasks: SprintTask[] = generated.map((task, index) => ({
    id: `task-${index + 1}`,
    title: task.title,
    detail: task.detail,
    assigneeId: task.assigneeId,
    assigneeName: names.get(task.assigneeId) ?? 'Member',
    estimatedHours: task.estimatedHours,
    completed: false,
    attachments: [],
  }));
  const db = getDb();
  const ref = doc(paths.sprints(db));
  await setDoc(ref, {
    ownerId: input.uid,
    title: input.title.trim() || `${input.subjectName} project`,
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    memberIds: members.map((member) => member.id),
    members,
    tasks,
    guidelines: guidelines.slice(0, 800_000),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  const ownerName = members.find((member) => member.id === input.uid)?.name ?? 'A friend';
  await Promise.all(
    members
      .filter((member) => member.id !== input.uid)
      .map((member) => createSocialInboxItem({
        senderId: input.uid,
        senderName: ownerName,
        recipientId: member.id,
        type: 'sprint',
        title: `${ownerName} added you to a group sprint`,
        body: input.title.trim() || `${input.subjectName} project`,
        payload: { sprintId: ref.id, subjectName: input.subjectName },
      }))
  ).catch(() => undefined);
  return ref.id;
}

export async function toggleSprintTask(sprintId: string, taskId: string): Promise<void> {
  const db = getDb();
  const ref = paths.sprint(db, sprintId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new Error('That sprint no longer exists.');
    const tasks = (snapshot.data().tasks ?? []) as SprintTask[];
    transaction.update(ref, {
      tasks: tasks.map((task) =>
        task.id === taskId ? { ...task, completed: !task.completed } : task
      ),
      updatedAt: serverTimestamp(),
    });
  });
}

export async function attachSprintDraft(input: {
  uid: string;
  sprint: GroupSprint;
  taskId: string;
  file: MaterialFile;
}): Promise<void> {
  const bytes = input.file.file
    ? await input.file.file.arrayBuffer()
    : await (await fetch(input.file.uri)).arrayBuffer();
  const upload = await uploadFileToR2(
    input.file.uri,
    `sprint-${input.sprint.id}-${input.file.name}`,
    input.uid,
    input.sprint.subjectId,
    input.file.mimeType || 'application/octet-stream',
    bytes
  );
  const db = getDb();
  const ref = paths.sprint(db, input.sprint.id);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new Error('That sprint no longer exists.');
    const tasks = (snapshot.data().tasks ?? []) as SprintTask[];
    transaction.update(ref, {
      tasks: tasks.map((task) =>
        task.id === input.taskId
          ? {
              ...task,
              attachments: [
                ...(task.attachments ?? []),
                {
                  fileName: input.file.name,
                  fileKey: upload.fileKey,
                  ownerId: input.uid,
                  attachedAtMillis: Date.now(),
                },
              ],
            }
          : task
      ),
      updatedAt: serverTimestamp(),
    });
  });
}
