import { doc, getDocs, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { paths } from '@/lib/paths';
import type { Flashcard, GeneratedCard } from '@/lib/schema';
import { getDb } from '@/services/firebase';

/**
 * Flashcard deck persistence.
 *
 * Cards live under the subject rather than in one global pile so a deck can be
 * regenerated for a single subject without touching the rest, and so deleting
 * a subject takes its cards with it.
 */

export async function saveGeneratedCards(
  uid: string,
  subjectId: string,
  cards: GeneratedCard[],
  sourceDocumentId: string | null = null
): Promise<number> {
  if (cards.length === 0) return 0;
  const db = getDb();
  const collection = paths.flashcards(db, uid, subjectId);

  for (let index = 0; index < cards.length; index += 400) {
    const batch = writeBatch(db);
    for (const card of cards.slice(index, index + 400)) {
      batch.set(doc(collection), {
        front: card.front,
        back: card.back,
        concept: card.concept,
        status: 'new',
        sourceDocumentId,
        createdAt: serverTimestamp(),
        lastSeenAt: null,
      });
    }
    await batch.commit();
  }

  return cards.length;
}

export async function setCardStatus(
  uid: string,
  subjectId: string,
  cardId: string,
  status: Flashcard['status']
): Promise<void> {
  const db = getDb();
  await updateDoc(paths.flashcard(db, uid, subjectId, cardId), {
    status,
    lastSeenAt: serverTimestamp(),
  });
}

/** Puts every card back in the pile so the deck can be run again from scratch. */
export async function resetDeck(uid: string, subjectId: string): Promise<void> {
  const db = getDb();
  const snapshot = await getDocs(paths.flashcards(db, uid, subjectId));
  if (snapshot.empty) return;

  for (let index = 0; index < snapshot.docs.length; index += 400) {
    const batch = writeBatch(db);
    for (const card of snapshot.docs.slice(index, index + 400)) {
      batch.update(card.ref, { status: 'new' });
    }
    await batch.commit();
  }
}

export async function deleteDeck(uid: string, subjectId: string): Promise<void> {
  const db = getDb();
  const snapshot = await getDocs(paths.flashcards(db, uid, subjectId));
  if (snapshot.empty) return;

  for (let index = 0; index < snapshot.docs.length; index += 400) {
    const batch = writeBatch(db);
    for (const card of snapshot.docs.slice(index, index + 400)) batch.delete(card.ref);
    await batch.commit();
  }
}

/**
 * The order a session runs in: cards flagged for review first, then unseen,
 * then known. What the student struggled with should come back soonest.
 */
export function studyOrder(cards: Flashcard[]): Flashcard[] {
  const rank: Record<Flashcard['status'], number> = { review: 0, new: 1, known: 2 };
  return [...cards].sort((a, b) => (rank[a.status] ?? 1) - (rank[b.status] ?? 1));
}

export function deckStats(cards: Flashcard[]): { known: number; review: number; fresh: number } {
  return {
    known: cards.filter((card) => card.status === 'known').length,
    review: cards.filter((card) => card.status === 'review').length,
    fresh: cards.filter((card) => card.status === 'new').length,
  };
}
