import {
  Timestamp,
  arrayUnion,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Timestamp as FirestoreTimestamp,
} from 'firebase/firestore';
import { buildContext, generateBattleCommentary, generateQuiz } from '@/lib/ai';
import { paths } from '@/lib/paths';
import type { QuizQuestion } from '@/lib/schema';
import { getDb } from './firebase';

export type ArenaMode = 'same-course' | 'cross-course' | 'ghost';
export type ArenaStatus = 'lobby' | 'playing' | 'finished';

export type ArenaRoom = {
  id: string;
  code: string;
  hostId: string;
  mode: ArenaMode;
  status: ArenaStatus;
  memberIds: string[];
  subjectId: string | null;
  subjectCode: string | null;
  subjectName: string | null;
  deck: QuizQuestion[] | null;
  currentQuestion: number;
  questionStartedAt: FirestoreTimestamp | null;
  commentary: string | null;
  ghostScore?: number | null;
  ghostName?: string | null;
  createdAt: FirestoreTimestamp | null;
  updatedAt: FirestoreTimestamp | null;
};

export type ArenaPlayer = {
  id: string;
  displayName: string;
  subjectId: string;
  subjectName: string;
  score: number;
  streak: number;
  onFire: boolean;
  answeredQuestion: number;
  selectedAnswer: number | null;
  lastCorrect: boolean | null;
  missedConcepts: string[];
  joinedAt: FirestoreTimestamp | null;
};

export type ArenaDeck = { id: string; ownerId: string; questions: QuizQuestion[] };

export type ArenaGhost = {
  id: string;
  ownerId: string;
  ownerName: string;
  subjectId: string;
  subjectName: string;
  score: number;
  deck: QuizQuestion[];
  missedConcepts: string[];
  createdAt: FirestoreTimestamp | null;
};

type Source = { title: string; text: string };

const roomCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

async function makeDeck(sources: Source[]): Promise<QuizQuestion[]> {
  const context = buildContext(sources);
  if (!context) throw new Error('Upload readable subject material before creating a battle.');
  const questions = await generateQuiz(context, { count: 5, battle: true });
  if (questions.length < 5) {
    throw new Error('This subject does not have enough readable material for five fair questions.');
  }
  return questions.slice(0, 5);
}

