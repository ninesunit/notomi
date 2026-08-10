import { deleteDoc, getDoc, increment, serverTimestamp, setDoc, Timestamp } from 'firebase/firestore';
import { nextReviewDate } from './dates';
import { getDb } from '@/services/firebase';
import { stableId } from './ids';
import { paths } from './paths';
import type { QuizQuestion, WeakConcept } from './schema';

function conceptKey(subjectId: string, question: QuizQuestion): string {
  return stableId(subjectId, question.concept || question.question);
}

/**
 * A missed question drops the concept back to box 0, so it comes round again
 * tomorrow no matter how well it was doing before.
 */
export async function recordMiss(
  uid: string,
  subjectId: string,
  subjectName: string | null,
  question: QuizQuestion
): Promise<void> {
  const db = getDb();
  const id = conceptKey(subjectId, question);
  const ref = paths.weakConcept(db, uid, id);
  const existing = await getDoc(ref);

  await setDoc(
    ref,
    {
      subjectId,
      subjectName,
      concept: question.concept || question.question.slice(0, 80),
      question: question.question,
      correctAnswer: question.options[question.correctAnswerIndex] ?? '',
      explanation: question.explanation || null,
      timesMissed: existing.exists() ? increment(1) : 1,
      timesReviewed: existing.exists() ? increment(1) : 1,
      box: 0,
      lastMissedAt: serverTimestamp(),
      nextReviewAt: nextReviewDate(0),
    },
    { merge: true }
  );
}

/**
 * Answering a tracked concept correctly promotes it up the Leitner ladder.
 * Clearing box 4 retires the concept entirely.
 */
export async function recordHit(
  uid: string,
  subjectId: string,
  question: QuizQuestion
): Promise<void> {
  const db = getDb();
  const ref = paths.weakConcept(db, uid, conceptKey(subjectId, question));
  const existing = await getDoc(ref);
  if (!existing.exists()) return;

  const box = ((existing.data() as WeakConcept).box ?? 0) + 1;
  if (box > 4) {
    await deleteDoc(ref);
    return;
  }

  await setDoc(
    ref,
    { box, timesReviewed: increment(1), nextReviewAt: nextReviewDate(box) },
    { merge: true }
  );
}

/** Concepts whose review date has arrived (or that have never been reviewed). */
export function isDue(concept: WeakConcept, now = new Date()): boolean {
  const next = concept.nextReviewAt;
  if (!next) return true;
  return (next as Timestamp).toMillis() <= now.getTime();
}
