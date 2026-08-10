import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { countdown, type Countdown as CountdownValue } from '@/lib/dates';

/**
 * Ticks a countdown without re-rendering the whole screen every second.
 *
 * The interval adapts to the magnitude: a deadline three weeks out does not
 * need per-second updates, and a phone left open on the calendar should not
 * burn battery on them.
 */
export function useCountdown(due: Date | null): CountdownValue | null {
  const [value, setValue] = useState(() => countdown(due));

  useEffect(() => {
    if (!due) {
      setValue(null);
      return;
    }

    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      const next = countdown(due);
      setValue(next);
      if (!next) return;

      // Under an hour the seconds matter; beyond a day they do not.
      const interval = next.days > 0 ? 60_000 : next.hours > 0 ? 30_000 : 1_000;
      timer = setTimeout(tick, interval);
    };

    tick();
    return () => clearTimeout(timer);
  }, [due?.getTime()]);

  return value;
}

/** Colour follows urgency so a glance across the page ranks by pressure. */
function tone(value: CountdownValue): { text: string; surface: string } {
  if (value.overdue) return { text: 'text-rose', surface: 'bg-rose-soft' };
  if (value.days === 0) return { text: 'text-accent', surface: 'bg-accent-soft' };
  if (value.days <= 3) return { text: 'text-amber', surface: 'bg-amber-soft' };
  return { text: 'text-muted', surface: 'bg-sand' };
}

export function CountdownChip({ due, compact = false }: { due: Date | null; compact?: boolean }) {
  const value = useCountdown(due);
  if (!value) return null;

  const { text, surface } = tone(value);

  return (
    <View className={`self-start rounded-full px-2.5 py-1 ${surface}`}>
      <Text className={`text-xs font-semibold ${text}`}>
        {compact ? value.short : value.long}
      </Text>
    </View>
  );
}

/** Large countdown for the calendar's "next up" panel. */
export function CountdownBlock({ due }: { due: Date | null }) {
  const value = useCountdown(due);
  if (!value) return null;

  const { text } = tone(value);
  const parts: { value: number; label: string }[] = [
    { value: value.days, label: value.days === 1 ? 'day' : 'days' },
    { value: value.hours, label: 'hr' },
    { value: value.minutes, label: 'min' },
  ];

  return (
    <View className="gap-1">
      <View className="flex-row items-end gap-3">
        {parts.map((part) => (
          <View key={part.label} className="items-center">
            <Text className={`text-2xl font-bold tabular-nums ${text}`}>
              {String(part.value).padStart(2, '0')}
            </Text>
            <Text className="text-[10px] uppercase tracking-wider text-subtle">{part.label}</Text>
          </View>
        ))}
      </View>
      {value.overdue ? (
        <Text className="text-xs font-semibold text-rose">overdue</Text>
      ) : null}
    </View>
  );
}
