import { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link, useLocalSearchParams } from 'expo-router';
import { Icon } from '@/components/Icon';
import { getDocs, orderBy, query } from 'firebase/firestore';
import { FlipCard } from '@/components/FlipCard';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Badge, Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { buildContext, generateFlashcards } from '@/lib/ai';
import { paths } from '@/lib/paths';
import type { Flashcard, SourceDocument, Subject } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { deckStats, deleteDeck, resetDeck, saveGeneratedCards, setCardStatus, studyOrder } from '@/services/flashcards';
import { logSession } from '@/services/sessions';
import { subjectInk, subjectTint } from '@/lib/color';

/**
 * Flashcard deck.
 *
 * Cards are generated once and stored, so a deck is a thing a student owns and
 * returns to rather than a fresh Gemini call each visit. "Know" and "Review
 * later" are the only two verdicts: a five-point confidence scale is more
 * bookkeeping than a student will do at speed.
 */
export default function Flashcards() {
  const params = useLocalSearchParams<{ subjectId?: string }>();
  const uid = useUid();
  const db = getDb();

  const [subjectId, setSubjectId] = useState<string | null>(params.subjectId ?? null);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const subjects = useCollection<Subject>(
    query(paths.subjects(db, uid), orderBy('updatedAt', 'desc')),
    [uid]
  );
  const cards = useCollection<Flashcard>(
    subjectId ? paths.flashcards(db, uid, subjectId) : null,
    [uid, subjectId]
  );

  const subject = subjects.data.find((candidate) => candidate.id === subjectId) ?? null;

  // Frozen for the run: re-sorting live would move the card out from under the
  // student the moment they marked it.
  const [deck, setDeck] = useState<Flashcard[]>([]);
  const stats = useMemo(() => deckStats(cards.data), [cards.data]);

  const startRun = useCallback(
    (source: Flashcard[]) => {
      setDeck(studyOrder(source));
      setIndex(0);
      setFlipped(false);
      setReviewed(0);
    },
    []
  );

  const generate = useCallback(
    async (targetId: string) => {
      setError(null);
      setGenerating(true);
      setSubjectId(targetId);

      try {
        const snapshot = await getDocs(
          query(paths.documents(db, uid, targetId), orderBy('createdAt', 'asc'))
        );
        const context = buildContext(
          snapshot.docs.map((document) => {
            const data = document.data() as SourceDocument;
            return { title: data.fileName || data.title, text: data.rawText ?? '' };
          })
        );

        if (!context) {
          setError('This subject has no readable text yet. Upload a document first.');
          return;
        }

        const generated = await generateFlashcards(context, 20);
        await saveGeneratedCards(uid, targetId, generated);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setGenerating(false);
      }
    },
    [db, uid]
  );

  const mark = useCallback(
    async (status: 'known' | 'review') => {
      const card = deck[index];
      if (!card || !subjectId) return;

      setReviewed((count) => count + 1);
      setFlipped(false);
      setIndex((current) => current + 1);

      // Fire-and-forget: the deck must not stall on a write.
      void setCardStatus(uid, subjectId, card.id, status).catch(() => undefined);

      // One minute per card is a fair approximation and keeps the streak honest
      // without timing every flip.
      if ((reviewed + 1) % 10 === 0) {
        void logSession(uid, {
          minutes: 10,
          mode: 'flashcards',
          subjectId,
          subjectName: subject?.name ?? null,
        }).catch(() => undefined);
      }
    },
    [deck, index, reviewed, subject?.name, subjectId, uid]
  );

  /* ----------------------------- chooser ----------------------------- */

  if (!subjectId) {
    return (
      <ScreenScroll maxWidth={760}>
        <BackLink />
        <PageHeader
          title="Flashcards"
          subtitle="Pick a subject and Notomi writes a deck from your own material."
        />

        {error ? (
          <View className="mb-6">
            <Notice title="Could not build the deck" body={error} />
          </View>
        ) : null}

        {subjects.loading ? (
          <Loading label="Loading subjects…" />
        ) : subjects.data.length === 0 ? (
          <EmptyState
            icon="layers"
            title="Nothing to study yet"
            body="Upload a document first — cards are written strictly from your own material."
            action={
              <Link href="/library" asChild>
                <Button label="Go to library" variant="secondary" />
              </Link>
            }
          />
        ) : (
          <View className="gap-3">
            {subjects.data.map((candidate) => (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                disabled={(candidate.documentCount ?? 0) === 0}
                onPress={() => setSubjectId(candidate.id)}
                className={`flex-row items-center gap-4 rounded-2xl border border-line bg-surface p-4 ${
                  (candidate.documentCount ?? 0) === 0 ? 'opacity-50' : ''
                }`}
              >
                <View
                  className="h-10 w-10 items-center justify-center rounded-xl"
                  style={{ backgroundColor: subjectTint(candidate.color, 0.1) }}
                >
                  <Icon name="layers" size={16} color={subjectInk(candidate.color)} />
                </View>
                <View className="flex-1 gap-1">
                  <Text className="text-[15px] font-semibold text-ink">{candidate.name}</Text>
                  <Text className="text-xs text-muted">
                    {candidate.documentCount ?? 0}{' '}
                    {(candidate.documentCount ?? 0) === 1 ? 'source' : 'sources'}
                  </Text>
                </View>
                <Icon name="chevron-right" size={16} tone="subtle" />
              </Pressable>
            ))}
          </View>
        )}
      </ScreenScroll>
    );
  }

  /* ------------------------------ deck ------------------------------- */

  if (cards.loading || generating) {
    return (
      <ScreenScroll maxWidth={760}>
        <Loading
          label={generating ? 'Writing cards from your material…' : 'Opening your deck…'}
        />
      </ScreenScroll>
    );
  }

  if (cards.data.length === 0) {
    return (
      <ScreenScroll maxWidth={760}>
        <BackLink />
        <PageHeader title={subject?.name ?? 'Flashcards'} subtitle="No cards in this deck yet." />

        {error ? (
          <View className="mb-6">
            <Notice title="Could not build the deck" body={error} />
          </View>
        ) : null}

        <EmptyState
          icon="layers"
          title="Build a deck"
          body="Notomi reads every source in this subject and writes one card per idea — definitions, mechanisms, and the distinctions that get confused."
          action={
            <Button
              label="Generate 20 cards"
              icon="zap"
              loading={generating}
              onPress={() => void generate(subjectId)}
            />
          }
        />

        <View className="mt-4 items-start">
          <Button label="Pick another subject" variant="ghost" size="sm" onPress={() => setSubjectId(null)} />
        </View>
      </ScreenScroll>
    );
  }

  const running = deck.length > 0 && index < deck.length;
  const finished = deck.length > 0 && index >= deck.length;

  return (
    <ScreenScroll maxWidth={760}>
      <BackLink />

      <PageHeader
        title={subject?.name ?? 'Flashcards'}
        subtitle={`${cards.data.length} cards · ${stats.known} known · ${stats.review} to review`}
        actions={
          running ? undefined : (
            <>
              <Button
                label="Add 20 more"
                icon="plus"
                variant="secondary"
                size="sm"
                loading={generating}
                onPress={() => void generate(subjectId)}
              />
              <Button label="Change subject" variant="ghost" size="sm" onPress={() => setSubjectId(null)} />
            </>
          )
        }
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Something went wrong" body={error} />
        </View>
      ) : null}

      {running ? (
        <View className="gap-5">
          <View className="flex-row items-center gap-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="End this run"
              onPress={() => setDeck([])}
              className="h-9 w-9 items-center justify-center rounded-lg bg-sand"
            >
              <Icon name="x" size={15} tone="muted" />
            </Pressable>
            <View className="flex-1 gap-1.5">
              <Text className="text-xs font-medium text-muted">
                Card {index + 1} of {deck.length}
              </Text>
              <View className="h-1 w-full overflow-hidden rounded-full bg-sand">
                <View
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${(index / deck.length) * 100}%` }}
                />
              </View>
            </View>
            {deck[index].concept ? <Badge label={deck[index].concept} tone="accent" /> : null}
          </View>

          <FlipCard
            front={deck[index].front}
            back={deck[index].back}
            flipped={flipped}
            onFlip={() => setFlipped((value) => !value)}
          />

          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button
                label="Review later"
                icon="rotate-ccw"
                variant="secondary"
                onPress={() => void mark('review')}
                className="w-full"
              />
            </View>
            <View className="flex-1">
              <Button
                label="I know this"
                icon="check"
                onPress={() => void mark('known')}
                className="w-full"
              />
            </View>
          </View>

          <Text className="text-center text-xs text-subtle">
            Tap the card to flip it. Marking moves you to the next one.
          </Text>
        </View>
      ) : finished ? (
        <Card className="items-center gap-4 py-10">
          <Icon name="check-circle" size={36} tone="pine" />
          <Text className="text-lg font-semibold text-ink">Deck complete</Text>
          <Text className="max-w-sm text-center text-sm leading-6 text-muted">
            You went through {reviewed} card{reviewed === 1 ? '' : 's'}. {stats.review} card
            {stats.review === 1 ? ' is' : 's are'} flagged to review — those come first next time.
          </Text>
          <View className="flex-row flex-wrap justify-center gap-2">
            {stats.review > 0 ? (
              <Button
                label={`Drill ${stats.review} flagged`}
                icon="target"
                onPress={() => startRun(cards.data.filter((card) => card.status === 'review'))}
              />
            ) : null}
            <Button
              label="Run the whole deck"
              icon="refresh-cw"
              variant="secondary"
              onPress={() => startRun(cards.data)}
            />
          </View>
        </Card>
      ) : (
        <View className="gap-5">
          <View className="flex-row flex-wrap gap-3">
            <DeckStat value={stats.fresh} label="Unseen" tone="neutral" />
            <DeckStat value={stats.review} label="To review" tone="amber" />
            <DeckStat value={stats.known} label="Known" tone="pine" />
          </View>

          <View className="flex-row flex-wrap gap-2">
            <Button label="Study all cards" icon="play" onPress={() => startRun(cards.data)} />
            {stats.review > 0 ? (
              <Button
                label={`Only the ${stats.review} flagged`}
                icon="target"
                variant="secondary"
                onPress={() => startRun(cards.data.filter((card) => card.status === 'review'))}
              />
            ) : null}
            {stats.fresh > 0 && stats.fresh < cards.data.length ? (
              <Button
                label={`Only the ${stats.fresh} unseen`}
                icon="eye"
                variant="secondary"
                onPress={() => startRun(cards.data.filter((card) => card.status === 'new'))}
              />
            ) : null}
          </View>

          <View className="gap-2 border-t border-line pt-5">
            <View className="flex-row flex-wrap gap-2">
              <Button
                label="Reset progress"
                icon="rotate-ccw"
                variant="ghost"
                size="sm"
                onPress={() => void resetDeck(uid, subjectId).catch((caught) => setError(String(caught)))}
              />
              <Button
                label={confirmDelete ? 'Tap again to delete' : 'Delete deck'}
                icon="trash-2"
                variant={confirmDelete ? 'danger' : 'ghost'}
                size="sm"
                onPress={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  setConfirmDelete(false);
                  void deleteDeck(uid, subjectId).catch((caught) => setError(String(caught)));
                }}
              />
            </View>
          </View>
        </View>
      )}
    </ScreenScroll>
  );
}

function BackLink() {
  return (
    <Link href="/knowledge" asChild>
      <Pressable className="mb-5 flex-row items-center gap-1.5 self-start py-1">
        <Icon name="arrow-left" size={15} tone="muted" />
        <Text className="text-sm font-medium text-muted">Back to Knowledge</Text>
      </Pressable>
    </Link>
  );
}

function DeckStat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: 'neutral' | 'amber' | 'pine';
}) {
  const surface =
    tone === 'pine' ? 'bg-pine-soft' : tone === 'amber' ? 'bg-amber-soft' : 'bg-sand';
  const text = tone === 'pine' ? 'text-pine' : tone === 'amber' ? 'text-amber' : 'text-muted';

  return (
    <View
      className={`flex-1 grow gap-1 rounded-2xl p-4 ${surface}`}
      style={{ minWidth: 120, flexBasis: 120 }}
    >
      <Text className={`text-2xl font-bold ${text}`}>{value}</Text>
      <Text className="text-[13px] text-ink/70">{label}</Text>
    </View>
  );
}
