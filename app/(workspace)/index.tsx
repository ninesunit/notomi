import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { orderBy, query } from 'firebase/firestore';
import { ImportReview } from '@/components/ImportReview';
import { LogComposer } from '@/components/LectureLog';
import { ScreenScroll } from '@/components/ScreenScroll';
import { defaultScope, filterByTerm } from '@/components/TermFilter';
import { FadeIn, Reveal } from '@/components/motion';
import { Button, Card, Loading, Notice, PageHeader } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { useIngest } from '@/hooks/useIngest';
import { useScheduleImport } from '@/hooks/useScheduleImport';
import { bucketFor, formatDue, toDate } from '@/lib/dates';
import { paths } from '@/lib/paths';
import {
  calculateGpa,
  minutesToLabel,
  todayIndex,
  type ClassBlock,
  type Semester,
  type Subject,
  type Todo,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { academicClasses, classesForDay } from '@/services/timetable';

/**
 * The dashboard.
 *
 * Three things, in the order a student needs them: the two AI engines that set
 * the app up, what is happening today, and how the term is going. Everything
 * else — the subject grid, the program map, the metric row, the reminder
 * settings — moved to the screen that owns it. A dashboard that repeats every
 * other screen is a table of contents, and nobody reads those twice.
 */
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
  const semesters = useCollection<Semester>(
    query(paths.semesters(db, uid), orderBy('order', 'asc')),
    [uid]
  );

  const { start } = useIngest();
  const importer = useScheduleImport(subjects.data);

  const scope = useMemo(
    () => defaultScope(subjects.data, semesters.data),
    [subjects.data, semesters.data]
  );

  /** The subjects a student is actually taking now. */
  const currentSubjects = useMemo(
    () => filterByTerm(subjects.data, scope, semesters.data),
    [subjects.data, scope, semesters.data]
  );

  /**
   * Only classes tied to a live subject in the current term. A block whose
   * subject was deleted is not a real class, and neither is last semester's
   * Monday lecture.
   */
  const liveClasses = useMemo(
    () => academicClasses(classes.data, currentSubjects),
    [classes.data, currentSubjects]
  );

  const open = useMemo(() => todos.data.filter((todo) => !todo.isCompleted), [todos.data]);
  const firstName = (user?.displayName || '').split(' ')[0];
  const setUp = subjects.data.length > 0 || classes.data.length > 0;

  return (
    <ScreenScroll>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
        subtitle={
          setUp
            ? 'Here is your day. Everything else is one tap away in the menu.'
            : 'Two uploads and Notomi builds your semester — timetable, subject folders and deadlines.'
        }
      />

      {subjects.error ? (
        <View className="mb-6">
          <Notice
            title="Could not load your library"
            body={`${subjects.error.message} — if this mentions permissions, deploy firestore.rules.`}
          />
        </View>
      ) : null}

      <Engines
        scanning={importer.scanning}
        onScan={() => void importer.scan()}
        onUpload={() => void start()}
        error={importer.error}
        notice={importer.notice}
      />

      <UpNextToday
        classes={liveClasses}
        todos={open}
        loading={classes.loading || todos.loading}
        configured={setUp}
      />

      {currentSubjects.length > 0 ? (
        <QuickLog uid={uid} subjects={currentSubjects} classes={liveClasses} />
      ) : null}

      <TermProgress
        subjects={currentSubjects}
        semesters={semesters.data}
        scope={scope}
        classes={liveClasses}
      />

      {importer.staged ? (
        <ImportReview
          uid={uid}
          rows={importer.staged.rows}
          skipped={importer.staged.skipped}
          semesters={semesters.data}
          onClose={() => importer.setStaged(null)}
          onDone={importer.describe}
        />
      ) : null}
    </ScreenScroll>
  );
}

/* ------------------------------------------------------------------ *
 * The engines
 * ------------------------------------------------------------------ */

