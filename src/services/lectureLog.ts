import {
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { askInClass, buildContext, summariseLecture } from '@/lib/ai';
import { dayKey } from '@/lib/dates';
import { paths } from '@/lib/paths';
import type { LectureLog, LectureRundown, SourceDocument } from '@/lib/schema';
import { getDb } from '@/services/firebase';

/**
 * The lecture log.
 *
 * A student writes one sentence coming out of a class — "did topic 4, got to
 * 4.2" — and Gemini turns it into notes for exactly that range, drawn from the
 * material already uploaded for the subject. The sentence is the index; the
 * subject's corpus is the content.
 *
 * Entries live under the subject rather than in a flat collection so that
 * deleting a subject takes its log with it, and so a subject page can read its
 * own history without a composite index.
 */

/** Loads a subject's corpus for the prompt. Shared by the log and the Q&A. */
async function subjectContext(uid: string, subjectId: string): Promise<string> {
  const db = getDb();
  const snapshot = await getDocs(
    query(paths.documents(db, uid, subjectId), orderBy('createdAt', 'asc'))
  );

  return buildContext(
    snapshot.docs.map((document) => {
      const data = document.data() as SourceDocument;
      return { title: data.fileName || data.title, text: data.rawText ?? '' };
    })
  );
}

/** The last few entries, as one-liners, so a rundown knows where to start. */
async function recentTopics(uid: string, subjectId: string): Promise<string[]> {
  const db = getDb();
  const snapshot = await getDocs(
    query(paths.lectures(db, uid, subjectId), orderBy('createdAt', 'desc'), limit(8))
  );

  return snapshot.docs
    .map((entry) => {
      const data = entry.data() as LectureLog;
      const where = [data.topic, data.reachedSection && `up to ${data.reachedSection}`]
        .filter(Boolean)
        .join(' ');
      return where || data.title || '';
    })
    .filter(Boolean);
}

export type LogInput = {
  subjectId: string;
  subjectName: string;
  /** What the student typed. */
  entry: string;
  classId?: string | null;
  /** The day of the class; defaults to today. */
  date?: Date;
};

/**
 * Writes an entry, then asks Gemini to expand it.
 *
 * The document is saved before the model is called and patched afterwards, so a
 * failed or slow generation never loses what the student wrote. That is the
 * whole reason this is two writes rather than one.
 */
export async function logLecture(
  uid: string,
  input: LogInput
): Promise<{ id: string; rundown: LectureRundown | null; error: string | null }> {
  const db = getDb();
  const ref = doc(paths.lectures(db, uid, input.subjectId));
  const when = input.date ?? new Date();

  const entry = input.entry.trim();
  await setDoc(ref, {
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    entry,
    // A placeholder title so the row is readable while the rundown is running.
    title: entry.length > 60 ? `${entry.slice(0, 57)}…` : entry,
    topic: null,
    reachedSection: null,
    notes: null,
    keyPoints: [],
    followUps: [],
    classId: input.classId ?? null,
    dayKey: dayKey(when),
    createdAt: serverTimestamp(),
  });

  try {
    const [context, previous] = await Promise.all([
      subjectContext(uid, input.subjectId),
      recentTopics(uid, input.subjectId),
    ]);

    const rundown = await summariseLecture({
      subjectName: input.subjectName,
      entry,
      context,
      previous,
    });

    await updateDoc(ref, {
      title: rundown.title,
      topic: rundown.topic,
      reachedSection: rundown.reachedSection,
      notes: rundown.notes,
      keyPoints: rundown.keyPoints,
      followUps: rundown.followUps,
    });

    return { id: ref.id, rundown, error: null };
  } catch (caught) {
    // The entry stands on its own; only the expansion failed.
    return {
      id: ref.id,
      rundown: null,
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

/** Re-runs the rundown for an entry the student has since edited. */
export async function regenerateLecture(
  uid: string,
  subjectId: string,
  log: LectureLog
): Promise<LectureRundown> {
  const db = getDb();
  const [context, previous] = await Promise.all([
    subjectContext(uid, subjectId),
    recentTopics(uid, subjectId),
  ]);

  const rundown = await summariseLecture({
    subjectName: log.subjectName || 'this subject',
    entry: log.entry,
    context,
    previous: previous.filter((line) => line !== log.title),
  });

  await updateDoc(paths.lecture(db, uid, subjectId, log.id), {
    title: rundown.title,
    topic: rundown.topic,
    reachedSection: rundown.reachedSection,
    notes: rundown.notes,
    keyPoints: rundown.keyPoints,
    followUps: rundown.followUps,
  });

  return rundown;
}

export async function deleteLecture(
  uid: string,
  subjectId: string,
  lectureId: string
): Promise<void> {
  await deleteDoc(paths.lecture(getDb(), uid, subjectId, lectureId));
}

/** A question asked mid-class, answered against the subject's own material. */
export async function askDuringClass(
  uid: string,
  input: { subjectId: string; subjectName: string; question: string; topic?: string | null }
): Promise<string> {
  const context = await subjectContext(uid, input.subjectId);
  return askInClass({
    subjectName: input.subjectName,
    question: input.question,
    context,
    topic: input.topic ?? null,
  });
}

/**
 * Groups a log by topic for the subject page.
 *
 * Entries without a topic collect under "Unfiled" rather than each becoming
 * their own heading — a student who wrote "revision" three times wants one
 * group, not three.
 */
export function groupByTopic(logs: LectureLog[]): [string, LectureLog[]][] {
  const groups = new Map<string, LectureLog[]>();

  for (const log of logs) {
    const key = log.topic?.trim() || 'Unfiled';
    const bucket = groups.get(key);
    if (bucket) bucket.push(log);
    else groups.set(key, [log]);
  }

  return [...groups.entries()].sort(([a], [b]) =>
    a === 'Unfiled' ? 1 : b === 'Unfiled' ? -1 : a.localeCompare(b, undefined, { numeric: true })
  );
}
