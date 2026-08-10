import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { orderBy, query } from 'firebase/firestore';
import { CountdownChip } from '@/components/Countdown';
import { CardGrid, GridItem, SubjectCard } from '@/components/SubjectCard';
import { ScreenScroll } from '@/components/ScreenScroll';
import { SubjectModal } from '@/components/SubjectModal';
import { UploadButton } from '@/components/UploadButton';
import { Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { bucketFor, countdown, formatDue, toDate } from '@/lib/dates';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import {
  DAY_FULL,
  minutesToLabel,
  todayIndex,
  type ClassBlock,
  type StudySession,
  type Subject,
  type Todo,
} from '@/lib/schema';
import { formatMinutes, summarizeStreak } from '@/services/sessions';
import { classesForDay } from '@/services/timetable';

export default function Dashboard() {
  const uid = useUid();
  const { user } = useAuth();
  const db = getDb();

  const subjects = useCollection<Subject>(
    query(paths.subjects(db, uid), orderBy('updatedAt', 'desc')),
    [uid]
  );

  /**
   * Ordered on a single field so Firestore serves this from the automatic
   * single-field index. Adding `where('isCompleted','==',false)` would demand a
   * composite index for no real benefit — a student's task list is small, and
   * the open/overdue split below is a cheap client-side pass.
   */
  const todos = useCollection<Todo>(query(paths.todos(db, uid), orderBy('dueDate', 'asc')), [uid]);
  const classes = useCollection<ClassBlock>(paths.classes(db, uid), [uid]);
  const sessions = useCollection<StudySession>(paths.sessions(db, uid), [uid]);

  const [editing, setEditing] = useState<Subject | null>(null);

  const open = useMemo(() => todos.data.filter((todo) => !todo.isCompleted), [todos.data]);

  const streak = useMemo(() => summarizeStreak(sessions.data), [sessions.data]);
  const today = todayIndex();
  const todaysClasses = useMemo(
    () => classesForDay(classes.data, today),
    [classes.data, today]
  );

  /**
   * The next exam or major assessment, which is what a student actually wants
   * counted down. A weekly reading with a date is not worth a banner.
   */
  const nextExam = useMemo(() => {
    const now = new Date();
    return open
      .map((todo) => ({ todo, due: toDate(todo.dueDate) }))
      .filter(
        ({ todo, due }) =>
          due !== null && due > now && /exam|final|midterm|test|paper/i.test(todo.title)
      )
      .sort((a, b) => (a.due?.getTime() ?? 0) - (b.due?.getTime() ?? 0))[0];
  }, [open]);

  const upcoming = useMemo(
    () =>
      open
        .map((todo) => ({ todo, due: toDate(todo.dueDate) }))
        .filter(({ due }) => due !== null)
        .slice(0, 5),
    [open]
  );

  const overdueCount = useMemo(
    () => open.filter((todo) => bucketFor(toDate(todo.dueDate)) === 'overdue').length,
    [open]
  );

  const sourceCount = useMemo(
    () => subjects.data.reduce((total, subject) => total + (subject.documentCount ?? 0), 0),
    [subjects.data]
  );

  const firstName = (user?.displayName || '').split(' ')[0];

  return (
    <ScreenScroll>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
        subtitle="Upload a syllabus or lecture and Notomi will file it, summarise it, and pull out your deadlines."
        actions={<UploadButton />}
      />

      {subjects.error ? (
        <View className="mb-6">
          <Notice
            title="Could not load your library"
            body={`${subjects.error.message} — if this mentions permissions, deploy firestore.rules.`}
          />
        </View>
      ) : null}

      {nextExam?.due ? <ExamBanner title={nextExam.todo.title} due={nextExam.due} /> : null}

      <View className="mb-6 flex-row flex-wrap gap-4">
        <View className="flex-1 grow" style={{ minWidth: 240, flexBasis: 240 }}>
          <StreakCard
            current={streak.current}
            longest={streak.longest}
            studiedToday={streak.studiedToday}
            minutesToday={streak.minutesToday}
          />
        </View>
        <View className="flex-1 grow" style={{ minWidth: 280, flexBasis: 280 }}>
          <TodayClasses classes={todaysClasses} day={today} loading={classes.loading} />
        </View>
      </View>

      <View className="mb-8 flex-row flex-wrap gap-3">
        <Stat icon="folder" value={subjects.data.length} label="Subjects" />
        <Stat icon="file-text" value={sourceCount} label="Sources" />
        <Stat icon="check-square" value={open.length} label="Open tasks" />
        <Stat
          icon="alert-circle"
          value={overdueCount}
          label="Overdue"
          tone={overdueCount > 0 ? 'rose' : 'neutral'}
        />
      </View>

      <View className="mb-6 flex-row items-center justify-between">
        <Text className="text-lg font-semibold tracking-tight text-ink">Your subjects</Text>
        {subjects.data.length > 0 ? (
          <Link href="/library" asChild>
            <Button label="View library" variant="ghost" size="sm" />
          </Link>
        ) : null}
      </View>

      {subjects.loading ? (
        <Loading label="Loading your subjects…" />
      ) : subjects.data.length === 0 ? (
        <EmptyState
          icon="upload-cloud"
          title="No subjects yet"
          body="Upload a PDF or DOCX. Notomi reads it on your device, then Gemini names the subject, summarises it and extracts every deadline it can find."
          action={<UploadButton label="Upload your first document" />}
        />
      ) : (
        <CardGrid>
          {subjects.data.map((subject) => (
            <GridItem key={subject.id}>
              <SubjectCard subject={subject} onEdit={() => setEditing(subject)} />
            </GridItem>
          ))}
        </CardGrid>
      )}

      <View className="mt-10 mb-6 flex-row items-center justify-between">
        <Text className="text-lg font-semibold tracking-tight text-ink">Coming up</Text>
        <Link href="/todos" asChild>
          <Button label="All to-dos" variant="ghost" size="sm" />
        </Link>
      </View>

      {upcoming.length === 0 ? (
        <Card className="items-start">
          <Text className="text-sm text-muted">
            Nothing scheduled. Deadlines found in an uploaded syllabus land here automatically.
          </Text>
        </Card>
      ) : (
        <Card className="gap-0 p-0">
          {upcoming.map(({ todo, due }, index) => {
            const bucket = bucketFor(due);
            return (
              <View
                key={todo.id}
                className={`flex-row items-center gap-3 px-5 py-3.5 ${
                  index > 0 ? 'border-t border-line' : ''
                }`}
              >
                <View
                  className={`h-2 w-2 rounded-full ${
                    bucket === 'overdue' ? 'bg-rose' : bucket === 'today' ? 'bg-accent' : 'bg-subtle'
                  }`}
                />
                <View className="flex-1 gap-0.5">
                  <Text className="text-[15px] font-medium text-ink" numberOfLines={1}>
                    {todo.title}
                  </Text>
                  {todo.subjectName ? (
                    <Text className="text-xs text-subtle" numberOfLines={1}>
                      {todo.subjectName}
                    </Text>
                  ) : null}
                </View>
                <Text
                  className={`text-[13px] font-medium ${
                    bucket === 'overdue' ? 'text-rose' : 'text-muted'
                  }`}
                >
                  {formatDue(due)}
                </Text>
              </View>
            );
          })}
        </Card>
      )}

      <SubjectModal
        uid={uid}
        subject={editing}
        visible={editing !== null}
        onClose={() => setEditing(null)}
      />
    </ScreenScroll>
  );
}

/* ------------------------------------------------------------------ *
 * Widgets
 * ------------------------------------------------------------------ */

/**
 * Exam countdown.
 *
 * Only shown when something exam-shaped is actually coming, and it leads the
 * page when it is — an exam in four days outranks everything else on screen.
 */
function ExamBanner({ title, due }: { title: string; due: Date }) {
  const remaining = countdown(due);
  const urgent = remaining !== null && remaining.days <= 7;

  return (
    <Link href="/todos" asChild>
      <Pressable
        accessibilityRole="link"
        className={`mb-6 flex-row items-center gap-4 overflow-hidden rounded-2xl border p-5 ${
          urgent ? 'border-rose/30 bg-rose-soft' : 'border-amber/25 bg-amber-soft'
        }`}
      >
        <View
          className={`h-11 w-11 items-center justify-center rounded-xl ${
            urgent ? 'bg-rose/15' : 'bg-amber/15'
          }`}
        >
          <Feather name="alert-circle" size={19} color={urgent ? '#B0443E' : '#B4832A'} />
        </View>

        <View className="flex-1 gap-1">
          <Text className="text-[11px] font-bold uppercase tracking-wider text-muted">
            Next assessment
          </Text>
          <Text className="text-[15px] font-semibold text-ink" numberOfLines={1}>
            {title}
          </Text>
          <Text className="text-xs text-muted">{formatDue(due)}</Text>
        </View>

        <CountdownChip due={due} />
      </Pressable>
    </Link>
  );
}

function StreakCard({
  current,
  longest,
  studiedToday,
  minutesToday,
}: {
  current: number;
  longest: number;
  studiedToday: boolean;
  minutesToday: number;
}) {
  return (
    <Link href="/focus" asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${current} day study streak`}
        className="h-full gap-3 rounded-2xl border border-line bg-accent-soft/50 p-5"
      >
        <View className="flex-row items-center gap-2">
          <Text className="text-2xl">{current > 0 ? '🔥' : '🌱'}</Text>
          <Text className="text-[11px] font-bold uppercase tracking-wider text-muted">
            Study streak
          </Text>
        </View>

        <Text className="text-[32px] font-bold leading-9 text-ink">
          {current} <Text className="text-base font-semibold text-muted">day{current === 1 ? '' : 's'}</Text>
        </Text>

        <Text className="text-[13px] leading-5 text-muted">
          {studiedToday
            ? `${formatMinutes(minutesToday)} today${longest > current ? ` · best run ${longest} days` : ' · keep it going'}`
            : current > 0
              ? 'Study today to keep the run alive.'
              : 'Finish a focus block to start a streak.'}
        </Text>
      </Pressable>
    </Link>
  );
}

/**
 * Today's classes, straight off the timetable. A student's first question in
 * the morning is "where do I have to be", and it should not need a click.
 */
function TodayClasses({
  classes,
  day,
  loading,
}: {
  classes: ClassBlock[];
  day: number;
  loading: boolean;
}) {
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

  return (
    <View className="h-full gap-3 rounded-2xl border border-line bg-surface p-5">
      <View className="flex-row items-center justify-between">
        <Text className="text-[11px] font-bold uppercase tracking-wider text-muted">
          {DAY_FULL[day]}
        </Text>
        <Link href="/timetable" asChild>
          <Pressable accessibilityRole="link" hitSlop={6}>
            <Text className="text-xs font-medium text-accent">Timetable</Text>
          </Pressable>
        </Link>
      </View>

      {loading ? (
        <Text className="text-sm text-muted">Loading…</Text>
      ) : classes.length === 0 ? (
        <View className="flex-1 justify-center gap-1 py-2">
          <Text className="text-sm text-muted">No classes today.</Text>
          <Text className="text-xs text-subtle">
            Scan a screenshot of your schedule to fill this in.
          </Text>
        </View>
      ) : (
        <View className="gap-2">
          {classes.slice(0, 4).map((block) => {
            const done = block.endMinute <= nowMinutes;
            const now = block.startMinute <= nowMinutes && block.endMinute > nowMinutes;

            return (
              <View key={block.id} className={`flex-row items-center gap-3 ${done ? 'opacity-45' : ''}`}>
                <View
                  className="h-8 w-1 rounded-full"
                  style={{ backgroundColor: block.color }}
                />
                <View className="flex-1">
                  <Text className="text-[13px] font-semibold text-ink" numberOfLines={1}>
                    {block.title}
                  </Text>
                  <Text className="text-[11px] text-subtle" numberOfLines={1}>
                    {[minutesToLabel(block.startMinute), block.venue].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                {now ? (
                  <View className="rounded-full bg-accent px-2 py-0.5">
                    <Text className="text-[10px] font-bold text-paper">NOW</Text>
                  </View>
                ) : null}
              </View>
            );
          })}

          {classes.length > 4 ? (
            <Text className="text-[11px] text-subtle">+{classes.length - 4} more today</Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

function Stat({
  icon,
  value,
  label,
  tone = 'neutral',
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  value: number;
  label: string;
  tone?: 'neutral' | 'rose';
}) {
  return (
    <View
      className="flex-1 grow gap-2 rounded-2xl border border-line bg-surface p-4"
      style={{ minWidth: 140, flexBasis: 140 }}
    >
      <Feather name={icon} size={15} color={tone === 'rose' ? '#B0443E' : '#9A9488'} />
      <Text className={`text-2xl font-bold ${tone === 'rose' ? 'text-rose' : 'text-ink'}`}>
        {value}
      </Text>
      <Text className="text-[13px] text-muted">{label}</Text>
    </View>
  );
}
