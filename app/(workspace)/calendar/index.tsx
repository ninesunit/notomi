import { useMemo, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Link } from 'expo-router';
import { Icon } from '@/components/Icon';
import { Timestamp, addDoc, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore';
import { CountdownBlock, CountdownChip } from '@/components/Countdown';
import { BurnoutHeatmap } from '@/components/AcademicInsights';
import { MonthCalendar, type DayMarker } from '@/components/MonthCalendar';
import { FloatingAction } from '@/components/FloatingAction';
import { SwipeableRow } from '@/components/Swipeable';
import { Reveal } from '@/components/motion';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import { TaskComposer, type NewTask } from '@/components/TaskComposer';
import { PHONE } from '@/lib/breakpoints';
import { Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { countdown, dayKey, isSameDay, toDate } from '@/lib/dates';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import type { Semester, Subject, Todo } from '@/lib/schema';
import {
  createExamRevisionPlan,
  findActiveSemester,
} from '@/services/academicPlanner';

type Dated = { todo: Todo; due: Date };

export default function Calendar() {
  const uid = useUid();
  const db = getDb();

  const todos = useCollection<Todo>(query(paths.todos(db, uid), orderBy('dueDate', 'asc')), [uid]);
  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);
  const semesters = useCollection<Semester>(
    query(paths.semesters(db, uid), orderBy('order', 'asc')),
    [uid]
  );

  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  );
  const [selected, setSelected] = useState<Date | null>(new Date());
  const { width } = useWindowDimensions();
  const phone = width < PHONE;
  /** Analytics, folded away on a phone until asked for. */
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'rose' | 'pine';
    title: string;
    body: string;
  } | null>(null);

  const activeSemester = useMemo(() => findActiveSemester(semesters.data), [semesters.data]);

  const colorFor = useMemo(() => {
    const map = new Map(subjects.data.map((s) => [s.id, s.color || '#B4552D']));
    return (subjectId: string | null) => (subjectId && map.get(subjectId)) || '#6F6A5F';
  }, [subjects.data]);

  const dated = useMemo<Dated[]>(
    () =>
      todos.data
        .map((todo) => ({ todo, due: toDate(todo.dueDate) }))
        .filter((entry): entry is Dated => entry.due !== null),
    [todos.data]
  );

  /** dayKey -> markers, so the grid can dot each day without re-scanning. */
  const markers = useMemo(() => {
    const map = new Map<string, DayMarker[]>();
    const now = new Date();

    for (const { todo, due } of dated) {
      if (todo.isCompleted) continue;
      const key = dayKey(due);
      const list = map.get(key) ?? [];
      list.push({ color: colorFor(todo.subjectId), overdue: due < now });
      map.set(key, list);
    }
    return map;
  }, [dated, colorFor]);

  const open = useMemo(() => dated.filter((entry) => !entry.todo.isCompleted), [dated]);

  /** The single most pressing deadline — the number a student actually wants. */
  const next = useMemo(() => {
    const now = Date.now();
    const upcoming = open.filter((entry) => entry.due.getTime() >= now);
    return upcoming[0] ?? null;
  }, [open]);

  const overdue = useMemo(() => {
    const now = Date.now();
    return open.filter((entry) => entry.due.getTime() < now);
  }, [open]);

  const forSelectedDay = useMemo(
    () => (selected ? dated.filter((entry) => isSameDay(entry.due, selected)) : []),
    [dated, selected]
  );

  const nextSeven = useMemo(() => {
    const now = new Date();
    const horizon = new Date(now);
    horizon.setDate(horizon.getDate() + 7);
    return open.filter((entry) => entry.due >= now && entry.due <= horizon).slice(0, 8);
  }, [open]);

  /**
   * The same write the Task Board does, because it is the same collection.
   *
   * Duplicated deliberately rather than shared: hoisting it would mean a module
   * that both screens import for four lines, and the two callers differ in the
   * one way that matters — this one has a date already chosen.
   */
  async function addTask({ title, dueDate, priority, subjectId }: NewTask) {
    const subject = subjects.data.find((candidate) => candidate.id === subjectId) ?? null;
    await addDoc(paths.todos(db, uid), {
      title,
      dueDate: dueDate ? Timestamp.fromDate(dueDate) : null,
      isCompleted: false,
      subjectId: subject?.id ?? null,
      subjectName: subject?.name ?? null,
      priority,
      subTasks: [],
      source: 'manual',
      sourceDocumentId: null,
      createdAt: serverTimestamp(),
      completedAt: null,
    });
    setComposerOpen(false);
  }

  function toggle(todo: Todo) {
    void updateDoc(paths.todo(db, uid, todo.id), {
      isCompleted: !todo.isCompleted,
      completedAt: todo.isCompleted ? null : serverTimestamp(),
    }).catch(() => undefined);
  }

  async function planStudyLeave() {
    if (!activeSemester) return;
    setPlanning(true);
    setMessage(null);
    try {
      const plan = await createExamRevisionPlan(uid, activeSemester, subjects.data, todos.data);
      setMessage({
        tone: 'pine',
        title: 'Revision plan added',
        body: `${plan.length} focused study block${plan.length === 1 ? '' : 's'} now appear in your calendar and tasks.`,
      });
    } catch (caught) {
      setMessage({
        tone: 'rose',
        title: 'Could not build the revision plan',
        body: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setPlanning(false);
    }
  }

  if (todos.loading) {
    return (
      <ScreenScroll>
        <Loading label="Loading your calendar…" />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll
      floating={
        phone ? (
          <FloatingAction label="New task" onPress={() => setComposerOpen(true)} />
        ) : undefined
      }
    >
      {/*
        A 28-point title with a subtitle is about a hundred and fifty points of
        chrome, and this screen already spends a hundred and seventy on the hub
        tabs above it. Same trade the dashboard made at app/(workspace)/index.tsx.
      */}
      {phone ? (
        <View className="mb-4 flex-row items-center justify-between gap-3">
          <Text className="text-[17px] font-semibold tracking-tight text-ink">Calendar</Text>
          <Text className="text-xs text-muted">
            {open.length
              ? `${open.length} open${overdue.length ? ` · ${overdue.length} overdue` : ''}`
              : 'Nothing due'}
          </Text>
        </View>
      ) : (
      <PageHeader
        title="Calendar"
        subtitle={
          open.length
            ? `${open.length} open deadline${open.length === 1 ? '' : 's'}${
                overdue.length ? ` · ${overdue.length} overdue` : ''
              }`
            : 'Deadlines from your syllabuses and your own tasks, in one place.'
        }
        actions={
          <>
            <Link href="/tasks" asChild>
              <Button label="Add a task" icon="plus" size="sm" variant="secondary" />
            </Link>
          </>
        }
      />
      )}

      {message ? (
        <View className="mb-6">
          <Notice tone={message.tone} title={message.title} body={message.body} />
        </View>
      ) : null}

      {semesters.error ? (
        <View className="mb-6">
          <Notice title="Could not load term anchors" body={semesters.error.message} />
        </View>
      ) : null}



      {/* Next-up panel: the countdown is the point of this page. */}
      {next ? (
        <Card className="mb-6 gap-4 border-accent/25 bg-accent-soft">
          <View className="flex-row flex-wrap items-start justify-between gap-4">
            <View className="flex-1 gap-1" style={{ minWidth: 200 }}>
              <Text className="text-xs font-semibold uppercase tracking-wider text-accent">
                Next deadline
              </Text>
              <Text className="text-[17px] font-semibold leading-6 text-ink">
                {next.todo.title}
              </Text>
              <Text className="text-sm text-ink/70">
                {next.todo.subjectName ? `${next.todo.subjectName} · ` : ''}
                {next.due.toLocaleDateString(undefined, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
                {', '}
                {next.due.toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Text>
            </View>
            {phone ? <CountdownChip due={next.due} compact /> : <CountdownBlock due={next.due} />}
          </View>
        </Card>
      ) : null}

      {/* The header already says "· N overdue"; on a phone this is the same
          fact a second time, for a hundred points. */}
      {overdue.length > 0 && !phone ? (
        <View className="mb-6">
          <Notice
            title={`${overdue.length} deadline${overdue.length === 1 ? '' : 's'} already passed`}
            body={overdue
              .slice(0, 3)
              .map((entry) => entry.todo.title)
              .join(' · ')}
          />
        </View>
      ) : null}

      <View className="flex-row flex-wrap gap-5">
        <View className="flex-1 grow" style={{ minWidth: 300, flexBasis: 340 }}>
          <Card>
            <MonthCalendar
              month={month}
              onMonthChange={setMonth}
              selected={selected}
              onSelectDay={setSelected}
              markers={markers}
              compact={phone}
            />
          </Card>
        </View>

        <View className="flex-1 grow gap-5" style={{ minWidth: 280, flexBasis: 320 }}>
          <View className="gap-3">
            <Text className="text-sm font-semibold text-muted">
              {selected
                ? selected.toLocaleDateString(undefined, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })
                : 'Pick a day'}
            </Text>

            {forSelectedDay.length === 0 ? (
              <Card>
                <Text className="text-sm text-muted">Nothing due on this day.</Text>
              </Card>
            ) : (
              <Card className="gap-0 p-0">
                {forSelectedDay.map((entry, index) => (
                  <SwipeableRow
                    key={entry.todo.id}
                    onSwipeRight={() => toggle(entry.todo)}
                    rightLabel={entry.todo.isCompleted ? 'Reopen' : 'Complete'}
                  >
                    <DeadlineRow
                      entry={entry}
                      color={colorFor(entry.todo.subjectId)}
                      first={index === 0}
                      onToggle={() => toggle(entry.todo)}
                    />
                  </SwipeableRow>
                ))}
              </Card>
            )}
          </View>

          <View className="gap-3">
            <View className="flex-row items-baseline justify-between gap-2">
              <Text className="text-sm font-semibold text-muted">Next 7 days</Text>
              {phone && nextSeven.length > 4 ? (
                <Link href="/tasks" asChild>
                  <Pressable accessibilityRole="link">
                    <Text className="text-xs font-semibold text-accent">
                      See all {nextSeven.length}
                    </Text>
                  </Pressable>
                </Link>
              ) : null}
            </View>
            {nextSeven.length === 0 ? (
              <Card>
                <Text className="text-sm text-muted">A clear week ahead.</Text>
              </Card>
            ) : (
              <Card className="gap-0 p-0">
                {(phone ? nextSeven.slice(0, 4) : nextSeven).map((entry, index) => (
                  <SwipeableRow
                    key={entry.todo.id}
                    onSwipeRight={() => toggle(entry.todo)}
                    rightLabel={entry.todo.isCompleted ? 'Reopen' : 'Complete'}
                  >
                    <DeadlineRow
                      entry={entry}
                      color={colorFor(entry.todo.subjectId)}
                      first={index === 0}
                      showDate
                      onToggle={() => toggle(entry.todo)}
                    />
                  </SwipeableRow>
                ))}
              </Card>
            )}
          </View>
        </View>
      </View>

      {/*
        Analytics, demoted.
        
        The heatmap and the strategist are worth having and are not what the
        page is for. Above the grid they pushed the month itself to roughly nine
        hundred points down — past the fold, on a screen whose whole job is
        showing a month. Below it, behind one pill, they cost a tap.
        
        Both can render nothing: the heatmap returns null with no active
        semester, and the strategist needs study-leave dates. The pill only
        appears when at least one of them has something to say.
      */}
      {phone && (activeSemester?.startDate || activeSemester?.studyLeaveStart) ? (
        <View className="mt-6 gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: insightsOpen }}
            onPress={() => setInsightsOpen((value) => !value)}
            className="flex-row items-center gap-2 self-start rounded-full border border-line bg-surface px-3.5 py-2"
          >
            <Icon name="activity" size={14} tone="accent" />
            <Text className="text-xs font-semibold text-ink">Insights</Text>
            <Icon name={insightsOpen ? 'chevron-up' : 'chevron-down'} size={14} tone="subtle" />
          </Pressable>

          <Reveal open={insightsOpen}>
            <View>
              <BurnoutHeatmap semester={activeSemester} todos={todos.data} />
              {activeSemester?.studyLeaveStart && activeSemester.studyLeaveEnd ? (
        <Card className="mb-6 gap-4 border-pine/20 bg-pine-soft">
          <View className="flex-row flex-wrap items-start justify-between gap-4">
            <View className="flex-1 gap-1" style={{ minWidth: 220 }}>
              <Text className="text-[15px] font-semibold text-ink">Smart exam gap strategist</Text>
              <Text className="text-xs leading-5 text-muted">
                Build a Study Leave plan from exam spacing and each subject's credit weighting.
              </Text>
            </View>
            <Button
              label="Build revision plan"
              icon="map"
              size="sm"
              loading={planning}
              onPress={() => void planStudyLeave()}
            />
          </View>
        </Card>
      ) : null}
            </View>
          </Reveal>
        </View>
      ) : null}

      {!phone ? (
        <View className="mt-6">
          <BurnoutHeatmap semester={activeSemester} todos={todos.data} />
          {activeSemester?.studyLeaveStart && activeSemester.studyLeaveEnd ? (
        <Card className="mb-6 gap-4 border-pine/20 bg-pine-soft">
          <View className="flex-row flex-wrap items-start justify-between gap-4">
            <View className="flex-1 gap-1" style={{ minWidth: 220 }}>
              <Text className="text-[15px] font-semibold text-ink">Smart exam gap strategist</Text>
              <Text className="text-xs leading-5 text-muted">
                Build a Study Leave plan from exam spacing and each subject's credit weighting.
              </Text>
            </View>
            <Button
              label="Build revision plan"
              icon="map"
              size="sm"
              loading={planning}
              onPress={() => void planStudyLeave()}
            />
          </View>
        </Card>
      ) : null}
        </View>
      ) : null}

      {dated.length === 0 ? (
        <View className="mt-8">
          <EmptyState
            icon="calendar"
            title="No dated deadlines yet"
            body="Upload a syllabus and Notomi files every date it finds here automatically, or add a task with a due date."
            action={
              <Link href="/knowledge" asChild>
                <Button label="Go to library" variant="secondary" />
              </Link>
            }
          />
        </View>
      ) : null}

      {/*
        Pre-filled with the day the student is already looking at. Adding a
        deadline from a calendar almost always means adding it to the date under
        the cursor, and asking again for a date they just tapped is the kind of
        small stupidity that makes an app feel like a form.
      */}
      <Sheet
        visible={composerOpen}
        onClose={() => setComposerOpen(false)}
        title="New task"
        icon="plus"
        dismissOnScrim={false}
      >
        <TaskComposer
          subjects={subjects.data}
          markers={markers}
          initialDueDate={selected}
          onSubmit={addTask}
          autoFocus
        />
      </Sheet>
    </ScreenScroll>
  );
}

function DeadlineRow({
  entry,
  color,
  first,
  showDate = false,
  onToggle,
}: {
  entry: Dated;
  color: string;
  first: boolean;
  showDate?: boolean;
  onToggle: () => void;
}) {
  const { todo, due } = entry;
  const value = countdown(due);

  return (
    <View
      className={`flex-row items-center gap-3 px-4 py-3.5 ${first ? '' : 'border-t border-line'}`}
    >
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: todo.isCompleted }}
        accessibilityLabel={`Mark ${todo.title} ${todo.isCompleted ? 'incomplete' : 'complete'}`}
        onPress={onToggle}
        className={`h-5 w-5 items-center justify-center rounded-md border ${
          todo.isCompleted ? 'border-pine bg-pine' : 'border-subtle bg-surface'
        }`}
      >
        {todo.isCompleted ? <Icon name="check" size={11} color="#FFFFFF" /> : null}
      </Pressable>

      <View className="h-8 w-1 rounded-full" style={{ backgroundColor: color }} />

      <View className="flex-1 gap-0.5">
        <Text
          className={`text-[15px] leading-5 ${
            todo.isCompleted ? 'text-subtle line-through' : 'text-ink'
          }`}
          numberOfLines={2}
        >
          {todo.title}
        </Text>
        <Text className="text-xs text-subtle" numberOfLines={1}>
          {[
            todo.subjectName,
            showDate
              ? due.toLocaleDateString(undefined, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })
              : null,
            due.toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>

      {todo.isCompleted ? (
        <Icon name="check-circle" size={15} color="#2E6F5E" />
      ) : value ? (
        <CountdownChip due={due} compact />
      ) : null}
    </View>
  );
}
