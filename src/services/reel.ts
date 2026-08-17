import {
  Timestamp,
  getDocs,
  increment,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { paths } from '@/lib/paths';
import type {
  GeneratedReelCard,
  ReelCard,
  ReelCategory,
  ReelOrigin,
  SourceDocument,
  Subject,
} from '@/lib/schema';
import { getDb } from './firebase';
import { extractText } from './fileProcessor';
import { originalBytes } from './driveStorage';

export type ReelFilter = 'all' | 'courses' | 'tech' | 'science' | 'business' | string;

type MaterialSource = {
  subject: Subject;
  document: SourceDocument;
};

function hash(value: string): string {
  let number = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    number ^= value.charCodeAt(index);
    number = Math.imul(number, 16777619);
  }
  return (number >>> 0).toString(36);
}

function categoryForFilter(filter: ReelFilter): 'all' | ReelCategory {
  if (filter === 'tech' || filter === 'science' || filter === 'business') return filter;
  if (filter === 'courses' || !['all', 'general'].includes(filter)) return 'courses';
  return filter === 'general' ? 'general' : 'all';
}

type LocalDiscovery = Pick<
  GeneratedReelCard,
  'format' | 'category' | 'title' | 'body' | 'takeaway' | 'points'
>;

const LOCAL_DISCOVERY: LocalDiscovery[] = [
  {
    format: 'fact', category: 'tech', title: 'Binary search cuts the problem in half',
    body: 'On sorted data, binary search discards half of the remaining candidates after every comparison.',
    takeaway: 'Repeated halving turns a linear hunt into logarithmic search.', points: [],
  },
  {
    format: 'diagram', category: 'tech', title: 'A reliable data pipeline has clear stages',
    body: 'Separating collection, validation, transformation and storage makes failures easier to isolate and recover.',
    takeaway: 'A visible boundary between stages is also a debugging boundary.',
    points: ['Collect input', 'Validate shape', 'Transform safely', 'Store with provenance'],
  },
  {
    format: 'audio', category: 'tech', title: 'Latency and throughput answer different questions',
    body: 'Latency is the time one operation takes. Throughput is how many operations finish during a period.',
    takeaway: 'A system can have high throughput while an individual request still feels slow.', points: [],
  },
  {
    format: 'fact', category: 'science', title: 'A hypothesis must be testable',
    body: 'A scientific hypothesis links measurable variables in a way that evidence could support or contradict.',
    takeaway: 'If no possible observation could challenge a claim, it is not a useful test hypothesis.', points: [],
  },
  {
    format: 'diagram', category: 'science', title: 'Correlation does not establish causation',
    body: 'Two variables can move together because of coincidence, reverse causality or a third confounding variable.',
    takeaway: 'Ask what mechanism and comparison would separate the competing explanations.',
    points: ['Observe association', 'List confounders', 'Test direction', 'Seek controlled evidence'],
  },
  {
    format: 'audio', category: 'science', title: 'Units are part of the answer',
    body: 'Dimensional analysis checks whether quantities can be combined and often exposes an incorrect formula before calculation.',
    takeaway: 'Carry units through every line, not only at the end.', points: [],
  },
  {
    format: 'fact', category: 'business', title: 'Cash flow is not the same as profit',
    body: 'Profit follows accounting recognition rules, while cash flow records when money actually enters or leaves the organisation.',
    takeaway: 'A profitable organisation can still run short of cash.', points: [],
  },
  {
    format: 'diagram', category: 'business', title: 'Opportunity cost makes trade-offs visible',
    body: 'Choosing one option means giving up the value of the best available alternative.',
    takeaway: 'Compare a decision with the next-best option, not with doing nothing.',
    points: ['List alternatives', 'Estimate their value', 'Choose one option', 'Record what was forgone'],
  },
  {
    format: 'audio', category: 'business', title: 'A metric needs a decision attached to it',
    body: 'A dashboard number is useful only when a team knows what action a change in that number should trigger.',
    takeaway: 'Define the response before collecting the metric.', points: [],
  },
  {
    format: 'fact', category: 'general', title: 'Retrieval practice strengthens memory',
    body: 'Trying to recall an idea without looking at the answer produces stronger learning than rereading it repeatedly.',
    takeaway: 'Close the notes and retrieve before checking.', points: [],
  },
  {
    format: 'diagram', category: 'general', title: 'A strong explanation has three layers',
    body: 'State the idea plainly, show how it works, then connect it to a concrete example.',
    takeaway: 'Definition, mechanism and example make an answer easier to understand and grade.',
    points: ['Plain definition', 'Underlying mechanism', 'Concrete example'],
  },
  {
    format: 'audio', category: 'general', title: 'Spacing beats one long cram session',
    body: 'Short reviews separated by time create repeated retrieval opportunities and slow the forgetting curve.',
    takeaway: 'Return just before the idea becomes difficult to recall.', points: [],
  },
];

