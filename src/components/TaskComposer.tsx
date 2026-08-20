import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { DatePicker } from '@/components/DatePicker';
import { Reveal } from '@/components/motion';
import { Button, Field } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { Priority, Subject } from '@/lib/schema';

export type NewTask = {
  title: string;
  dueDate: Date | null;
  priority: Priority;
  subjectId: string | null;
};

const PRIORITIES: Priority[] = ['low', 'medium', 'high'];

/**
 * Everything needed to add a task, without deciding where it sits.
 *
 * Lifted out of the Task Board so the same fields can be an inline card on a
 * desktop and a bottom sheet on a phone. On a 390-point screen this form ran to
 * about five hundred points, and with the page header above it that was the
 * whole first screen — every task pushed out of sight behind a form the student
 * was not using.
 *
 * It owns its own draft state and hands finished tasks up. The Firestore write
 * stays with the screen, so this component works anywhere the caller can save:
 * the Calendar uses it too, pre-filled with whichever day is selected.
 */
export function TaskComposer({
  subjects,
  markers,
  onSubmit,
  initialDueDate = null,
  submitLabel = 'Add task',
  autoFocus = false,
}: {
  subjects: Subject[];
  markers?: Map<string, { color: string; overdue?: boolean }[]>;
  /** Resolves when saved; the draft is only cleared then. */
  onSubmit: (task: NewTask) => Promise<void>;
  initialDueDate?: Date | null;
  submitLabel?: string;
  autoFocus?: boolean;
}) {
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState<Date | null>(initialDueDate);
  const [priority, setPriority] = useState<Priority>('medium');
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Collapsed by default, and not only to save room.
   *
   * The chip list grows with the student's subject count, so it is the one part
   * of this form with no upper bound. Inside a bottom sheet that matters twice
   * over: the sheet caps its body at a fraction of the window height, and on
   * iOS that height does not shrink when the keyboard appears — so an unbounded
   * list here is what pushes the save button under the keys.
   */
  const [subjectsOpen, setSubjectsOpen] = useState(false);
  const chosen = subjects.find((subject) => subject.id === subjectId) ?? null;

  const save = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit({ title: trimmed, dueDate, priority, subjectId });
      setTitle('');
      setDueDate(null);
      setPriority('medium');
      setSubjectId(null);
      setSubjectsOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-4">
      <Field
        label="New task"
        value={title}
        onChangeText={setTitle}
        placeholder="Draft the literature review"
        onSubmitEditing={() => void save()}
        returnKeyType="done"
        autoFocus={autoFocus}
      />

      {/* One row, so the sheet stays short enough to clear the keyboard. */}
      <View className="flex-row flex-wrap items-end gap-3">
        <View className="min-w-0 flex-1 gap-2" style={{ minWidth: 180 }}>
          <DatePicker value={dueDate} onChange={setDueDate} markers={markers} />
        </View>

        <View className="gap-2">
          <Text className="text-sm font-medium text-muted">Priority</Text>
          <View className="flex-row gap-2">
            {PRIORITIES.map((level) => (
              <Pressable
                key={level}
                accessibilityRole="button"
                accessibilityState={{ selected: priority === level }}
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

      {subjects.length > 0 ? (
        <View className="gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: subjectsOpen }}
            onPress={() => setSubjectsOpen((open) => !open)}
            className="flex-row items-center gap-1.5 self-start py-0.5"
          >
            <Text className="text-sm font-medium text-muted">
              Subject{chosen ? `: ${chosen.moduleCode || chosen.name}` : ' (optional)'}
            </Text>
            <Icon name={subjectsOpen ? 'chevron-up' : 'chevron-down'} size={14} tone="subtle" />
          </Pressable>

          <Reveal open={subjectsOpen}>
            <View className="flex-row flex-wrap gap-2 pt-1">
              {subjects.map((subject) => (
                <Pressable
                  key={subject.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: subjectId === subject.id }}
                  onPress={() => setSubjectId(subjectId === subject.id ? null : subject.id)}
                  className={`rounded-lg border px-3 py-1.5 ${
                    subjectId === subject.id
                      ? 'border-accent bg-accent-soft'
                      : 'border-line bg-paper'
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
          </Reveal>
        </View>
      ) : null}

      <Button
        label={submitLabel}
        icon="plus"
        onPress={() => void save()}
        disabled={!title.trim()}
        loading={busy}
        className="self-start"
      />
    </View>
  );
}
