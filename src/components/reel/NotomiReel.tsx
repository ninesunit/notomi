import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import * as Speech from 'expo-speech';
import { useRouter } from 'expo-router';
import { orderBy, query } from 'firebase/firestore';
import { Icon } from '@/components/Icon';
import { Markdown } from '@/components/Markdown';
import { ResponsiveTermPicker } from '@/components/ResponsiveTermPicker';
import { Sheet } from '@/components/Sheet';
import { Button, Loading, Notice } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { streamReelElaboration } from '@/lib/ai';
import { paths } from '@/lib/paths';
import type { ReelCard, Subject } from '@/lib/schema';
import { feedback } from '@/lib/sound';
import { getDb } from '@/services/firebase';
import { canSharePresence, setPresence, syncPublicMasteredStats } from '@/services/social';
import {
  answerReelQuiz,
  buildReelQueue,
  cacheGlobalDiscoveryCards,
  extendReel,
  filterReelCards,
  markReelCard,
  primeReel,
  recordReelDwell,
  toggleReelBookmark,
  type ReelFilter,
} from '@/services/reel';

const BASE_FILTERS: { id: ReelFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'courses', label: 'My Courses' },
  { id: 'tech', label: 'Tech & AI' },
  { id: 'science', label: 'Science' },
  { id: 'business', label: 'Business' },
];

const WEB_SNAP =
  Platform.OS === 'web'
    ? ({ scrollSnapType: 'y mandatory' } as ViewStyle)
    : undefined;