function finishLocalCard(card: LocalDiscovery): GeneratedReelCard {
  return {
    ...card,
    question: null,
    options: [],
    correctAnswerIndex: null,
    explanation: null,
    sourceQuote: null,
    pageNumber: null,
  };
}

function localDiscoveryCards(
  category: 'all' | ReelCategory,
  courseCodes: string[],
  count = 6
): GeneratedReelCard[] {
  if (category === 'courses') {
    const course = courseCodes.length === 1 ? courseCodes[0] : 'your courses';
    const courseCards: LocalDiscovery[] = [
      {
        format: 'fact', category: 'courses', title: `Active recall for ${course}`,
        body: 'Write what you remember before reopening the source, then correct only the missing or inaccurate parts.',
        takeaway: 'Retrieval reveals the exact gap that rereading can hide.', points: [],
      },
      {
        format: 'diagram', category: 'courses', title: 'Turn one topic into an exam-ready answer',
        body: 'Build from the definition to the mechanism, evidence and a concise conclusion.',
        takeaway: 'A repeatable answer structure reduces cognitive load under time pressure.',
        points: ['Define', 'Explain how', 'Support', 'Conclude'],
      },
      {
        format: 'audio', category: 'courses', title: 'Use examples as a comprehension test',
        body: 'If you can create a new correct example and explain why it fits, you understand more than the wording of the notes.',
        takeaway: 'A new example tests transfer, not recognition.', points: [],
      },
      {
        format: 'fact', category: 'courses', title: 'Interleave related problem types',
        body: 'Mixing related question types forces you to identify the method instead of repeating one procedure mechanically.',
        takeaway: 'Choosing the method is part of solving the problem.', points: [],
      },
      {
        format: 'diagram', category: 'courses', title: 'A useful weekly review is selective',
        body: 'Start with weak concepts, test them, repair the gaps, and schedule the next retrieval.',
        takeaway: 'Review should respond to evidence, not cover every page equally.',
        points: ['Find weak concepts', 'Test recall', 'Repair gaps', 'Schedule return'],
      },
      {
        format: 'audio', category: 'courses', title: 'Teach the concept without the notes',
        body: 'Explaining a topic aloud exposes missing links because vague recognition can no longer substitute for a complete chain of reasoning.',
        takeaway: 'If the explanation stalls, that point belongs in the study queue.', points: [],
      },
    ];
    return courseCards.slice(0, count).map(finishLocalCard);
  }

  const pool = category === 'all'
    ? LOCAL_DISCOVERY
    : LOCAL_DISCOVERY.filter((card) => card.category === category);
  return pool.slice(0, count).map(finishLocalCard);
}

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

