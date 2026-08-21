import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Platform, Pressable, Text, View } from 'react-native';
import * as Speech from 'expo-speech';
import { useRouter } from 'expo-router';
import { Icon, type IconName } from '@/components/Icon';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { Subject } from '@/lib/schema';
import { feedback } from '@/lib/sound';
import { getDb } from '@/services/firebase';
import {
  commitReviewSession,
  countReviewCards,
  REVIEW_MODES,
  startReviewSession,
  setReviewBookmark,
  type DeckCard,
  type ReviewAnswer,
  type ReviewMode,
  type ReviewOutcome,
  type ReviewSession,
} from '@/services/review';

const MODE_ICON: Record<ReviewMode, IconName> = {
  quick: 'timer',
  exam: 'target',
  difficult: 'flame',
  mixed: 'repeat',
  mistakes: 'rotate-ccw',
  bookmarked: 'bookmark',
  document: 'file-text',
};

/** Everything the deck can be doing, so no two states can be true at once. */
type Phase =
  | { name: 'choosing' }
  | { name: 'loading'; mode: ReviewMode }
  | { name: 'reviewing'; session: ReviewSession }
  | { name: 'saving' }
  | { name: 'done'; total: number; kept: number; mastered: number; heldBack: number };

/**
 * The Review Deck.
 *
 * This is what replaced Notomi Reel, and the difference is the whole point: a
 * student arrives here having decided to revise, picks what they want to go
 * over, and works through a fixed batch that ends. There is no feed, nothing
 * loads when they reach the bottom, and closing the screen finishes the
 * session rather than pausing an endless one.
 */
