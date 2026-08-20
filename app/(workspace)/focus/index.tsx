import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Icon } from '@/components/Icon';
import { ResponsiveTermPicker } from '@/components/ResponsiveTermPicker';
import { orderBy, query } from 'firebase/firestore';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Badge, Button, Card, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { StudySession, Subject, Todo } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { formatMinutes, logSession, summarizeStreak } from '@/services/sessions';
import {
  friendsPath,
  isFocusing,
  presenceQuery,
  profilePath,
  setPresence,
  syncPublicStudyStats,
  type Friend,
  type Presence,
  type Profile,
} from '@/services/social';

/**
 * Pomodoro timer.
 *
 * The clock is derived from a wall-clock deadline rather than decremented on a
 * tick, so a backgrounded tab — where browsers throttle timers to once a minute
 * — resumes showing the true remaining time instead of however many ticks it
 * was allowed to run.
 */

type Phase = 'focus' | 'break';

const LENGTHS: Record<Phase, number> = { focus: 25 * 60, break: 5 * 60 };
/** After four focus blocks, the break is a long one. */
const LONG_BREAK = 15 * 60;
const CYCLES_TO_LONG_BREAK = 4;

export default function Focus() {
  const params = useLocalSearchParams<{ subjectId?: string; taskId?: string }>();
  const uid = useUid();
  const db = getDb();

  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);
  const sessions = useCollection<StudySession>(
    query(paths.sessions(db, uid), orderBy('createdAt', 'desc')),
    [uid]
  );
  const todos = useCollection<Todo>(query(paths.todos(db, uid), orderBy('dueDate', 'asc')), [uid]);
  const socialProfile = useDocument<Profile>(profilePath(db, uid), [uid]);

  const [phase, setPhase] = useState<Phase>('focus');
  const [running, setRunning] = useState(false);
  const [remaining, setRemaining] = useState(LENGTHS.focus);
  const [completed, setCompleted] = useState(0);
  // Pre-selected when arriving from a subject page, so "Study this" lands on a
  // timer that is already pointed at the right thing.
  const [subjectId, setSubjectId] = useState<string | null>(params.subjectId ?? null);
  const [taskId, setTaskId] = useState<string | null>(params.taskId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [justLogged, setJustLogged] = useState<number | null>(null);

  /** Wall-clock instant the current phase ends; null whenever paused. */
  const deadline = useRef<number | null>(null);
  /**
   * Seconds actually spent running this block, accumulated by the tick.
   *
   * Deriving the figure from the clock face instead — total minus remaining —
   * silently over-credits a block that did not start at full length, which is
   * exactly what joining a friend mid-session does.
   */
  const worked = useRef(0);
  const lastTick = useRef(0);

  const total = phase === 'break' && completed % CYCLES_TO_LONG_BREAK === 0 && completed > 0
    ? LONG_BREAK
    : LENGTHS[phase];

  const subject = subjects.data.find((candidate) => candidate.id === subjectId) ?? null;
  const task = todos.data.find((candidate) => candidate.id === taskId && !candidate.isCompleted) ?? null;
  const streak = useMemo(() => summarizeStreak(sessions.data), [sessions.data]);
  const publicStudyStats = useMemo(() => {
    let focusMinutes = 0;
    let nightFocusMinutes = 0;
    for (const session of sessions.data) {
      if (session.mode !== 'focus') continue;
      focusMinutes += session.minutes ?? 0;
      const hour = session.createdAt?.toDate?.().getHours();
      if (typeof hour === 'number' && hour < 5) nightFocusMinutes += session.minutes ?? 0;
    }
    return { focusMinutes, nightFocusMinutes, currentStreak: streak.current };
  }, [sessions.data, streak.current]);

  const friends = useCollection<Friend>(friendsPath(db, uid), [uid]);
  const room = useMemo(
    () => friends.data.filter((friend) => friend.status === 'accepted'),
    [friends.data]
  );

  useEffect(() => {
    if (sessions.loading || socialProfile.loading) return;
    void syncPublicStudyStats(uid, socialProfile.data, publicStudyStats).catch(() => undefined);
  }, [uid, sessions.loading, socialProfile.loading, socialProfile.data, publicStudyStats]);

  /**
   * Presence is broadcast only while a focus block is actually running, and
   * only when somebody is there to see it. The remaining time is read from a
   * ref: it changes four times a second, and this must not fire on every tick.
   */
  const remainingRef = useRef(remaining);
  remainingRef.current = remaining;

  useEffect(() => {
    if (room.length === 0 || socialProfile.data?.sharePresence !== true) return;

    if (running && phase === 'focus') {
      void setPresence(uid, {
        status: 'focus',
        subjectName: subject?.name ?? null,
        minutes: Math.max(1, Math.ceil(remainingRef.current / 60)),
      }).catch(() => undefined);
    } else {
      void setPresence(uid, { status: 'idle' }).catch(() => undefined);
    }
  }, [running, phase, subject?.name, uid, room.length, socialProfile.data?.sharePresence]);

  // Leaving the screen ends the broadcast. A closed tab writes nothing at all,
  // which is why the document also carries its own expiry.
  useEffect(
    () => () => {
      if (socialProfile.data?.sharePresence === true) {
        void setPresence(uid, { status: 'idle' }).catch(() => undefined);
      }
    },
    [uid, socialProfile.data?.sharePresence]
  );

  const finish = useCallback(
    async (elapsedSeconds: number) => {
      // Only focus time counts as study. Logging breaks would let a student
      // build a streak by resting.
      if (phase !== 'focus') return;
      const minutes = Math.round(elapsedSeconds / 60);
      if (minutes < 1) return;

      try {
        await logSession(uid, {
          minutes,
          mode: 'focus',
          subjectId: subject?.id ?? null,
          subjectName: subject?.name ?? null,
          taskId: task?.id ?? null,
          taskTitle: task?.title ?? null,
        });
        setJustLogged(minutes);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [phase, subject, task, uid]
  );

  /** Advances to the next phase, logging the block that just ended. */
  const advance = useCallback(
    (elapsedSeconds: number) => {
      void finish(elapsedSeconds);

      if (phase === 'focus') {
        const next = completed + 1;
        setCompleted(next);
        setPhase('break');
        setRemaining(next % CYCLES_TO_LONG_BREAK === 0 ? LONG_BREAK : LENGTHS.break);
      } else {
        setPhase('focus');
        setRemaining(LENGTHS.focus);
      }

      setRunning(false);
      deadline.current = null;
      worked.current = 0;
      chime();
    },
    [completed, finish, phase]
  );

  useEffect(() => {
    if (!running) return;
    lastTick.current = Date.now();

    const tick = () => {
      if (deadline.current === null) return;
      const now = Date.now();
      worked.current += (now - lastTick.current) / 1000;
      lastTick.current = now;

      const left = Math.round((deadline.current - now) / 1000);
      if (left <= 0) {
        setRemaining(0);
        advance(worked.current);
        return;
      }
      setRemaining(left);
    };

    const id = setInterval(tick, 250);
    tick();
    return () => clearInterval(id);
  }, [running, advance]);

  function start() {
    setJustLogged(null);
    deadline.current = Date.now() + remaining * 1000;
    lastTick.current = Date.now();
    setRunning(true);
  }

  function pause() {
    if (deadline.current !== null) {
      setRemaining(Math.max(0, Math.round((deadline.current - Date.now()) / 1000)));
    }
    deadline.current = null;
    setRunning(false);
  }

  /** Ends the block early but still banks the minutes actually worked. */
  function stop() {
    const elapsed = worked.current;
    deadline.current = null;
    worked.current = 0;
    setRunning(false);
    if (phase === 'focus' && elapsed >= 60) void finish(elapsed);
    setRemaining(total);
  }

  function reset(next: Phase) {
    deadline.current = null;
    worked.current = 0;
    setRunning(false);
    setPhase(next);
    setRemaining(next === 'focus' ? LENGTHS.focus : LENGTHS.break);
  }

  /**
   * Sits down with a friend already working: same subject, same finish time.
   * Ending together is the whole point, so the block is short by however long
   * they have been at it rather than starting a fresh twenty-five.
   */
  function join(seconds: number, subjectName: string | null) {
    const matched = subjectName
      ? subjects.data.find((candidate) => candidate.name === subjectName)
      : null;
    if (matched) setSubjectId(matched.id);

    setJustLogged(null);
    setPhase('focus');
    setRemaining(seconds);
    worked.current = 0;
    lastTick.current = Date.now();
    deadline.current = Date.now() + seconds * 1000;
    setRunning(true);
  }

  const progress = total > 0 ? 1 - remaining / total : 0;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return (
    <ScreenScroll maxWidth={760}>
      <PageHeader
        title="Focus Room"
        subtitle="Twenty-five minutes of work, five of rest. Finished blocks feed your streak."
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Could not save that session" body={error} />
        </View>
      ) : null}

      <Card
        className={`mb-6 items-center gap-6 py-10 ${
          phase === 'focus' ? 'bg-accent-soft/40' : 'bg-pine-soft/40'
        }`}
      >
        <View className="flex-row items-center gap-2">
          <Badge
            label={phase === 'focus' ? 'Focus block' : total === LONG_BREAK ? 'Long break' : 'Break'}
            tone={phase === 'focus' ? 'accent' : 'pine'}
          />
          {completed > 0 ? (
            <Text className="text-xs text-muted">
              {completed} block{completed === 1 ? '' : 's'} done today
            </Text>
          ) : null}
        </View>

        <Text className="text-[68px] font-bold leading-[76px] tracking-tight text-ink">
          {minutes}:{String(seconds).padStart(2, '0')}
        </Text>

        <View className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-line">
          <View
            className={`h-full rounded-full ${phase === 'focus' ? 'bg-accent' : 'bg-pine'}`}
            style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
          />
        </View>

        {/*
          Inline, directly above Start.
          
          What you are about to work on and the button that starts working on
          it belong in the same glance. This sat in its own card below the
          timer, below the focus room and below the ambient controls, so
          attaching a task meant scrolling past the thing the screen is for and
          scrolling back to press Start.
        */}
        {todos.data.some((candidate) => !candidate.isCompleted) ? (
          <View className="w-full max-w-sm">
            <ResponsiveTermPicker
              options={[
                { id: '', label: 'No task attached' },
                ...todos.data
                  .filter((candidate) => !candidate.isCompleted)
                  .map((candidate) => ({ id: candidate.id, label: candidate.title })),
              ]}
              value={taskId ?? ''}
              title="Attach a task"
              sheetIcon="check-square"
              onChange={(next) => {
                setTaskId(next || null);
                const chosen = todos.data.find((candidate) => candidate.id === next);
                if (next && chosen?.subjectId) setSubjectId(chosen.subjectId);
              }}
            />
          </View>
        ) : null}

        <View className="flex-row flex-wrap items-center justify-center gap-2">
          {running ? (
            <Button label="Pause" icon="pause" onPress={pause} />
          ) : (
            <Button
              label={remaining === total ? 'Start' : 'Resume'}
              icon="play"
              onPress={start}
            />
          )}
          <Button label="Reset" icon="rotate-ccw" variant="secondary" onPress={stop} />
          <Button
            label={phase === 'focus' ? 'Skip to break' : 'Back to focus'}
            variant="ghost"
            onPress={() => reset(phase === 'focus' ? 'break' : 'focus')}
          />
        </View>

        {justLogged ? (
          <Text className="text-xs font-medium text-pine">
            Logged {formatMinutes(justLogged)}
            {subject ? ` to ${subject.name}` : ''}.
          </Text>
        ) : null}

        {room.length > 0 && running && phase === 'focus' ? (
          <Text className="text-[11px] text-subtle">
            Your friends can see that you are focusing{subject ? ` on ${subject.name}` : ''}.
          </Text>
        ) : null}
      </Card>

      <FocusRoom friends={room} onJoin={join} />

      <AmbientControl />


      <Card className="mb-6 gap-3">
        <Text className="text-sm font-semibold text-ink">What are you working on?</Text>
        {subjects.loading ? (
          <Loading label="Loading subjects…" />
        ) : subjects.data.length === 0 ? (
          <Text className="text-sm text-muted">
            Upload material to create a subject, and your focus time will be tracked against it.
          </Text>
        ) : (
          <View className="flex-row flex-wrap gap-1.5">
            {subjects.data.map((candidate) => (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                accessibilityState={{ selected: subjectId === candidate.id }}
                onPress={() => setSubjectId(subjectId === candidate.id ? null : candidate.id)}
                className={`rounded-lg border px-3 py-2 ${
                  subjectId === candidate.id
                    ? 'border-accent bg-accent-soft'
                    : 'border-line bg-paper'
                }`}
              >
                <Text
                  className={`text-xs font-medium ${
                    subjectId === candidate.id ? 'text-accent' : 'text-muted'
                  }`}
                >
                  {candidate.name}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </Card>

      <View className="flex-row flex-wrap gap-3">
        <Metric
          icon="zap"
          value={`${streak.current}`}
          label={`day streak${streak.longest > streak.current ? ` · best ${streak.longest}` : ''}`}
        />
        <Metric icon="clock" value={formatMinutes(streak.minutesToday)} label="studied today" />
        <Metric icon="calendar" value={formatMinutes(streak.minutesThisWeek)} label="this week" />
      </View>

      <Text className="mt-6 text-xs leading-5 text-subtle">
        The timer keeps running if you switch tabs — it counts real elapsed time, not screen time.
        Stopping early still banks the minutes you worked.
      </Text>
    </ScreenScroll>
  );
}

/**
 * Who else is working right now.
 *
 * Studying alone is the part students drop out of, so the room shows only the
 * friends actually mid-block and offers the one action that matters: finish at
 * the same time as them. It renders nothing when nobody is working — an empty
 * room is worse than no room.
 */
function FocusRoom({
  friends,
  onJoin,
}: {
  friends: Friend[];
  onJoin: (seconds: number, subjectName: string | null) => void;
}) {
  const friendIds = friends.map((friend) => friend.id);
  const livePresence = useCollection<Presence>(presenceQuery(friendIds), [friendIds.join('|')]);
  const presence = useMemo(
    () => Object.fromEntries(livePresence.data.map((entry) => [entry.id, entry])),
    [livePresence.data]
  );

  // Re-renders once a minute so a block that has run out stops showing as live.
  const [, setClock] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setClock((value) => value + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const live = friends
    .map((friend) => ({ friend, presence: presence[friend.id] }))
    .filter((entry) => isFocusing(entry.presence));

  if (live.length === 0) return null;

  return (
    <Card className="mb-6 gap-3">
      <View className="flex-row items-center gap-2">
        <View className="h-2 w-2 rounded-full bg-rose" />
        <Text className="text-sm font-semibold text-ink">
          {live.length === 1 ? 'A friend is working' : `${live.length} friends are working`}
        </Text>
      </View>

      {live.map(({ friend, presence: state }) => {
        const until = state?.until?.toDate?.();
        const left = until ? Math.max(0, Math.round((until.getTime() - Date.now()) / 1000)) : 0;

        return (
          <View key={friend.id} className="flex-row items-center gap-3">
            <View
              className="h-9 w-9 items-center justify-center rounded-full"
              style={{ backgroundColor: `${friend.color}24` }}
            >
              <Text className="text-xs font-bold" style={{ color: friend.color }}>
                {friend.displayName.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View className="flex-1">
              <Text className="text-sm font-medium text-ink" numberOfLines={1}>
                {friend.displayName}
              </Text>
              <Text className="text-xs text-subtle" numberOfLines={1}>
                {state?.subjectName ? `Deep focus · ${state.subjectName}` : 'In deep focus'} ·{' '}
                {Math.ceil(left / 60)} min left
              </Text>
            </View>
            <Button
              label="Join"
              size="sm"
              variant="secondary"
              disabled={left < 60}
              onPress={() => onJoin(left, state?.subjectName ?? null)}
            />
          </View>
        );
      })}

      <Text className="text-[11px] leading-4 text-subtle">
        Joining sets your timer to end when theirs does.
      </Text>
    </Card>
  );
}

function Metric({
  icon,
  value,
  label,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  value: string;
  label: string;
}) {
  return (
    <View
      className="flex-1 grow gap-2 rounded-2xl border border-line bg-surface p-4"
      style={{ minWidth: 150, flexBasis: 150 }}
    >
      <Icon name={icon} size={15} tone="subtle" />
      <Text className="text-2xl font-bold text-ink">{value}</Text>
      <Text className="text-[13px] text-muted">{label}</Text>
    </View>
  );
}

/**
 * A short tone at the end of a block, synthesised rather than fetched so there
 * is no audio asset to ship and nothing to load before it can play.
 */
function chime(): void {
  if (Platform.OS !== 'web') return;
  try {
    const Context =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;

    const context = new Context();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = 660;
    // Ramp down rather than cutting off: an abrupt stop clicks.
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.6);

    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.6);
    oscillator.onended = () => void context.close();
  } catch {
    /* Audio is a nicety; a blocked AudioContext must not break the timer. */
  }
}

function AmbientControl() {
  const [playing, setPlaying] = useState(false);
  const audio = useRef<{ context: AudioContext; source: AudioBufferSourceNode; gain: GainNode } | null>(null);

  useEffect(
    () => () => {
      audio.current?.source.stop();
      void audio.current?.context.close();
    },
    []
  );

  function toggle() {
    if (Platform.OS !== 'web') return;
    if (audio.current) {
      audio.current.source.stop();
      void audio.current.context.close();
      audio.current = null;
      setPlaying(false);
      return;
    }

    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    const context = new Context();
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let index = 0; index < data.length; index += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[index] = last * 2.8;
    }
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = true;
    gain.gain.value = 0.12;
    source.connect(gain).connect(context.destination);
    source.start();
    audio.current = { context, source, gain };
    setPlaying(true);
  }

  return (
    <Card className="mb-6 flex-row items-center gap-3">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-sand">
        <Icon name={playing ? 'volume-2' : 'volume-x'} size={17} tone="ink" />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-ink">Ambient focus audio</Text>
        <Text className="text-xs text-muted">Soft brown noise generated on your device.</Text>
      </View>
      <Button
        label={playing ? 'Turn off' : 'Play'}
        icon={playing ? 'volume-x' : 'volume-2'}
        variant="secondary"
        size="sm"
        onPress={toggle}
      />
    </Card>
  );
}
