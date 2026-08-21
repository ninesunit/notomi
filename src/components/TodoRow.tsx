import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { Icon, useTones } from '@/components/Icon';
import { CountdownChip } from './Countdown';
import { DatePicker } from './DatePicker';
import { Badge, Button, Field, IconButton } from './ui';
import { Sheet } from './Sheet';
import { formatDue, toDate } from '@/lib/dates';
import type { Priority, SubTask, Todo } from '@/lib/schema';
import { PHONE } from '@/lib/breakpoints';
import { feedback } from '@/lib/sound';

const PRIORITY_TONE: Record<Priority, 'rose' | 'amber' | 'neutral'> = {
  high: 'rose',
  medium: 'amber',
  low: 'neutral',
};

const PRIORITY_ORDER: Priority[] = ['low', 'medium', 'high'];

/** A dot rather than a word: on a compact row the word is most of the row. */
const PRIORITY_DOT: Record<Priority, string> = {
  high: 'bg-rose',
  medium: 'bg-amber',
  low: 'bg-line',
};

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
  const [detailOpen, setDetailOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState(todo.title);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /**
   * Below this the row's furniture does not fit beside the title.
   *
   * A checkbox, a priority badge and three icon buttons come to roughly 290
   * points of fixed width. The title column is flex-1 with no floor, so on a
   * phone it got whatever was left — about sixty points — and set one word per
   * line down the whole screen. Widening the title is not the fix; there is
   * genuinely no room for both, so on a narrow screen the row becomes one
   * line and everything else moves into a sheet the row opens.
   */
  const { width } = useWindowDimensions();
  const narrow = width < PHONE;

  const subTasks = todo.subTasks ?? [];
  const doneCount = subTasks.filter((subTask) => subTask.isCompleted).length;
  const due = toDate(todo.dueDate);

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

  /* ------------------------------ Phone ------------------------------ */

  if (narrow) {
    /*
     * One line per task.
     *
     * The old phone row carried the title, a due date, a subject, a syllabus
     * badge and a menu button, wrapping to three lines and about 140 points —
     * so an iPhone showed three tasks. Everything except the title, the state
     * and when it is due is detail, and detail is what a tap is for.
     */
    return (
      <View className="border-t border-line first:border-t-0">
        <View className="flex-row items-center gap-2.5 px-3 py-2.5">
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: todo.isCompleted }}
            accessibilityLabel={`Mark ${todo.title} ${todo.isCompleted ? 'incomplete' : 'complete'}`}
            onPress={() => {
              feedback(todo.isCompleted ? 'toggle' : 'complete', 12);
              actions.toggle(todo);
            }}
            hitSlop={8}
            className={`h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
              todo.isCompleted ? 'border-pine bg-pine' : 'border-subtle bg-surface'
            }`}
          >
            {todo.isCompleted ? <Icon name="check" size={12} tone="inverse" /> : null}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${todo.title}. ${
              due ? formatDue(due) : 'No due date'
            }. Opens the full task.`}
            onPress={() => setDetailOpen(true)}
            className="min-w-0 flex-1 flex-row items-center gap-2"
          >
            <View className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[todo.priority]}`} />
            <Text
              numberOfLines={1}
              className={`min-w-0 flex-1 text-[15px] ${
                todo.isCompleted ? 'text-subtle line-through' : 'text-ink'
              }`}
            >
              {todo.title}
            </Text>
            {subTasks.length > 0 ? (
              <Text className="shrink-0 text-[11px] tabular-nums text-subtle">
                {doneCount}/{subTasks.length}
              </Text>
            ) : null}
            {due ? (
              <Text
                numberOfLines={1}
                className={`shrink-0 text-[11px] font-medium ${
                  overdue && !todo.isCompleted ? 'text-rose' : 'text-muted'
                }`}
              >
                {shortDue(due)}
              </Text>
            ) : null}
            <Icon name="chevron-right" size={14} tone="subtle" />
          </Pressable>
        </View>

        <TaskDetailSheet
          visible={detailOpen}
          onClose={() => setDetailOpen(false)}
          todo={todo}
          actions={actions}
          overdue={overdue}
        />
      </View>
    );
  }

  /* ----------------------------- Desktop ----------------------------- */

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
          onPress={() => {
            feedback(todo.isCompleted ? 'toggle' : 'complete', 12);
            actions.toggle(todo);
          }}
          className={`mt-0.5 h-5 w-5 items-center justify-center rounded-md border ${
            todo.isCompleted ? 'border-pine bg-pine' : 'border-subtle bg-surface'
          }`}
        >
          {todo.isCompleted ? <Icon name="check" size={12} tone="inverse" /> : null}
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
              className="rounded-lg border border-line bg-surface px-2 py-1 text-base text-ink"
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

        {controls}
      </View>

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
          <DatePicker
            label="Due date"
            value={due}
            onChange={(next) => actions.setDueDate(todo, next)}
          />
          <SubTaskList todo={todo} actions={actions} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The whole task, on request.
 *
 * On a phone this is the only place a task can be edited, which is the point.
 * Renaming used to be an autofocused input inside the row — inside a Pressable,
 * inside a swipeable, and opened from a modal that was closing at the moment
 * the field asked for focus. On iOS the field lost focus to the closing modal
 * and its own blur handler immediately committed and dismissed it, so the
 * keyboard flashed and nothing changed. A field in a sheet that is already
 * open has none of those problems.
 */