export async function createArenaRoom(input: {
  uid: string;
  displayName: string;
  subject: { id: string; name: string; moduleCode: string | null };
  sources: Source[];
  mode: Exclude<ArenaMode, 'ghost'>;
}): Promise<string> {
  const db = getDb();
  const deck = await makeDeck(input.sources);
  const roomRef = doc(paths.arenaRooms(db));
  const batch = writeBatch(db);
  batch.set(roomRef, {
    code: roomCode(),
    hostId: input.uid,
    mode: input.mode,
    status: 'lobby',
    memberIds: [input.uid],
    subjectId: input.mode === 'same-course' ? input.subject.id : null,
    subjectCode: input.subject.moduleCode,
    subjectName: input.subject.name,
    deck: input.mode === 'same-course' ? deck : null,
    currentQuestion: 0,
    questionStartedAt: null,
    commentary: 'Room ready. Waiting for players.',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.set(paths.arenaPlayer(db, roomRef.id, input.uid), {
    displayName: input.displayName,
    subjectId: input.subject.id,
    subjectName: input.subject.name,
    score: 0,
    streak: 0,
    onFire: false,
    answeredQuestion: -1,
    selectedAnswer: null,
    lastCorrect: null,
    missedConcepts: [],
    joinedAt: serverTimestamp(),
  });
  if (input.mode === 'cross-course') {
    batch.set(paths.arenaDeck(db, roomRef.id, input.uid), {
      ownerId: input.uid,
      questions: deck,
    });
  }
  await batch.commit();
  return roomRef.id;
}

export async function findArenaRoom(code: string): Promise<ArenaRoom | null> {
  const found = await getDocs(
    query(
      paths.arenaRooms(getDb()),
      where('code', '==', code.trim().toUpperCase()),
      where('status', '==', 'lobby')
    )
  );
  if (found.empty) return null;
  const room = found.docs[0];
  return { id: room.id, ...room.data() } as ArenaRoom;
}

export async function joinArenaRoom(input: {
  room: ArenaRoom;
  uid: string;
  displayName: string;
  subject: { id: string; name: string; moduleCode: string | null };
  sources: Source[];
}): Promise<void> {
  if (input.room.status !== 'lobby') throw new Error('That battle has already started.');
  if (input.room.memberIds.length >= 6) throw new Error('That room already has six players.');
  const roomCourse = (input.room.subjectCode || input.room.subjectName || '').trim().toUpperCase();
  const selectedCourse = (input.subject.moduleCode || input.subject.name).trim().toUpperCase();
  if (input.room.mode === 'same-course' && roomCourse !== selectedCourse) {
    throw new Error(`Choose ${input.room.subjectCode || input.room.subjectName} to join this room.`);
  }

  const deck = input.room.mode === 'cross-course' ? await makeDeck(input.sources) : null;
  const db = getDb();
  await runTransaction(db, async (transaction) => {
    const roomRef = paths.arenaRoom(db, input.room.id);
    const current = await transaction.get(roomRef);
    if (!current.exists()) throw new Error('That room no longer exists.');
    const memberIds = (current.data().memberIds ?? []) as string[];
    if (!memberIds.includes(input.uid) && memberIds.length >= 6) {
      throw new Error('That room already has six players.');
    }
    transaction.update(roomRef, {
      memberIds: arrayUnion(input.uid),
      updatedAt: serverTimestamp(),
    });
    transaction.set(
      paths.arenaPlayer(db, input.room.id, input.uid),
      {
        displayName: input.displayName,
        subjectId: input.subject.id,
        subjectName: input.subject.name,
        score: 0,
        streak: 0,
        onFire: false,
        answeredQuestion: -1,
        selectedAnswer: null,
        lastCorrect: null,
        missedConcepts: [],
        joinedAt: serverTimestamp(),
      },
      { merge: true }
    );
    if (deck) {
      transaction.set(paths.arenaDeck(db, input.room.id, input.uid), {
        ownerId: input.uid,
        questions: deck,
      });
    }
  });
}

export async function startArenaRoom(roomId: string): Promise<void> {
  await updateDoc(paths.arenaRoom(getDb(), roomId), {
    status: 'playing',
    currentQuestion: 0,
    questionStartedAt: Timestamp.now(),
    commentary: 'Round one is live. Accuracy comes first; speed breaks ties.',
    updatedAt: serverTimestamp(),
  });
}

export async function submitArenaAnswer(input: {
  roomId: string;
  uid: string;
  questionIndex: number;
  answerIndex: number;
  question: QuizQuestion;
  questionStartedAt: FirestoreTimestamp | null;
}): Promise<void> {
  const db = getDb();
  await runTransaction(db, async (transaction) => {
    const ref = paths.arenaPlayer(db, input.roomId, input.uid);
    const current = await transaction.get(ref);
    if (!current.exists()) throw new Error('You are no longer in this room.');
    const player = current.data() as ArenaPlayer;
    if (player.answeredQuestion >= input.questionIndex) return;

    const correct = input.answerIndex === input.question.correctAnswerIndex;
    const nextStreak = correct ? (player.streak ?? 0) + 1 : 0;
    const elapsed = input.questionStartedAt
      ? Math.max(0, Date.now() - input.questionStartedAt.toMillis())
      : 10_000;
    const speedMultiplier = elapsed <= 3_000 ? 1.5 : elapsed <= 6_000 ? 1.2 : 1;
    const comboMultiplier = 1 + Math.min(0.5, Math.max(0, nextStreak - 1) * 0.1);
    const points = correct ? Math.round(100 * speedMultiplier * comboMultiplier) : 0;
    const concept = input.question.concept?.trim() || 'Review this question';

    transaction.update(ref, {
      score: increment(points),
      streak: nextStreak,
      onFire: nextStreak >= 3,
      answeredQuestion: input.questionIndex,
      selectedAnswer: input.answerIndex,
      lastCorrect: correct,
      missedConcepts: correct ? player.missedConcepts ?? [] : arrayUnion(concept),
    });
  });
}

export async function advanceArenaRound(room: ArenaRoom, players: ArenaPlayer[]): Promise<void> {
  const next = room.currentQuestion + 1;
  const commentary = await generateBattleCommentary({
    round: next,
    players: players.map((player) => ({
      name: player.displayName,
      score: player.score,
      streak: player.streak,
      correct: player.lastCorrect,
    })),
  }).catch(() => 'Scores are locked. The next round is ready.');
  const total = room.deck?.length ?? 5;
  await updateDoc(paths.arenaRoom(getDb(), room.id), {
    status: next >= total ? 'finished' : 'playing',
    currentQuestion: Math.min(next, total - 1),
    questionStartedAt: next >= total ? null : Timestamp.now(),
    commentary,
    updatedAt: serverTimestamp(),
  });
}

export async function addMissedConceptsToStudyQueue(
  uid: string,
  subjectId: string,
  subjectName: string,
  concepts: string[]
): Promise<void> {
  const db = getDb();
  const batch = writeBatch(db);
  for (const concept of [...new Set(concepts)]) {
    const ref = doc(paths.todos(db, uid));
    batch.set(ref, {
      title: `Review ${concept}`,
      dueDate: null,
      isCompleted: false,
      subjectId,
      subjectName,
      priority: 'medium',
      subTasks: [],
      source: 'arena',
      sourceDocumentId: null,
      createdAt: serverTimestamp(),
      completedAt: null,
    });
  }
  await batch.commit();
}

export async function saveGhostRun(
  room: ArenaRoom,
  player: ArenaPlayer,
  deck: QuizQuestion[]
): Promise<void> {
  const ref = doc(paths.arenaGhosts(getDb()));
  await setDoc(ref, {
    ownerId: player.id,
    ownerName: player.displayName,
    subjectId: player.subjectId,
    subjectName: player.subjectName,
    score: player.score,
    deck,
    missedConcepts: player.missedConcepts ?? [],
    roomId: room.id,
    createdAt: serverTimestamp(),
  });
}

export async function startGhostChallenge(input: {
  uid: string;
  displayName: string;
  ghost: ArenaGhost;
}): Promise<string> {
  const db = getDb();
  const roomRef = doc(paths.arenaRooms(db));
  const batch = writeBatch(db);
  batch.set(roomRef, {
    code: roomCode(),
    hostId: input.uid,
    mode: 'ghost',
    status: 'playing',
    memberIds: [input.uid],
    subjectId: input.ghost.subjectId,
    subjectCode: null,
    subjectName: input.ghost.subjectName,
    deck: input.ghost.deck,
    currentQuestion: 0,
    questionStartedAt: Timestamp.now(),
    commentary: `You are challenging ${input.ghost.ownerName}'s saved run.`,
    ghostScore: input.ghost.score,
    ghostName: input.ghost.ownerName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.set(paths.arenaPlayer(db, roomRef.id, input.uid), {
    displayName: input.displayName,
    subjectId: input.ghost.subjectId,
    subjectName: input.ghost.subjectName,
    score: 0,
    streak: 0,
    onFire: false,
    answeredQuestion: -1,
    selectedAnswer: null,
    lastCorrect: null,
    missedConcepts: [],
    joinedAt: serverTimestamp(),
  });
  await batch.commit();
  return roomRef.id;
}

export async function getPlayerDeck(room: ArenaRoom, uid: string): Promise<QuizQuestion[]> {
  if (room.deck) return room.deck;
  const snapshot = await getDoc(paths.arenaDeck(getDb(), room.id, uid));
  return snapshot.exists() ? ((snapshot.data().questions ?? []) as QuizQuestion[]) : [];
}