/** Zero-request micro-chunking for material cards generated during upload. */
export function buildLocalMaterialReelCards(text: string, count = 6): GeneratedReelCard[] {
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
    const points = sentences.length >= 3 ? sentences.slice(0, 4).map((sentence) => truncate(sentence, 120)) : [];
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

async function materialSources(uid: string, subjects: Subject[]): Promise<MaterialSource[]> {
  const db = getDb();
  const snapshots = await Promise.all(
    subjects.map(async (subject) => ({
      subject,
      documents: await getDocs(paths.documents(db, uid, subject.id)),
    }))
  );

  return snapshots.flatMap(({ subject, documents }) =>
    documents.docs.flatMap((document) => {
      const data = { id: document.id, ...document.data() } as SourceDocument;
      return data.status === 'ready' && (data.rawText ?? '').trim().length > 200
        ? [{ subject, document: data }]
        : [];
    })
  );
}

/**
 * Older PDF records predate page markers. Re-read their stored original once,
 * persist the marked corpus, then every future Reel generation and Reader link
 * can cite the actual page without asking the student to upload again.
 */
async function pageAwareText(uid: string, source: MaterialSource): Promise<string> {
  const document = source.document;
  if (
    document.sourceKind !== 'pdf' ||
    /\[Page\s+\d+\]/i.test(document.rawText) ||
    (!document.r2FileKey && !document.r2FileUrl && !document.driveFileId)
  ) {
    return document.rawText;
  }

  try {
    // Originals may live in the student's Drive, whose stored url is a view
    // page rather than the file — asking for the bytes covers both stores.
    const blob = await originalBytes(document);
    if (!blob) return document.rawText;
    const parsed = await extractText(
      await blob.arrayBuffer(),
      document.fileName || document.title,
      document.mimeType || 'application/pdf'
    );
    if (!/\[Page\s+\d+\]/i.test(parsed.text)) return document.rawText;
    await updateDoc(
      paths.document(getDb(), uid, source.subject.id, document.id),
      { rawText: parsed.text, charCount: parsed.text.length }
    );
    return parsed.text;
  } catch (error) {
    console.warn('[reel] Could not retrofit PDF page markers; using stored text.', error);
    return document.rawText;
  }
}

function firestoreCard(
  generated: GeneratedReelCard,
  source: {
    origin: ReelOrigin;
    subjectId: string | null;
    subjectCode: string | null;
    documentId: string | null;
    documentTitle: string | null;
  }
) {
  return {
    ...generated,
    origin: source.origin,
    subjectId: source.subjectId,
    subjectCode: source.subjectCode,
    documentId: source.documentId,
    documentTitle: source.documentTitle,
    highlight: generated.sourceQuote,
    bookmarked: false,
    mastered: false,
    srsLevel: 0,
    dwellMs: 0,
    timesSeen: 0,
    quizAnswered: false,
    quizCorrect: null,
    xpEarned: 0,
    nextReviewAt: null,
    lastSeenAt: null,
    masteredAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

async function saveGeneratedCards(
  uid: string,
  generated: GeneratedReelCard[],
  source: {
    origin: ReelOrigin;
    subjectId: string | null;
    subjectCode: string | null;
    documentId: string | null;
    documentTitle: string | null;
  }
): Promise<void> {
  const db = getDb();
  await Promise.all(
    generated.map((card) => {
      const cardSource =
        source.origin === 'global-discovery' && card.category === 'courses'
          ? { ...source, origin: 'course-discovery' as const }
          : source;
      const id = hash(
        [cardSource.origin, cardSource.documentId, cardSource.subjectCode, card.title, card.body].join('|')
      );
      return setDoc(paths.reelCard(db, uid, id), firestoreCard(card, cardSource), { merge: true });
    })
  );
}

export async function preGenerateDocumentReel(input: {
  uid: string;
  subjectId: string;
  subjectName: string;
  subjectCode: string | null;
  documentId: string;
  documentTitle: string;
  text: string;
}): Promise<void> {
  if (input.text.trim().length < 200) return;
  const cards = buildLocalMaterialReelCards(input.text);
  if (cards.length === 0) return;
  await saveGeneratedCards(input.uid, cards, {
    origin: 'material',
    subjectId: input.subjectId,
    subjectCode: input.subjectCode,
    documentId: input.documentId,
    documentTitle: input.documentTitle,
  });
}

export async function cacheGlobalDiscoveryCards(uid: string, cards: ReelCard[]): Promise<void> {
  const db = getDb();
  await Promise.all(
    cards.map((card) =>
      setDoc(
        paths.reelCard(db, uid, card.id),
        {
          ...card,
          origin: card.origin || 'global-discovery',
          subjectId: card.subjectId ?? null,
          subjectCode: card.subjectCode ?? null,
          documentId: null,
          documentTitle: null,
          bookmarked: card.bookmarked ?? false,
          mastered: card.mastered ?? false,
          srsLevel: card.srsLevel ?? 0,
          dwellMs: card.dwellMs ?? 0,
          timesSeen: card.timesSeen ?? 0,
          quizAnswered: card.quizAnswered ?? false,
          quizCorrect: card.quizCorrect ?? null,
          xpEarned: card.xpEarned ?? 0,
          nextReviewAt: card.nextReviewAt ?? null,
          lastSeenAt: null,
          masteredAt: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      )
    )
  );
}

/**
 * Warms an empty feed from personal material and a small discovery reserve.
 * Existing document ids are passed from the live listener, preventing a file
 * from being chunked on every visit.
 */
export async function primeReel(
  uid: string,
  subjects: Subject[],
  existing: ReelCard[],
  filter: ReelFilter = 'all'
): Promise<void> {
  const courseCodes = subjects
    .map((subject) => subject.moduleCode?.trim())
    .filter((code): code is string => !!code);
  const selectedCodes =
    !['all', 'courses', 'tech', 'science', 'business', 'general'].includes(filter)
      ? [filter]
      : courseCodes;

  const knownDocuments = new Set(
    existing.map((card) => card.documentId).filter((id): id is string => !!id)
  );
  const sources = await materialSources(uid, subjects);
  const nextSource = sources.find(
    ({ subject, document }) =>
      !knownDocuments.has(document.id) &&
      (filter === 'all' ||
        filter === 'courses' ||
        filter === subject.moduleCode ||
        ['tech', 'science', 'business', 'general'].includes(filter))
  );

  const tasks: Promise<void>[] = [];
  if (nextSource && (filter === 'all' || filter === 'courses' || filter === nextSource.subject.moduleCode)) {
    tasks.push(
      pageAwareText(uid, nextSource).then((text) =>
        saveGeneratedCards(uid, buildLocalMaterialReelCards(text), {
          origin: 'material',
          subjectId: nextSource.subject.id,
          subjectCode: nextSource.subject.moduleCode,
          documentId: nextSource.document.id,
          documentTitle: nextSource.document.fileName || nextSource.document.title,
        })
      )
    );
  }

  const category = categoryForFilter(filter);
  const matchingDiscovery = existing.filter((card) => {
    if (card.origin === 'material') return false;
    if (filter === 'all') return true;
    if (filter === 'courses') return card.origin === 'course-discovery';
    if (selectedCodes.includes(filter)) return card.subjectCode === filter;
    return card.category === category;
  }).length;

  if (matchingDiscovery < 5) {
    const cards = localDiscoveryCards(category, selectedCodes);
    tasks.push(
      saveGeneratedCards(uid, cards, {
        origin: category === 'courses' ? 'course-discovery' : 'global-discovery',
        subjectId: null,
        subjectCode: category === 'courses' && selectedCodes.length === 1 ? selectedCodes[0] : null,
        documentId: null,
        documentTitle: null,
      })
    );
  }

  if (tasks.length === 0) return;
  const results = await Promise.allSettled(tasks);
  if (results.every((result) => result.status === 'rejected')) {
    const reason = results.find((result) => result.status === 'rejected');
    throw reason && reason.status === 'rejected' ? reason.reason : new Error('Could not build the Reel.');
  }
}

/** Adds another cached discovery batch when the student nears the end. */
export async function extendReel(
  uid: string,
  subjects: Subject[],
  filter: ReelFilter
): Promise<void> {
  const snapshot = await getDocs(paths.reelCards(getDb(), uid));
  const existing = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as ReelCard);
  await primeReel(uid, subjects, existing, filter);
}

export async function toggleReelBookmark(uid: string, card: ReelCard): Promise<void> {
  await updateDoc(paths.reelCard(getDb(), uid, card.id), {
    bookmarked: !card.bookmarked,
    updatedAt: serverTimestamp(),
  });
}

export async function markReelCard(
  uid: string,
  card: ReelCard,
  outcome: 'mastered' | 'review'
): Promise<void> {
  const nextLevel = outcome === 'mastered' ? Math.min(5, (card.srsLevel ?? 0) + 1) : 0;
  const intervalDays = [0, 1, 3, 7, 14, 30][nextLevel];
  const delay = outcome === 'mastered' ? intervalDays * 86_400_000 : 5 * 60_000;

  await updateDoc(paths.reelCard(getDb(), uid, card.id), {
    mastered: outcome === 'mastered',
    srsLevel: nextLevel,
    nextReviewAt: Timestamp.fromDate(new Date(Date.now() + delay)),
    masteredAt: outcome === 'mastered' ? serverTimestamp() : null,
    lastSeenAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function recordReelDwell(uid: string, cardId: string, dwellMs: number): Promise<void> {
  if (dwellMs < 700) return;
  await updateDoc(paths.reelCard(getDb(), uid, cardId), {
    dwellMs: increment(Math.min(dwellMs, 120_000)),
    timesSeen: increment(1),
    // A long pause is implicit difficulty feedback. Put the concept back near
    // the front soon, instead of treating watch time as mastery.
    ...(dwellMs >= 15_000
      ? { nextReviewAt: Timestamp.fromDate(new Date(Date.now() + 5 * 60_000)) }
      : {}),
    lastSeenAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function answerReelQuiz(
  uid: string,
  card: ReelCard,
  selectedIndex: number
): Promise<boolean> {
  const correct = selectedIndex === card.correctAnswerIndex;
  await updateDoc(paths.reelCard(getDb(), uid, card.id), {
    quizAnswered: true,
    quizCorrect: correct,
    xpEarned: correct && !card.quizAnswered ? 10 : card.xpEarned ?? 0,
    lastSeenAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return correct;
}

export function filterReelCards(cards: ReelCard[], filter: ReelFilter): ReelCard[] {
  if (filter === 'all') return cards;
  if (filter === 'courses') {
    return cards.filter((card) => card.origin !== 'global-discovery');
  }
  if (filter === 'tech' || filter === 'science' || filter === 'business') {
    return cards.filter((card) => card.category === filter);
  }
  return cards.filter((card) => card.subjectCode === filter);
}

/** Personal/course/global mix with due SRS reviews inserted every third card. */
export function buildReelQueue(cards: ReelCard[], now = Date.now()): ReelCard[] {
  const reviewTime = (card: ReelCard) =>
    card.nextReviewAt?.toMillis ? card.nextReviewAt.toMillis() : null;
  const due = cards.filter((card) => {
    const time = reviewTime(card);
    return time !== null && time <= now;
  });
  const active = cards.filter(
    (card) => {
      const time = reviewTime(card);
      return !card.mastered && (time === null || time <= now) && !due.some((review) => review.id === card.id);
    }
  );
  const material = active.filter((card) => card.origin === 'material');
  const course = active.filter((card) => card.origin === 'course-discovery');
  const global = active.filter((card) => card.origin === 'global-discovery');
  const cycle: ReelOrigin[] = [
    'material',
    'material',
    'course-discovery',
    'material',
    'global-discovery',
    'material',
    'course-discovery',
  ];
  const pools = { material, 'course-discovery': course, 'global-discovery': global };
  const positions = { material: 0, 'course-discovery': 0, 'global-discovery': 0 };
  const fresh: ReelCard[] = [];

  while (fresh.length < active.length) {
    let added = false;
    for (const origin of cycle) {
      const pool = pools[origin];
      const position = positions[origin];
      if (position < pool.length) {
        fresh.push(pool[position]);
        positions[origin] += 1;
        added = true;
      }
    }
    if (!added) break;
  }

  const queue: ReelCard[] = [];
  let reviewIndex = 0;
  for (let index = 0; index < fresh.length; index += 1) {
    if (index > 0 && index % 2 === 0 && reviewIndex < due.length) {
      queue.push(due[reviewIndex++]);
    }
    queue.push(fresh[index]);
  }
  queue.push(...due.slice(reviewIndex));
  return queue;
}
