import { useState } from 'react';
import { Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { CountdownChip } from './Countdown';
import { DatePicker } from './DatePicker';
import { Badge, IconButton } from './ui';
import { formatDue, toDate } from '@/lib/dates';
import type { Priority, SubTask, Todo } from '@/lib/schema';
import { PHONE } from '@/lib/breakpoints';

const PRIORITY_TONE: Record<Priority, 'rose' | 'amber' | 'neutral'> = {
  high: 'rose',
  medium: 'amber',
  low: 'neutral',
};

const PRIORITY_ORDER: Priority[] = ['low', 'medium', 'high'];

export type TodoActions = {
  toggle: (todo: Todo) => void;
  remove: (todo: Todo) => void;
  cyclePriority: (todo: Todo) => void;
  setSubTasks: (todo: Todo, subTasks: SubTask[]) => void;
  setDueDate: (todo: Todo, due: Date | null) => void;
  rename: (todo: Todo, title: string) => void;
};

export function TodoRow({
  todo,
  actions,
  overdue,
}: {
  todo: Todo;
  actions: TodoActions;
  overdue: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(todo.title);
  const [confirming, setConfirming] = useState(false);

  /**
   * Below this the row's furniture does not fit beside the title.
   *
   * A checkbox, a priority badge and three icon buttons come to roughly 290
   * points of fixed width. The title column is flex-1 with no floor, so on a
   * phone it got whatever was left — about sixty points — and set one word per
   * line down the whole screen. Widening the title is not the fix; there is
   * genuinely no room for both, so on a narrow screen the controls move to
   * their own line underneath.
   */
  const { width } = useWindowDimensions();
  const narrow = width < PHONE;

  const subTasks = todo.subTasks ?? [];
  const doneCount = subTasks.filter((subTask) => subTask.isCompleted).length;
  const due = toDate(todo.dueDate);

  function addSubTask() {
    const title = draft.trim();
    if (!title) return;
    actions.setSubTasks(todo, [
      ...subTasks,
      { id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, title, isCompleted: false },
    ]);
    setDraft('');
  }

  function toggleSubTask(id: string) {
    actions.setSubTasks(
      todo,
      subTasks.map((subTask) =>
        subTask.id === id ? { ...subTask, isCompleted: !subTask.isCompleted } : subTask
      )
    );
  }

  /** Blur and submit both land here, so an edit is never lost by clicking away. */
  function commitTitle() {
    if (!editing) return;
    setEditing(false);
    const next = titleDraft.trim();
    if (!next || next === todo.title) {
      setTitleDraft(todo.title);
      return;
    }
    actions.rename(todo, next);
  }

  const controls = (
    <>
      <Pressable
        accessibilityLabel={`Priority: ${todo.priority}. Tap to change.`}
        onPress={() => actions.cyclePriority(todo)}
      >
        <Badge label={todo.priority} tone={PRIORITY_TONE[todo.priority] ?? 'neutral'} />
      </Pressable>

      <IconButton
        icon="edit-2"
        label={`Rename ${todo.title}`}
        onPress={() => {
          setTitleDraft(todo.title);
          setEditing(true);
        }}
      />

      {/* Two taps to delete, but both are on the row: a task the student
          cannot see how to remove is exactly what the orphan bug felt like. */}
      <IconButton
        icon={confirming ? 'check' : 'trash-2'}
        tone="rose"
        label={confirming ? `Confirm deleting ${todo.title}` : `Delete ${todo.title}`}
        onPress={() => {
          if (confirming) actions.remove(todo);
          else setConfirming(true);
        }}
      />

      <IconButton
        icon={expanded ? 'chevron-up' : 'chevron-down'}
        label="Toggle subtasks"
        onPress={() => setExpanded((value) => !value)}
      />
    </>
  );

  return (
    <View className="border-t border-line first:border-t-0">
      <View className="flex-row items-start gap-3 px-4 py-3.5">
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: todo.isCompleted }}
          accessibilityLabel={`Mark ${todo.title} ${todo.isCompleted ? 'incomplete' : 'complete'}`}
          onPress={() => actions.toggle(todo)}
          className={`mt-0.5 h-5 w-5 items-center justify-center rounded-md border ${
            todo.isCompleted ? 'border-pine bg-pine' : 'border-subtle bg-surface'
          }`}
        >
          {todo.isCompleted ? <Icon name="check" size={12} color="#FFFFFF" /> : null}
        </Pressable>

        <Pressable
          className="min-w-0 flex-1 gap-1.5"
          onPress={() => setExpanded((value) => !value)}
        >
          {editing ? (
            <TextInput
              value={titleDraft}
              onChangeText={setTitleDraft}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              onSubmitEditing={commitTitle}
              onBlur={commitTitle}
              className="rounded-lg border border-line bg-surface px-2 py-1 text-[15px] text-ink"
            />
          ) : (
            <Text
              className={`text-[15px] leading-6 ${
                todo.isCompleted ? 'text-subtle line-through' : 'text-ink'
              }`}
            >
              {todo.title}
            </Text>
          )}

          <View className="flex-row flex-wrap items-center gap-2">
            {due ? (
              <Text
                className={`text-xs font-medium ${
                  overdue && !todo.isCompleted ? 'text-rose' : 'text-muted'
                }`}
              >
                {formatDue(due)}
              </Text>
            ) : null}

            {due && !todo.isCompleted ? <CountdownChip due={due} compact /> : null}

            {todo.subjectName ? (
              <Text className="text-xs text-subtle" numberOfLines={1}>
                {todo.subjectName}
              </Text>
            ) : null}

            {todo.source === 'syllabus' ? <Badge label="From syllabus" tone="pine" /> : null}

            {subTasks.length > 0 ? (
              <Text className="text-xs text-subtle">
                {doneCount}/{subTasks.length} steps
              </Text>
            ) : null}
          </View>
        </Pressable>

        {narrow ? null : controls}
      </View>

      {narrow ? (
        <View className="flex-row items-center gap-2 px-4 pb-3 pl-12">{controls}</View>
      ) : null}

      {confirming ? (
        <View className="flex-row items-center gap-3 border-t border-line bg-rose-soft/50 px-4 py-2 pl-12">
          <Text className="flex-1 text-xs text-ink/75">
            Press the tick to delete this task permanently.
          </Text>
          <Pressable accessibilityRole="button" onPress={() => setConfirming(false)} hitSlop={6}>
            <Text className="text-xs font-semibold text-muted">Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      {expanded ? (
        <View className="gap-3 border-t border-line bg-paper/60 px-4 py-3 pl-12">
          {/* Reschedule without retyping the task. */}
          <DatePicker
            label="Due date"
            value={due}
            onChange={(next) => actions.setDueDate(todo, next)}
          />

          {subTasks.map((subTask) => (
            <View key={subTask.id} className="flex-row items-center gap-3">
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: subTask.isCompleted }}
                onPress={() => toggleSubTask(subTask.id)}
                className={`h-4 w-4 items-center justify-center rounded border ${
                  subTask.isCompleted ? 'border-pine bg-pine' : 'border-subtle bg-surface'
                }`}
              >
                {subTask.isCompleted ? <Icon name="check" size={9} color="#FFFFFF" /> : null}
              </Pressable>

              <Text
                className={`flex-1 text-sm ${
                  subTask.isCompleted ? 'text-subtle line-through' : 'text-ink/80'
                }`}
              >
                {subTask.title}
              </Text>

              <IconButton
                icon="x"
                label={`Remove ${subTask.title}`}
                onPress={() =>
                  actions.setSubTasks(
                    todo,
                    subTasks.filter((candidate) => candidate.id !== subTask.id)
                  )
                }
              />
            </View>
          ))}

          <View className="flex-row items-center gap-2">
            <Icon name="plus" size={13} color="#9A9488" />
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={addSubTask}
              placeholder="Break this into a step…"
              placeholderTextColor="#9A9488"
              returnKeyType="done"
              className="flex-1 py-1.5 text-sm text-ink"
            />
          </View>

        </View>
      ) : null}
    </View>
  );
}

export function nextPriority(current: Priority): Priority {
  const index = PRIORITY_ORDER.indexOf(current);
  return PRIORITY_ORDER[(index + 1) % PRIORITY_ORDER.length];
}