function learningStreak(cards: ReelCard[]): number {
  const days = new Set(
    cards.flatMap((card) =>
      card.lastSeenAt?.toDate ? [card.lastSeenAt.toDate().toDateString()] : []
    )
  );
  let streak = 0;
  const cursor = new Date();
  // Today is allowed to be empty until the first card is completed; in that
  // case the streak continues from yesterday rather than displaying zero.
  if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);
  while (days.has(cursor.toDateString())) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function NotomiReel() {
  const uid = useUid();
  const db = getDb();
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  const cards = useCollection<ReelCard>(
    query(paths.reelCards(db, uid), orderBy('createdAt', 'asc')),
    [uid]
  );
  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);
  const discovery = useCollection<ReelCard>(paths.discoveryCards(db), []);
  const [filter, setFilter] = useState<ReelFilter>('all');
  const [viewportHeight, setViewportHeight] = useState(Math.max(420, windowHeight - 120));
  const [loadingMore, setLoadingMore] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [sessionMastered, setSessionMastered] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [elaborating, setElaborating] = useState<ReelCard | null>(null);
  const [elaboration, setElaboration] = useState('');
  const [elaborationError, setElaborationError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const visibleRef = useRef<{ id: string | null; since: number }>({ id: null, since: Date.now() });
  const primingRef = useRef(false);

  const filters = useMemo(() => {
    const seen = new Set<string>();
    const courseFilters = subjects.data.flatMap((subject) => {
      const code = subject.moduleCode?.trim();
      if (!code || seen.has(code)) return [];
      seen.add(code);
      return [{ id: code, label: code }];
    });
    return [...BASE_FILTERS, ...courseFilters];
  }, [subjects.data]);

  const filtered = useMemo(
    () => filterReelCards(cards.data, filter),
    [cards.data, filter]
  );
  const queue = useMemo(() => buildReelQueue(filtered), [filtered]);
  const todayKey = new Date().toDateString();
  const masteredToday = useMemo(
    () =>
      cards.data.filter(
        (card) => card.masteredAt?.toDate && card.masteredAt.toDate().toDateString() === todayKey
      ).length,
    [cards.data, todayKey]
  );
  const battery = Math.min(100, sessionMastered * 10);
  const streak = useMemo(() => learningStreak(cards.data), [cards.data]);

  const generate = useCallback(
    async (more = false) => {
      if (primingRef.current) return;
      primingRef.current = true;
      setLoadingMore(true);
      setGenerationError(null);
      try {
        if (more) await extendReel(uid, subjects.data, filter);
        else await primeReel(uid, subjects.data, cards.data, filter);
      } catch (caught) {
        setGenerationError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        primingRef.current = false;
        setLoadingMore(false);
      }
    }, [uid, subjects.data, cards.data, filter]
  );

  useEffect(() => {
    if (cards.loading || discovery.loading || cards.data.length >= 5 || discovery.data.length === 0) return;
    void cacheGlobalDiscoveryCards(uid, discovery.data).catch((error) =>
      console.warn('[reel] Global discovery cache could not be copied.', error)
    );
  }, [uid, cards.loading, cards.data.length, discovery.loading, discovery.data]);

  useEffect(() => {
    void canSharePresence(uid).then((allowed) => {
      if (allowed) void setPresence(uid, { status: 'reel', minutes: 5 }).catch(() => undefined);
    });
  }, [uid]);

  useEffect(() => {
    if (cards.loading) return;
    const mastered = cards.data.filter((card) => card.mastered).length;
    void syncPublicMasteredStats(uid, mastered).catch(() => undefined);
  }, [uid, cards.loading, cards.data]);

  useEffect(() => {
    if (cards.loading || subjects.loading || queue.length >= 5) return;
    void generate(false);
  }, [cards.loading, subjects.loading, queue.length, generate]);

  useEffect(() => {
    const current = queue[activeIndex];
    const previous = visibleRef.current;
    if (previous.id && previous.id !== current?.id) {
      void recordReelDwell(uid, previous.id, Date.now() - previous.since).catch(() => undefined);
    }
    visibleRef.current = { id: current?.id ?? null, since: Date.now() };
  }, [activeIndex, queue, uid]);

  useEffect(
    () => () => {
      const visible = visibleRef.current;
      if (visible.id) {
        void recordReelDwell(uid, visible.id, Date.now() - visible.since).catch(() => undefined);
      }
      Speech.stop();
    },
    [uid]
  );

  const chooseFilter = useCallback((next: ReelFilter) => {
    setFilter(next);
    setActiveIndex(0);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, []);

  const loadNearEnd = useCallback(
    (index: number) => {
      setActiveIndex(index);
      if (queue.length > 0 && index >= queue.length - 3) void generate(true);
    },
    [queue.length, generate]
  );

  const openSource = useCallback(
    (card: ReelCard) => {
      if (!card.subjectId || !card.documentId) return;
      router.push({
        pathname: '/knowledge/subject/[subjectId]/[docId]',
        params: {
          subjectId: card.subjectId,
          docId: card.documentId,
          ...(card.pageNumber ? { page: String(card.pageNumber) } : {}),
          ...(card.highlight ? { highlight: card.highlight } : {}),
        },
      });
    },
    [router]
  );

  const master = useCallback(
    async (card: ReelCard) => {
      feedback('success');
      setSessionMastered((count) => count + 1);
      await markReelCard(uid, card, 'mastered');
    },
    [uid]
  );

  const review = useCallback(
    async (card: ReelCard) => {
      feedback('toggle');
      await markReelCard(uid, card, 'review');
    },
    [uid]
  );

  const elaborate = useCallback(async (card: ReelCard) => {
    setElaborating(card);
    setElaboration('');
    setElaborationError(null);
    setStreaming(true);
    try {
      await streamReelElaboration(
        {
          title: card.title,
          body: card.body,
          takeaway: card.takeaway,
          sourceContext: card.highlight,
        },
        setElaboration
      );
    } catch (caught) {
      setElaborationError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStreaming(false);
    }
  }, []);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setViewportHeight(Math.max(420, Math.round(event.nativeEvent.layout.height)));
  }, []);

  return (
    <View className="min-h-0 flex-1 bg-paper" onLayout={onLayout}>
      <View className="shrink-0 gap-2 border-b border-line bg-paper px-5 pb-3 pt-3 md:px-10">
        <View className="mx-auto w-full gap-2" style={{ maxWidth: 1080 }}>
          <View className="flex-row items-center gap-3">
            <View className="h-8 w-8 items-center justify-center rounded-lg bg-accent-soft">
              <Icon name="sliders-horizontal" size={15} tone="accent" />
            </View>
            <View className="min-w-0 flex-1">
              <ResponsiveTermPicker
                options={filters}
                value={filter}
                onChange={chooseFilter}
                title="Filter Notomi Reel"
                sheetIcon="sliders-horizontal"
              />
            </View>
          </View>

          <View className="flex-row items-center gap-3">
            <Icon name="layers" size={14} tone="pine" />
            <Text className="text-xs font-semibold text-muted">Brain battery</Text>
            <View className="h-2 flex-1 overflow-hidden rounded-full bg-line">
              <View className="h-full rounded-full bg-pine" style={{ width: `${battery}%` }} />
            </View>
            <Text className="text-xs font-bold text-pine">{battery}%</Text>
            <Text className="text-xs text-subtle">{masteredToday} mastered today</Text>
            <Text className="text-xs text-subtle">{streak} day streak</Text>
          </View>
        </View>
      </View>

      {generationError && queue.length > 0 ? (
        <View className="absolute left-5 right-5 top-28 z-20 mx-auto" style={{ maxWidth: 448 }}>
          <Notice title="Could not add more cards" body={generationError} />
        </View>
      ) : null}

      {queue.length === 0 ? (
        <View className="flex-1 items-center justify-center px-5">
          {loadingMore ? (
            <Loading label="Building your knowledge feed…" />
          ) : (
            <View className="w-full gap-4" style={{ maxWidth: 448 }}>
              <Notice
                title="Your Reel is ready to be built"
                body={
                  generationError ??
                  'Notomi can micro-chunk your materials and mix them with course-aware discovery cards.'
                }
              />
              <Button label="Build my Reel" icon="sparkles" onPress={() => void generate(false)} />
            </View>
          )}
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
        className="reel-snap min-h-0 flex-1"
          style={WEB_SNAP}
          pagingEnabled
          snapToInterval={viewportHeight}
          decelerationRate="fast"
          disableIntervalMomentum
          showsVerticalScrollIndicator={false}
          onMomentumScrollEnd={(event) =>
            loadNearEnd(Math.max(0, Math.round(event.nativeEvent.contentOffset.y / viewportHeight)))
          }
        >
          {queue.map((card, index) => (
            <View
              key={card.id}
              /*
               * justify-start, not justify-center.
               *
               * The cell is exactly one viewport tall. Centring a card that is
               * taller than that pushes half the overflow above the top edge,
               * where it is both cut off and unreachable — the card opened
               * mid-sentence, under the header, with no way to scroll up to
               * the beginning of it. Anchoring to the top means a long card is
               * only ever clipped at the end, which is the direction a reader
               * expects and can do something about.
               */
              className="items-center justify-start px-5 pb-8 pt-5 md:px-10"
              style={
                Platform.OS === 'web'
                  ? ({ height: viewportHeight, scrollSnapAlign: 'start' } as ViewStyle)
                  : { height: viewportHeight }
              }
            >
              <KnowledgeCard
                card={card}
                index={index}
                total={queue.length}
                onElaborate={() => void elaborate(card)}
                onSource={() => openSource(card)}
                onBookmark={() => void toggleReelBookmark(uid, card)}
                onMastered={() => void master(card)}
                onReview={() => void review(card)}
                onAnswer={(selected) => answerReelQuiz(uid, card, selected)}
              />
              {sessionMastered > 0 && sessionMastered % 3 === 0 && index === activeIndex ? (
                <View className="mt-3 flex-row items-center gap-2 rounded-full bg-accent-soft px-4 py-2">
                  <Icon name="sparkles" size={14} tone="accent" />
                  <Text className="text-xs font-semibold text-accent">
                    Three concepts mastered this session
                  </Text>
                </View>
              ) : null}
            </View>
          ))}
        </ScrollView>
      )}

      <Sheet
        visible={elaborating !== null}
        onClose={() => setElaborating(null)}
        title={elaborating?.title ?? 'Elaborate'}
        icon="sparkles"
        maxHeight={580}
      >
        {elaborationError ? (
          <Notice title="Could not elaborate" body={elaborationError} />
        ) : elaboration ? (
          <Markdown source={elaboration} />
        ) : (
          <Loading label="Opening the concept…" />
        )}
        {streaming && elaboration ? (
          <Text className="text-xs font-medium text-subtle">Still writing…</Text>
        ) : null}
      </Sheet>
    </View>
  );
}

