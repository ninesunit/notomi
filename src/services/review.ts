import { Timestamp, increment, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';

import { paths } from '@/lib/paths';
import type { GeneratedReviewCard, ReviewCard, Subject } from '@/lib/schema';
import { getDb } from './firebase';

/**
 * Review cards: what survived Notomi Reel.
 *
 * The feed is gone — the infinite scroll, the dwell timers, the global
 * discovery content, the elaboration calls, and the generation that fired on
 * every upload whether or not anyone would ever look at the result. What was
 * worth keeping is the card itself: a concept lifted from the student's own
 * material, with the page it came from, a mastery state and a review date.
 *
 * The difference is intent. A student now opens a subject and starts a review
 * of a known length. Nothing generates unless they ask for it, and nothing is
 * written per swipe.
 *
 * Cards still live in `users/{uid}/reelCards`. Renaming the collection would
 * mean migrating every existing card to gain nothing a comment cannot say:
 * this is the review deck, and that is where it has always been stored.
 */

/** How long a session runs. Bounded, because "just one more" is what was wrong. */
export const SESSION_SIZE = 12;

export type ReviewMode = 'due' | 'weak' | 'bookmarked' | 'all';

export const REVIEW_MODES: Array<{ id: ReviewMode; label: string; blurb: string }> = [
  { id: 'due', label: 'Due now', blurb: 'Concepts your spacing schedule says are ready.' },
  { id: 'weak', label: 'Difficult', blurb: 'The ones you have asked to see again.' },
  { id: 'bookmarked', label: 'Saved', blurb: 'Everything you bookmarked.' },
  { id: 'all', label: 'Everything', blurb: 'A mixed pass over the whole deck.' },
];

function hash(value: string): string {
  let number = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    number ^= value.charCodeAt(index);
    number = Math.imul(number, 16777619);
  }
  return (number >>> 0).toString(36);
}

/* ------------------------------ Building ------------------------------ */

type LocalConcept = { text: string; quote: string; pageNumber: number | null };

