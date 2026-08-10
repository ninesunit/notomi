import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
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
import { DatePicker } from '@/components/DatePicker';
import { ScreenScroll } from '@/components/ScreenScroll';
import { nextPriority, TodoRow, type TodoActions } from '@/components/TodoRow';
import { Button, Card, EmptyState, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { bucketFor, dayKey, toDate, type DueBucket } from '@/lib/dates';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import type { Priority, SubTask, Subject, Todo } from '@/lib/schema';
import { sweepOrphanedTodos } from '@/services/ingestion';

const GROUPS: { key: DueBucket; title: string; hint: string }[] = [
  { key: 'overdue', title: 'Overdue', hint: 'Past due and still open' },
  { key: 'today', title: 'Today', hint: 'Due before the day is out' },
  { key: 'upcoming', title: 'Upcoming', hint: 'Everything still ahead' },
  { key: 'someday', title: 'No date', hint: 'Unscheduled' },
];


export default function Todos() {
  const uid = useUid();
  const db = getDb();

  const todos = useCollection<Todo>(query(paths.todos(db, uid), orderBy('dueDate', 'asc')), [uid]);
  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);

  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [priority, setPriority] = useState<Priority>('medium');
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
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

  const open = useMemo(() => todos.data.filter((todo) => !todo.isCompleted), [todos.data]);
  const completed = useMemo(() => todos.data.filter((todo) => todo.isCompleted), [todos.data]);

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
    () => open.filter((todo) => todo.source === 'syllabus').length,
    [open]
  );

  /**
   * Fed into the picker so choosing a date shows what is already due that day
   * — the main reason to pick from a calendar rather than type a date.
   */
  const markers = useMemo(() => {
    const map = new Map<string, { color: string; overdue?: boolean }[]>();
    const now = new Date();
    for (const todo of open) {
      const due = toDate(todo.dueDate);
      if (!due) continue;
      const key = dayKey(due);
      const list = map.get(key) ?? [];
      const subject = subjects.data.find((s) => s.id === todo.subjectId);
      list.push({ color: subject?.color || '#6F6A5F', overdue: due < now });
      map.set(key, list);
    }
    return map;
  }, [open, subjects.data]);

  async function addTodo() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setError(null);

    const subject = subjects.data.find((candidate) => candidate.id === subjectId) ?? null;

    try {
      await addDoc(paths.todos(db, uid), {
        title: trimmed,
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
      setTitle('');
      setDueDate(null);
      setPriority('medium');
      setSubjectId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

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
      void deleteDoc(paths.todo(db, uid, todo.id)).catch((caught) => setError(String(caught)));
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
    <ScreenScroll maxWidth={860}>
      <PageHeader
        title="To-dos"
        subtitle={
          syllabusCount > 0
            ? `${open.length} open · ${syllabusCount} pulled from your syllabuses automatically`
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

      <Card className="mb-8 gap-4">
        <Field
          label="New task"
          value={title}
          onChangeText={setTitle}
          placeholder="Draft the literature review"
          onSubmitEditing={() => void addTodo()}
          returnKeyType="done"
        />

        <View className="flex-row flex-wrap items-end gap-4">
          <View className="flex-1 gap-2" style={{ minWidth: 220 }}>
            <DatePicker value={dueDate} onChange={setDueDate} markers={markers} />
          </View>

          <View className="gap-2">
            <Text className="text-sm font-medium text-muted">Priority</Text>
            <View className="flex-row gap-2">
              {(['low', 'medium', 'high'] as Priority[]).map((level) => (
                <Pressable
                  key={level}
                  onPress={() => setPriority(level)}
                  className={`rounded-lg border px-3 py-2 ${
                    priority === level ? 'border-ink bg-ink' : 'border-line bg-paper'
                  }`}
                >
                  <Text
                    className={`text-xs font-semibold capitalize ${
                      priority === level ? 'text-paper' : 'text-muted'
                    }`}
                  >
                    {level}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>

        {subjects.data.length > 0 ? (
          <View className="gap-2">
            <Text className="text-sm font-medium text-muted">Subject (optional)</Text>
            <View className="flex-row flex-wrap gap-2">
              {subjects.data.map((subject) => (
                <Pressable
                  key={subject.id}
                  onPress={() => setSubjectId(subjectId === subject.id ? null : subject.id)}
                  className={`rounded-lg border px-3 py-1.5 ${
                    subjectId === subject.id ? 'border-accent bg-accent-soft' : 'border-line bg-paper'
                  }`}
                >
                  <Text
                    className={`text-xs font-medium ${
                      subjectId === subject.id ? 'text-accent' : 'text-muted'
                    }`}
                  >
                    {subject.moduleCode || subject.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        <Button
          label="Add task"
          icon="plus"
          onPress={() => void addTodo()}
          disabled={!title.trim()}
          className="self-start"
        />
      </Card>

      {todos.loading ? (
        <Loading label="Loading your tasks…" />
      ) : open.length === 0 && completed.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title="Nothing on your list"
          body="Add a task above, or upload a syllabus — every deadline Gemini finds in it lands here automatically."
        />
      ) : (
        <View className="gap-8">
          {GROUPS.map((group) => {
            const items = grouped[group.key];
            if (items.length === 0) return null;

            return (
              <View key={group.key} className="gap-3">
                <View className="flex-row items-baseline gap-2">
                  <Text
                    className={`text-lg font-semibold tracking-tight ${
                      group.key === 'overdue' ? 'text-rose' : 'text-ink'
                    }`}
                  >
                    {group.title}
                  </Text>
                  <Text className="text-xs text-subtle">
                    {items.length} · {group.hint}
                  </Text>
                </View>

                <View className="overflow-hidden rounded-2xl border border-line bg-surface">
                  {items.map((todo) => (
                    <TodoRow
                      key={todo.id}
                      todo={todo}
                      actions={actions}
                      overdue={group.key === 'overdue'}
                    />
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
                <Feather
                  name={showCompleted ? 'chevron-down' : 'chevron-right'}
                  size={15}
                  color="#6F6A5F"
                />
                <Text className="text-sm font-medium text-muted">
                  Completed ({completed.length})
                </Text>
              </Pressable>

              {showCompleted ? (
                <View className="overflow-hidden rounded-2xl border border-line bg-surface">
                  {completed.map((todo) => (
                    <TodoRow key={todo.id} todo={todo} actions={actions} overdue={false} />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      )}
    </ScreenScroll>
  );
}
