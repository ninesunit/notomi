import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { getDocs, limit, orderBy, query } from 'firebase/firestore';

import { Icon } from '@/components/Icon';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import { Button, Card, EmptyState, Loading, PageHeader, Touchable } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection, useQueryOnce } from '@/hooks/useFirestore';
import { subjectInk, subjectTint, TINT } from '@/lib/color';
import { paths } from '@/lib/paths';
import type { ReviewCard, SourceDocument, Subject } from '@/lib/schema';
import { feedback } from '@/lib/sound';
import { getDb } from '@/services/firebase';
import {
  buildLocalCards,
  buildSession,
  commitSession,
  countDue,
  REVIEW_MODES,
  SESSION_SIZE,
  saveCards,
  subjectsWithCards,
  toggleBookmark,
  type CardOutcome,
  type ReviewMode,
} from '@/services/review';

/**
 * The Review Deck: what a student opens on purpose.
 *
 * The feed this replaces was open-ended by design — you left when you got
 * bored, which is a metric worth optimising for a social product and the wrong
 * one for a study tool. A session here has a length, a subject, and an end.
 *
 * Outcomes are held locally and written once, when the session finishes or the
 * student leaves it. Twelve cards used to be a dozen writes.
 */
export function ReviewDeck() {
  const uid = useUid();
  /*
   * Read once, and only the front of the schedule.
   *
   * Ordered by review date, so the cards nearest their turn arrive first and
   * ones never seen (null) sort ahead of everything. Eighty is about four
   * sessions — past that is not what a student should be revising today, and
   * an unbounded read of someone's whole deck on every visit to the tab is
   * exactly the kind of thing that empties a daily quota by lunchtime.
   */
  const cards = useQueryOnce<ReviewCard>(
    query(paths.reelCards(getDb(), uid), orderBy('nextReviewAt', 'asc'), limit(80)),
    [uid]
  );
  const subjects = useCollection<Subject>(paths.subjects(getDb(), uid), [uid]);

  const [session, setSession] = useState<ReviewCard[] | null>(null);
  const [mode, setMode] = useState<ReviewMode>('due');
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  if (cards.loading || subjects.loading) {
    return (
      <ScreenScroll>
        <Loading label="Opening your deck…" />
      </ScreenScroll>
    );
  }

  if (session) {
    return (
      <Session
        uid={uid}
        cards={session}
        subjects={subjects.data}
        onDone={() => {
          setSession(null);
          cards.refresh();
        }}
      />
    );
  }

  return (
    <>
      <Picker
        cards={cards.data}
        subjects={subjects.data}
        mode={mode}
        subjectId={subjectId}
        onMode={setMode}
        onSubject={setSubjectId}
        onBuild={() => setBuilding(true)}
        onStart={() => {
          const next = buildSession(cards.data, mode, { subjectId });
          if (next.length === 0) return;
          feedback('tap');
          setSession(next);
        }}
      />
      <DeckBuilder
        uid={uid}
        visible={building}
        subjects={subjects.data}
        onClose={() => {
          setBuilding(false);
          // No listener to tell us new cards exist, so the deck asks.
          cards.refresh();
        }}
      />
    </>
  );
}

/* ------------------------------- Builder ------------------------------- */

/**
 * Building a deck, on request and at no cost.
 *
 * The text was already extracted at upload and is already in the document, so
 * a deck is chunked locally: no request, no download, nothing spent. This is
 * the whole reason cards are no longer generated for every file automatically
 * — doing it on demand is cheap enough that doing it speculatively was never
 * worth it.
 */
