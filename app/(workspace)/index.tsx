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
import { Badge, Button, Card, Loading, Notice, PageHeader, Touchable } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { useIngest } from '@/hooks/useIngest';
import { bucketFor, formatDue, toDate } from '@/lib/dates';
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
import { subjectTint, workloadTint } from '@/lib/color';
import { SemesterSetup } from '@/components/SemesterSetup';
import { InstallAppCard } from '@/components/InstallAppCard';
import { buildDailyPlan } from '@/services/dailyPlan';
import { workspaceHealth } from '@/services/workspaceHealth';

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

      <MissionStatus semester={activeSemester} todos={open} />

      <SemesterSetup
        uid={uid}
        classCount={classes.data.length}
        subjects={subjects.data}
        todos={todos.data}
        busy={ingest.busy}
        onUpload={(files) => ingest.startFiles(files).then(() => undefined)}
      />

      {subjects.error ? (
        <View className="mb-6">
          <Notice title="Could not load your library" body={subjects.error.message} />
        </View>
      ) : null}

      {compact ? (
        <MobileQuickActions
          busy={ingest.busy}
          onFiles={(files) => ingest.startFiles(files).then(() => undefined)}
        />
      ) : (
        <Engines
          busy={ingest.busy}
          collapsed={false}
          onFiles={(files) => ingest.startFiles(files).then(() => undefined)}
        />
      )}

      {compact ? <MobileTodayBrief classes={liveClasses} routines={routines.data} /> : null}

      {setUp ? (
        <DashboardAssists
          classes={liveClasses}
          routines={routines.data}
          todos={todos.data}
          semesters={semesters.data}
          subjects={subjects.data}
          compact={compact}
        />
      ) : null}

      <ThisWeek
        classes={liveClasses}
        routines={routines.data}
        todos={open}
        loading={classes.loading || todos.loading}
        configured={setUp}
        compact={compact}
        semester={activeSemester}
      />

      {setUp ? <InstallAppCard compact /> : null}

      <CompactBurnout
        semester={activeSemester}
        todos={open}
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

    </ScreenScroll>
  );
}

function DashboardAssists({
  classes,
  routines,
  todos,
  semesters,
  subjects,
  compact,
}: {
  classes: ResolvedClass[];
  routines: RoutineBlock[];
  todos: Todo[];
  semesters: Semester[];
  subjects: Subject[];
  compact: boolean;
}) {
  const plan = useMemo(() => buildDailyPlan({ classes, routines, todos }), [classes, routines, todos]);
  const issues = useMemo(
    () => workspaceHealth({ semesters, subjects, classes, routines, todos }),
    [semesters, subjects, classes, routines, todos]
  );

  return (
    <View className={`mb-5 ${compact ? 'gap-2' : 'flex-row gap-3'}`}>
      <Card className="min-w-0 flex-1 gap-3 p-4">
        <View className="flex-row items-center gap-2">
          <Icon name="sparkles" size={15} tone="accent" />
          <Text className="flex-1 text-sm font-semibold text-ink">Today plan</Text>
          <Link href="/tasks" asChild>
            <Touchable accessibilityRole="link" className="flex-row items-center gap-1">
              <Text className="text-xs font-semibold text-muted">Tasks</Text>
              <Icon name="chevron-right" size={13} tone="subtle" />
            </Touchable>
          </Link>
        </View>
        {plan.length ? plan.slice(0, compact ? 2 : 3).map((item) => (
          <View key={item.id} className="flex-row items-start gap-2.5">
            <View className="mt-1 h-2 w-2 rounded-full bg-accent" />
            <View className="min-w-0 flex-1">
              <Text className="text-xs font-semibold text-ink" numberOfLines={1}>{item.title}</Text>
              <Text className="text-[11px] text-muted" numberOfLines={1}>{item.detail}</Text>
            </View>
          </View>
        )) : <Text className="text-xs text-muted">No fixed blocks or open tasks need placing today.</Text>}
      </Card>

      <Card className="min-w-0 flex-1 gap-3 p-4">
        <View className="flex-row items-center gap-2">
          <Icon name={issues.length ? 'alert-circle' : 'check-circle-2'} size={15} tone={issues.length ? 'amber' : 'pine'} />
          <Text className="flex-1 text-sm font-semibold text-ink">Workspace check</Text>
          <Text className={`text-xs font-semibold ${issues.length ? 'text-amber' : 'text-pine'}`}>
            {issues.length ? `${issues.length} to review` : 'Ready'}
          </Text>
        </View>
        {issues.length ? issues.slice(0, compact ? 1 : 2).map((issue) => (
          <Link key={issue.id} href={issue.href} asChild>
            <Touchable accessibilityRole="link" className="flex-row items-center gap-2 rounded-lg bg-sand px-3 py-2">
              <Text className="min-w-0 flex-1 text-xs font-medium text-ink" numberOfLines={1}>{issue.title}</Text>
              <Icon name="chevron-right" size={13} tone="subtle" />
            </Touchable>
          </Link>
        )) : <Text className="text-xs text-muted">Terms, courses, schedule and tasks are consistent.</Text>}
      </Card>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Phone start: one tap in, one glance out
 * ------------------------------------------------------------------ */

function MobileQuickActions({
  busy,
  onFiles,
}: {
  busy: boolean;
  onFiles: (files: MaterialFile[]) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  const choose = () => {
    setError(null);
    // Keep the picker inside the original press gesture for iOS Safari.
    void pickMaterials()
      .then((files) => (files.length > 0 ? onFiles(files) : undefined))
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught))
      );
  };

  return (
    <View className="mb-4 gap-2">
      <View className="flex-row gap-2">
        <Button
          label="Scan files"
          icon="upload-cloud"
          loading={busy}
          disabled={busy}
          onPress={choose}
          className="flex-1"
        />
        <Link href="/tasks?tab=board&compose=1" asChild>
          <Button label="Add task" icon="plus" variant="secondary" className="flex-1" />
        </Link>
      </View>
      {error ? <Notice title="Could not add those files" body={error} /> : null}
    </View>
  );
}

