import { useMemo, useState } from 'react';
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
} from 'firebase/firestore';
import { ScreenScroll } from '@/components/ScreenScroll';
import { nextPriority, TodoRow, type TodoActions } from '@/components/TodoRow';
import { Button, Card, EmptyState, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { bucketFor, parseDueDate, toDate, type DueBucket } from '@/lib/dates';
import { getDb } from '@/lib/firebase';
import { paths } from '@/lib/paths';
import type { Priority, SubTask, Subject, Todo } from '@/lib/schema';

const GROUPS: { key: DueBucket; title: string; hint: string }[] = [
  { key: 'overdue', title: 'Overdue', hint: 'Past due and still open' },
  { key: 'today', title: 'Today', hint: 'Due before the day is out' },
  { key: 'upcoming', title: 'Upcoming', hint: 'Everything still ahead' },
  { key: 'someday', title: 'No date', hint: 'Unscheduled' },
];

const QUICK_DATES: { label: string; days: number | null }[] = [
  { label: 'Today', days: 0 },
  { label: 'Tomorrow', days: 1 },
  { label: 'Next week', days: 7 },
  { label: 'No date', days: null },
];

export default function Todos() {
  const uid = useUid();
  const db = getDb();

  const todos = useCollection<Todo>(query(paths.todos(db, uid), orderBy('dueDate', 'asc')), [uid]);
  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);

  const [title, setTitle] = useState('');
  const [dateText, setDateText] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function addTodo() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setError(null);

    const subject = subjects.data.find((candidate) => candidate.id === subjectId) ?? null;

    try {
      await addDoc(paths.todos(db, uid), {
        title: trimmed,
        dueDate: parseDueDate(dateText),
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
      setDateText('');
      setPriority('medium');
      setSubjectId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const actions: TodoActions = {
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
  };

  function applyQuickDate(days: number | null) {
    if (days === null) {
      setDateText('');
      return;
    }
    const date = new Date();
    date.setDate(date.getDate() + days);
    setDateText(
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate()
      ).padStart(2, '0')}`
    );
  }

  const parsedPreview = parseDueDate(dateText);

  return (
    <ScreenScroll maxWidth={860}>
      <PageHeader
        title="To-dos"
        subtitle={
          syllabusCount > 0
            ? `${open.length} open · ${syllabusCount} pulled from your syllabuses automatically`
            : 'Manual tasks and syllabus deadlines, in one list.'
        }
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Could not save" body={error} />
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
            <Text className="text-sm font-medium text-muted">Due</Text>
            <View className="flex-row flex-wrap gap-2">
              {QUICK_DATES.map((quick) => (
                <Pressable
                  key={quick.label}
                  onPress={() => applyQuickDate(quick.days)}
                  className="rounded-lg border border-line bg-paper px-3 py-1.5"
                >
                  <Text className="text-xs font-medium text-muted">{quick.label}</Text>
                </Pressable>
              ))}
            </View>
            <Field
              value={dateText}
              onChangeText={setDateText}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              autoCorrect={false}
              hint={
                dateText && !parsedPreview
                  ? 'Not a date Notomi recognises — use YYYY-MM-DD.'
                  : undefined
              }
            />
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