function KnowledgeCard({
  card,
  index,
  total,
  onElaborate,
  onSource,
  onBookmark,
  onMastered,
  onReview,
  onAnswer,
}: {
  card: ReelCard;
  index: number;
  total: number;
  onElaborate: () => void;
  onSource: () => void;
  onBookmark: () => void;
  onMastered: () => void;
  onReview: () => void;
  onAnswer: (selected: number) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const lastTap = useRef(0);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 16 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4,
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dx > 70) onMastered();
          else if (gesture.dx < -70) onReview();
        },
      }),
    [onMastered, onReview]
  );

  const sourceLabel = card.documentTitle
    ? `${card.documentTitle}${card.pageNumber ? ` · Page ${card.pageNumber}` : ''}`
    : card.subjectCode
      ? `${card.subjectCode} · Course discovery`
      : 'Notomi discovery';

  const toggleSpeech = useCallback(() => {
    if (speaking) {
      Speech.stop();
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

  return (
    <Pressable
      accessibilityRole="summary"
      accessibilityLabel={`${card.title}. Card ${index + 1} of ${total}`}
      delayLongPress={500}
      onLongPress={card.documentId ? onSource : undefined}
      onPress={() => {
        const now = Date.now();
        if (now - lastTap.current < 300) onBookmark();
        lastTap.current = now;
      }}
      className="w-full overflow-hidden rounded-3xl border border-line/80 bg-surface"
      style={{ maxWidth: 448, minHeight: 470 }}
      {...responder.panHandlers}
    >
      <View className="flex-row items-center justify-between border-b border-line px-5 py-4">
        <View className="flex-row items-center gap-2">
          <View className="h-8 w-8 items-center justify-center rounded-lg bg-accent-soft">
            <Icon
              name={card.format === 'diagram' ? 'layers' : card.format === 'quiz' ? 'check-circle-2' : 'book-open'}
              size={15}
              tone="accent"
            />
          </View>
          <Text className="text-xs font-bold uppercase tracking-wider text-muted">
            {card.format === 'audio' ? 'TL;DR audio' : card.format}
          </Text>
        </View>
        <Text className="text-xs font-medium text-subtle">
          {index + 1} / {total}
        </Text>
      </View>

      <View className="flex-1 justify-center gap-5 px-6 py-7">
        <Text className="text-[27px] font-bold leading-9 tracking-tight text-ink">{card.title}</Text>
        <Text className="text-base leading-7 text-muted">{card.body}</Text>

        {card.format === 'diagram' && card.points.length > 0 ? (
          <View className="gap-2.5">
            {card.points.map((point, pointIndex) => (
              <View key={`${card.id}-${pointIndex}`} className="flex-row items-start gap-3">
                <View className="mt-0.5 h-6 w-6 items-center justify-center rounded-full bg-pine-soft">
                  <Text className="text-xs font-bold text-pine">{pointIndex + 1}</Text>
                </View>
                <Text className="flex-1 text-sm leading-6 text-ink">{point}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {card.format === 'quiz' && card.question && card.options.length > 0 ? (
          <View className="gap-2.5">
            <Text className="text-[15px] font-semibold leading-6 text-ink">{card.question}</Text>
            {card.options.map((option, optionIndex) => {
              const answered = selected !== null || card.quizAnswered;
              const correct = optionIndex === card.correctAnswerIndex;
              const chosen = selected === optionIndex;
              return (
                <Pressable
                  key={`${card.id}-option-${optionIndex}`}
                  accessibilityRole="button"
                  disabled={answered}
                  onPress={() => {
                    setSelected(optionIndex);
                    void onAnswer(optionIndex);
                  }}
                  className={`rounded-xl border px-4 py-3 ${
                    answered && correct
                      ? 'border-pine bg-pine-soft'
                      : answered && chosen
                        ? 'border-rose bg-rose-soft'
                        : 'border-line bg-sand/40'
                  }`}
                >
                  <Text className="text-sm font-medium text-ink">{option}</Text>
                </Pressable>
              );
            })}
            {(selected !== null || card.quizAnswered) && card.explanation ? (
              <Text className="text-sm leading-6 text-muted">
                {card.explanation}{card.quizCorrect || selected === card.correctAnswerIndex ? '  +10 XP' : ''}
              </Text>
            ) : null}
          </View>
        ) : null}

        {card.format === 'audio' ? (
          <Pressable
            accessibilityRole="button"
            onPress={toggleSpeech}
            className="flex-row items-center gap-2 self-start rounded-full bg-sand px-4 py-2.5"
          >
            <Icon name="book-open" size={15} tone="ink" />
            <Text className="text-xs font-semibold text-ink">
              {speaking ? 'Stop TL;DR' : 'Listen to TL;DR'}
            </Text>
          </Pressable>
        ) : null}

        <View className="rounded-2xl bg-sand p-4">
          <Text className="text-xs font-bold uppercase tracking-wider text-subtle">Remember</Text>
          <Text className="mt-1.5 text-sm font-semibold leading-6 text-ink">{card.takeaway}</Text>
        </View>
      </View>

      <View className="gap-3 border-t border-line px-5 py-4">
        <View className="flex-row flex-wrap gap-2">
          <ActionButton icon="sparkles" label="Elaborate" onPress={onElaborate} />
          <ActionButton
            icon="bookmark"
            label={card.bookmarked ? 'Saved' : 'Bookmark'}
            active={card.bookmarked}
            onPress={onBookmark}
          />
          <ActionButton icon="rotate-ccw" label="Review" onPress={onReview} />
          <ActionButton icon="check-circle-2" label="Mastered" onPress={onMastered} />
        </View>
        <Pressable
          accessibilityRole={card.documentId ? 'link' : 'text'}
          disabled={!card.documentId}
          onPress={card.documentId ? onSource : undefined}
          className="flex-row items-center gap-2 self-start rounded-full bg-sand px-3 py-2"
        >
          <Icon name={card.documentId ? 'external-link' : 'book-open'} size={13} tone="muted" />
          <Text className="max-w-[330px] text-xs font-medium text-muted" numberOfLines={1}>
            {sourceLabel}
          </Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

function ActionButton({
  icon,
  label,
  active = false,
  onPress,
}: {
  icon: 'sparkles' | 'bookmark' | 'rotate-ccw' | 'check-circle-2';
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`flex-row items-center gap-1.5 rounded-full px-3 py-2 ${
        active ? 'bg-ink' : 'bg-sand'
      }`}
    >
      <Icon name={icon} size={13} tone={active ? 'inverse' : 'muted'} />
      <Text className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}>{label}</Text>
    </Pressable>
  );
}
