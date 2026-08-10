import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { orderBy, query } from 'firebase/firestore';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Badge, Button, Card, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { StudySession, Subject } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { formatMinutes, logSession, summarizeStreak } from '@/services/sessions';

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
  const uid = useUid();
  const db = getDb();

  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);
  const sessions = useCollection<StudySession>(
    query(paths.sessions(db, uid), orderBy('createdAt', 'desc')),
    [uid]
  );

  const [phase, setPhase] = useState<Phase>('focus');
  const [running, setRunning] = useState(false);
  const [remaining, setRemaining] = useState(LENGTHS.focus);
  const [completed, setCompleted] = useState(0);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justLogged, setJustLogged] = useState<number | null>(null);

  /** Wall-clock instant the current phase ends; null whenever paused. */
  const deadline = useRef<number | null>(null);

  const total = phase === 'break' && completed % CYCLES_TO_LONG_BREAK === 0 && completed > 0
    ? LONG_BREAK
    : LENGTHS[phase];

  const subject = subjects.data.find((candidate) => candidate.id === subjectId) ?? null;
  const streak = useMemo(() => summarizeStreak(sessions.data), [sessions.data]);

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
        });
        setJustLogged(minutes);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [phase, subject, uid]
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
      chime();
    },
    [completed, finish, phase]
  );

  useEffect(() => {
    if (!running) return;

    const tick = () => {
      if (deadline.current === null) return;
      const left = Math.round((deadline.current - Date.now()) / 1000);
      if (left <= 0) {
        setRemaining(0);
        advance(total);
        return;
      }
      setRemaining(left);
    };

    const id = setInterval(tick, 250);
    tick();
    return () => clearInterval(id);
  }, [running, advance, total]);

  function start() {
    setJustLogged(null);
    deadline.current = Date.now() + remaining * 1000;
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
    const elapsed = total - remaining;
    deadline.current = null;
    setRunning(false);
    if (phase === 'focus' && elapsed >= 60) void finish(elapsed);
    setRemaining(total);
  }

  function reset(next: Phase) {
    deadline.current = null;
    setRunning(false);
    setPhase(next);
    setRemaining(next === 'focus' ? LENGTHS.focus : LENGTHS.break);
  }

  const progress = total > 0 ? 1 - remaining / total : 0;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return (
    <ScreenScroll maxWidth={760}>
      <PageHeader
        title="Focus"
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
      </Card>

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
                  {candidate.emoji ? `${candidate.emoji} ` : ''}
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

function Metric({
  icon,
  value,
  label,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  value: string;
  label: string;
}) {
  return (
    <View
      className="flex-1 grow gap-2 rounded-2xl border border-line bg-surface p-4"
      style={{ minWidth: 150, flexBasis: 150 }}
    >
      <Feather name={icon} size={15} color="#9A9488" />
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