type TodayItem =
  | { kind: 'class'; start: number; end: number; title: string; venue: string | null; block: ResolvedClass }
  | { kind: 'routine'; start: number; end: number; title: string; venue: string | null };

/**
 * The answer a phone is opened for: what is happening now, and what follows.
 * It deliberately shows at most two rows. The full week remains directly
 * underneath, collapsed until it is actually wanted.
 */
function MobileTodayBrief({
  classes,
  routines,
}: {
  classes: ResolvedClass[];
  routines: RoutineBlock[];
}) {
  const [selectedClass, setSelectedClass] = useState<ResolvedClass | null>(null);
  const day = todayIndex();
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();

  const items = useMemo<TodayItem[]>(
    () =>
      [
        ...classes
          .filter((block) => block.day === day)
          .map((block) => ({
            kind: 'class' as const,
            start: block.startMinute,
            end: block.endMinute,
            title: block.subjectName || block.title,
            venue: block.venue,
            block,
          })),
        ...routines
          .filter((block) => block.day === day)
          .map((block) => ({
            kind: 'routine' as const,
            start: block.startMinute,
            end: block.endMinute,
            title: block.title,
            venue: block.venue,
          })),
      ].sort((left, right) => left.start - right.start),
    [classes, day, routines]
  );

  const current = items.find((item) => item.start <= minute && item.end > minute) ?? null;
  const next = items.find((item) => item.start > minute) ?? null;
  const visible = [current, next].filter((item): item is TodayItem => item !== null);

  return (
    <View className="mb-4 gap-2.5">
      <View className="flex-row items-center justify-between">
        <Text className="text-[15px] font-semibold tracking-tight text-ink">Today</Text>
        <Link href="/schedule" asChild>
          <Touchable accessibilityRole="link" className="flex-row items-center gap-1 py-1">
            <Text className="text-xs font-semibold text-muted">Open schedule</Text>
            <Icon name="chevron-right" size={13} tone="subtle" />
          </Touchable>
        </Link>
      </View>

      <Card className="gap-0 p-0">
        {visible.length === 0 ? (
          <View className="px-4 py-4">
            <Text className="text-sm font-semibold text-ink">Nothing else scheduled today</Text>
            <Text className="mt-0.5 text-xs text-muted">Your next class will appear here.</Text>
          </View>
        ) : (
          visible.map((item, index) => {
            const happening = item === current;
            const row = (
              <View
                className={`flex-row items-center gap-3 px-4 py-3.5 ${index > 0 ? 'border-t border-line' : ''}`}
              >
                <View className={`h-9 w-9 items-center justify-center rounded-xl ${happening ? 'bg-pine-soft' : 'bg-sand'}`}>
                  <Icon name={item.kind === 'class' ? 'book-open' : 'clock'} size={16} tone={happening ? 'pine' : 'muted'} />
                </View>
                <View className="min-w-0 flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text className="text-[11px] font-bold uppercase tracking-wider text-subtle">
                      {happening ? 'Now' : 'Next'}
                    </Text>
                    <Text className="text-xs text-muted">
                      {minutesToLabel(item.start)}–{minutesToLabel(item.end)}
                    </Text>
                  </View>
                  <Text className="text-sm font-semibold text-ink" numberOfLines={1}>{item.title}</Text>
                  <Text className="text-xs text-muted" numberOfLines={1}>
                    {item.venue?.trim() || (item.kind === 'class' ? 'Venue not set' : 'Personal routine')}
                  </Text>
                </View>
                {item.kind === 'class' ? <Icon name="chevron-right" size={15} tone="subtle" /> : null}
              </View>
            );

            return item.kind === 'class' ? (
              <Touchable
                key={`${item.kind}-${item.block.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.title}`}
                onPress={() => setSelectedClass(item.block)}
              >
                {row}
              </Touchable>
            ) : (
              <View key={`${item.kind}-${item.start}-${item.title}`}>{row}</View>
            );
          })
        )}
      </Card>

      <DashboardClassSheet block={selectedClass} onClose={() => setSelectedClass(null)} />
    </View>
  );
}