function localConcepts(text: string): LocalConcept[] {
  const pages: { pageNumber: number | null; text: string }[] = [];
  const marker = /\[Page\s+(\d+)\]/gi;
  let pageNumber: number | null = null;
  let start = 0;
  for (const match of text.matchAll(marker)) {
    if (match.index! > start) pages.push({ pageNumber, text: text.slice(start, match.index) });
    pageNumber = Number(match[1]);
    start = match.index! + match[0].length;
  }
  pages.push({ pageNumber, text: text.slice(start) });

  return pages.flatMap((page) =>
    page.text
      .split(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z])/)
      .map((raw) => raw.trim())
      .filter(
        (raw) =>
          raw.length >= 90 &&
          raw.length <= 1_400 &&
          !/(?:copyright|all rights reserved|https?:\/\/|@\w+\.\w+|telephone|student id)/i.test(raw)
      )
      .map((raw) => ({
        text: raw.replace(/\s+/g, ' ').trim(),
        quote: raw.slice(0, 260).trim(),
        pageNumber: page.pageNumber,
      }))
  );
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const clipped = value.slice(0, limit - 1);
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, Math.max(boundary, Math.floor(limit * 0.7))).trim()}…`;
}

/**
 * Cards straight from the text, with no request to anyone.
 *
 * Worth keeping precisely because it costs nothing: a student can build a deck
 * from a document without spending any of the day's AI allowance, and the
 * result still carries the page each concept came from.
 */
export function buildLocalCards(text: string, count = 6): GeneratedReviewCard[] {
  const concepts = localConcepts(text);
  if (concepts.length === 0) return [];
  const wanted = Math.min(Math.max(3, count), 8, concepts.length);
  const selected = Array.from({ length: wanted }, (_, index) =>
    concepts[Math.min(concepts.length - 1, Math.floor((index * concepts.length) / wanted))]
  );

  return selected.map((concept, index) => {
    const sentences = concept.text
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    const points =
      sentences.length >= 3 ? sentences.slice(0, 4).map((sentence) => truncate(sentence, 120)) : [];
    const first = sentences[0] || concept.text;
    return {
      format: points.length >= 3 ? 'diagram' : index % 3 === 2 ? 'audio' : 'fact',
      category: 'courses',
      title: truncate(first.replace(/[.:;!?]+$/, ''), 78),
      body: truncate(concept.text, 320),
      takeaway: truncate(first, 170),
      points,
      question: null,
      options: [],
      correctAnswerIndex: null,
      explanation: null,
      sourceQuote: concept.quote,
      pageNumber: concept.pageNumber,
    };
  });
}

/** Writes a generated batch. Only ever called from an explicit student action. */
export async function saveCards(
  uid: string,
  generated: GeneratedReviewCard[],
  source: {
    subjectId: string | null;
    subjectCode: string | null;
    documentId: string | null;
    documentTitle: string | null;
  }
): Promise<number> {
  if (generated.length === 0) return 0;
  const db = getDb();

  await Promise.all(
    generated.map((card) => {
      // Content-addressed, so building a deck twice from the same document
      // updates the same cards rather than doubling them.
      const id = hash(['material', source.documentId, source.subjectCode, card.title, card.body].join('|'));
      return setDoc(
        paths.reelCard(db, uid, id),
        {
          ...card,
          origin: 'material' as const,
          subjectId: source.subjectId,
          subjectCode: source.subjectCode,
          documentId: source.documentId,
          documentTitle: source.documentTitle,
          highlight: card.sourceQuote,
          bookmarked: false,
          mastered: false,
          srsLevel: 0,
          timesSeen: 0,
          quizAnswered: false,
          quizCorrect: null,
          xpEarned: 0,
          nextReviewAt: null,
          lastSeenAt: null,
          masteredAt: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    })
  );

  return generated.length;
}

/* ------------------------------ Sessions ------------------------------ */

function dueAt(card: ReviewCard): number | null {
  return card.nextReviewAt?.toMillis ? card.nextReviewAt.toMillis() : null;
}

/**
 * The cards for one session, in order, capped.
 *
 * A cap rather than a queue that refills: the point of the change is that a
 * student knows when they are finished. Due cards lead because a schedule
 * nobody honours is not a schedule.
 */
export function buildSession(
  cards: ReviewCard[],
  mode: ReviewMode,
  options: { subjectId?: string | null; limit?: number; now?: number } = {}
): ReviewCard[] {
  const { subjectId = null, limit = SESSION_SIZE, now = Date.now() } = options;

  const scoped = subjectId ? cards.filter((card) => card.subjectId === subjectId) : cards;

  const pool = scoped.filter((card) => {
    if (mode === 'bookmarked') return card.bookmarked;
    if (mode === 'weak') return !card.mastered && (card.srsLevel ?? 0) === 0 && (card.timesSeen ?? 0) > 0;
    if (mode === 'due') {
      const time = dueAt(card);
      return time === null ? !card.mastered : time <= now;
    }
    return true;
  });

  return [...pool]
    .sort((a, b) => {
      const left = dueAt(a);
      const right = dueAt(b);
      if (left === right) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return left - right;
    })
    .slice(0, limit);
}

export function countDue(cards: ReviewCard[], now = Date.now()): number {
  return cards.filter((card) => {
    const time = dueAt(card);
    return time === null ? !card.mastered : time <= now;
  }).length;
}

/** Doubling intervals, capped at a month. Deliberately boring, and free. */
const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30];

export type CardOutcome = {
  cardId: string;
  outcome: 'mastered' | 'again';
  /** Present only for quiz cards the student actually answered. */
  quizCorrect?: boolean;
  previousLevel: number;
  previouslyAnswered: boolean;
  previousXp: number;
};

/**
 * One write for a whole session, not one per card.
 *
 * The feed wrote on every swipe — a dwell timer, a seen count, a review date.
 * Twelve cards was a dozen writes against a daily allowance measured in
 * thousands, shared by every student. A session is now a single batch, sent
 * when the student finishes or leaves.
 */
export async function commitSession(uid: string, outcomes: CardOutcome[]): Promise<void> {
  if (outcomes.length === 0) return;
  const db = getDb();
  const batch = writeBatch(db);

  for (const entry of outcomes) {
    const nextLevel =
      entry.outcome === 'mastered' ? Math.min(5, entry.previousLevel + 1) : 0;
    const delay =
      entry.outcome === 'mastered' ? INTERVAL_DAYS[nextLevel] * 86_400_000 : 10 * 60_000;

    batch.update(paths.reelCard(db, uid, entry.cardId), {
      mastered: entry.outcome === 'mastered',
      srsLevel: nextLevel,
      timesSeen: increment(1),
      nextReviewAt: Timestamp.fromDate(new Date(Date.now() + delay)),
      masteredAt: entry.outcome === 'mastered' ? serverTimestamp() : null,
      lastSeenAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...(entry.quizCorrect === undefined
        ? {}
        : {
            quizAnswered: true,
            quizCorrect: entry.quizCorrect,
            xpEarned: entry.quizCorrect && !entry.previouslyAnswered ? entry.previousXp + 10 : entry.previousXp,
          }),
    });
  }

  await batch.commit();
}

/** Bookmarks are immediate: the student expects the star to stick. */
export async function toggleBookmark(uid: string, card: ReviewCard): Promise<void> {
  const db = getDb();
  await setDoc(
    paths.reelCard(db, uid, card.id),
    { bookmarked: !card.bookmarked, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

/** Subjects that actually have cards, for the deck picker. */
export function subjectsWithCards(cards: ReviewCard[], subjects: Subject[]): Subject[] {
  const withCards = new Set(cards.map((card) => card.subjectId).filter(Boolean));
  return subjects.filter((subject) => withCards.has(subject.id));
}
