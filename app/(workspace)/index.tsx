import { useMemo, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Link } from 'expo-router';
import { Icon } from '@/components/Icon';
import { orderBy, query } from 'firebase/firestore';
import { FileDropZone } from '@/components/FileDropZone';
import { LogComposer } from '@/components/LectureLog';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import { CompactWeekGrid } from '@/components/CompactWeekGrid';
import { AgendaWeek } from '@/components/AgendaWeek';
import { DayFilter } from '@/components/DayFilter';
import { WeekStyleToggle } from '@/components/WeekStyleToggle';
import { useVisibleDays } from '@/hooks/useVisibleDays';
import { useWeekStyle } from '@/hooks/useWeekStyle';
import { defaultScope, filterByTerm } from '@/components/TermFilter';
import { Button, Card, Loading, Notice, PageHeader } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { useIngest } from '@/hooks/useIngest';
import { bucketFor, formatDue, isSameDay, toDate } from '@/lib/dates';
import { paths } from '@/lib/paths';
import {
  calculateGpa,
  DAY_FULL,
  minutesToLabel,
  todayIndex,
  type ClassBlock,
  type RoutineBlock,
  type Semester,
  type Subject,
  type Todo,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { academicClasses, type ResolvedClass } from '@/services/timetable';
import { buildBurnoutWeeks, findActiveSemester } from '@/services/academicPlanner';
import { weekDays, weekOf, weekRangeLabel } from '@/services/teachingPlan';
import { pickMaterials, type MaterialFile } from '@/services/ingestion';
import { subjectTint } from '@/lib/color';

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
  const routines = useCollection<RoutineBlock>(paths.routines(db, uid), [uid]);
  const semesters = useCollection<Semester>(
    query(paths.semesters(db, uid), orderBy('order', 'asc')),
    [uid]
  );

  const ingest = useIngest();

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
  const activeSemester = useMemo(() => findActiveSemester(semesters.data), [semesters.data]);
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

      <MissionStatus semester={activeSemester} todos={open} classes={liveClasses} />

      {subjects.error ? (
        <View className="mb-6">
          <Notice title="Could not load your library" body={subjects.error.message} />
        </View>
      ) : null}

      <Engines
        busy={ingest.busy}
        collapsed={compact}
        onFiles={(files) => ingest.startFiles(files).then(() => undefined)}
      />

      <ThisWeek
        classes={liveClasses}
        routines={routines.data}
        todos={open}
        loading={classes.loading || todos.loading}
        configured={setUp}
        compact={compact}
        semester={activeSemester}
      />

      <WorkloadAhead semester={activeSemester} todos={open} />

      {currentSubjects.length > 0 ? (
        <QuickLog uid={uid} subjects={currentSubjects} classes={liveClasses} />
      ) : null}

      <TermProgress
        subjects={currentSubjects}
        semesters={semesters.data}
        scope={scope}
        classes={liveClasses}
      />

    </ScreenScroll>
  );
}

/**
 * Where the term is, and what today asks of you — in one sentence.
 *
 * This was four things competing for the same strip: a term badge, a week
 * number, a date range and a colour-coded "Burnout: Building load" pill. Each
 * was true and none of them answered the question a student opens the app
 * with, which is whether today is going to be a lot. A ratio against the
 * term's own peak cannot answer it either — in a quiet semester the busiest
 * week still reads "High load", and in a brutal one the third-worst week reads
 * "Balanced".
 *
 * So it counts what is actually on today and says so in words. The term and
 * week stay, quietly, as the line underneath: context, not a headline.
 */