/**
 * The two things that do the work.
 *
 * Given the top of the screen because they are what makes Notomi worth
 * installing: one screenshot builds the timetable, the library and the program
 * map at once, and one syllabus fills the calendar. Everything else in the app
 * is downstream of these two buttons.
 */
function Engines({
  scanning,
  onScan,
  onUpload,
  error,
  notice,
}: {
  scanning: boolean;
  onScan: () => void;
  onUpload: () => void;
  error: string | null;
  notice: string | null;
}) {
  return (
    <View className="mb-9 gap-3">
      <View className="flex-row flex-wrap gap-3">
        <EngineCard
          index={0}
          emoji="📸"
          title="Scan schedule"
          body="Upload a screenshot of your weekly timetable. Gemini reads it, you check it, and it builds your subjects, classes and program in one go."
          action={scanning ? 'Reading your schedule…' : 'Start with a screenshot'}
          icon="camera"
          busy={scanning}
          tint="#B4552D"
          onPress={onScan}
        />
        <EngineCard
          index={1}
          emoji="📄"
          title="Upload syllabus"
          body="Drop in a course outline or lecture slides. Notomi reads them on your device, then pulls out the topics, key dates and deadlines."
          action="Choose a document"
          icon="upload-cloud"
          tint="#4C5FA8"
          onPress={onUpload}
        />
      </View>

      {error ? <Notice title="Could not read that timetable" body={error} /> : null}
      {notice ? <Notice tone="pine" title="Your semester is set up" body={notice} /> : null}
    </View>
  );
}

