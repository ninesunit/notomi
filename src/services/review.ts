import {
  getCountFromServer,
  getDocs,
  increment,
  limit as limitTo,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type QueryConstraint,
} from 'firebase/firestore';
import { nextReviewDate } from '@/lib/dates';
import { stableId } from '@/lib/ids';
import { paths } from '@/lib/paths';
import type {
  GeneratedReviewCard,
  ReviewCard,
  ReviewFormat,
  ReviewOrigin,
  SourceDocument,
  Subject,
  WeakConcept,
} from '@/lib/schema';
import { getDb } from './firebase';

/* ------------------------------------------------------------------ *
 * Modes
 * ------------------------------------------------------------------ */

export type ReviewMode =
  | 'quick'
  | 'exam'
  | 'difficult'
  | 'mixed'
  | 'mistakes'
  | 'bookmarked'
  | 'document';

export const REVIEW_MODES: {
  id: ReviewMode;
  label: string;
  blurb: string;
  size: number;
}[] = [
  {
    id: 'quick',
    label: 'Five-minute review',
    blurb: 'The concepts due today, oldest first.',
    size: 10,
  },
  {
    id: 'exam',
    label: 'Exam preparation',
    blurb: 'A longer pass over everything not yet mastered.',
    size: 20,
  },
  {
    id: 'difficult',
    label: 'Difficult concepts',
    blurb: 'What keeps dropping back to the start.',
    size: 15,
  },
  {
    id: 'mixed',
    label: 'Random mixed review',
    blurb: 'A shuffle across every course.',
    size: 15,
  },
  {
    id: 'mistakes',
    label: 'Mistakes from Arena',
    blurb: 'Questions you have missed in a quiz or battle.',
    size: 15,
  },
  {
    id: 'bookmarked',
    label: 'Saved cards',
    blurb: 'Everything you bookmarked to come back to.',
    size: 15,
  },
];

const SIZE_BY_MODE = new Map(REVIEW_MODES.map((mode) => [mode.id, mode.size]));

/** Cards from one document is reached from a document, not from the mode list. */
export function sessionSize(mode: ReviewMode): number {
  return SIZE_BY_MODE.get(mode) ?? 15;
}

/* ------------------------------------------------------------------ *
 * The deck a session hands to the screen
 * ------------------------------------------------------------------ */

/**
 * One card as the deck screen sees it.
 *
 * Two very different records end up here: a stored review card written from a
 * student's own material, and a weak concept recorded when a quiz or an Arena
 * battle was answered wrongly. They review identically, so the screen is given
 * one shape and `source` is how the commit knows which record to write back.
 */
export type DeckCard = {
  id: string;
  source: 'card' | 'concept';
  format: ReviewFormat;
  title: string;
  body: string;
  takeaway: string;
  points: string[];
  question: string | null;
  options: string[];
  correctAnswerIndex: number | null;
  explanation: string | null;
  subjectId: string | null;
  subjectCode: string | null;
  subjectName: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  highlight: string | null;
  bookmarked: boolean;
  mastered: boolean;
  srsLevel: number;
};

export type ReviewOutcome = 'again' | 'good';

export type ReviewAnswer = {
  card: DeckCard;
  outcome: ReviewOutcome;
  /** Only set when the card carried a quiz the student actually answered. */
  quizCorrect: boolean | null;
};

export type ReviewScope = {
  mode: ReviewMode;
  /** Empty means every course. */
  subjectIds: string[];
  documentId?: string | null;
};

/* ------------------------------------------------------------------ *
 * Reading a session
 * ------------------------------------------------------------------ */

/**
 * How many stored cards a session may read before selecting from them.
 *
 * A review session is a bounded batch, not a feed, so the deck never opens a
 * listener and never pages forward on its own. Twice the session size gives
 * the mode something to choose between — a five-minute review wants the most
 * overdue ten of the next twenty, not the first ten it happens to see — while
 * keeping one session inside a couple of dozen document reads. At the free
 * tier's daily read allowance that is a handful of sessions a day per student
 * with room left over for the rest of the app.
 */
function poolSize(size: number): number {
  return Math.min(60, Math.max(24, size * 2));
}

