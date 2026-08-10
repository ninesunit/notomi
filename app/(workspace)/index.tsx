import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { orderBy, query } from 'firebase/firestore';
import { CountdownChip } from '@/components/Countdown';
import { LogComposer } from '@/components/LectureLog';
import { ProgramMap } from '@/components/ProgramMap';
import { RemindersCard } from '@/components/Reminders';
import { CardGrid, GridItem, SubjectCard } from '@/components/SubjectCard';
import { ScreenScroll } from '@/components/ScreenScroll';
import { SubjectModal } from '@/components/SubjectModal';
import { defaultScope, filterByTerm } from '@/components/TermFilter';
import { UploadButton } from '@/components/UploadButton';
import { Reveal } from '@/components/motion';
import { Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { useIngest } from '@/hooks/useIngest';
import { bucketFor, countdown, formatDue, toDate } from '@/lib/dates';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import {
  minutesToLabel,
  todayIndex,
  type ClassBlock,
  type Semester,
  type StudySession,
  type Subject,
  type Todo,
} from '@/lib/schema';
import { summarizeStreak } from '@/services/sessions';
import { academicClasses, classesForDay } from '@/services/timetable';

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
  const semesters = useCollection<Semester>(
    query(paths.semesters(db, uid), orderBy('order', 'asc')),
    [uid]
  );

  const [editing, setEditing] = useState<Subject | null>(null);
  const { start } = useIngest();

  const open = useMemo(() => todos.data.filter((todo) => !todo.isCompleted), [todos.data]);

  const streak = useMemo(() => summarizeStreak(sessions.data), [sessions.data]);
  const today = todayIndex();

  /**
   * Only classes tied to a live subject in the current term. A stale block is
   * not a real class, and neither is last semester's Monday lecture.
   */
  const scope = useMemo(
    () => defaultScope(subjects.data, semesters.data),
    [subjects.data, semesters.data]
  );

  /** The subjects a student is actually taking now. */
  const currentSubjects = useMemo(
    () => filterByTerm(subjects.data, scope, semesters.data),
    [subjects.data, scope, semesters.data]
  );

  const liveClasses = useMemo(
    () => academicClasses(classes.data, currentSubjects),
    [classes.data, currentSubjects]
  );

  const scopeName =
    scope === 'all'
      ? null
      : (semesters.data.find((semester) => semester.id === scope)?.name ?? null);
  const todaysClasses = useMemo(() => classesForDay(liveClasses, today), [liveClasses, today]);
  const tomorrowsClasses = useMemo(
    () => classesForDay(liveClasses, (today + 1) % 7),
    [liveClasses, today]
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

      {/* The hero answers the question a student actually opens the app with:
          where do I need to be, and when. */}
      <ClassHero classes={todaysClasses} tomorrow={tomorrowsClasses} loading={classes.loading} />

      <MetricPills
        streak={streak.current}
        classesToday={todaysClasses.length}
        pending={open.length}
        overdue={overdueCount}
      />

      <QuickActions onUpload={() => void start()} />

      {/* The log sits high on the page on purpose: it is used walking out of a
          lecture theatre, and anything below the fold does not get used then. */}
      {currentSubjects.length > 0 ? (
        <QuickLog uid={uid} subjects={currentSubjects} classes={liveClasses} />
      ) : null}

      <RemindersCard />

      {nextExam?.due ? <ExamBanner title={nextExam.todo.title} due={nextExam.due} /> : null}

      {semesters.data.length > 0 ? (
        <View className="mb-8 gap-3">
          <View className="flex-row items-center justify-between">
            <Text className="text-lg font-semibold tracking-tight text-ink">Where you are</Text>
            <Link href="/program" asChild>
              <Button label="Full map" variant="ghost" size="sm" />
            </Link>
          </View>
          <ProgramMap
            compact
            semesters={semesters.data}
            subjects={subjects.data}
            classes={classes.data}
          />
        </View>
      ) : null}

      <View className="mb-6 flex-row items-center justify-between">
        <View className="flex-1">
          <Text className="text-lg font-semibold tracking-tight text-ink">
            {scopeName ? 'This term' : 'Your subjects'}
          </Text>
          {scopeName ? <Text className="text-xs text-muted">{scopeName}</Text> : null}
        </View>
        {subjects.data.length > 0 ? (
          <Link href="/library" asChild>
            <Button
              label={
                subjects.data.length > currentSubjects.length
                  ? `All ${subjects.data.length} subjects`
                  : 'View library'
              }
              variant="ghost"
              size="sm"
            />
          </Link>
        ) : null}
      </View>

      {subjects.loading ? (
        <Loading label="Loading your subjects…" />
      ) : currentSubjects.length === 0 ? (
        <EmptyState
          icon="upload-cloud"
          title={subjects.data.length > 0 ? 'Nothing filed under this term' : 'No subjects yet'}
          body={
            subjects.data.length > 0
              ? 'You have subjects on other terms. Assign them to this one in the program planner, or open the library to see everything.'
              : 'Upload a PDF or DOCX. Notomi reads it on your device, then Gemini names the subject, summarises it and extracts every deadline it can find.'
          }
          action={
            subjects.data.length > 0 ? (
              <Link href="/program" asChild>
                <Button label="Open the planner" variant="secondary" />
              </Link>
            ) : (
              <UploadButton label="Upload your first document" />
            )
          }
        />
      ) : (
        <CardGrid>
          {currentSubjects.map((subject, index) => (
            <GridItem key={subject.id} index={index}>
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
 * The hero: what is happening with classes right now.
 *
 * Three states, resolved against the wall clock — before the next class, inside
 * one, or finished for the day. Each says something different and offers a
 * different next step, which is the point: a card that always says the same
 * thing is a header, not a hero.
 */
function ClassHero({
  classes,
  tomorrow,
  loading,
}: {
  classes: ClassBlock[];
  tomorrow: ClassBlock[];
  loading: boolean;
}) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const inProgress = classes.find(
    (block) => block.startMinute <= nowMinutes && block.endMinute > nowMinutes
  );
  const next = classes.find((block) => block.startMinute > nowMinutes);

  if (loading) {
    return (
      <View className="mb-5 h-28 justify-center rounded-2xl border border-line bg-surface px-5">
        <Text className="text-sm text-muted">Checking your timetable…</Text>
      </View>
    );
  }

  if (classes.length === 0) {
    return (
      <Link href="/timetable" asChild>
        <Pressable
          accessibilityRole="link"
          className="mb-5 flex-row items-center gap-4 rounded-2xl border border-dashed border-line bg-surface p-5"
        >
          <Text className="text-2xl">🗓️</Text>
          <View className="flex-1 gap-0.5">
            <Text className="text-[15px] font-semibold text-ink">No classes today</Text>
            <Text className="text-[13px] text-muted">
              Scan a screenshot of your schedule to fill in your week.
            </Text>
          </View>
          <Feather name="chevron-right" size={16} color="#9A9488" />
        </Pressable>
      </Link>
    );
  }

  if (inProgress) {
    const remaining = inProgress.endMinute - nowMinutes;
    return (
      <View
        className="mb-5 overflow-hidden rounded-2xl border p-5"
        style={{ backgroundColor: `${inProgress.color}1A`, borderColor: `${inProgress.color}59` }}
      >
        <View className="flex-row items-center gap-2">
          <View className="h-2 w-2 rounded-full" style={{ backgroundColor: inProgress.color }} />
          <Text className="text-[11px] font-bold uppercase tracking-wider" style={{ color: inProgress.color }}>
            In class now
          </Text>
        </View>

        <Text className="mt-2 text-[22px] font-bold leading-7 text-ink" numberOfLines={2}>
          {inProgress.title}
        </Text>
        <Text className="mt-1 text-[13px] text-muted">
          {[
            `Ends at ${minutesToLabel(inProgress.endMinute)}`,
            `${remaining} min left`,
            inProgress.venue,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>

        {inProgress.subjectId ? (
          <View className="mt-4 flex-row">
            <Link href={`/library/${inProgress.subjectId}`} asChild>
              <Button label="View class notes" icon="book-open" size="sm" />
            </Link>
          </View>
        ) : null}
      </View>
    );
  }

  if (next) {
    const minutesAway = next.startMinute - nowMinutes;
    const soon = minutesAway <= 30;

    return (
      <View
        className="mb-5 overflow-hidden rounded-2xl border p-5"
        style={{ backgroundColor: `${next.color}14`, borderColor: `${next.color}40` }}
      >
        <Text className="text-[11px] font-bold uppercase tracking-wider" style={{ color: next.color }}>
          Next class
        </Text>

        <Text className="mt-2 text-[22px] font-bold leading-7 text-ink" numberOfLines={2}>
          {next.title}
        </Text>

        <View className="mt-1 flex-row flex-wrap items-center gap-2">
          <Text className={`text-[13px] font-semibold ${soon ? 'text-accent' : 'text-muted'}`}>
            {minutesAway < 60
              ? `in ${minutesAway} min`
              : `at ${minutesToLabel(next.startMinute)}`}
          </Text>
          {next.venue ? <Text className="text-[13px] text-muted">· {next.venue}</Text> : null}
          {next.kind ? <Text className="text-[13px] text-subtle">· {next.kind}</Text> : null}
        </View>

        {next.subjectId ? (
          <View className="mt-4 flex-row">
            <Link href={`/library/${next.subjectId}`} asChild>
              <Button label="View class notes" icon="book-open" size="sm" />
            </Link>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View className="mb-5 rounded-2xl border border-pine/25 bg-pine-soft p-5">
      <Text className="text-[22px] font-bold leading-7 text-ink">All done for today 🎉</Text>
      <Text className="mt-1 text-[13px] text-muted">
        {tomorrow.length === 0
          ? 'Nothing scheduled tomorrow either.'
          : `Tomorrow: ${tomorrow
              .slice(0, 3)
              .map((block) => `${block.title} at ${minutesToLabel(block.startMinute)}`)
              .join(', ')}${tomorrow.length > 3 ? ` and ${tomorrow.length - 3} more` : ''}.`}
      </Text>

      <View className="mt-4 flex-row flex-wrap gap-2">
        <Link href="/focus" asChild>
          <Button label="Start a focus block" icon="target" size="sm" />
        </Link>
        <Link href="/study" asChild>
          <Button label="Study" icon="zap" variant="secondary" size="sm" />
        </Link>
      </View>
    </View>
  );
}

/** One horizontal row of pills — denser than four stacked metric boxes. */
function MetricPills({
  streak,
  classesToday,
  pending,
  overdue,
}: {
  streak: number;
  classesToday: number;
  pending: number;
  overdue: number;
}) {
  return (
    <View className="mb-5 flex-row flex-wrap gap-2">
      <Pill href="/focus" emoji={streak > 0 ? '🔥' : '🌱'} value={streak} label="day streak" />
      <Pill href="/timetable" emoji="🗓️" value={classesToday} label="classes today" />
      <Pill href="/todos" emoji="✅" value={pending} label="tasks open" />
      {overdue > 0 ? (
        <Pill href="/todos" emoji="⚠️" value={overdue} label="overdue" tone="rose" />
      ) : null}
    </View>
  );
}

function Pill({
  href,
  emoji,
  value,
  label,
  tone = 'neutral',
}: {
  href: string;
  emoji: string;
  value: number;
  label: string;
  tone?: 'neutral' | 'rose';
}) {
  return (
    <Link href={href as never} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${value} ${label}`}
        className={`flex-row items-center gap-2 rounded-full border px-3.5 py-2 ${
          tone === 'rose' ? 'border-rose/30 bg-rose-soft' : 'border-line bg-surface'
        }`}
      >
        <Text className="text-sm">{emoji}</Text>
        <Text className={`text-sm font-bold ${tone === 'rose' ? 'text-rose' : 'text-ink'}`}>
          {value}
        </Text>
        <Text className="text-[13px] text-muted">{label}</Text>
      </Pressable>
    </Link>
  );
}

function QuickActions({ onUpload }: { onUpload: () => void }) {
  return (
    <View className="mb-8 flex-row flex-wrap gap-2">
      <Link href="/capture" asChild>
        <Button label="Capture" icon="camera" variant="secondary" size="sm" />
      </Link>
      <Link href="/timetable" asChild>
        <Button label="Scan schedule" icon="grid" variant="secondary" size="sm" />
      </Link>
      <Button
        label="Upload material"
        icon="upload-cloud"
        variant="secondary"
        size="sm"
        onPress={onUpload}
      />
      <Link href="/todos" asChild>
        <Button label="New task" icon="plus" variant="secondary" size="sm" />
      </Link>
    </View>
  );
}

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

/**
 * Log a class from the dashboard.
 *
 * The subject is guessed from the timetable — the class happening now, else the
 * last one that finished today — because the student has just walked out of it.
 * The guess is a chip row, not a hidden default: guessing wrong and filing a
 * lecture under the wrong subject is worse than one extra tap.
 */
function QuickLog({
  uid,
  subjects,
  classes,
}: {
  uid: string;
  subjects: Subject[];
  classes: ClassBlock[];
}) {
  const today = todayIndex();
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

  const suggestedId = useMemo(() => {
    const todays = classes
      .filter((block) => block.day === today && block.subjectId)
      .sort((a, b) => a.startMinute - b.startMinute);

    const current = todays.find(
      (block) => block.startMinute <= nowMinutes && block.endMinute > nowMinutes
    );
    if (current?.subjectId) return current.subjectId;

    const finished = [...todays].reverse().find((block) => block.endMinute <= nowMinutes);
    return finished?.subjectId ?? null;
  }, [classes, today, nowMinutes]);

  const [subjectId, setSubjectId] = useState<string | null>(null);
  const active = subjects.find((subject) => subject.id === (subjectId ?? suggestedId)) ?? subjects[0];
  const [open, setOpen] = useState(false);

  if (!active) return null;

  return (
    <View className="mb-8 gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="flex-row items-center gap-3 rounded-2xl border border-line bg-surface p-4"
      >
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-accent-soft">
          <Feather name="edit-3" size={15} color="#B4552D" />
        </View>
        <View className="flex-1">
          <Text className="text-[15px] font-semibold text-ink">Log a class</Text>
          <Text className="text-xs text-muted" numberOfLines={1}>
            {open
              ? `Writing up ${active.name}`
              : 'Say what you covered and Gemini writes the notes'}
          </Text>
        </View>
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={16} color="#9A9488" />
      </Pressable>

      <Reveal open={open}>
        <View className="gap-3">
          {subjects.length > 1 ? (
            <View className="flex-row flex-wrap gap-1.5">
              {subjects.map((subject) => {
                const selected = subject.id === active.id;
                return (
                  <Pressable
                    key={subject.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setSubjectId(subject.id)}
                    className={`rounded-lg border px-3 py-1.5 ${
                      selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
                    }`}
                  >
                    <Text
                      className={`text-xs font-medium ${selected ? 'text-accent' : 'text-muted'}`}
                    >
                      {subject.emoji ? `${subject.emoji} ` : ''}
                      {subject.moduleCode || subject.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <LogComposer
            key={active.id}
            dense
            uid={uid}
            subjectId={active.id}
            subjectName={active.name}
          />

          <Link href={`/library/${active.id}`} asChild>
            <Button label="Open the full log" icon="book-open" variant="ghost" size="sm" />
          </Link>
        </View>
      </Reveal>
    </View>
  );
}
