import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { orderBy, query, where } from 'firebase/firestore';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import { Icon } from '@/components/Icon';
import { Badge, Button, Card, EmptyState, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { QuizQuestion, SourceDocument, Subject } from '@/lib/schema';
import {
  addMissedConceptsToStudyQueue,
  advanceArenaRound,
  createArenaRoom,
  findArenaRoom,
  getPlayerDeck,
  joinArenaRoom,
  saveGhostRun,
  startArenaRoom,
  startGhostChallenge,
  submitArenaAnswer,
  type ArenaGhost,
  type ArenaMode,
  type ArenaPlayer,
  type ArenaRoom,
} from '@/services/arena';
import { getDb } from '@/services/firebase';
import { friendsPath, recordArenaWin, type Friend } from '@/services/social';

export function Arena() {
  const uid = useUid();
  const { user } = useAuth();
  const db = getDb();
  const subjects = useCollection<Subject>(query(paths.subjects(db, uid), orderBy('name')), [uid]);
  const friends = useCollection<Friend>(friendsPath(db, uid), [uid]);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const selected = subjects.data.find((subject) => subject.id === subjectId) ?? subjects.data[0] ?? null;
  const documents = useCollection<SourceDocument>(
    selected ? paths.documents(db, uid, selected.id) : null,
    [uid, selected?.id]
  );
  const [mode, setMode] = useState<Exclude<ArenaMode, 'ghost'>>('same-course');
  const [joinCode, setJoinCode] = useState('');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const displayName = user?.displayName || user?.email?.split('@')[0] || 'Student';

  const room = useDocument<ArenaRoom>(roomId ? paths.arenaRoom(db, roomId) : null, [roomId]);
  const players = useCollection<ArenaPlayer>(roomId ? paths.arenaPlayers(db, roomId) : null, [roomId]);
  const me = players.data.find((player) => player.id === uid) ?? null;
  const [deck, setDeck] = useState<QuizQuestion[]>([]);

  const acceptedFriendIds = friends.data
    .filter((friend) => friend.status === 'accepted')
    .slice(0, 10)
    .map((friend) => friend.id);
  const ghosts = useCollection<ArenaGhost>(
    acceptedFriendIds.length
      ? query(paths.arenaGhosts(db), where('ownerId', 'in', acceptedFriendIds))
      : null,
    [acceptedFriendIds.join('|')]
  );

  useEffect(() => {
    if (!room.data) {
      setDeck([]);
      return;
    }
    let live = true;
    void getPlayerDeck(room.data, uid).then((questions) => live && setDeck(questions));
    return () => {
      live = false;
    };
  }, [room.data, uid]);

  const sources = useMemo(
    () =>
      documents.data.map((document) => ({
        title: document.fileName || document.title,
        text: document.rawText ?? '',
      })),
    [documents.data]
  );
  const hasReadableMaterial = sources.some((source) => source.text.trim().length > 0);

  async function create() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      setRoomId(
        await createArenaRoom({ uid, displayName, subject: selected, sources, mode })
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const found = await findArenaRoom(joinCode);
      if (!found) throw new Error('No open Arena room uses that code.');
      await joinArenaRoom({ room: found, uid, displayName, subject: selected, sources });
      setRoomId(found.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (roomId && (room.loading || players.loading)) {
    return (
      <ScreenScroll>
        <Loading label="Opening Arena room…" />
      </ScreenScroll>
    );
  }

  if (roomId && room.data && me) {
    return (
      <BattleRoom
        room={room.data}
        players={players.data}
        me={me}
        deck={deck}
        onLeave={() => setRoomId(null)}
      />
    );
  }

  return (
    <ScreenScroll>
      <PageHeader
        title="Notomi Arena"
        subtitle="Live course-grounded battles and asynchronous ghost challenges."
      />
      {error ? <View className="mb-5"><Notice title="Could not open that battle" body={error} /></View> : null}

      {subjects.loading ? (
        <Loading label="Loading your subjects…" />
      ) : subjects.data.length === 0 ? (
        <EmptyState
          icon="book-open"
          title="Add a subject first"
          body="Arena questions are generated only from uploaded course materials."
        />
      ) : (
        <View className="gap-6">
          <Card className="gap-5">
            <View className="gap-1">
              <Text className="font-heading text-lg text-ink">Create a live room</Text>
              <Text className="text-sm leading-5 text-muted">
                Five questions are generated once and cached for the entire battle.
              </Text>
            </View>
            <SubjectPicker subjects={subjects.data} value={selected?.id ?? ''} onChange={setSubjectId} />
            <View className="flex-row flex-wrap gap-2">
              <ModeChip
                active={mode === 'same-course'}
                label="Same-course"
                onPress={() => setMode('same-course')}
              />
              <ModeChip
                active={mode === 'cross-course'}
                label="Cross-course"
                onPress={() => setMode('cross-course')}
              />
            </View>
            <Button
              label={busy ? 'Preparing deck…' : 'Create room'}
              icon="swords"
              loading={busy}
              disabled={!selected || documents.loading || !hasReadableMaterial}
              onPress={() => void create()}
              className="self-start"
            />
            {!documents.loading && selected && !hasReadableMaterial ? (
              <View className="flex-row flex-wrap items-center gap-2 rounded-xl bg-amber-soft px-3 py-2.5">
                <Icon name="book-open" size={15} tone="amber" />
                <Text className="flex-1 text-xs leading-5 text-ink/80">
                  Upload at least one readable material for this subject before creating a room.
                </Text>
                <Link href="/knowledge" asChild>
                  <Pressable accessibilityRole="link" className="rounded-lg px-2 py-1.5">
                    <Text className="text-xs font-semibold text-amber">Open Library</Text>
                  </Pressable>
                </Link>
              </View>
            ) : null}
          </Card>

          <Card className="gap-4">
            <View className="gap-1">
              <Text className="font-heading text-lg text-ink">Join with a room code</Text>
              <Text className="text-sm text-muted">Select the subject you want to play before joining.</Text>
            </View>
            <View className="flex-row items-end gap-2">
              <View className="flex-1">
                <Field
                  label="Six-character code"
                  value={joinCode}
                  onChangeText={(value) => setJoinCode(value.toUpperCase().slice(0, 6))}
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
              </View>
              <Button
                label="Join"
                size="sm"
                loading={busy}
                disabled={joinCode.length !== 6 || !selected}
                onPress={() => void join()}
              />
            </View>
          </Card>

          <View className="gap-3">
            <View className="flex-row items-center gap-2">
              <Icon name="trophy" size={18} tone="accent" />
              <Text className="font-heading text-lg text-ink">Ghost battles</Text>
            </View>
            {ghosts.data.length === 0 ? (
              <Card><Text className="text-sm text-muted">Friends’ saved runs will appear here.</Text></Card>
            ) : (
              ghosts.data.map((ghost) => (
                <Card key={ghost.id} className="flex-row items-center gap-3">
                  <View className="h-10 w-10 items-center justify-center rounded-xl bg-sand">
                    <Icon name="trophy" size={18} tone="muted" />
                  </View>
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-ink">{ghost.ownerName}</Text>
                    <Text className="text-xs text-muted">{ghost.subjectName} · {ghost.score} points</Text>
                  </View>
                  <Button
                    label="Challenge"
                    size="sm"
                    variant="secondary"
                    onPress={() =>
                      void startGhostChallenge({ uid, displayName, ghost }).then(setRoomId)
                    }
                  />
                </Card>
              ))
            )}
          </View>
        </View>
      )}
    </ScreenScroll>
  );
}

function SubjectPicker({
  subjects,
  value,
  onChange,
}: {
  subjects: Subject[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-muted">Subject</Text>
      <View className="flex-row flex-wrap gap-2">
        {subjects.map((subject) => {
          const active = subject.id === value;
          return (
            <Pressable
              key={subject.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              onPress={() => onChange(subject.id)}
              className={`rounded-xl border px-3 py-2 ${active ? 'border-ink bg-ink' : 'border-line bg-surface'}`}
            >
              <Text className={`text-xs font-semibold ${active ? 'text-paper' : 'text-ink'}`}>
                {subject.moduleCode || subject.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function ModeChip({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`rounded-xl px-3 py-2 ${active ? 'bg-ink' : 'bg-sand'}`}
    >
      <Text className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}>{label}</Text>
    </Pressable>
  );
}

function BattleRoom({
  room,
  players,
  me,
  deck,
  onLeave,
}: {
  room: ArenaRoom;
  players: ArenaPlayer[];
  me: ArenaPlayer;
  deck: QuizQuestion[];
  onLeave: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const question = deck[room.currentQuestion] ?? null;
  const answered = me.answeredQuestion >= room.currentQuestion;
  const allAnswered = room.memberIds.every(
    (memberId) => players.find((player) => player.id === memberId)?.answeredQuestion === room.currentQuestion
  );
  const host = room.hostId === me.id;

  useEffect(() => {
    if (room.status !== 'finished') return;
    const winningScore = room.mode === 'ghost'
      ? room.ghostScore ?? 0
      : Math.max(...players.map((player) => player.score));
    if (me.score > winningScore || (room.mode !== 'ghost' && me.score === winningScore)) {
      void recordArenaWin(me.id, room.id).catch(() => undefined);
    }
  }, [room.id, room.mode, room.status, room.ghostScore, players, me.id, me.score]);

  async function answer(index: number) {
    if (!question || answered) return;
    setBusy(true);
    setError(null);
    try {
      await submitArenaAnswer({
        roomId: room.id,
        uid: me.id,
        questionIndex: room.currentQuestion,
        answerIndex: index,
        question,
        questionStartedAt: room.questionStartedAt,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenScroll>
      <PageHeader
        title="Arena room"
        subtitle={`Room ${room.code} · ${room.mode === 'same-course' ? 'Same-course' : room.mode === 'cross-course' ? 'Cross-course' : 'Ghost battle'}`}
        actions={<Button label="Leave" variant="secondary" size="sm" onPress={onLeave} />}
      />
      {error ? <View className="mb-5"><Notice title="Arena action failed" body={error} /></View> : null}

      <View className="mb-5 flex-row flex-wrap gap-2">
        {players
          .slice()
          .sort((a, b) => b.score - a.score)
          .map((player) => (
            <View key={player.id} className="flex-row items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
              {player.onFire ? <Icon name="flame" size={15} tone="accent" /> : null}
              <Text className="text-xs font-semibold text-ink">{player.displayName}</Text>
              <Badge label={`${player.score}`} tone={player.id === me.id ? 'accent' : 'neutral'} />
            </View>
          ))}
        {room.mode === 'ghost' ? (
          <View className="flex-row items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
            <Icon name="trophy" size={15} tone="muted" />
            <Text className="text-xs font-semibold text-ink">{room.ghostName}</Text>
            <Badge label={`${room.ghostScore ?? 0}`} />
          </View>
        ) : null}
      </View>

      <Card className="mb-5 flex-row items-start gap-3 border-accent/20 bg-accent-soft">
        <Icon name="message-circle" size={18} tone="accent" />
        <Text className="flex-1 text-sm leading-6 text-ink">{room.commentary}</Text>
      </Card>

      {room.status === 'lobby' ? (
        <Card className="gap-4">
          <View className="gap-1">
            <Text className="font-heading text-xl text-ink">Invite 2–6 players</Text>
            <Text className="text-sm text-muted">Share room code <Text className="font-bold text-ink">{room.code}</Text>.</Text>
          </View>
          <View className="gap-2">
            {players.map((player) => (
              <View key={player.id} className="flex-row items-center gap-3 rounded-xl bg-sand px-3 py-2.5">
                <Icon name="user-check" size={16} tone="pine" />
                <Text className="flex-1 text-sm font-medium text-ink">{player.displayName}</Text>
                <Text className="text-xs text-muted">{player.subjectName}</Text>
              </View>
            ))}
          </View>
          {host ? (
            <Button
              label="Start battle"
              icon="play"
              disabled={players.length < 2}
              onPress={() => void startArenaRoom(room.id)}
              className="self-start"
            />
          ) : (
            <Text className="text-sm text-muted">Waiting for the host to start.</Text>
          )}
        </Card>
      ) : room.status === 'playing' && question ? (
        <Card className="gap-5">
          <View className="flex-row items-center justify-between gap-3">
            <Badge label={`Question ${room.currentQuestion + 1} of ${deck.length || 5}`} tone="accent" />
            {me.onFire ? (
              <View className="flex-row items-center gap-1.5">
                <Icon name="flame" size={16} tone="accent" />
                <Text className="text-xs font-semibold text-accent">On Fire</Text>
              </View>
            ) : null}
          </View>
          <Text className="font-heading text-xl leading-8 text-ink">{question.question}</Text>
          <View className="gap-2">
            {question.options.map((option, index) => {
              const selected = me.selectedAnswer === index && answered;
              const correct = answered && index === question.correctAnswerIndex;
              return (
                <Pressable
                  key={`${index}-${option}`}
                  accessibilityRole="button"
                  disabled={busy || answered}
                  onPress={() => void answer(index)}
                  className={`rounded-xl border px-4 py-3 ${
                    correct
                      ? 'border-pine bg-pine-soft'
                      : selected
                        ? 'border-rose bg-rose-soft'
                        : 'border-line bg-surface'
                  }`}
                >
                  <Text className="text-sm leading-6 text-ink">{option}</Text>
                </Pressable>
              );
            })}
          </View>
          {answered ? (
            <View className="gap-3 border-t border-line pt-4">
              <Text className={`text-sm font-semibold ${me.lastCorrect ? 'text-pine' : 'text-rose'}`}>
                {me.lastCorrect ? 'Correct' : 'Review this one'}
              </Text>
              <Text className="text-sm leading-6 text-muted">{question.explanation}</Text>
              {host ? (
                <Button
                  label={room.currentQuestion + 1 >= deck.length ? 'Finish battle' : 'Next round'}
                  icon="arrow-right"
                  disabled={!allAnswered}
                  loading={busy}
                  onPress={() => void advanceArenaRound(room, players)}
                  className="self-start"
                />
              ) : (
                <Text className="text-xs text-subtle">Waiting for the host and remaining players.</Text>
              )}
            </View>
          ) : null}
        </Card>
      ) : null}

      <Sheet
        visible={room.status === 'finished'}
        onClose={onLeave}
        title="Battle receipt"
        icon="trophy"
        dismissOnScrim={false}
        footer={
          <>
            <Button label="Close" variant="ghost" size="sm" onPress={onLeave} />
            <View className="flex-1" />
            <Button
              label={saved ? 'Saved' : 'Save ghost run'}
              icon="trophy"
              size="sm"
              disabled={saved}
              onPress={() => {
                void saveGhostRun(room, me, deck).then(() => setSaved(true));
              }}
            />
          </>
        }
      >
        <View className="gap-5">
          <View className="items-center gap-1 rounded-2xl bg-sand p-5">
            <Text className="font-heading text-3xl text-ink">{me.score}</Text>
            <Text className="text-sm text-muted">points</Text>
            {room.mode === 'ghost' ? (
              <Text className="mt-2 text-sm font-semibold text-ink">
                {me.score > (room.ghostScore ?? 0) ? 'Ghost beaten' : 'Ghost run wins this time'}
              </Text>
            ) : null}
          </View>
          <View className="gap-2">
            <Text className="font-heading text-lg text-ink">Missed concepts</Text>
            {me.missedConcepts.length ? (
              me.missedConcepts.map((concept) => (
                <View key={concept} className="flex-row items-center gap-2 rounded-xl bg-rose-soft px-3 py-2">
                  <Icon name="target" size={15} tone="rose" />
                  <Text className="flex-1 text-sm text-ink">{concept}</Text>
                </View>
              ))
            ) : (
              <Text className="text-sm text-muted">No missed concepts in this run.</Text>
            )}
          </View>
          {me.missedConcepts.length ? (
            <Button
              label="Add to Study Queue"
              icon="plus"
              variant="secondary"
              onPress={() =>
                void addMissedConceptsToStudyQueue(
                  me.id,
                  me.subjectId,
                  me.subjectName,
                  me.missedConcepts
                )
              }
              className="self-start"
            />
          ) : null}
        </View>
      </Sheet>
    </ScreenScroll>
  );
}