function toDeckCard(card: ReviewCard, subjects: Map<string, Subject>): DeckCard {
  const subject = card.subjectId ? subjects.get(card.subjectId) : undefined;
  return {
    id: card.id,
    source: 'card',
    format: card.format ?? 'fact',
    title: card.title,
    body: card.body,
    takeaway: card.takeaway ?? card.body,
    points: Array.isArray(card.points) ? card.points : [],
    question: card.question ?? null,
    options: Array.isArray(card.options) ? card.options : [],
    correctAnswerIndex: card.correctAnswerIndex ?? null,
    explanation: card.explanation ?? null,
    subjectId: card.subjectId ?? null,
    subjectCode: card.subjectCode ?? subject?.moduleCode ?? null,
    subjectName: subject?.name ?? null,
    documentId: card.documentId ?? null,
    documentTitle: card.documentTitle ?? null,
    pageNumber: card.pageNumber ?? null,
    highlight: card.highlight ?? null,
    bookmarked: card.bookmarked === true,
    mastered: card.mastered === true,
    srsLevel: card.srsLevel ?? 0,
  };
}

function conceptToDeckCard(concept: WeakConcept): DeckCard {
  return {
    id: concept.id,
    source: 'concept',
    format: 'quiz',
    title: concept.concept || concept.question.slice(0, 80),
    body: concept.question,
    takeaway: concept.correctAnswer,
    points: [],
    question: concept.question,
    options: [],
    correctAnswerIndex: null,
    explanation: concept.explanation ?? null,
    subjectId: concept.subjectId ?? null,
    subjectCode: null,
    subjectName: concept.subjectName ?? null,
    documentId: null,
    documentTitle: null,
    pageNumber: null,
    highlight: null,
    bookmarked: false,
    mastered: false,
    srsLevel: concept.box ?? 0,
  };
}

/**
 * Normalises the origin recorded by the retired Reel.
 *
 * It wrote three: material, course-discovery and global-discovery. Only the
 * first came from a student's own upload; the other two were generated filler.
 */
function originOf(card: ReviewCard): ReviewOrigin {
  return (card.origin as string) === 'material' ? 'material' : 'discovery';
}

/**
 * Would a student recognise this card as theirs?
 *
 * Cards built from an uploaded document always qualify. A leftover discovery
 * card only qualifies once the student has done something with it — saved it,
 * mastered it, answered its quiz — because that state is theirs even when the
 * card was not. Untouched filler stays out of every deck rather than being
 * deleted, so nothing is lost if it turns out someone wanted it.
 */
function ownedByStudent(card: ReviewCard): boolean {
  if (originOf(card) === 'material') return true;
  return (
    card.bookmarked === true ||
    card.mastered === true ||
    (card.srsLevel ?? 0) > 0 ||
    card.quizAnswered === true
  );
}

function dueAt(card: ReviewCard): number {
  const next = card.nextReviewAt;
  // A card that has never been scheduled is ready now, not never.
  return next?.toMillis ? next.toMillis() : 0;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/**
 * Reads the candidate cards for a scope.
 *
 * Every branch is one bounded query against a single field, so none of them
 * needs a composite index and none of them can run away. Where a filter is
 * applied the ordering is done in memory afterwards; where there is no filter
 * the server orders by review date, which puts never-reviewed and most-overdue
 * cards at the front of the batch that gets read.
 */
async function readCandidates(uid: string, scope: ReviewScope, size: number): Promise<ReviewCard[]> {
  const db = getDb();
  const collectionRef = paths.reviewCards(db, uid);
  const pool = poolSize(size);

  const read = async (constraints: QueryConstraint[]) => {
    const snapshot = await getDocs(query(collectionRef, ...constraints));
    return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as ReviewCard);
  };

  if (scope.documentId) {
    return read([where('documentId', '==', scope.documentId), limitTo(pool)]);
  }
  if (scope.mode === 'bookmarked') {
    // Bookmarks are indexed on the flag, not the course, so a course scope is
    // applied here rather than as a second filter the query would need an
    // index for. Saved cards are few; narrowing them in memory is free.
    const saved = await read([where('bookmarked', '==', true), limitTo(pool)]);
    return scope.subjectIds.length === 0
      ? saved
      : saved.filter((card) => card.subjectId && scope.subjectIds.includes(card.subjectId));
  }
  if (scope.subjectIds.length === 1) {
    return read([where('subjectId', '==', scope.subjectIds[0]), limitTo(pool)]);
  }
  // Firestore caps an `in` filter at 30 values. Past that the unscoped read
  // below is both cheaper and no less correct, so it falls through to it.
  if (scope.subjectIds.length > 1 && scope.subjectIds.length <= 30) {
    return read([where('subjectId', 'in', scope.subjectIds), limitTo(pool)]);
  }

  const ordered = await read([orderBy('nextReviewAt', 'asc'), limitTo(pool)]);
  // orderBy skips documents missing the field entirely. Every card Notomi has
  // written carries an explicit null, but an empty result is cheap to double
  // check and a student with cards seeing "no cards" would be a dead end.
  return ordered.length > 0 ? ordered : read([limitTo(pool)]);
}