export function ReviewDeck({
  subjectId = null,
  documentId = null,
  documentTitle = null,
}: {
  subjectId?: string | null;
  documentId?: string | null;
  documentTitle?: string | null;
}) {
  const uid = useUid();
  const subjects = useCollection<Subject>(paths.subjects(getDb(), uid), [uid]);
  const [scopeId, setScopeId] = useState<string>(subjectId ?? 'all');
  const [phase, setPhase] = useState<Phase>({ name: 'choosing' });
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => setScopeId(subjectId ?? 'all'), [subjectId]);

  // One aggregate read, so an account with no cards can say so plainly
  // instead of every mode opening onto an empty session.
  useEffect(() => {
    if (!uid) return;
    let live = true;
    void countReviewCards(uid)
      .then((count) => live && setTotal(count))
      .catch(() => live && setTotal(null));
    return () => {
      live = false;
    };
  }, [uid]);

  const scopeIds = useMemo(
    () => (scopeId === 'all' ? [] : [scopeId]),
    [scopeId]
  );

  const begin = useCallback(
    async (mode: ReviewMode) => {
      setError(null);
      setPhase({ name: 'loading', mode });
      try {
        const session = await startReviewSession(
          uid,
          { mode, subjectIds: scopeIds, documentId },
          subjects.data
        );
        if (session.cards.length === 0) {
          setPhase({ name: 'choosing' });
          setError(
            mode === 'mistakes'
              ? 'Nothing to re-try yet. Missed questions from a quiz or an Arena battle collect here.'
              : mode === 'bookmarked'
                ? 'You have not saved any cards yet. Bookmark one during a review to find it here.'
                : 'Nothing is due in that selection right now. Try another mode, or build a deck from a document.'
          );
          return;
        }
        setPhase({ name: 'reviewing', session });
      } catch (caught) {
        setPhase({ name: 'choosing' });
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [uid, scopeIds, documentId, subjects.data]
  );

  const finish = useCallback(
    async (answers: ReviewAnswer[], heldBack: number) => {
      const kept = answers.filter((answer) => answer.outcome === 'good').length;
      setPhase({ name: 'saving' });
      try {
        const mastered = await commitReviewSession(uid, answers);
        setPhase({ name: 'done', total: answers.length, kept, mastered, heldBack });
      } catch (caught) {
        // The session is over either way; say what happened rather than
        // discarding the work silently.
        setError(
          `Your answers could not be saved: ${
            caught instanceof Error ? caught.message : String(caught)
          }`
        );
        setPhase({ name: 'done', total: answers.length, kept, mastered: 0, heldBack });
      }
    },
    [uid]
  );

  if (phase.name === 'reviewing') {
    return (
      <ReviewRunner
        session={phase.session}
        onFinish={(answers) => void finish(answers, phase.session.heldBack)}
        onQuit={() => setPhase({ name: 'choosing' })}
      />
    );
  }

  return (
    <ScreenScroll>
      <PageHeader
        title="Review Deck"
        subtitle={
          documentTitle
            ? `Concepts from ${documentTitle}.`
            : 'Choose what to go over. Every session is a fixed batch that ends.'
        }
      />

      {error ? (
        <View className="mb-5">
          <Notice tone="amber" title="Nothing started" body={error} />
        </View>
      ) : null}

      {phase.name === 'saving' ? (
        <Loading label="Saving your session…" />
      ) : phase.name === 'done' ? (
        <SessionSummary
          total={phase.total}
          kept={phase.kept}
          mastered={phase.mastered}
          heldBack={phase.heldBack}
          onAgain={() => setPhase({ name: 'choosing' })}
        />
      ) : total === 0 ? (
        <EmptyDeck />
      ) : (
        <>
          {documentId ? null : (
            <SubjectScope
              subjects={subjects.data}
              value={scopeId}
              onChange={setScopeId}
              loading={subjects.loading}
            />
          )}

          <View className="gap-2.5">
            {REVIEW_MODES.map((mode) => (
              <ModeRow
                key={mode.id}
                icon={MODE_ICON[mode.id]}
                label={mode.label}
                blurb={mode.blurb}
                size={mode.size}
                busy={phase.name === 'loading' && phase.mode === mode.id}
                disabled={phase.name === 'loading'}
                onPress={() => void begin(mode.id)}
              />
            ))}
          </View>
        </>
      )}
    </ScreenScroll>
  );
}

function EmptyDeck() {
  return (
    <EmptyState
      icon="layers"
      title="No review cards yet"
      body="Open a document in a course folder and choose Build review cards. Notomi lifts the concepts out of it — no AI request, no waiting."
    />
  );
}

/**
 * Which course to revise.
 *
 * A horizontal strip of pills would scroll sideways on a phone, which the
 * design language does not allow, so this wraps instead and stays one tap deep.
 */
function SubjectScope({
  subjects,
  value,
  onChange,
  loading,
}: {
  subjects: Subject[];
  value: string;
  onChange: (id: string) => void;
  loading: boolean;
}) {
  if (loading || subjects.length === 0) return null;

  const options = [{ id: 'all', name: 'All courses', color: null as string | null }, ...subjects.map(
    (subject) => ({ id: subject.id, name: subject.name, color: subject.color })
  )];

  return (
    <View className="mb-5 gap-2">
      <Text className="text-xs font-bold uppercase tracking-wider text-subtle">Reviewing</Text>
      <View className="flex-row flex-wrap gap-2">
        {options.map((option) => {
          const active = option.id === value;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Review ${option.name}`}
              onPress={() => {
                if (active) return;
                feedback('toggle');
                onChange(option.id);
              }}
              className={`min-h-11 flex-row items-center gap-2 rounded-full border px-3.5 py-2 ${
                active ? 'border-ink bg-ink' : 'border-line bg-surface'
              }`}
            >
              {/*
                Only while unselected. The selected pill is already inverted,
                and a subject's own hue over near-black ink is a coin flip on
                legibility — the selection must not be readable by colour alone
                in either direction.
              */}
              {option.color && !active ? (
                <View className="h-2 w-2 rounded-full" style={{ backgroundColor: option.color }} />
              ) : null}
              <Text
                className={`text-[13px] font-semibold ${active ? 'text-paper' : 'text-muted'}`}
                numberOfLines={1}
              >
                {option.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function ModeRow({
  icon,
  label,
  blurb,
  size,
  busy,
  disabled,
  onPress,
}: {
  icon: IconName;
  label: string;
  blurb: string;
  size: number;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${blurb} Up to ${size} cards.`}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-14 flex-row items-center gap-3.5 rounded-2xl border border-line bg-surface px-4 py-3.5 ${
        disabled && !busy ? 'opacity-50' : ''
      }`}
    >
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-sand">
        <Icon name={busy ? 'loader' : icon} size={17} tone="ink" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[15px] font-semibold text-ink">{label}</Text>
        <Text className="text-xs leading-5 text-muted">{blurb}</Text>
      </View>
      <Text className="text-xs font-semibold text-subtle">{size}</Text>
      <Icon name="chevron-right" size={15} tone="subtle" />
    </Pressable>
  );
}

function SessionSummary({
  total,
  kept,
  mastered,
  heldBack,
  onAgain,
}: {
  total: number;
  kept: number;
  mastered: number;
  heldBack: number;
  onAgain: () => void;
}) {
  return (
    <View className="gap-4">
      <Card className="items-center gap-2 py-8">
        <View className="h-14 w-14 items-center justify-center rounded-full bg-pine-soft">
          <Icon name="check-circle-2" size={24} tone="pine" />
        </View>
        <Text className="font-heading text-xl font-bold text-ink">Session complete</Text>
        <Text className="text-center text-sm leading-6 text-muted">
          {kept} of {total} kept.{' '}
          {mastered > 0
            ? `${mastered} concept${mastered === 1 ? '' : 's'} reached the top of the ladder.`
            : 'The rest come round again on their own schedule.'}
        </Text>
        {heldBack > 0 ? (
          <Text className="text-center text-xs text-subtle">
            {heldBack} more {heldBack === 1 ? 'card is' : 'cards are'} waiting in that selection.
          </Text>
        ) : null}
      </Card>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={heldBack > 0 ? 'Keep going' : 'Review something else'}
          icon="layers"
          onPress={onAgain}
        />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * The session itself
 * ------------------------------------------------------------------ */

/**
 * Works through one batch, one card at a time.
 *
 * Answers are held here and written once at the end. A swipe costs nothing
 * but a re-render, which is what lets a twenty-card session be one batched
 * write instead of sixty.
 */
function ReviewRunner({
  session,
  onFinish,
  onQuit,
}: {
  session: ReviewSession;
  onFinish: (answers: ReviewAnswer[]) => void;
  onQuit: () => void;
}) {
  const uid = useUid();
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<ReviewAnswer[]>([]);
  const [quizCorrect, setQuizCorrect] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  const card = session.cards[index];
  const done = index >= session.cards.length;

  // Leaving mid-card must not leave the card still being read aloud. The
  // cleanup swallows the promise so React does not see one returned to it.
  useEffect(
    () => () => {
      void Speech.stop();
    },
    []
  );

  useEffect(() => {
    if (done) onFinish(answers);
    // The batch is finished exactly once; answers are complete by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const answer = useCallback(
    (outcome: ReviewOutcome) => {
      if (!card) return;
      void Speech.stop();
      feedback(outcome === 'good' ? 'success' : 'toggle');
      setAnswers((current) => [...current, { card, outcome, quizCorrect }]);
      setQuizCorrect(null);
      setIndex((current) => current + 1);
    },
    [card, quizCorrect]
  );

  const bookmark = useCallback(() => {
    if (!card || card.source !== 'card') return;
    const next = !(saved[card.id] ?? card.bookmarked);
    // Optimistic, and reverted if the write is refused: a bookmark that takes
    // a round trip to appear reads as a tap that missed.
    setSaved((current) => ({ ...current, [card.id]: next }));
    feedback('toggle');
    void setReviewBookmark(uid, card.id, next).catch(() =>
      setSaved((current) => ({ ...current, [card.id]: !next }))
    );
  }, [card, saved, uid]);

  /**
   * Opens the document a card was lifted from.
   *
   * Navigating away unmounts the session, so the answers so far are committed
   * first. Following a citation ends the review — which the summary says — but
   * it must never be the thing that quietly throws ten answers away.
   */
  const openSource = useCallback(() => {
    if (!card?.subjectId || !card.documentId) return;
    void Speech.stop();
    if (answers.length > 0) onFinish(answers);
    router.push({
      pathname: '/knowledge/subject/[subjectId]/[docId]',
      params: {
        subjectId: card.subjectId,
        docId: card.documentId,
        ...(card.pageNumber ? { page: String(card.pageNumber) } : {}),
        ...(card.highlight ? { highlight: card.highlight } : {}),
      },
    });
  }, [card, answers, onFinish, router]);

  if (!card) return <Loading label="Saving your session…" />;

  const progress = Math.round((index / session.cards.length) * 100);

  return (
    <View className="min-h-0 flex-1 bg-paper">
      {/*
        Sticky, and deliberately thin. It carries the only two things a student
        needs while revising — how far through they are, and the way out — and
        leaves the rest of the height to the card.
      */}
      <View className="shrink-0 border-b border-line bg-paper px-4 pb-3 pt-3 md:px-10">
        <View className="mx-auto w-full gap-2.5" style={{ maxWidth: 640 }}>
          <View className="flex-row items-center gap-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="End this review session"
              onPress={() => {
                void Speech.stop();
                if (answers.length > 0) onFinish(answers);
                else onQuit();
              }}
              className="h-11 w-11 items-center justify-center rounded-xl"
            >
              <Icon name="x" size={18} tone="muted" />
            </Pressable>
            <Text className="flex-1 text-sm font-semibold text-ink">
              {index + 1} of {session.cards.length}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                (saved[card.id] ?? card.bookmarked) ? 'Remove bookmark' : 'Bookmark this card'
              }
              disabled={card.source !== 'card'}
              onPress={bookmark}
              className={`h-11 w-11 items-center justify-center rounded-xl ${
                card.source === 'card' ? '' : 'opacity-30'
              }`}
            >
              <Icon
                name="bookmark"
                size={17}
                tone={(saved[card.id] ?? card.bookmarked) ? 'accent' : 'muted'}
              />
            </Pressable>
          </View>
          <View
            className="h-1.5 overflow-hidden rounded-full bg-line"
            accessibilityRole="progressbar"
            accessibilityValue={{ now: index, min: 0, max: session.cards.length }}
          >
            <View className="h-full rounded-full bg-ink" style={{ width: `${progress}%` }} />
          </View>
        </View>
      </View>

      <ScreenScroll>
        <ReviewCardFace
          card={card}
          onQuizAnswer={setQuizCorrect}
          onSource={card.documentId ? openSource : undefined}
          onSwipe={answer}
        />
      </ScreenScroll>

      {/*
        The two answers sit at the bottom of the screen, inside the thumb's
        reach on a phone, and stay put while the card above them scrolls.
        Swiping does the same thing; these are what make it discoverable and
        what a student using a keyboard or a screen reader actually gets.
      */}
      <View className="shrink-0 border-t border-line bg-paper px-4 pb-3 pt-3 md:px-10">
        <View className="mx-auto w-full flex-row gap-2.5" style={{ maxWidth: 640 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show this again — I did not remember it"
            onPress={() => answer('again')}
            className="min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-xl border border-line bg-surface"
          >
            <Icon name="rotate-ccw" size={16} tone="muted" />
            <Text className="text-[15px] font-semibold text-ink">Again</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="I remembered this"
            onPress={() => answer('good')}
            className="min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-ink"
          >
            <Icon name="check" size={16} tone="inverse" />
            <Text className="text-[15px] font-semibold text-paper">Got it</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * One card
 * ------------------------------------------------------------------ */

const FORMAT_ICON: Record<DeckCard['format'], IconName> = {
  fact: 'book-open',
  quiz: 'check-circle-2',
  diagram: 'layers',
  audio: 'volume-2',
};

function ReviewCardFace({
  card,
  onQuizAnswer,
  onSource,
  onSwipe,
}: {
  card: DeckCard;
  onQuizAnswer: (correct: boolean | null) => void;
  onSource?: () => void;
  onSwipe: (outcome: ReviewOutcome) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const drift = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;

  // A new card is a clean slate, including anything the last one was saying.
  useEffect(() => {
    setRevealed(false);
    setPicked(null);
    setSpeaking(false);
    void Speech.stop();
    drift.setValue({ x: 0, y: 0 });
  }, [card.id, drift]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Only claim the gesture once it is clearly horizontal, so the card
        // body can still be scrolled and text can still be selected.
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 16 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4,
        onPanResponderMove: (_event, gesture) => drift.setValue({ x: gesture.dx, y: 0 }),
        onPanResponderRelease: (_event, gesture) => {
          if (Math.abs(gesture.dx) > 90) {
            onSwipe(gesture.dx > 0 ? 'good' : 'again');
            return;
          }
          Animated.spring(drift, {
            toValue: { x: 0, y: 0 },
            speed: 40,
            bounciness: 6,
            useNativeDriver: Platform.OS !== 'web',
          }).start();
        },
      }),
    [drift, onSwipe]
  );

  const speak = useCallback(() => {
    if (speaking) {
      void Speech.stop();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    Speech.speak(`${card.title}. ${card.body}. ${card.takeaway}`, {
      rate: 1.03,
      onDone: () => setSpeaking(false),
      onStopped: () => setSpeaking(false),
      onError: () => setSpeaking(false),
    });
  }, [card.body, card.takeaway, card.title, speaking]);

  const source = card.documentTitle
    ? `${card.documentTitle}${card.pageNumber ? ` · Page ${card.pageNumber}` : ''}`
    : card.subjectName ?? card.subjectCode ?? null;

  const isQuiz = card.format === 'quiz' && card.question !== null;
  const hasOptions = isQuiz && card.options.length > 0;

  return (
    /*
      The animation and the styling are split deliberately: NativeWind does not
      apply className to Animated components, so utilities on an Animated.View
      are silently dropped and the card renders with no border, no surface and
      no corners. The transform lives out here, everything visible lives on the
      plain View inside.
    */
    <Animated.View
      accessibilityLabel={`${card.title}. Swipe right if you remembered it, left to see it again.`}
      style={{
        width: '100%',
        maxWidth: 640,
        alignSelf: 'center',
        transform: [{ translateX: drift.x }],
      }}
      {...responder.panHandlers}
    >
      <View className="w-full overflow-hidden rounded-3xl border border-line bg-surface">
      <View className="flex-row items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <Icon name={FORMAT_ICON[card.format] ?? 'book-open'} size={15} tone="muted" />
          <Text className="text-xs font-bold uppercase tracking-wider text-muted" numberOfLines={1}>
            {card.source === 'concept'
              ? 'Missed question'
              : card.format === 'audio'
                ? 'Spoken summary'
                : card.format}
          </Text>
        </View>
        {card.subjectCode || card.subjectName ? (
          <Text className="shrink-0 text-xs font-medium text-subtle" numberOfLines={1}>
            {card.subjectCode ?? card.subjectName}
          </Text>
        ) : null}
      </View>

      <View className="gap-5 px-5 py-6 sm:px-6 sm:py-7">
        <Text className="font-heading text-[24px] font-bold leading-8 tracking-tight text-ink">
          {card.title}
        </Text>
        <Text className="text-[15px] leading-7 text-muted" selectable>
          {card.body}
        </Text>

        {card.format === 'diagram' && card.points.length > 0 ? (
          <View className="gap-2.5">
            {card.points.map((point, position) => (
              <View key={`${card.id}-${position}`} className="flex-row items-start gap-3">
                <View className="mt-0.5 h-6 w-6 items-center justify-center rounded-full bg-pine-soft">
                  <Text className="text-xs font-bold text-pine">{position + 1}</Text>
                </View>
                <Text className="flex-1 text-sm leading-6 text-ink">{point}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {hasOptions ? (
          <View className="gap-2.5">
            {card.options.map((option, position) => {
              const answered = picked !== null;
              const correct = position === card.correctAnswerIndex;
              const chosen = picked === position;
              return (
                <Pressable
                  key={`${card.id}-option-${position}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: answered, selected: chosen }}
                  disabled={answered}
                  onPress={() => {
                    setPicked(position);
                    setRevealed(true);
                    const right = position === card.correctAnswerIndex;
                    feedback(right ? 'success' : 'toggle');
                    onQuizAnswer(right);
                  }}
                  className={`min-h-12 justify-center rounded-xl border px-4 py-3 ${
                    answered && correct
                      ? 'border-pine bg-pine-soft'
                      : answered && chosen
                        ? 'border-rose bg-rose-soft'
                        : 'border-line bg-sand/40'
                  }`}
                >
                  <Text className="text-sm font-medium leading-5 text-ink">{option}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {card.format === 'audio' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={speaking ? 'Stop reading this card' : 'Read this card aloud'}
            onPress={speak}
            className="min-h-11 flex-row items-center gap-2 self-start rounded-full bg-sand px-4 py-2.5"
          >
            <Icon name={speaking ? 'volume-x' : 'volume-2'} size={15} tone="ink" />
            <Text className="text-xs font-semibold text-ink">
              {speaking ? 'Stop' : 'Read it to me'}
            </Text>
          </Pressable>
        ) : null}

        {/*
          The answer stays hidden until asked for. Retrieval is the part of a
          review that does the work; a card that shows its own answer is a card
          being reread.
        */}
        {revealed || (hasOptions && picked !== null) ? (
          <View className="gap-1.5 rounded-2xl bg-sand p-4">
            <Text className="text-xs font-bold uppercase tracking-wider text-subtle">
              {card.source === 'concept' ? 'Correct answer' : 'Remember'}
            </Text>
            <Text className="text-sm font-semibold leading-6 text-ink" selectable>
              {card.takeaway}
            </Text>
            {card.explanation ? (
              <Text className="mt-1 text-sm leading-6 text-muted" selectable>
                {card.explanation}
              </Text>
            ) : null}
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show the answer"
            onPress={() => {
              feedback('tap');
              setRevealed(true);
            }}
            className="min-h-12 items-center justify-center rounded-2xl border border-dashed border-line bg-sand/40"
          >
            <Text className="text-sm font-semibold text-muted">
              {isQuiz ? 'Show the answer' : 'Reveal the takeaway'}
            </Text>
          </Pressable>
        )}
      </View>

      {source ? (
        <View className="border-t border-line px-5 py-3.5">
          <Pressable
            accessibilityRole={onSource ? 'link' : 'text'}
            accessibilityLabel={onSource ? `Open the source: ${source}` : source}
            disabled={!onSource}
            onPress={onSource}
            className="min-h-11 flex-row items-center gap-2 self-start rounded-full px-1 py-2"
          >
            <Icon name={onSource ? 'external-link' : 'book-open'} size={13} tone="subtle" />
            <Text className="max-w-[280px] text-xs font-medium text-muted" numberOfLines={1}>
              {source}
            </Text>
          </Pressable>
        </View>
      ) : null}
      </View>
    </Animated.View>
  );
}
