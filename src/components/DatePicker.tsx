import { useMemo, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Button } from './ui';
import { MonthCalendar } from './MonthCalendar';
import { formatDue } from '@/lib/dates';

const QUICK: { label: string; days: number | null }[] = [
  { label: 'Today', days: 0 },
  { label: 'Tomorrow', days: 1 },
  { label: 'This weekend', days: -1 }, // resolved below
  { label: 'Next week', days: 7 },
];

/** Common deadline times, so a due date is not silently "midnight". */
const TIMES: { label: string; hour: number; minute: number }[] = [
  { label: '9:00', hour: 9, minute: 0 },
  { label: '12:00', hour: 12, minute: 0 },
  { label: '17:00', hour: 17, minute: 0 },
  { label: '23:59', hour: 23, minute: 59 },
];

function upcomingSaturday(): Date {
  const date = new Date();
  const delta = (6 - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + delta);
  return date;
}

/**
 * Calendar-backed due-date control.
 *
 * Replaces the old free-text YYYY-MM-DD field: typing a date is error-prone,
 * gives no sense of which weekday it lands on, and cannot show that three
 * other deadlines already sit that week.
 */
export function DatePicker({
  value,
  onChange,
  label = 'Due',
  placeholder = 'No date',
  markers,
}: {
  value: Date | null;
  onChange: (date: Date | null) => void;
  label?: string;
  placeholder?: string;
  markers?: Map<string, { color: string; overdue?: boolean }[]>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Date | null>(value);
  const [month, setMonth] = useState(
    () => new Date((value ?? new Date()).getFullYear(), (value ?? new Date()).getMonth(), 1)
  );

  const summary = useMemo(() => {
    if (!value) return placeholder;
    const relative = formatDue(value);
    const exact = value.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    const time = value.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${exact}, ${time} · ${relative}`;
  }, [value, placeholder]);

  function openPicker() {
    setDraft(value);
    setMonth(new Date((value ?? new Date()).getFullYear(), (value ?? new Date()).getMonth(), 1));
    setOpen(true);
  }

  function pickQuick(days: number | null) {
    if (days === null) return;
    const date = days === -1 ? upcomingSaturday() : new Date();
    if (days >= 0) date.setDate(date.getDate() + days);
    // Keep whatever time the draft already had, else default to end of day.
    date.setHours(draft?.getHours() ?? 23, draft?.getMinutes() ?? 59, 0, 0);
    setDraft(date);
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
  }

  function pickDay(date: Date) {
    const next = new Date(date);
    next.setHours(draft?.getHours() ?? 23, draft?.getMinutes() ?? 59, 0, 0);
    setDraft(next);
  }

  function pickTime(hour: number, minute: number) {
    const next = new Date(draft ?? new Date());
    next.setHours(hour, minute, 0, 0);
    setDraft(next);
  }

  return (
    <View className="gap-1.5">
      {label ? <Text className="text-sm font-medium text-muted">{label}</Text> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${summary}`}
        onPress={openPicker}
        className="flex-row items-center gap-2.5 rounded-xl border border-line bg-surface px-4 py-3"
      >
        <Icon name="calendar" size={15} tone={value ? 'accent' : 'subtle'} />
        <Text className={`flex-1 text-[15px] ${value ? 'text-ink' : 'text-subtle'}`}>{summary}</Text>
        {value ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear date"
            onPress={() => onChange(null)}
            hitSlop={8}
          >
            <Icon name="x" size={14} tone="subtle" />
          </Pressable>
        ) : null}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View className="flex-1 items-center justify-center bg-ink/40 px-5">
          <View className="w-full max-w-sm gap-4 rounded-2xl border border-line bg-surface p-5">
            <View className="flex-row items-center justify-between">
              <Text className="text-[15px] font-semibold text-ink">Pick a due date</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={() => setOpen(false)}
                className="h-8 w-8 items-center justify-center rounded-lg"
              >
                <Icon name="x" size={16} tone="muted" />
              </Pressable>
            </View>

            <View className="flex-row flex-wrap gap-2">
              {QUICK.map((quick) => (
                <Pressable
                  key={quick.label}
                  onPress={() => pickQuick(quick.days)}
                  className="rounded-lg border border-line bg-paper px-3 py-1.5"
                >
                  <Text className="text-xs font-medium text-muted">{quick.label}</Text>
                </Pressable>
              ))}
            </View>

            <MonthCalendar
              compact
              month={month}
              onMonthChange={setMonth}
              selected={draft}
              onSelectDay={pickDay}
              markers={markers}
            />

            <View className="gap-2">
              <Text className="text-xs font-semibold uppercase tracking-wider text-subtle">
                Time
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {TIMES.map((time) => {
                  const active =
                    draft?.getHours() === time.hour && draft?.getMinutes() === time.minute;
                  return (
                    <Pressable
                      key={time.label}
                      onPress={() => pickTime(time.hour, time.minute)}
                      className={`rounded-lg border px-3 py-1.5 ${
                        active ? 'border-ink bg-ink' : 'border-line bg-paper'
                      }`}
                    >
                      <Text
                        className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}
                      >
                        {time.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View className="flex-row items-center justify-between gap-2 border-t border-line pt-4">
              <Button
                label="No date"
                variant="ghost"
                size="sm"
                onPress={() => {
                  onChange(null);
                  setOpen(false);
                }}
              />
              <Button
                label="Set date"
                size="sm"
                disabled={!draft}
                onPress={() => {
                  if (draft) onChange(draft);
                  setOpen(false);
                }}
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