async function readMistakes(uid: string, scope: ReviewScope, size: number): Promise<WeakConcept[]> {
  const db = getDb();
  const constraints =
    scope.subjectIds.length === 1
      ? [where('subjectId', '==', scope.subjectIds[0]), limitTo(poolSize(size))]
      : [limitTo(poolSize(size))];
  const snapshot = await getDocs(query(paths.weakConcepts(db, uid), ...constraints));
  return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as WeakConcept);
}

/** Orders and trims the candidates according to what the student asked for. */
function selectForMode(cards: ReviewCard[], mode: ReviewMode, size: number): ReviewCard[] {
  const now = Date.now();
  const owned = cards.filter(ownedByStudent);

  if (mode === 'mixed') {
    const eligible = owned.filter((card) => !card.mastered || dueAt(card) <= now);
    return shuffle(eligible).slice(0, size);
  }

  if (mode === 'difficult') {
    const struggling = owned.filter(
      (card) =>
        !card.mastered &&
        ((card.srsLevel ?? 0) <= 1 || card.quizCorrect === false) &&
        (card.timesSeen ?? 0) > 0
    );
    // A student who asks for their hard concepts and has never marked one
    // should still get a session rather than an empty screen.
    const fallback = owned.filter((card) => !card.mastered);
    const chosen = struggling.length > 0 ? struggling : fallback;
    return [...chosen].sort((a, b) => (a.srsLevel ?? 0) - (b.srsLevel ?? 0) || dueAt(a) - dueAt(b)).slice(0, size);
  }

  if (mode === 'exam') {
    const eligible = owned.filter((card) => !card.mastered || dueAt(card) <= now);
    return [...eligible]
      .sort((a, b) => Number(a.mastered) - Number(b.mastered) || dueAt(a) - dueAt(b))
      .slice(0, size);
  }

  // quick, bookmarked and a single document all want the same thing: what is
  // due, most overdue first, and unseen material before anything scheduled
  // into the future.
  const due = owned.filter((card) => dueAt(card) <= now);
  const chosen = due.length > 0 ? due : owned.filter((card) => !card.mastered);
  return [...chosen].sort((a, b) => dueAt(a) - dueAt(b)).slice(0, size);
}

export type ReviewSession = {
  mode: ReviewMode;
  cards: DeckCard[];
  /** Candidates that matched but did not fit this batch. */
  heldBack: number;
};

/**
 * Builds one review session.
 *
 * Deliberately a plain async read rather than a subscription: a session is a
 * fixed set of cards a student chose to sit down with, and it should not
 * change underneath them while they work through it.
 */
export async function startReviewSession(
  uid: string,
  scope: ReviewScope,
  subjects: Subject[]
): Promise<ReviewSession> {
  const size = scope.documentId ? 15 : sessionSize(scope.mode);
  const bySubject = new Map(subjects.map((subject) => [subject.id, subject]));

  if (scope.mode === 'mistakes') {
    const concepts = await readMistakes(uid, scope, size);
    const ordered = [...concepts].sort((a, b) => {
      const left = a.nextReviewAt?.toMillis ? a.nextReviewAt.toMillis() : 0;
      const right = b.nextReviewAt?.toMillis ? b.nextReviewAt.toMillis() : 0;
      return left - right || (b.timesMissed ?? 0) - (a.timesMissed ?? 0);
    });
    return {
      mode: scope.mode,
      cards: ordered.slice(0, size).map(conceptToDeckCard),
      heldBack: Math.max(0, ordered.length - size),
    };
  }

  const candidates = await readCandidates(uid, scope, size);
  const selected = selectForMode(candidates, scope.mode, size);
  return {
    mode: scope.mode,
    cards: selected.map((card) => toDeckCard(card, bySubject)),
    heldBack: Math.max(0, candidates.filter(ownedByStudent).length - selected.length),
  };
}

/** One aggregate read, so an empty deck can say so without listing the cards. */
export async function countReviewCards(uid: string): Promise<number> {
  const snapshot = await getCountFromServer(paths.reviewCards(getDb(), uid));
  return snapshot.data().count;
}

/* ------------------------------------------------------------------ *
 * Writing a session back
 * ------------------------------------------------------------------ */

