import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { orderBy, query } from 'firebase/firestore';
import { useCollection } from '@/hooks/useFirestore';
import { formatDateTime } from '@/lib/dates';
import { paths } from '@/lib/paths';
import { feedback } from '@/lib/sound';
import type { LectureLog } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import {
  askDuringClass,
  deleteLecture,
  groupByTopic,
  logLecture,
  regenerateLecture,
} from '@/services/lectureLog';
import { Markdown } from './Markdown';
import { FadeIn, Reveal } from './motion';
import { Badge, Button, Card, EmptyState, IconButton, Loading, Notice } from './ui';

/**
 * The lecture log for one subject.
 *
 * Two things happen here, and they are deliberately the same box: a student
 * either says what a class covered, or asks the question they did not want to
 * raise a hand for. Both are one sentence typed on a phone during or just after
 * a lecture, so the composer is the first thing on the panel and everything
 * else is history below it.
 */
export function LectureLogPanel({
  uid,
  subjectId,
  subjectName,
}: {
  uid: string;
  subjectId: string;
  subjectName: string;
}) {
  const db = getDb();
  const logs = useCollection<LectureLog>(
    query(paths.lectures(db, uid, subjectId), orderBy('createdAt', 'desc')),
    [uid, subjectId]
  );

  const grouped = useMemo(() => groupByTopic(logs.data), [logs.data]);
  const lastTopic = logs.data[0]?.topic ?? null;

  return (
    <View className="gap-6">
      <LogComposer
        uid={uid}
        subjectId={subjectId}
        subjectName={subjectName}
        currentTopic={lastTopic}
      />

      {logs.loading ? (
        <Loading label="Loading your log…" />
      ) : logs.data.length === 0 ? (
        <EmptyState
          icon="book-open"
          title="No classes logged yet"
          body="After a lecture, write one line — “did topic 4, reached 4.2”. Notomi writes the notes for exactly that range from your uploaded material, and files them under the topic."
        />
      ) : (
        <View className="gap-7">
          {grouped.map(([topic, entries]) => (
            <View key={topic} className="gap-3">
              <View className="flex-row items-center gap-2">
                <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                  {topic}
                </Text>
                <View className="h-px flex-1 bg-line" />
                <Text className="text-xs text-subtle">{entries.length}</Text>
              </View>

              {entries.map((log, index) => (
                <FadeIn key={log.id} index={index}>
                  <LogEntry uid={uid} subjectId={subjectId} log={log} />
                </FadeIn>
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Composer
 * ------------------------------------------------------------------ */

type Mode = 'log' | 'ask';

export function LogComposer({
  uid,
  subjectId,
  subjectName,
  currentTopic,
  /** Compact enough for the dashboard, where it sits inside another card. */
  dense = false,
  onLogged,
}: {
  uid: string;
  subjectId: string;
  subjectName: string;
  currentTopic?: string | null;
  dense?: boolean;
  onLogged?: () => void;
}) {
  const [mode, setMode] = useState<Mode>('log');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value || busy) return;

    setBusy(true);
    setError(null);
    setAnswer(null);
    setDone(null);

    try {
      if (mode === 'ask') {
        const reply = await askDuringClass(uid, {
          subjectId,
          subjectName,
          question: value,
          topic: currentTopic,
        });
        setAnswer(reply);
        feedback('sent');
      } else {
        const result = await logLecture(uid, { subjectId, subjectName, entry: value });
        if (result.error) setError(result.error);
        else {
          setDone('Logged and written up.');
          feedback('complete');
        }
        setText('');
        onLogged?.();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      feedback('error');
    } finally {
      setBusy(false);
    }
  }, [busy, currentTopic, mode, onLogged, subjectId, subjectName, text, uid]);

  return (
    <Card className={dense ? 'gap-3 p-4' : 'gap-3.5'}>
      <View className="flex-row items-center gap-2">
        {(
          [
            { id: 'log' as const, label: 'Log a class', icon: 'edit-3' as const },
            { id: 'ask' as const, label: 'Ask in class', icon: 'help-circle' as const },
          ]
        ).map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === option.id }}
            onPress={() => {
              feedback('toggle');
              setMode(option.id);
              setAnswer(null);
              setDone(null);
            }}
            className={`flex-row items-center gap-1.5 rounded-full px-3 py-1.5 ${
              mode === option.id ? 'bg-ink' : 'bg-sand'
            }`}
          >
            <Icon
              name={option.icon}
              size={12}
              color={mode === option.id ? '#F7F5EE' : '#6F6A5F'}
            />
            <Text
              className={`text-xs font-semibold ${
                mode === option.id ? 'text-paper' : 'text-muted'
              }`}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        editable={!busy}
        placeholder={
          mode === 'log'
            ? 'Today we did topic 4 and reached 4.2 — normalisation up to 3NF.'
            : 'Why does 3NF still allow redundancy?'
        }
        placeholderTextColor="#9A9488"
        className="min-h-[76px] rounded-xl border border-line bg-paper px-4 py-3 text-[15px] leading-6 text-ink"
        style={{ textAlignVertical: 'top' }}
      />

      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-xs leading-4 text-subtle">
          {mode === 'log'
            ? 'Written up from this subject’s material, filed under the topic.'
            : 'Answered from your own slides and notes — no need to interrupt.'}
        </Text>
        <Button
          label={busy ? (mode === 'log' ? 'Writing…' : 'Thinking…') : mode === 'log' ? 'Log it' : 'Ask'}
          icon={mode === 'log' ? 'check' : 'send'}
          size="sm"
          loading={busy}
          disabled={!text.trim() || busy}
          onPress={() => void submit()}
        />
      </View>

      {done ? <Notice tone="pine" title={done} /> : null}
      {error ? <Notice title="That could not be written up" body={error} /> : null}

      <Reveal open={answer !== null}>
        {answer ? (
          <View className="gap-2 rounded-xl border border-line bg-paper p-4">
            <View className="flex-row items-center gap-2">
              <Icon name="zap" size={12} color="#B4552D" />
              <Text className="text-xs font-bold uppercase tracking-wider text-accent">Answer</Text>
            </View>
            <Markdown source={answer} />
            <Text className="text-[11px] leading-4 text-subtle">
              Grounded in this subject’s uploaded material. Check it against what the lecturer says.
            </Text>
          </View>
        ) : null}
      </Reveal>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * One logged class
 * ------------------------------------------------------------------ */

function LogEntry({
  uid,
  subjectId,
  log,
}: {
  uid: string;
  subjectId: string;
  log: LectureLog;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = !log.notes;

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      await regenerateLecture(uid, subjectId, log);
      feedback('success');
      setOpen(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      feedback('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? 'Collapse' : 'Expand'} ${log.title}`}
        onPress={() => {
          feedback('tap');
          setOpen((value) => !value);
        }}
        className="flex-row items-start gap-3"
      >
        <View className="mt-0.5 h-9 w-9 items-center justify-center rounded-lg bg-sand">
          <Icon name="book-open" size={15} color="#6F6A5F" />
        </View>

        <View className="flex-1 gap-1">
          <Text className="text-[15px] font-semibold leading-5 text-ink">{log.title}</Text>
          <Text className="text-xs text-subtle">
            {[formatDateTime(log.createdAt), log.reachedSection ? `up to ${log.reachedSection}` : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>

        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color="#9A9488" />
      </Pressable>

      {pending ? (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" color="#B4552D" />
          <Text className="text-xs text-subtle">Notes are still being written…</Text>
        </View>
      ) : null}

      {!open && log.keyPoints.length > 0 ? (
        <Text className="text-sm leading-5 text-ink/70" numberOfLines={2}>
          {log.keyPoints[0]}
        </Text>
      ) : null}

      <Reveal open={open}>
        <View className="gap-4 border-t border-line pt-4">
          <View className="gap-1.5">
            <Text className="text-xs font-bold uppercase tracking-wider text-muted">
              What you wrote
            </Text>
            <Text className="text-sm leading-5 text-ink/75">{log.entry}</Text>
          </View>

          {log.keyPoints.length > 0 ? (
            <View className="gap-2">
              <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                Key points
              </Text>
              {log.keyPoints.map((point) => (
                <View key={point} className="flex-row gap-2">
                  <Text className="text-sm text-accent">•</Text>
                  <Text className="flex-1 text-sm leading-5 text-ink">{point}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {log.notes ? (
            <View className="gap-2">
              <Text className="text-xs font-bold uppercase tracking-wider text-muted">Rundown</Text>
              <Markdown source={log.notes} />
            </View>
          ) : null}

          {log.followUps.length > 0 ? (
            <View className="gap-2 rounded-xl bg-amber-soft p-3.5">
              <Text className="text-xs font-bold uppercase tracking-wider text-amber">
                Before the next class
              </Text>
              {log.followUps.map((item) => (
                <View key={item} className="flex-row gap-2">
                  <Icon name="arrow-right" size={13} color="#B4832A" style={{ marginTop: 3 }} />
                  <Text className="flex-1 text-sm leading-5 text-ink">{item}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {error ? <Notice title="Could not rewrite that" body={error} /> : null}

          <View className="flex-row items-center gap-2">
            {log.reachedSection ? <Badge label={`Reached ${log.reachedSection}`} tone="accent" /> : null}
            <View className="flex-1" />
            <Button
              label={busy ? 'Rewriting…' : 'Rewrite notes'}
              icon="refresh-cw"
              variant="ghost"
              size="sm"
              loading={busy}
              disabled={busy}
              onPress={() => void regenerate()}
            />
            <IconButton
              icon="trash-2"
              tone="rose"
              label={`Delete ${log.title}`}
              onPress={() => void deleteLecture(uid, subjectId, log.id)}
            />
          </View>
        </View>
      </Reveal>
    </Card>
  );
}