function TaskDetailSheet({
  visible,
  onClose,
  todo,
  actions,
  overdue,
}: {
  visible: boolean;
  onClose: () => void;
  todo: Todo;
  actions: TodoActions;
  overdue: boolean;
}) {
  const [title, setTitle] = useState(todo.title);
  const [confirming, setConfirming] = useState(false);
  const due = toDate(todo.dueDate);

  // Reopening shows what is stored, not what was typed and abandoned last time.
  useEffect(() => {
    if (visible) {
      setTitle(todo.title);
      setConfirming(false);
    }
  }, [visible, todo.title]);

  function save() {
    const next = title.trim();
    if (next && next !== todo.title) actions.rename(todo, next);
    onClose();
  }

  return (
    <Sheet
      visible={visible}
      onClose={save}
      title="Task"
      icon="check-square"
      variant="fullscreen-mobile"
      dismissOnScrim={false}
      primaryAction={{ label: 'Done', onPress: save }}
    >
      <View className="gap-5">
        <Field
          label="Task"
          value={title}
          onChangeText={setTitle}
          multiline
          placeholder="What needs doing?"
          returnKeyType="done"
          onSubmitEditing={save}
        />

        <View className="flex-row flex-wrap items-center gap-2">
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: todo.isCompleted }}
            onPress={() => {
              feedback(todo.isCompleted ? 'toggle' : 'complete', 12);
              actions.toggle(todo);
            }}
            className={`flex-row items-center gap-2 rounded-xl border px-3 py-2.5 ${
              todo.isCompleted ? 'border-pine bg-pine-soft' : 'border-line bg-surface'
            }`}
          >
            <Icon name={todo.isCompleted ? 'check-circle' : 'circle'} size={16} tone={todo.isCompleted ? 'pine' : 'muted'} />
            <Text className={`text-sm font-semibold ${todo.isCompleted ? 'text-pine' : 'text-ink'}`}>
              {todo.isCompleted ? 'Completed' : 'Mark complete'}
            </Text>
          </Pressable>
          {todo.subjectName ? (
            <View className="rounded-xl bg-sand px-3 py-2.5">
              <Text className="text-sm font-medium text-muted" numberOfLines={1}>
                {todo.subjectName}
              </Text>
            </View>
          ) : null}
          {todo.source === 'syllabus' ? <Badge label="From syllabus" tone="pine" /> : null}
        </View>

        <View className="gap-2">
          <Text className="text-sm font-medium text-muted">Priority</Text>
          <View className="flex-row gap-2">
            {PRIORITY_ORDER.map((level) => (
              <Pressable
                key={level}
                accessibilityRole="radio"
                accessibilityState={{ selected: todo.priority === level }}
                onPress={() => {
                  if (todo.priority !== level) actions.cyclePriority(todo);
                }}
                disabled={todo.priority === level}
                className={`flex-1 flex-row items-center justify-center gap-2 rounded-xl border py-2.5 ${
                  todo.priority === level ? 'border-ink bg-ink' : 'border-line bg-surface'
                }`}
              >
                <View className={`h-2 w-2 rounded-full ${PRIORITY_DOT[level]}`} />
                <Text
                  className={`text-xs font-semibold capitalize ${
                    todo.priority === level ? 'text-paper' : 'text-muted'
                  }`}
                >
                  {level}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View className="gap-2">
          <DatePicker
            label="Due date"
            value={due}
            onChange={(next) => actions.setDueDate(todo, next)}
          />
          {due && !todo.isCompleted ? (
            <View className="flex-row items-center gap-2">
              <CountdownChip due={due} compact />
              <Text className={`text-xs ${overdue ? 'text-rose' : 'text-muted'}`}>
                {formatDue(due)}
              </Text>
            </View>
          ) : null}
        </View>

        <View className="gap-2">
          <Text className="text-sm font-medium text-muted">Steps</Text>
          <SubTaskList todo={todo} actions={actions} />
        </View>

        <View className="gap-2 border-t border-line pt-4">
          {confirming ? (
            <>
              <Text className="text-xs leading-5 text-muted">
                This deletes the task. You will have five seconds to undo it.
              </Text>
              <Button
                label="Yes, delete this task"
                icon="trash-2"
                variant="danger"
                onPress={() => {
                  onClose();
                  actions.remove(todo);
                }}
              />
              <Button label="Keep it" variant="ghost" onPress={() => setConfirming(false)} />
            </>
          ) : (
            <Button
              label="Delete task"
              icon="trash-2"
              variant="danger"
              onPress={() => setConfirming(true)}
            />
          )}
        </View>
      </View>
    </Sheet>
  );
}

function SubTaskList({ todo, actions }: { todo: Todo; actions: TodoActions }) {
  const tones = useTones();
  const [draft, setDraft] = useState('');
  const subTasks = todo.subTasks ?? [];

  function addSubTask() {
    const title = draft.trim();
    if (!title) return;
    actions.setSubTasks(todo, [
      ...subTasks,
      { id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, title, isCompleted: false },
    ]);
    setDraft('');
  }

  return (
    <View className="gap-3">
      {subTasks.map((subTask) => (
        <View key={subTask.id} className="flex-row items-center gap-3">
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: subTask.isCompleted }}
            accessibilityLabel={subTask.title}
            hitSlop={8}
            onPress={() =>
              actions.setSubTasks(
                todo,
                subTasks.map((candidate) =>
                  candidate.id === subTask.id
                    ? { ...candidate, isCompleted: !candidate.isCompleted }
                    : candidate
                )
              )
            }
            className={`h-4 w-4 items-center justify-center rounded border ${
              subTask.isCompleted ? 'border-pine bg-pine' : 'border-subtle bg-surface'
            }`}
          >
            {subTask.isCompleted ? <Icon name="check" size={9} tone="inverse" /> : null}
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
        <Icon name="plus" size={13} tone="subtle" />
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={addSubTask}
          placeholder="Break this into a step…"
          placeholderTextColor={tones.subtle}
          returnKeyType="done"
          className="flex-1 py-1.5 text-base text-ink"
        />
      </View>
    </View>
  );
}

/** "Fri 3 Oct" rather than "in 4 days" — a compact row has no room to explain. */
function shortDue(due: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(due);
  day.setHours(0, 0, 0, 0);
  const offset = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  if (offset === -1) return 'Yesterday';
  if (offset < 0) return `${Math.abs(offset)}d late`;
  if (offset < 7) return due.toLocaleDateString(undefined, { weekday: 'short' });
  return due.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function nextPriority(current: Priority): Priority {
  const index = PRIORITY_ORDER.indexOf(current);
  return PRIORITY_ORDER[(index + 1) % PRIORITY_ORDER.length];
}