/**
 * The top of the ladder, where a concept counts as mastered.
 *
 * The intervals themselves come from nextReviewDate, which is also what the
 * quiz flow's weak concepts climb — one spacing schedule in the app rather
 * than a review deck quietly running its own.
 */
const TOP_LEVEL = 5;

/**
 * Persists a finished session in one batch.
 *
 * Nothing is written while a student is working through the deck. A swipe
 * costs no network at all, so a twenty-card session is one write per card at
 * the end instead of three or four each as it went — which is the difference
 * between a review habit fitting inside the free daily write allowance and
 * exhausting it by mid-morning.
 */
export async function commitReviewSession(uid: string, answers: ReviewAnswer[]): Promise<number> {
  if (answers.length === 0) return 0;
  const db = getDb();
  const batch = writeBatch(db);
  let newlyMastered = 0;

  for (const answer of answers) {
    const { card, outcome, quizCorrect } = answer;

    if (card.source === 'concept') {
      // A missed concept drops to the bottom of the ladder; clearing the top
      // rung retires it, which is what the quiz flow has always done.
      const ref = paths.weakConcept(db, uid, card.id);
      if (outcome === 'again') {
        batch.set(
          ref,
          { box: 0, nextReviewAt: nextReviewDate(0), lastMissedAt: serverTimestamp() },
          { merge: true }
        );
      } else {
        const box = (card.srsLevel ?? 0) + 1;
        if (box > 4) batch.delete(ref);
        else batch.set(ref, { box, nextReviewAt: nextReviewDate(box) }, { merge: true });
      }
      continue;
    }

    const level = outcome === 'good' ? Math.min(TOP_LEVEL, (card.srsLevel ?? 0) + 1) : 0;
    const mastered = outcome === 'good' && level >= TOP_LEVEL;
    if (mastered && !card.mastered) newlyMastered += 1;

    batch.update(paths.reviewCard(db, uid, card.id), {
      srsLevel: level,
      mastered,
      // Getting it wrong brings the concept back in a day, not in five minutes:
      // a card cannot be re-earned inside the session that just failed it.
      nextReviewAt: nextReviewDate(outcome === 'good' ? level : 0),
      masteredAt: mastered ? serverTimestamp() : null,
      timesSeen: increment(1),
      ...(quizCorrect === null ? {} : { quizAnswered: true, quizCorrect }),
      lastSeenAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  await batch.commit();
  return newlyMastered;
}

/** A bookmark is a single deliberate tap, so it writes immediately. */
export async function setReviewBookmark(
  uid: string,
  cardId: string,
  bookmarked: boolean
): Promise<void> {
  await updateDoc(paths.reviewCard(getDb(), uid, cardId), {
    bookmarked,
    updatedAt: serverTimestamp(),
  });
}

/* ------------------------------------------------------------------ *
 * Building cards from material
 * ------------------------------------------------------------------ */

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
 * Turns a document's text into review cards without asking Gemini anything.
 *
 * The concepts are already written down in the material; picking them out is
 * chunking, not reasoning, and deterministic code does it instantly, offline,
 * and without touching a rate limit that the reader and the importer need
 * more than this does.
 */
export function buildLocalReviewCards(text: string, count = 6): GeneratedReviewCard[] {
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

/**
 * Writes a deck for one document, on request.
 *
 * Nothing calls this during an upload. A semester of slides used to mint six
 * cards per file the moment it landed, whether or not anyone ever reviewed
 * them; now a student asks for the deck they want and pays for that one.
 * Returns how many cards the document yielded.
 */
export async function buildDeckForDocument(input: {
  uid: string;
  subject: Subject;
  document: SourceDocument;
  count?: number;
}): Promise<number> {
  const text = input.document.rawText ?? '';
  if (text.trim().length < 200) return 0;
  const cards = buildLocalReviewCards(text, input.count);
  if (cards.length === 0) return 0;

  const db = getDb();
  const title = input.document.fileName || input.document.title;
  await Promise.all(
    cards.map((card) => {
      // Stable id, so asking for the deck twice refreshes it rather than
      // doubling it.
      const id = stableId('review', input.document.id, card.title, card.body);
      return setDoc(
        paths.reviewCard(db, input.uid, id),
        {
          ...card,
          origin: 'material' as ReviewOrigin,
          subjectId: input.subject.id,
          subjectCode: input.subject.moduleCode ?? null,
          documentId: input.document.id,
          documentTitle: title,
          highlight: card.sourceQuote,
          bookmarked: false,
          mastered: false,
          srsLevel: 0,
          timesSeen: 0,
          quizAnswered: false,
          quizCorrect: null,
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
  return cards.length;
}