function MissionStatus({
  semester,
  todos,
  classes,
}: {
  semester: Semester | null;
  todos: Todo[];
  classes: ResolvedClass[];
}) {
  if (!semester) {
    return (
      <View className="mb-5 flex-row flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
        <Icon name="calendar" size={16} tone="muted" />
        <Text className="flex-1 text-sm font-semibold text-ink">No active term selected</Text>
        <Link href="/schedule?tab=terms" asChild>
          <Button label="Manage terms" icon="arrow-right" variant="ghost" size="sm" />
        </Link>
      </View>
    );
  }

  // One definition of "which week is it", shared with the teaching plan and the
  // timetable. Counting 7-day slices from the term's start date drifts out of
  // step with a Monday-aligned plan the moment a term begins mid-week.
  const week = weekOf(semester);
  const dates = week ? weekRangeLabel(semester, week) : null;

  const now = new Date();
  const day = todayIndex();
  const classCount = classes.filter((block) => block.day === day).length;
  const dueCount = todos.filter((todo) => {
    const date = toDate(todo.dueDate);
    return !!date && isSameDay(date, now);
  }).length;

  // A deadline is worth more than a class because it is work rather than
  // attendance. Deliberately arithmetic and not a model: this changes what a
  // student does next, so it has to be the same every time they look.
  const load = classCount + dueCount * 2;
  const headline =
    load === 0 ? 'Clear day' : load >= 7 ? 'Heavy day' : load >= 3 ? 'Moderate day' : 'Light day';

  const parts = [
    classCount > 0 ? `${classCount} ${classCount === 1 ? 'class' : 'classes'}` : null,
    dueCount > 0 ? `${dueCount} ${dueCount === 1 ? 'deadline' : 'deadlines'}` : null,
  ].filter(Boolean);

  return (
    <View className="mb-5 gap-1 rounded-2xl border border-line bg-surface px-4 py-3">
      <View className="flex-row items-center gap-2.5">
        <Icon
          name={load >= 7 ? 'alert-triangle' : load === 0 ? 'check-circle' : 'layout-dashboard'}
          size={15}
          tone={load >= 7 ? 'amber' : load === 0 ? 'pine' : 'ink'}
        />
        <Text className="flex-1 text-sm font-semibold leading-5 text-ink">
          {parts.length > 0
            ? `${headline} — ${parts.join(' and ')} today.`
            : `${headline} — nothing scheduled today.`}
        </Text>
      </View>
      <Text className="text-xs text-muted" numberOfLines={1}>
        {[semester.name, week ? `Week ${week}` : null, dates].filter(Boolean).join(' · ')}
      </Text>
    </View>
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
  busy,
  onFiles,
  collapsed,
}: {
  busy: boolean;
  onFiles: (files: import('@/services/ingestion').MaterialFile[]) => Promise<void>;
  /** True once this workspace has content and the screen is a phone. */
  collapsed: boolean;
}) {
  const [error, setError] = useState<string | null>(null);

  /*
   * The full panel is an onboarding target, and it earns its size exactly
   * once: on an empty workspace, where there is nothing else to look at and
   * everything downstream depends on the first upload. After that it is three
   * hundred points of instruction for something the student has already done,
   * sitting between them and the schedule they opened the app to check.
   *
   * So it collapses to one action on a phone that is already set up, and stays
   * whole for a new account and on any screen with room for both.
   */
  if (collapsed) {
    return (
      <View className="mb-4">
        <Button
          label="Add anything academic"
          icon="upload-cloud"
          variant="secondary"
          loading={busy}
          onPress={() => {
            setError(null);
            // Called straight from the press with nothing awaited before it:
            // iOS Safari only opens a file picker inside the gesture that
            // asked for one.
            void pickMaterials()
              .then((files: MaterialFile[]) => (files.length > 0 ? onFiles(files) : undefined))
              .catch((caught: unknown) =>
                setError(caught instanceof Error ? caught.message : String(caught))
              );
          }}
        />
        {error ? (
          <View className="mt-2">
            <Notice title="Could not add those files" body={error} />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View className="mb-5">
      <FileDropZone
        busy={busy}
        compact
        title="Drop anything academic"
        body="Up to 10 schedules, calendars, syllabuses, slides or notes. Notomi stages the files, identifies each type, then routes each one automatically. Maximum 25 MB total."
        onFiles={onFiles}
      />
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
  routines,
  todos,
  loading,
  configured,
  compact,
  semester,
}: {
  classes: ResolvedClass[];
  routines: RoutineBlock[];
  todos: Todo[];
  loading: boolean;
  configured: boolean;
  /** Drops the section heading; the week is self-evident and space is short. */
  compact: boolean;
  /** Dates the repeating week against the term, when one is running. */
  semester: Semester | null;
}) {
  const now = new Date();
  const [selectedClass, setSelectedClass] = useState<ResolvedClass | null>(null);
  const { visibleDays, toggleDay } = useVisibleDays();
  const [style] = useWeekStyle();


  /** The dates this repeating week actually falls on, when a term is running. */
  const weekDates = useMemo(() => {
    const week = weekOf(semester);
    return week ? weekDays(semester, week) : null;
  }, [semester]);

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
          <Text className="text-lg font-semibold tracking-tight text-ink">Weekly schedule</Text>
          <Link href="/schedule" asChild>
            <Button label="Full schedule" variant="ghost" size="sm" />
          </Link>
        </View>
      )}

      {loading ? (
        <Loading label="Checking your week…" />
      ) : classes.length === 0 && routines.length === 0 ? (
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
        /*
         * The same compressed grid the timetable now uses on a phone, so the
         * dashboard's week and the timetable's week are the same picture
         * rather than two different summaries of the same data. Hours are
         * trimmed to what is actually taught, padded by one either side.
         */
        <>
          {/*
            The same controls and the same settings as the timetable. A student
            who hides the weekend in one place and finds it back in the other
            has two settings that look like one — and the style toggle sits
            here at every width for the same reason, since a control that
            exists on one device and not another is the same trap.

            One row rather than two: the day filter's pills are flex-1, so it
            takes whatever the toggle leaves and the week below keeps its
            height.
          */}
          <View className="mb-3 flex-row items-center gap-2">
            <WeekStyleToggle compact />
            {compact || style === 'agenda' ? (
              <DayFilter visibleDays={visibleDays} onToggle={toggleDay} className="flex-1" />
            ) : null}
          </View>
          {style === 'agenda' ? (
            <AgendaWeek
              classes={classes}
              routines={routines}
              visibleDays={visibleDays}
              onSelect={setSelectedClass}
              dates={weekDates}
            />
          ) : (
            <CompactWeekGrid
              classes={classes}
              routines={routines}
              visibleDays={visibleDays}
              onSelect={setSelectedClass}
              dates={weekDates}
            />
          )}
        </>
      )}

      {due.length > 0 ? (
        <Card className="gap-0 p-0">
          {due.map((entry, index) => (
            <TaskRow key={entry.todo.id} entry={entry} first={index === 0} />
          ))}
        </Card>
      ) : null}

      <DashboardClassSheet block={selectedClass} onClose={() => setSelectedClass(null)} />
    </View>
  );
}