function DeckBuilder({
  uid,
  visible,
  subjects,
  onClose,
}: {
  uid: string;
  visible: boolean;
  subjects: Subject[];
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<Subject | null>(null);
  const [documents, setDocuments] = useState<SourceDocument[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setChosen(null);
      setDocuments(null);
      setMade(null);
    }
  }, [visible]);

  useEffect(() => {
    if (!chosen) return;
    let active = true;
    setDocuments(null);
    void getDocs(paths.documents(getDb(), uid, chosen.id))
      .then((snapshot) => {
        if (!active) return;
        setDocuments(
          snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as SourceDocument)
        );
      })
      .catch(() => active && setDocuments([]));
    return () => {
      active = false;
    };
  }, [chosen, uid]);

  return (
    <Sheet visible={visible} onClose={onClose} title="Build a deck" icon="layers">
      {!chosen ? (
        <View className="gap-2">
          <Text className="text-xs text-muted">Which subject?</Text>
          {subjects.length === 0 ? (
            <Text className="text-sm text-subtle">Add a subject and upload something first.</Text>
          ) : (
            subjects.map((subject) => (
              <Touchable
                key={subject.id}
                accessibilityRole="button"
                onPress={() => setChosen(subject)}
                className="flex-row items-center gap-3 rounded-xl border border-line px-3 py-3"
              >
                <View
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: subjectInk(subject.color) }}
                />
                <Text className="flex-1 text-sm font-medium text-ink" numberOfLines={1}>
                  {subject.moduleCode ? `${subject.moduleCode} · ` : ''}
                  {subject.name}
                </Text>
                <Icon name="chevron-right" size={15} tone="subtle" />
              </Touchable>
            ))
          )}
        </View>
      ) : documents === null ? (
        <Loading label="Finding your material…" />
      ) : (
        <View className="gap-2">
          <Touchable
            accessibilityRole="button"
            onPress={() => setChosen(null)}
            className="flex-row items-center gap-2 self-start py-1"
          >
            <Icon name="chevron-left" size={14} tone="muted" />
            <Text className="text-xs font-semibold text-muted">{chosen.name}</Text>
          </Touchable>

          {made ? <Text className="text-sm font-medium text-pine">{made}</Text> : null}

          {documents.filter((entry) => (entry.rawText ?? '').length > 200).length === 0 ? (
            <Text className="text-sm leading-5 text-subtle">
              Nothing here has enough readable text to build cards from yet.
            </Text>
          ) : (
            documents
              .filter((entry) => (entry.rawText ?? '').length > 200)
              .map((document) => (
                <Touchable
                  key={document.id}
                  accessibilityRole="button"
                  disabled={busy !== null}
                  onPress={() => {
                    setBusy(document.id);
                    setMade(null);
                    const cards = buildLocalCards(document.rawText);
                    void saveCards(uid, cards, {
                      subjectId: chosen.id,
                      subjectCode: chosen.moduleCode ?? null,
                      documentId: document.id,
                      documentTitle: document.fileName || document.title,
                    })
                      .then((count) => {
                        feedback('success');
                        setMade(
                          count === 0
                            ? 'No usable concepts in that one.'
                            : `${count} card${count === 1 ? '' : 's'} added to your deck.`
                        );
                      })
                      .catch(() => feedback('error'))
                      .finally(() => setBusy(null));
                  }}
                  className={`flex-row items-center gap-3 rounded-xl border border-line px-3 py-3 ${
                    busy === document.id ? 'opacity-50' : ''
                  }`}
                >
                  <Icon name="file-text" size={15} tone="muted" />
                  <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                    {document.fileName || document.title}
                  </Text>
                  <Icon name="plus" size={15} tone="accent" />
                </Touchable>
              ))
          )}
        </View>
      )}
    </Sheet>
  );
}

/* ------------------------------- Picker -------------------------------- */