function EngineCard({
  index,
  emoji,
  title,
  body,
  action,
  icon,
  tint,
  busy = false,
  onPress,
}: {
  index: number;
  emoji: string;
  title: string;
  body: string;
  action: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  tint: string;
  busy?: boolean;
  onPress: () => void;
}) {
  return (
    <View className="flex-1 grow" style={{ minWidth: 250, flexBasis: 250 }}>
      <FadeIn index={index}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={{ busy }}
          onPress={onPress}
          disabled={busy}
          className="h-full gap-3 overflow-hidden rounded-2xl border p-5"
          style={{ backgroundColor: `${tint}12`, borderColor: `${tint}3D` }}
        >
          <View className="flex-row items-center gap-3">
            <View
              className="h-11 w-11 items-center justify-center rounded-xl"
              style={{ backgroundColor: `${tint}24` }}
            >
              <Text className="text-xl">{emoji}</Text>
            </View>
            <Text className="flex-1 text-[17px] font-bold leading-6 text-ink">{title}</Text>
          </View>

          <Text className="text-[13px] leading-5 text-ink/70">{body}</Text>

          <View className="mt-auto flex-row items-center gap-2 pt-1">
            <Feather name={busy ? 'loader' : icon} size={14} color={tint} />
            <Text className="text-[13px] font-semibold" style={{ color: tint }}>
              {action}
            </Text>
          </View>
        </Pressable>
      </FadeIn>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Up next today
 * ------------------------------------------------------------------ */

type Entry =
  | { kind: 'class'; at: number; block: ClassBlock }
  | { kind: 'task'; at: number; todo: Todo; overdue: boolean };

/**
 * What is left of today, classes and deadlines interleaved.
 *
 * Interleaved rather than two lists because the question is "what is next", not
 * "what kind of thing is next". Anything already finished drops off: a feed
 * still showing this morning's lecture at four in the afternoon is a timetable,
 * and there is a whole screen for that.
 */
function UpNextToday({
  classes,
  todos,
  loading,
  configured,
}: {
  classes: ClassBlock[];
  todos: Todo[];
  loading: boolean;
  configured: boolean;
}) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const today = todayIndex();

  const entries = useMemo(() => {
    const rows: Entry[] = classesForDay(classes, today)
      .filter((block) => block.endMinute > nowMinutes)
      .map((block) => ({ kind: 'class' as const, at: block.startMinute, block }));

    for (const todo of todos) {
      const due = toDate(todo.dueDate);
      if (!due) continue;
      const bucket = bucketFor(due, now);
      if (bucket !== 'today' && bucket !== 'overdue') continue;
      rows.push({
        kind: 'task',
        // An overdue task sorts to the top of the day, where it belongs.
        at: bucket === 'overdue' ? -1 : due.getHours() * 60 + due.getMinutes(),
        todo,
        overdue: bucket === 'overdue',
      });
    }

    return rows.sort((a, b) => a.at - b.at).slice(0, 6);
    // `now` is derived from render time; the other four are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classes, todos, today, nowMinutes]);

  return (
    <View className="mb-9 gap-3">
      <View className="flex-row items-center justify-between">
        <Text className="text-lg font-semibold tracking-tight text-ink">Up next today</Text>
        <Link href="/timetable" asChild>
          <Button label="Timetable" variant="ghost" size="sm" />
        </Link>
      </View>

      {loading ? (
        <Loading label="Checking your day…" />
      ) : entries.length === 0 ? (
        <Card className="gap-1">
          <Text className="text-[15px] font-semibold text-ink">
            {configured ? 'Nothing left today 🎉' : 'Nothing scheduled yet'}
          </Text>
          <Text className="text-sm leading-5 text-muted">
            {configured
              ? 'No more classes and no deadlines due. A good moment for a focus block.'
              : 'Scan your schedule above and today’s classes will appear here automatically.'}
          </Text>
        </Card>
      ) : (
        <Card className="gap-0 p-0">
          {entries.map((entry, index) =>
            entry.kind === 'class' ? (
              <ClassRow
                key={`class-${entry.block.id}`}
                block={entry.block}
                nowMinutes={nowMinutes}
                first={index === 0}
              />
            ) : (
              <TaskRow key={`task-${entry.todo.id}`} entry={entry} first={index === 0} />
            )
          )}
        </Card>
      )}
    </View>
  );
}

function ClassRow({
  block,
  nowMinutes,
  first,
}: {
  block: ClassBlock;
  nowMinutes: number;
  first: boolean;
}) {
  const live = block.startMinute <= nowMinutes && block.endMinute > nowMinutes;
  const away = block.startMinute - nowMinutes;

  const body = (
    <View
      className={`flex-row items-center gap-3.5 px-5 py-4 ${first ? '' : 'border-t border-line'}`}
    >
      <View className="h-10 w-1 rounded-full" style={{ backgroundColor: block.color }} />

      <View className="flex-1 gap-0.5">
        <Text className="text-[15px] font-semibold text-ink" numberOfLines={1}>
          {block.subjectName || block.title}
        </Text>
        <Text className="text-xs text-muted" numberOfLines={1}>
          {[
            `${minutesToLabel(block.startMinute)}–${minutesToLabel(block.endMinute)}`,
            block.venue,
            block.kind,
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </Text>
      </View>

      {live ? (
        <View className="rounded-full bg-accent px-2 py-1">
          <Text className="text-[10px] font-bold uppercase tracking-wider text-paper">Now</Text>
        </View>
      ) : (
        <Text className="text-[13px] font-semibold text-muted">
          {away < 60 ? `in ${away} min` : minutesToLabel(block.startMinute)}
        </Text>
      )}
    </View>
  );

  if (!block.subjectId) return body;

  return (
    <Link href={`/library/${block.subjectId}`} asChild>
      <Pressable accessibilityRole="link" accessibilityLabel={`Open ${block.title}`}>
        {body}
      </Pressable>
    </Link>
  );
}

function TaskRow({ entry, first }: { entry: Extract<Entry, { kind: 'task' }>; first: boolean }) {
  const due = toDate(entry.todo.dueDate);

  return (
    <Link href="/todos" asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open ${entry.todo.title}`}
        className={`flex-row items-center gap-3.5 px-5 py-4 ${first ? '' : 'border-t border-line'}`}
      >
        <View
          className={`h-8 w-8 items-center justify-center rounded-lg ${
            entry.overdue ? 'bg-rose-soft' : 'bg-sand'
          }`}
        >
          <Feather
            name={entry.overdue ? 'alert-circle' : 'check-square'}
            size={14}
            color={entry.overdue ? '#B0443E' : '#6F6A5F'}
          />
        </View>

        <View className="flex-1 gap-0.5">
          <Text className="text-[15px] font-medium text-ink" numberOfLines={1}>
            {entry.todo.title}
          </Text>
          {entry.todo.subjectName ? (
            <Text className="text-xs text-subtle" numberOfLines={1}>
              {entry.todo.subjectName}
            </Text>
          ) : null}
        </View>

        <Text className={`text-[13px] font-semibold ${entry.overdue ? 'text-rose' : 'text-muted'}`}>
          {formatDue(due)}
        </Text>
      </Pressable>
    </Link>
  );
}

/* ------------------------------------------------------------------ *
 * Quick lecture log
 * ------------------------------------------------------------------ */

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
  const active =
    subjects.find((subject) => subject.id === (subjectId ?? suggestedId)) ?? subjects[0];
  const [open, setOpen] = useState(false);

  if (!active) return null;

  return (
    <View className="mb-9 gap-3">
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
            {open ? `Writing up ${active.name}` : 'Say what you covered and Gemini writes the notes'}
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

/* ------------------------------------------------------------------ *
 * Term progress
 * ------------------------------------------------------------------ */

/**
 * One bar, three numbers.
 *
 * Progress is measured in graded credits rather than in weeks elapsed: Notomi
 * does not know a university's term dates, and inventing them would be worse
 * than measuring something true.
 */
function TermProgress({
  subjects,
  semesters,
  scope,
  classes,
}: {
  subjects: Subject[];
  semesters: Semester[];
  scope: string;
  classes: ClassBlock[];
}) {
  const termName =
    semesters.find((semester) => semester.id === scope)?.name ??
    (semesters.find((semester) => semester.isCurrent)?.name || 'This term');

  const credits = subjects.reduce((total, subject) => total + (subject.creditHours ?? 0), 0);
  const graded = subjects.filter((subject) => subject.grade);
  const gradedCredits = graded.reduce((total, subject) => total + (subject.creditHours ?? 0), 0);
  const { gpa } = calculateGpa(
    subjects.map((subject) => ({ creditHours: subject.creditHours, grade: subject.grade }))
  );

  const hoursAWeek = classes.reduce(
    (total, block) => total + (block.endMinute - block.startMinute) / 60,
    0
  );

  if (subjects.length === 0) return null;

  const fraction = credits > 0 ? gradedCredits / credits : 0;

  return (
    <Link href="/program" asChild>
      <Pressable accessibilityRole="link" accessibilityLabel="Open your program structure">
        <Card className="gap-3">
          <View className="flex-row items-end justify-between">
            <View className="flex-1">
              <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                {termName}
              </Text>
              <Text className="mt-1 text-[15px] font-semibold text-ink">
                {subjects.length} {subjects.length === 1 ? 'subject' : 'subjects'}
                {credits > 0 ? ` · ${credits} credits` : ''}
              </Text>
            </View>
            <Feather name="chevron-right" size={16} color="#9A9488" />
          </View>

          <View className="h-2 w-full overflow-hidden rounded-full bg-sand">
            <View
              className="h-full rounded-full bg-pine"
              style={{ width: `${Math.round(fraction * 100)}%` }}
            />
          </View>

          <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
            <Text className="text-xs text-muted">
              {graded.length} of {subjects.length} graded
            </Text>
            {hoursAWeek > 0 ? (
              <Text className="text-xs text-muted">{Math.round(hoursAWeek)} h of class a week</Text>
            ) : null}
            {gpa !== null ? (
              <Text className="text-xs font-semibold text-pine">GPA {gpa.toFixed(2)}</Text>
            ) : null}
          </View>
        </Card>
      </Pressable>
    </Link>
  );
}