function DashboardClassSheet({
  block,
  onClose,
}: {
  block: ResolvedClass | null;
  onClose: () => void;
}) {
  const subjectName = block?.subjectName || block?.title || 'Class details';

  return (
    <Sheet
      visible={block !== null}
      onClose={onClose}
      title={subjectName}
      icon="book-open"
      footer={
        block ? (
          <>
            <Link href={`/knowledge/subject/${block.subjectId}` as never} asChild>
              <Button label="Course materials" icon="book-open" variant="secondary" size="sm" />
            </Link>
            <View className="flex-1" />
            <Link href={`/schedule?tab=timetable&editClassId=${block.id}` as never} asChild>
              <Button label="Edit class" icon="edit-3" size="sm" />
            </Link>
          </>
        ) : null
      }
    >
      {block ? (
        <View className="gap-3">
          <View
            className="rounded-2xl border border-line p-4"
            style={{
              backgroundColor: subjectTint(block.color, 0.07),
              borderLeftColor: block.color,
              borderLeftWidth: 4,
            }}
          >
            <Text className="text-lg font-semibold text-ink">{subjectName}</Text>
            <Text className="mt-1 text-sm text-muted">
              {[block.code, block.kind, block.section].filter(Boolean).join(' · ') ||
                'Scheduled class'}
            </Text>
          </View>

          <ClassDetailRow
            icon="calendar"
            label="Time"
            value={`${DAY_FULL[block.day]} · ${minutesToLabel(block.startMinute)}–${minutesToLabel(
              block.endMinute
            )}`}
          />
          <ClassDetailRow
            icon="map"
            label="Venue"
            value={block.venue?.trim() || 'Venue not set'}
          />
        </View>
      ) : null}
    </Sheet>
  );
}

function ClassDetailRow({
  icon,
  label,
  value,
}: {
  icon: 'calendar' | 'map';
  label: string;
  value: string;
}) {
  return (
    <View className="flex-row items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
        <Icon name={icon} size={16} tone="muted" />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-[11px] font-bold uppercase tracking-wider text-subtle">{label}</Text>
        <Text className="text-sm font-semibold text-ink">{value}</Text>
      </View>
    </View>
  );
}