function Picker({
  cards,
  subjects,
  mode,
  subjectId,
  onMode,
  onSubject,
  onBuild,
  onStart,
}: {
  cards: ReviewCard[];
  subjects: Subject[];
  mode: ReviewMode;
  subjectId: string | null;
  onMode: (mode: ReviewMode) => void;
  onSubject: (subjectId: string | null) => void;
  onBuild: () => void;
  onStart: () => void;
}) {
  const decks = subjectsWithCards(cards, subjects);
  const ready = buildSession(cards, mode, { subjectId });
  const due = countDue(cards);

  if (cards.length === 0) {
    return (
      <ScreenScroll>
        <PageHeader
          title="Review"
          subtitle="Cards built from your own material, in sessions with an end."
        />
        <EmptyState
          icon="layers"
          title="No cards yet"
          body="Build a deck from something you have already uploaded. Nothing is generated until you ask for it."
          action={<Button label="Build a deck" icon="plus" onPress={onBuild} />}
        />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      <PageHeader
        title="Review"
        subtitle={
          due > 0
            ? `${due} card${due === 1 ? '' : 's'} ready across ${decks.length} subject${decks.length === 1 ? '' : 's'}.`
            : 'Nothing is due. Anything below is a head start.'
        }
      />

      <View className="mb-5 gap-2">
        <Text className="text-xs font-medium text-muted">What to review</Text>
        <View className="flex-row flex-wrap gap-1.5">
          {REVIEW_MODES.map((option) => {
            const active = mode === option.id;
            return (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${option.label}. ${option.blurb}`}
                onPress={() => {
                  if (active) return;
                  feedback('toggle');
                  onMode(option.id);
                }}
                className={`min-w-0 flex-1 items-center rounded-xl px-2 py-2.5 ${
                  active ? 'bg-ink' : 'bg-sand'
                }`}
              >
                <Text
                  className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}
                  numberOfLines={1}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text className="text-[11px] leading-4 text-subtle">
          {REVIEW_MODES.find((option) => option.id === mode)?.blurb}
        </Text>
      </View>

      {decks.length > 1 ? (
        <View className="mb-5 gap-2">
          <Text className="text-xs font-medium text-muted">Subject</Text>
          <View className="flex-row flex-wrap gap-1.5">
            <SubjectChip
              label="All subjects"
              active={subjectId === null}
              onPress={() => onSubject(null)}
            />
            {decks.map((subject) => (
              <SubjectChip
                key={subject.id}
                label={subject.moduleCode || subject.name}
                color={subject.color}
                active={subjectId === subject.id}
                onPress={() => onSubject(subject.id)}
              />
            ))}
          </View>
        </View>
      ) : null}

      <Card className="mb-6 gap-4">
        <View className="flex-row items-center gap-3">
          <View className="h-11 w-11 items-center justify-center rounded-xl bg-accent-soft">
            <Icon name="layers" size={19} tone="accent" />
          </View>
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-ink">
              {ready.length === 0
                ? 'Nothing matches'
                : `${ready.length} card${ready.length === 1 ? '' : 's'} this session`}
            </Text>
            <Text className="text-xs leading-4 text-muted">
              {ready.length === 0
                ? 'Try another filter, or build a deck from a document.'
                : `Capped at ${SESSION_SIZE}. Your answers are saved when you finish.`}
            </Text>
          </View>
        </View>
        <View className="flex-row flex-wrap gap-2">
          <Button
            label="Start review"
            icon="play"
            disabled={ready.length === 0}
            onPress={onStart}
          />
          <Button label="Build a deck" icon="plus" variant="secondary" onPress={onBuild} />
        </View>
      </Card>
    </ScreenScroll>
  );
}

function SubjectChip({
  label,
  color,
  active,
  onPress,
}: {
  label: string;
  color?: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => {
        feedback('toggle');
        onPress();
      }}
      className={`rounded-lg border px-3 py-1.5 ${active ? 'border-ink' : 'border-line'}`}
      style={color && !active ? { backgroundColor: subjectTint(color, TINT.wash) } : undefined}
    >
      <Text
        className={`text-xs font-semibold ${active ? 'text-ink' : 'text-muted'}`}
        style={color && !active ? { color: subjectInk(color) } : undefined}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/* ------------------------------- Session ------------------------------- */

function Session({
  uid,
  cards,
  subjects,
  onDone,
}: {
  uid: string;
  cards: ReviewCard[];
  subjects: Subject[];
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [answer, setAnswer] = useState<number | null>(null);

  // Held rather than written per card. The ref is what the unmount flush reads,
  // because a state value captured at mount would always be the empty one.
  const outcomes = useRef<CardOutcome[]>([]);
  const flushed = useRef(false);

  const flush = useCallback(() => {
    if (flushed.current || outcomes.current.length === 0) return;
    flushed.current = true;
    void commitSession(uid, outcomes.current).catch((error) =>
      console.error('[review] Could not save this session.', error)
    );
  }, [uid]);

  // Leaving mid-session still counts: the cards already answered are saved.
  useEffect(() => flush, [flush]);

  const card = cards[index];
  const subject = useMemo(
    () => subjects.find((entry) => entry.id === card?.subjectId) ?? null,
    [subjects, card?.subjectId]
  );

  if (!card) {
    return (
      <ScreenScroll>
        <EmptyState
          icon="check-circle-2"
          title="Session complete"
          body={`${cards.length} card${cards.length === 1 ? '' : 's'} reviewed. Your schedule is updated.`}
          action={<Button label="Back to the deck" icon="arrow-left" onPress={onDone} />}
        />
      </ScreenScroll>
    );
  }

  const isQuiz = card.format === 'quiz' && card.options.length > 1;
  const answered = answer !== null;

  function record(outcome: 'mastered' | 'again') {
    outcomes.current.push({
      cardId: card.id,
      outcome,
      previousLevel: card.srsLevel ?? 0,
      previouslyAnswered: card.quizAnswered ?? false,
      previousXp: card.xpEarned ?? 0,
      ...(isQuiz && answered ? { quizCorrect: answer === card.correctAnswerIndex } : {}),
    });
    feedback(outcome === 'mastered' ? 'success' : 'toggle');

    if (index + 1 >= cards.length) flush();
    setIndex((value) => value + 1);
    setRevealed(false);
    setAnswer(null);
  }

  return (
    <ScreenScroll>
      <View className="mb-4 flex-row items-center gap-3">
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Leave this review"
          onPress={() => {
            flush();
            onDone();
          }}
          className="h-9 w-9 items-center justify-center rounded-lg border border-line"
        >
          <Icon name="x" size={16} tone="muted" />
        </Touchable>
        <View className="h-1.5 flex-1 overflow-hidden rounded-full bg-sand">
          <View
            className="h-full rounded-full bg-ink"
            style={{ width: `${Math.round((index / cards.length) * 100)}%` }}
          />
        </View>
        <Text className="text-xs font-semibold text-muted">
          {index + 1} / {cards.length}
        </Text>
      </View>

      <Card className="mb-4 gap-4">
        {subject ? (
          <View className="flex-row items-center gap-2">
            <View
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: subjectInk(subject.color) }}
            />
            <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              {subject.moduleCode || subject.name}
            </Text>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={card.bookmarked ? 'Remove bookmark' : 'Bookmark this card'}
              onPress={() => {
                feedback('toggle');
                void toggleBookmark(uid, card).catch(() => undefined);
              }}
              className="ml-auto h-8 w-8 items-center justify-center rounded-lg"
            >
              <Icon name="bookmark" size={15} tone={card.bookmarked ? 'accent' : 'subtle'} />
            </Touchable>
          </View>
        ) : null}

        <Text className="text-lg font-semibold leading-7 text-ink">{card.title}</Text>

        {isQuiz ? (
          <View className="gap-2">
            {card.options.map((option, optionIndex) => {
              const chosen = answer === optionIndex;
              const correct = optionIndex === card.correctAnswerIndex;
              const show = answered && (chosen || correct);
              return (
                <Pressable
                  key={option}
                  accessibilityRole="button"
                  accessibilityState={{ selected: chosen }}
                  disabled={answered}
                  onPress={() => {
                    feedback(optionIndex === card.correctAnswerIndex ? 'success' : 'error');
                    setAnswer(optionIndex);
                    setRevealed(true);
                  }}
                  className={`rounded-xl border px-3.5 py-3 ${
                    show
                      ? correct
                        ? 'border-pine bg-pine-soft'
                        : 'border-rose bg-rose-soft'
                      : 'border-line bg-surface'
                  }`}
                >
                  <Text className="text-sm leading-5 text-ink">{option}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : revealed ? (
          <View className="gap-3">
            <Text className="text-[15px] leading-6 text-ink">{card.body}</Text>
            {card.points.length > 0 ? (
              <View className="gap-1.5">
                {card.points.map((point) => (
                  <View key={point} className="flex-row gap-2">
                    <Text className="text-sm text-subtle">•</Text>
                    <Text className="flex-1 text-sm leading-5 text-muted">{point}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : (
          <Text className="text-sm leading-5 text-subtle">
            Bring the answer to mind, then reveal it.
          </Text>
        )}

        {revealed && card.takeaway ? (
          <View className="rounded-xl bg-sand p-3.5">
            <Text className="text-sm leading-5 text-ink">{card.takeaway}</Text>
          </View>
        ) : null}

        {answered && card.explanation ? (
          <Text className="text-sm leading-5 text-muted">{card.explanation}</Text>
        ) : null}

        {card.documentTitle ? (
          <View className="flex-row items-center gap-1.5">
            <Icon name="file-text" size={12} tone="subtle" />
            <Text className="flex-1 text-[11px] text-subtle" numberOfLines={1}>
              {card.documentTitle}
              {card.pageNumber ? ` · page ${card.pageNumber}` : ''}
            </Text>
          </View>
        ) : null}
      </Card>

      {!revealed && !isQuiz ? (
        <Button label="Show answer" icon="eye" onPress={() => setRevealed(true)} />
      ) : (
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button
              label="Again"
              icon="rotate-ccw"
              variant="secondary"
              onPress={() => record('again')}
            />
          </View>
          <View className="flex-1">
            <Button label="Got it" icon="check" onPress={() => record('mastered')} />
          </View>
        </View>
      )}
    </ScreenScroll>
  );
}