function MissionStatus({ semester, todos }: { semester: Semester | null; todos: Todo[] }) {
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
  const weeks = buildBurnoutWeeks(semester, todos);
  const current = week ? weeks[week - 1] : weeks[0];
  const peak = Math.max(1, ...weeks.map((entry) => entry.workload));
  const ratio = current ? current.workload / peak : 0;
  const status = ratio >= 0.8 ? 'High load' : ratio >= 0.45 ? 'Building load' : 'Balanced';
  const tone = ratio >= 0.8 ? 'rose' : ratio >= 0.45 ? 'amber' : 'pine';

  return (
    <View className="mb-5 flex-row flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
      <Icon name="layout-dashboard" size={16} tone="ink" />
      <Badge label={`${semester.name}${week ? ` • Week ${week}` : ''}`} />
      {dates ? <Text className="text-xs font-medium text-muted">{dates}</Text> : null}
      <View className="flex-1" />
      <Badge label={`Burnout: ${status}`} tone={tone} />
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
  const [weekOpen, setWeekOpen] = useState(!compact);


  /** The dates this repeating week actually falls on, when a term is running. */
  const weekDates = useMemo(() => {
    const week = weekOf(semester);
    return week ? weekDays(semester, week) : null;
  }, [semester]);

  /**
   * What is due, from now to a fortnight out.
   *
   * This used to be today and overdue only — three rows that were empty most
   * of the week, which is the wrong half of the term to be silent in. A
   * deadline is worth knowing about while there is still time to act on it,
   * and a fortnight is about as far ahead as a student plans.
   *
   * Sorted by date rather than by bucket: the list is the sequence you will
   * meet them in, which is the only order that needs no explaining.
   */
  const due = useMemo(() => {
    const horizon = now.getTime() + 14 * 86_400_000;
    const rows: Entry[] = [];
    for (const todo of todos) {
      const date = toDate(todo.dueDate);
      if (!date) continue;
      const bucket = bucketFor(date, now);
      if (bucket !== 'today' && bucket !== 'overdue' && date.getTime() > horizon) continue;
      rows.push({ todo, overdue: bucket === 'overdue' });
    }
    return rows
      .sort(
        (left, right) =>
          (toDate(left.todo.dueDate)?.getTime() ?? 0) - (toDate(right.todo.dueDate)?.getTime() ?? 0)
      )
      .slice(0, compact ? 3 : 5);
    // `now` is derived from render time; todos is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, todos]);

  const laterCount = Math.max(
    0,
    todos.filter((todo) => toDate(todo.dueDate) !== null).length - due.length
  );

  return (
    <View className="mb-6 gap-2.5">
      {compact ? (
        <Touchable
          accessibilityRole="button"
          accessibilityState={{ expanded: weekOpen }}
          onPress={() => setWeekOpen((current) => !current)}
          className="flex-row items-center rounded-xl border border-line bg-surface px-4 py-3"
        >
          <Icon name="calendar-days" size={16} tone="muted" />
          <Text className="ml-2.5 flex-1 text-sm font-semibold text-ink">Weekly schedule</Text>
          <Text className="mr-2 text-xs font-semibold text-muted">{weekOpen ? 'Hide' : 'Show'}</Text>
          <Icon name={weekOpen ? 'chevron-up' : 'chevron-down'} size={15} tone="subtle" />
        </Touchable>
      ) : (
        <View className="flex-row items-center justify-between">
          <Text className="text-lg font-semibold tracking-tight text-ink">Weekly schedule</Text>
          <Link href="/schedule" asChild>
            <Button label="Full schedule" variant="ghost" size="sm" />
          </Link>
        </View>
      )}

      {compact && !weekOpen ? null : loading ? (
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
        <View className="mt-1 gap-2">
          <View className="flex-row items-baseline gap-2">
            <Text className="text-sm font-semibold tracking-tight text-ink">Coming up</Text>
            <Text className="min-w-0 flex-1 text-xs text-subtle" numberOfLines={1}>
              next 14 days
            </Text>
            <Link href="/tasks" asChild>
              <Touchable
                accessibilityRole="link"
                accessibilityLabel="Open the Task Board"
                className="flex-row items-center gap-1"
              >
                <Text className="text-xs font-semibold text-muted">
                  {laterCount > 0 ? `+${laterCount} more` : 'All tasks'}
                </Text>
                <Icon name="chevron-right" size={13} tone="subtle" />
              </Touchable>
            </Link>
          </View>
          <Card className="gap-0 p-0">
            {due.map((entry, index) => (
              <TaskRow key={entry.todo.id} entry={entry} first={index === 0} />
            ))}
          </Card>
        </View>
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

function CompactBurnout({ semester, todos }: { semester: Semester | null; todos: Todo[] }) {
  const weeks = useMemo(() => buildBurnoutWeeks(semester, todos), [semester, todos]);
  if (!semester || weeks.length === 0) return null;
  const peak = Math.max(1, ...weeks.map((week) => week.workload));
  return (
    <View className="mb-6 flex-row items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
      <Icon name="activity" size={16} tone="accent" />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-ink">Burnout forecast</Text>
        <Text className="text-[11px] text-muted" numberOfLines={1}>{semester.name}</Text>
      </View>
      <View className="flex-row gap-1">
        {weeks.slice(0, 14).map((week) => {
          return (
            <View
              key={week.index}
              accessibilityLabel={`Week ${week.index + 1}, workload ${week.workload}`}
              className="h-5 w-2 rounded-full"
              style={{ backgroundColor: workloadTint(week.workload, peak) }}
            />
          );
        })}
      </View>
    </View>
  );
}

/**
 * One deadline, one line.
 *
 * The date leads rather than trails. Five of these are read as a column of
 * dates with tasks attached — "Wed, Fri, Fri, Mon" — which is the shape of the
 * question a student is actually asking when they glance at this.
 */
function TaskRow({ entry, first }: { entry: Entry; first: boolean }) {
  const due = toDate(entry.todo.dueDate);

  return (
    <Link href="/tasks" asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${entry.todo.title}, ${formatDue(due)}. Open the Task Board.`}
        className={`flex-row items-center gap-3 px-3 py-2.5 ${first ? '' : 'border-t border-line'}`}
      >
        <View
          className={`w-[62px] shrink-0 items-center rounded-lg py-1 ${
            entry.overdue ? 'bg-rose-soft' : 'bg-sand'
          }`}
        >
          <Text
            className={`text-[11px] font-bold ${entry.overdue ? 'text-rose' : 'text-muted'}`}
            numberOfLines={1}
          >
            {dueChip(due, entry.overdue)}
          </Text>
        </View>

        <View className="min-w-0 flex-1">
          <Text className="text-[14px] font-medium leading-5 text-ink" numberOfLines={1}>
            {entry.todo.title}
          </Text>
          {entry.todo.subjectName ? (
            <Text className="text-[11px] text-subtle" numberOfLines={1}>
              {entry.todo.subjectName}
            </Text>
          ) : null}
        </View>

        <Icon name="chevron-right" size={14} tone="subtle" />
      </Pressable>
    </Link>
  );
}

/** Six characters at most: this chip is 62 points wide and must not wrap. */
function dueChip(due: Date | null, overdue: boolean): string {
  if (!due) return '—';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(due);
  day.setHours(0, 0, 0, 0);
  const offset = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (overdue || offset < 0) return offset === -1 ? '1d late' : `${Math.abs(offset)}d late`;
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tmrw';
  if (offset < 7) return due.toLocaleDateString(undefined, { weekday: 'short' });
  return due.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
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