/**
 * The one week ahead worth warning about.
 *
 * This was fourteen coloured bars, which is a pretty way of saying nothing: a
 * strip of tints with no numbers, no names and nothing to press cannot change
 * what a student does next, and it took a full row of the dashboard to not do
 * it. A forecast earns its space by naming the week, the reason and the move.
 *
 * It also stays quiet. Rendering "workload is fine" every day for eleven weeks
 * is how a warning becomes furniture, so when nothing is piling up this is
 * simply not on the screen.
 */
function WorkloadAhead({ semester, todos }: { semester: Semester | null; todos: Todo[] }) {
  const forecast = useMemo(() => {
    const weeks = buildBurnoutWeeks(semester, todos);
    if (!semester || weeks.length === 0) return null;

    // Look from this week forward. What happened in week 3 is not a forecast,
    // and it is not something a student can still do anything about.
    const current = Math.max(0, (weekOf(semester) ?? 1) - 1);
    const ahead = weeks.slice(current, current + 4).filter((week) => week.tasks >= 2);
    if (ahead.length === 0) return null;

    const worst = ahead.reduce((peak, week) => (week.workload > peak.workload ? week : peak));
    // Two deadlines in a week is ordinary. Three, or two heavy ones, is the
    // week that ruins the fortnight around it.
    if (worst.tasks < 3 && worst.workload < 10) return null;

    const due = todos.filter((todo) => {
      const date = toDate(todo.dueDate);
      return !todo.isCompleted && !!date && date >= worst.start && date <= worst.end;
    });
    const subjects = new Set(
      due.map((todo) => todo.subjectName).filter((name): name is string => !!name)
    ).size;

    const offset = worst.index - current;
    const when =
      offset === 0 ? 'This week' : offset === 1 ? 'Next week' : `In ${offset} weeks`;

    return {
      when,
      reason: [
        `${due.length} ${due.length === 1 ? 'deadline' : 'deadlines'}`,
        subjects > 1 ? `across ${subjects} subjects` : null,
      ]
        .filter(Boolean)
        .join(' '),
      heavy: worst.workload >= 14,
    };
  }, [semester, todos]);

  if (!forecast) return null;

  return (
    <View className="mb-6 gap-2.5 rounded-2xl border border-line bg-surface px-4 py-3.5">
      <View className="flex-row items-start gap-2.5">
        <Icon
          name={forecast.heavy ? 'alert-triangle' : 'activity'}
          size={15}
          tone={forecast.heavy ? 'amber' : 'accent'}
          style={{ marginTop: 2 }}
        />
        <Text className="flex-1 text-sm font-semibold leading-5 text-ink">
          {forecast.when} is heavy — {forecast.reason}.
        </Text>
      </View>
      <View className="flex-row">
        <Link href="/tasks" asChild>
          <Button label="Review workload" icon="arrow-right" variant="secondary" size="sm" />
        </Link>
      </View>
    </View>
  );
}

function TaskRow({ entry, first }: { entry: Entry; first: boolean }) {
  const due = toDate(entry.todo.dueDate);

  return (
    <Link href="/tasks" asChild>
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
          <Icon
            name={entry.overdue ? 'alert-circle' : 'check-square'}
            size={14}
            tone={entry.overdue ? 'rose' : 'muted'}
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
          <Icon name="edit-3" size={15} tone="accent" />
        </View>
        <View className="flex-1">
          <Text className="text-[15px] font-semibold text-ink">Log a class</Text>
          <Text className="text-xs text-muted" numberOfLines={1}>
            {open
              ? `Writing up ${active.name}`
              : 'Say what you covered and Notomi writes the notes'}
          </Text>
        </View>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} tone="subtle" />
      </Pressable>

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title="Log a Class"
        icon="edit-3"
        maxHeight={680}
      >
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

          <Link href={`/knowledge/subject/${active.id}`} asChild>
            <Button label="Open the full log" icon="book-open" variant="ghost" size="sm" />
          </Link>
        </View>
      </Sheet>
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
    <Link href="/schedule?tab=terms" asChild>
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
            <Icon name="chevron-right" size={16} tone="subtle" />
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
