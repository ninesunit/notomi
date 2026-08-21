import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Icon } from '@/components/Icon';
import {
  addDoc,
  deleteDoc,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { FloatingAction } from '@/components/FloatingAction';
import { ResponsiveTermPicker } from '@/components/ResponsiveTermPicker';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import { TaskComposer, type NewTask } from '@/components/TaskComposer';
import { SwipeableRow } from '@/components/Swipeable';
import { nextPriority, TodoRow, type TodoActions } from '@/components/TodoRow';
import { Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { useUndo } from '@/hooks/useUndo';
import { PHONE } from '@/lib/breakpoints';
import { bucketFor, dayKey, toDate, type DueBucket } from '@/lib/dates';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import type { SubTask, Subject, Todo } from '@/lib/schema';
import { sweepOrphanedTodos } from '@/services/ingestion';

/**
 * The cuts a student actually asks for.
 *
 * Deliberately not a query. Firestore would need a composite index per
 * combination and would still not answer "high priority in the next week", and
 * a term's task list is small enough that filtering it in memory costs
 * nothing. The reads are the same reads either way.
 */
type Lens = 'all' | 'high' | 'week' | 'syllabus' | 'manual' | 'steps';

const LENSES: { id: Lens; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'high', label: 'High priority' },
  { id: 'week', label: 'Next 7 days' },
  { id: 'syllabus', label: 'From a syllabus' },
  { id: 'manual', label: 'Added by me' },
  { id: 'steps', label: 'Has steps' },
];

function matchesLens(todo: Todo, lens: Lens): boolean {
  if (lens === 'all') return true;
  if (lens === 'high') return todo.priority === 'high';
  if (lens === 'syllabus') return todo.source === 'syllabus';
  if (lens === 'manual') return todo.source !== 'syllabus';
  if (lens === 'steps') return (todo.subTasks ?? []).length > 0;
  const due = toDate(todo.dueDate);
  if (!due) return false;
  return due.getTime() <= Date.now() + 7 * 86_400_000;
}

const GROUPS: { key: DueBucket; title: string; hint: string }[] = [
  { key: 'overdue', title: 'Overdue', hint: 'Past due and still open' },
  { key: 'today', title: 'Today', hint: 'Due before the day is out' },
  { key: 'upcoming', title: 'Upcoming', hint: 'Everything still ahead' },
  { key: 'someday', title: 'No date', hint: 'Unscheduled' },
];


export default function Todos() {
  const uid = useUid();
  const db = getDb();

  const { schedule, hidden } = useUndo();

  const all = useCollection<Todo>(query(paths.todos(db, uid), orderBy('dueDate', 'asc')), [uid]);
  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);

  // A row swiped away is gone from the list immediately, even though its
  // Firestore delete has not run yet.
  const todos = useMemo(
    () => ({ ...all, data: all.data.filter((todo) => !hidden.has(todo.id)) }),
    [all, hidden]
  );

  const [showCompleted, setShowCompleted] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [lens, setLens] = useState<Lens>('all');

  /*
   * The composer's submit, lifted into the sheet's header.
   *
   * Held in state rather than a ref because the header has to re-render when
   * the task becomes submittable — a ref would keep the button greyed out
   * until something else happened to redraw.
   */
  const [composerState, setComposerState] = useState<{
    submit: () => void;
    canSubmit: boolean;
    busy: boolean;
  } | null>(null);
  const onComposerReady = useCallback(setComposerState, []);
  const composer = composerState
    ? {
        label: 'Add task',
        onPress: composerState.submit,
        disabled: !composerState.canSubmit,
        loading: composerState.busy,
      }
    : undefined;
  const { width } = useWindowDimensions();
  const phone = width < PHONE;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Deleting a material now takes its deadlines with it, but accounts that
   * deleted material before that fix still carry orphaned to-dos. Sweep once
   * per mount so the list heals itself without the student being told about a
   * bug they never understood.
   */
  const swept = useRef(false);
  useEffect(() => {
    if (swept.current) return;
    swept.current = true;
    void sweepOrphanedTodos(uid)
      .then((removed) => {
        if (removed > 0) {
          setNotice(
            `Removed ${removed} deadline${removed === 1 ? '' : 's'} left behind by material you had already deleted.`
          );
        }
      })
      .catch(() => undefined);
  }, [uid]);

  const everythingOpen = useMemo(
    () => todos.data.filter((todo) => !todo.isCompleted),
    [todos.data]
  );

  const filtering = subjectFilter !== 'all' || lens !== 'all';
  const keep = useCallback(
    (todo: Todo) =>
      (subjectFilter === 'all' ||
        (subjectFilter === 'none' ? !todo.subjectId : todo.subjectId === subjectFilter)) &&
      matchesLens(todo, lens),
    [subjectFilter, lens]
  );

  const open = useMemo(() => everythingOpen.filter(keep), [everythingOpen, keep]);
  const completed = useMemo(
    () => todos.data.filter((todo) => todo.isCompleted && keep(todo)),
    [todos.data, keep]
  );

  /** Counts on the picker come from the whole list, not the filtered one. */
  const subjectOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let loose = 0;
    for (const todo of everythingOpen) {
      if (todo.subjectId) counts.set(todo.subjectId, (counts.get(todo.subjectId) ?? 0) + 1);
      else loose += 1;
    }
    return [
      { id: 'all', label: 'All subjects', detail: `${everythingOpen.length} open` },
      ...subjects.data
        .filter((subject) => counts.has(subject.id))
        .map((subject) => ({
          id: subject.id,
          label: subject.moduleCode || subject.name,
          detail: `${counts.get(subject.id)} open · ${subject.name}`,
        })),
      ...(loose ? [{ id: 'none', label: 'No subject', detail: `${loose} open` }] : []),
    ];
  }, [everythingOpen, subjects.data]);

  /**
   * Manual tasks and syllabus-extracted deadlines live in the same collection,
   * so grouping here covers both without any special-casing.
   */
  const grouped = useMemo(() => {
    const buckets: Record<DueBucket, Todo[]> = { overdue: [], today: [], upcoming: [], someday: [] };
    for (const todo of open) buckets[bucketFor(toDate(todo.dueDate))].push(todo);
    return buckets;
  }, [open]);

  const syllabusCount = useMemo(
    () => everythingOpen.filter((todo) => todo.source === 'syllabus').length,
    [everythingOpen]
  );

  /**
   * Fed into the picker so choosing a date shows what is already due that day
   * — the main reason to pick from a calendar rather than type a date.
   */
  const markers = useMemo(() => {
    const map = new Map<string, { color: string; overdue?: boolean }[]>();
    const now = new Date();
    for (const todo of everythingOpen) {
      const due = toDate(todo.dueDate);
      if (!due) continue;
      const key = dayKey(due);
      const list = map.get(key) ?? [];
      const subject = subjects.data.find((s) => s.id === todo.subjectId);
      list.push({ color: subject?.color || '#6F6A5F', overdue: due < now });
      map.set(key, list);
    }
    return map;
  }, [everythingOpen, subjects.data]);

  /**
   * The write, kept here rather than in the composer.
   *
   * The composer is shared with the Calendar, which saves to the same place but
   * arrives with a due date already chosen. Leaving the Firestore call on the
   * screen is what lets one component serve both.
   */
  const addTodo = useCallback(
    async ({ title, dueDate, priority, subjectId }: NewTask) => {
      setError(null);
      const subject = subjects.data.find((candidate) => candidate.id === subjectId) ?? null;

      try {
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
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        throw caught;
      }
    },
    [db, subjects.data, uid]
  );

  /** Bulk clear. Batched so a long list is one round trip, not fifty. */
  const clearMany = useCallback(
    async (items: Todo[], describe: string) => {
      if (items.length === 0) return;
      setError(null);
      setBusy(true);
      try {
        for (let index = 0; index < items.length; index += 400) {
          const batch = writeBatch(db);
          for (const todo of items.slice(index, index + 400)) {
            batch.delete(paths.todo(db, uid, todo.id));
          }
          await batch.commit();
        }
        setNotice(`Cleared ${items.length} ${describe}${items.length === 1 ? '' : 's'}.`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [db, uid]
  );

  const actions: TodoActions = {
    rename: (todo, nextTitle) => {
      void updateDoc(paths.todo(db, uid, todo.id), { title: nextTitle }).catch((caught) =>
        setError(String(caught))
      );
    },
    toggle: (todo) => {
      void updateDoc(paths.todo(db, uid, todo.id), {
        isCompleted: !todo.isCompleted,
        completedAt: todo.isCompleted ? null : serverTimestamp(),
      }).catch((caught) => setError(String(caught)));
    },
    remove: (todo) => {
      // The row goes now; the write goes in five seconds unless undone.
      schedule({
        key: todo.id,
        label: `“${todo.title.slice(0, 32)}${todo.title.length > 32 ? '…' : ''}” deleted`,
        commit: () => deleteDoc(paths.todo(db, uid, todo.id)),
      });
    },
    cyclePriority: (todo) => {
      void updateDoc(paths.todo(db, uid, todo.id), {
        priority: nextPriority(todo.priority),
      }).catch((caught) => setError(String(caught)));
    },
    setSubTasks: (todo, subTasks: SubTask[]) => {
      void updateDoc(paths.todo(db, uid, todo.id), { subTasks }).catch((caught) =>
        setError(String(caught))
      );
    },
    setDueDate: (todo, next) => {
      void updateDoc(paths.todo(db, uid, todo.id), {
        dueDate: next ? Timestamp.fromDate(next) : null,
      }).catch((caught) => setError(String(caught)));
    },
  };

  return (
    <ScreenScroll
      maxWidth={860}
      floating={
        phone ? (
          <FloatingAction label="New task" onPress={() => setComposerOpen(true)} />
        ) : undefined
      }
    >
      <PageHeader
        title="Task Board"
        subtitle={
          syllabusCount > 0
            ? `${everythingOpen.length} open · ${syllabusCount} pulled from your syllabuses automatically`
            : 'Manual tasks and syllabus deadlines, in one list.'
        }
        actions={
          <>
            {grouped.overdue.length > 0 ? (
              <Button
                label={`Clear ${grouped.overdue.length} overdue`}
                icon="alert-circle"
                variant="secondary"
                size="sm"
                disabled={busy}
                onPress={() => void clearMany(grouped.overdue, 'overdue task')}
              />
            ) : null}
            {completed.length > 0 ? (
              <Button
                label={`Clear ${completed.length} completed`}
                icon="check"
                variant="secondary"
                size="sm"
                disabled={busy}
                onPress={() => void clearMany(completed, 'completed task')}
              />
            ) : null}
          </>
        }
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Could not save" body={error} />
        </View>
      ) : null}

      {notice ? (
        <View className="mb-6">
          <Notice tone="pine" title="Tidied up" body={notice} />
        </View>
      ) : null}

      {/*
        Two controls, and only once there is enough to be worth narrowing.

        A subject picker and a lens covers what students actually ask for —
        "just this module", "what is high priority", "what is due this week" —
        and both are dropdowns rather than pill rows so twelve subjects cost
        the same vertical space as two.
      */}
      {everythingOpen.length > 4 || filtering ? (
        <View className="mb-6 flex-row flex-wrap items-center gap-2">
          <View className="min-w-0 flex-1" style={{ minWidth: 150 }}>
            <ResponsiveTermPicker
              alwaysDropdown
              icon="folder"
              options={subjectOptions}
              value={subjectFilter}
              title="Filter by subject"
              sheetIcon="folder"
              onChange={setSubjectFilter}
            />
          </View>
          <View className="min-w-0 flex-1" style={{ minWidth: 150 }}>
            <ResponsiveTermPicker
              alwaysDropdown
              icon="filter"
              options={LENSES}
              value={lens}
              title="Filter tasks"
              sheetIcon="filter"
              onChange={(next) => setLens(next as Lens)}
            />
          </View>
          {filtering ? (
            <Button
              label="Clear"
              icon="x"
              variant="ghost"
              size="sm"
              onPress={() => {
                setSubjectFilter('all');
                setLens('all');
              }}
            />
          ) : null}
        </View>
      ) : null}

      {/*
        The form is the whole first screen on a phone.
        
        Header plus form came to roughly six hundred and fifty of an
        eight-hundred-point viewport, so a student opening the Task Board saw a
        form and no tasks. On a desktop it costs nothing and works well, so it
        stays exactly as it was; on a phone it moves behind the button in the
        corner and the list gets the screen.
      */}
      {phone ? null : (
        <Card className="mb-8">
          <TaskComposer subjects={subjects.data} markers={markers} onSubmit={addTodo} />
        </Card>
      )}

      {todos.loading ? (
        <Loading label="Loading your tasks…" />
      ) : open.length === 0 && completed.length === 0 ? (
        filtering ? (
          <EmptyState
            icon="filter"
            title="Nothing matches this filter"
            body="There are tasks on the board — none of them fit what you have narrowed to."
            action={
              <Button
                label="Clear the filter"
                icon="x"
                onPress={() => {
                  setSubjectFilter('all');
                  setLens('all');
                }}
              />
            }
          />
        ) : (
          <EmptyState
            icon="check-circle"
            title="Nothing on your list"
            body={
              phone
                ? 'Tap the button below, or upload a syllabus — every deadline Notomi finds in it lands here automatically.'
                : 'Add a task above, or upload a syllabus — every deadline Notomi finds in it lands here automatically.'
            }
            // On a phone the form is no longer above to be the obvious next step.
            action={
              phone ? (
                <Button label="New task" icon="plus" onPress={() => setComposerOpen(true)} />
              ) : undefined
            }
          />
        )
      ) : (
        <View className={phone ? 'gap-5' : 'gap-8'}>
          {GROUPS.map((group) => {
            const items = grouped[group.key];
            if (items.length === 0) return null;

            return (
              <View key={group.key} className={phone ? 'gap-2' : 'gap-3'}>
                <View className="flex-row items-baseline gap-2">
                  <Text
                    className={`font-semibold tracking-tight ${phone ? 'text-[15px]' : 'text-lg'} ${
                      group.key === 'overdue' ? 'text-rose' : 'text-ink'
                    }`}
                  >
                    {group.title}
                  </Text>
                  <Text className="min-w-0 flex-1 text-xs text-subtle" numberOfLines={1}>
                    {items.length}
                    {phone ? '' : ` · ${group.hint}`}
                  </Text>
                </View>

                <View className="overflow-hidden rounded-2xl border border-line bg-surface">
                  {items.map((todo) => (
                    <SwipeableRow
                      key={todo.id}
                      onSwipeLeft={() => actions.remove(todo)}
                      onSwipeRight={() => actions.toggle(todo)}
                      rightLabel="Complete"
                    >
                      <TodoRow todo={todo} actions={actions} overdue={group.key === 'overdue'} />
                    </SwipeableRow>
                  ))}
                </View>
              </View>
            );
          })}

          {completed.length > 0 ? (
            <View className="gap-3">
              <Pressable
                onPress={() => setShowCompleted((value) => !value)}
                className="flex-row items-center gap-2 self-start py-1"
              >
                <Icon
                  name={showCompleted ? 'chevron-down' : 'chevron-right'}
                  size={15}
                  tone="muted"
                />
                <Text className="text-sm font-medium text-muted">
                  Completed ({completed.length})
                </Text>
              </Pressable>

              {showCompleted ? (
                <View className="overflow-hidden rounded-2xl border border-line bg-surface">
                  {completed.map((todo) => (
                    <SwipeableRow
                      key={todo.id}
                      onSwipeLeft={() => actions.remove(todo)}
                      onSwipeRight={() => actions.toggle(todo)}
                      rightLabel="Reopen"
                    >
                      <TodoRow todo={todo} actions={actions} overdue={false} />
                    </SwipeableRow>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      )}
      {/*
        dismissOnScrim is off deliberately: a half-typed task thrown away by a
        stray tap on the backdrop is exactly the failure Sheet's own notes
        describe, and this form takes longer to fill than most.
      */}
      <Sheet
        visible={composerOpen}
        onClose={() => setComposerOpen(false)}
        title="New task"
        icon="plus"
        dismissOnScrim={false}
        variant="form"
        primaryAction={composer}
      >
        <TaskComposer
          onReady={onComposerReady}
          subjects={subjects.data}
          markers={markers}
          onSubmit={addTodo}
        />
      </Sheet>
    </ScreenScroll>
  );
}
