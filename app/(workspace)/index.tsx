import { useMemo, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Link } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { orderBy, query } from 'firebase/firestore';
import { ImportReview } from '@/components/ImportReview';
import { LogComposer } from '@/components/LectureLog';
import { ScreenScroll } from '@/components/ScreenScroll';
import { NowLine, WeekOverview } from '@/components/WeekOverview';
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
  todayIndex,
  type ClassBlock,
  type Semester,
  type Subject,
  type Todo,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { academicClasses, type ResolvedClass } from '@/services/timetable';

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

  const { width } = useWindowDimensions();
  /**
   * A phone that is already set up gets a one-line greeting instead of a page
   * header. The 28pt title and its subtitle are ninety points of chrome, and
   * ninety points is the difference between seeing your whole week and
   * scrolling for the end of it.
   */
  const compact = width < 560 && setUp;

  return (
    <ScreenScroll>
      {compact ? (
        <Text className="mb-4 text-[17px] font-semibold tracking-tight text-ink">
          {firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
        </Text>
      ) : (
        <PageHeader
          title={firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
          subtitle={
            setUp
              ? undefined
              : 'Two uploads and Notomi builds your semester — timetable, subject folders and deadlines.'
          }
        />
      )}

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

      <ThisWeek
        classes={liveClasses}
        todos={open}
        loading={classes.loading || todos.loading}
        configured={setUp}
        compact={compact}
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
  const { width } = useWindowDimensions();
  /**
   * Two tiles side by side on a phone, two full cards on anything wider.
   *
   * The explanatory paragraph is what a landing page needs; on a 393pt screen
   * it pushed the actual content of the app below the fold, which is the
   * opposite of what a home screen is for. The short form says the same thing
   * in the space a native app would give it.
   */
  const compact = width < 560;

  return (
    <View className="mb-5 gap-3">
      <View className="flex-row flex-wrap gap-3">
        <EngineCard
          index={0}
          compact={compact}
          emoji="📸"
          title="Scan schedule"
          caption="Your timetable from a screenshot"
          body="Upload a screenshot of your weekly timetable. Gemini reads it, you check it, and it builds your subjects, classes and program in one go."
          action={scanning ? 'Reading your schedule…' : 'Start with a screenshot'}
          icon="camera"
          busy={scanning}
          tint="#B4552D"
          onPress={onScan}
        />
        <EngineCard
          index={1}
          compact={compact}
          emoji="📄"
          title="Upload syllabus"
          caption="Deadlines and topics from a PDF"
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
  compact,
  emoji,
  title,
  caption,
  body,
  action,
  icon,
  tint,
  busy = false,
  onPress,
}: {
  index: number;
  compact: boolean;
  emoji: string;
  title: string;
  /** The one-line form, used where there is no room for the paragraph. */
  caption: string;
  body: string;
  action: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  tint: string;
  busy?: boolean;
  onPress: () => void;
}) {
  return (
    <View
      className="flex-1 grow"
      style={compact ? { flexBasis: 0, minWidth: 0 } : { minWidth: 250, flexBasis: 250 }}
    >
      <FadeIn index={index}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={{ busy }}
          onPress={onPress}
          disabled={busy}
          className={`h-full overflow-hidden rounded-2xl border ${
            compact ? 'gap-1.5 p-3.5' : 'gap-3 p-5'
          }`}
          style={{ backgroundColor: `${tint}12`, borderColor: `${tint}3D` }}
        >
          <View className="flex-row items-center gap-2">
            <View
              className={`items-center justify-center rounded-xl ${
                compact ? 'h-9 w-9' : 'h-11 w-11'
              }`}
              style={{ backgroundColor: `${tint}24` }}
            >
              <Text className={compact ? 'text-base' : 'text-xl'}>{emoji}</Text>
            </View>
            {compact ? (
              <Feather
                name={busy ? 'loader' : icon}
                size={13}
                color={tint}
                style={{ marginLeft: 'auto' }}
              />
            ) : null}
          </View>

          {compact ? (
            <>
              <Text className="text-[15px] font-bold leading-5 text-ink">{title}</Text>
              <Text className="text-[12px] leading-4 text-ink/70">
                {busy ? 'Reading your schedule…' : caption}
              </Text>
            </>
          ) : (
            <>
              <Text className="text-[17px] font-bold leading-6 text-ink">{title}</Text>
              <Text className="text-[13px] leading-5 text-ink/70">{body}</Text>
              <View className="mt-auto flex-row items-center gap-2 pt-1">
                <Feather name={busy ? 'loader' : icon} size={14} color={tint} />
                <Text className="text-[13px] font-semibold" style={{ color: tint }}>
                  {action}
                </Text>
              </View>
            </>
          )}
        </Pressable>
      </FadeIn>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Up next today
 * ------------------------------------------------------------------ */

type Entry = { todo: Todo; overdue: boolean };

/**
 * The week, plus whatever is due today.
 *
 * This replaced a list of today's classes, and the reason is that a student
 * opening the app on Sunday night wants to know what Monday looks like, not to
 * be told Sunday is empty. The whole week fits in the space the day list took,
 * with today highlighted and a single line saying what is on right now — so the
 * "what next" question is still answered without scrolling for it.
 */
function ThisWeek({
  classes,
  todos,
  loading,
  configured,
  compact,
}: {
  classes: ResolvedClass[];
  todos: Todo[];
  loading: boolean;
  configured: boolean;
  /** Drops the section heading; the week is self-evident and space is short. */
  compact: boolean;
}) {
  const now = new Date();

  const due = useMemo(() => {
    const rows: Entry[] = [];
    for (const todo of todos) {
      const date = toDate(todo.dueDate);
      if (!date) continue;
      const bucket = bucketFor(date, now);
      if (bucket !== 'today' && bucket !== 'overdue') continue;
      rows.push({ todo, overdue: bucket === 'overdue' });
    }
    // Overdue first: it is the one that changes what you do next.
    return rows.sort((a, b) => Number(b.overdue) - Number(a.overdue)).slice(0, 3);
    // `now` is derived from render time; todos is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todos]);

  return (
    <View className="mb-6 gap-2.5">
      {compact ? null : (
        <View className="flex-row items-center justify-between">
          <Text className="text-lg font-semibold tracking-tight text-ink">Your week</Text>
          <Link href="/timetable" asChild>
            <Button label="Timetable" variant="ghost" size="sm" />
          </Link>
        </View>
      )}

      {loading ? (
        <Loading label="Checking your week…" />
      ) : classes.length === 0 ? (
        <Card className="gap-1">
          <Text className="text-[15px] font-semibold text-ink">
            {configured ? 'No classes this term' : 'No timetable yet'}
          </Text>
          <Text className="text-sm leading-5 text-muted">
            {configured
              ? 'Switch term in the timetable, or scan this term’s schedule.'
              : 'Scan your schedule above and your whole week appears here.'}
          </Text>
        </Card>
      ) : (
        <>
          <NowLine classes={classes} />
          {/* The card is the link on a phone, where the heading that used to
              carry one has been dropped. */}
          <Link href="/timetable" asChild>
            <Pressable accessibilityRole="link" accessibilityLabel="Open your timetable">
              <WeekOverview classes={classes} />
            </Pressable>
          </Link>
        </>
      )}

      {due.length > 0 ? (
        <Card className="gap-0 p-0">
          {due.map((entry, index) => (
            <TaskRow key={entry.todo.id} entry={entry} first={index === 0} />
          ))}
        </Card>
      ) : null}
    </View>
  );
}

function TaskRow({ entry, first }: { entry: Entry; first: boolean }) {
  const due = toDate(entry.todo.dueDate);

  return (
    <Link href="/todos" asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open ${entry.todo.title}`}
        className={`flex-row items-center gap-3 px-4 py-3 ${first ? '' : 'border-t border-line'}`}
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
          <Text className="text-[14px] font-medium leading-5 text-ink" numberOfLines={2}>
            {entry.todo.title}
          </Text>
          {entry.todo.subjectName ? (
            <Text className="text-xs text-subtle" numberOfLines={1}>
              {entry.todo.subjectName}
            </Text>
          ) : null}
        </View>

        <Text
          className={`shrink-0 text-[13px] font-semibold ${
            entry.overdue ? 'text-rose' : 'text-muted'
          }`}
        >
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
    <View className="mb-6 gap-3">
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
