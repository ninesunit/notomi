import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore';
import { CountdownBlock, CountdownChip } from '@/components/Countdown';
import { AcademicCalendarImport } from '@/components/AcademicCalendarImport';
import { BurnoutHeatmap } from '@/components/AcademicInsights';
import { MonthCalendar, type DayMarker } from '@/components/MonthCalendar';
import { ScreenScroll } from '@/components/ScreenScroll';
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
  type CalendarImportOutcome,
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
  const [calendarOpen, setCalendarOpen] = useState(false);
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

  function toggle(todo: Todo) {
    void updateDoc(paths.todo(db, uid, todo.id), {
      isCompleted: !todo.isCompleted,
      completedAt: todo.isCompleted ? null : serverTimestamp(),
    }).catch(() => undefined);
  }

  function calendarImported(outcome: CalendarImportOutcome) {
    setMessage({
      tone: 'pine',
      title: 'Academic calendar anchored',
      body: `${outcome.created} term${outcome.created === 1 ? '' : 's'} added and ${outcome.updated} updated.${
        outcome.currentTerm ? ` ${outcome.currentTerm} is active now.` : ''
      }`,
    });
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
    <ScreenScroll>
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
            <Button
              label="Import academic calendar"
              icon="calendar"
              size="sm"
              variant="secondary"
              onPress={() => setCalendarOpen(true)}
            />
            <Link href="/todos" asChild>
              <Button label="Add a task" icon="plus" size="sm" variant="secondary" />
            </Link>
          </>
        }
      />

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
            <CountdownBlock due={next.due} />
          </View>
        </Card>
      ) : null}

      {overdue.length > 0 ? (
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
                  <DeadlineRow
                    key={entry.todo.id}
                    entry={entry}
                    color={colorFor(entry.todo.subjectId)}
                    first={index === 0}
                    onToggle={() => toggle(entry.todo)}
                  />
                ))}
              </Card>
            )}
          </View>

          <View className="gap-3">
            <Text className="text-sm font-semibold text-muted">Next 7 days</Text>
            {nextSeven.length === 0 ? (
              <Card>
                <Text className="text-sm text-muted">A clear week ahead.</Text>
              </Card>
            ) : (
              <Card className="gap-0 p-0">
                {nextSeven.map((entry, index) => (
                  <DeadlineRow
                    key={entry.todo.id}
                    entry={entry}
                    color={colorFor(entry.todo.subjectId)}
                    first={index === 0}
                    showDate
                    onToggle={() => toggle(entry.todo)}
                  />
                ))}
              </Card>
            )}
          </View>
        </View>
      </View>

      {dated.length === 0 ? (
        <View className="mt-8">
          <EmptyState
            icon="calendar"
            title="No dated deadlines yet"
            body="Upload a syllabus and Notomi files every date it finds here automatically, or add a task with a due date."
            action={
              <Link href="/library" asChild>
                <Button label="Go to library" variant="secondary" />
              </Link>
            }
          />
        </View>
      ) : null}

      <AcademicCalendarImport
        visible={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        uid={uid}
        semesters={semesters.data}
        onImported={calendarImported}
      />
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
        {todo.isCompleted ? <Feather name="check" size={11} color="#FFFFFF" /> : null}
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
        <Feather name="check-circle" size={15} color="#2E6F5E" />
      ) : value ? (
        <CountdownChip due={due} compact />
      ) : null}
    </View>
  );
}
