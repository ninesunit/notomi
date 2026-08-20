import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import {
  addMonths,
  dayKey,
  isSameDay,
  monthGrid,
  monthLabel,
  weekdayLabels,
} from '@/lib/dates';

export type DayMarker = {
  /** Dot colour for the day cell. */
  color: string;
  /** Whether any item on this day is already past due. */
  overdue?: boolean;
};

type Props = {
  /** Which month to display. Uncontrolled if omitted. */
  month?: Date;
  onMonthChange?: (month: Date) => void;
  selected?: Date | null;
  onSelectDay?: (date: Date) => void;
  /** dayKey -> markers, drawn as dots under the date. */
  markers?: Map<string, DayMarker[]>;
  /** Dim past days — useful when picking a due date. */
  disablePast?: boolean;
  compact?: boolean;
};

/**
 * Month grid used both as the calendar page and as the to-do date picker.
 *
 * Always renders six weeks so the height never changes between months; a grid
 * that resizes as you page through it is genuinely harder to scan.
 */
export function MonthCalendar({
  month: controlledMonth,
  onMonthChange,
  selected,
  onSelectDay,
  markers,
  disablePast = false,
  compact = false,
}: Props) {
  const [uncontrolled, setUncontrolled] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  );
  const month = controlledMonth ?? uncontrolled;

  const setMonth = (next: Date) => {
    if (onMonthChange) onMonthChange(next);
    else setUncontrolled(next);
  };

  const cells = useMemo(() => monthGrid(month), [month]);
  const weekdays = useMemo(() => weekdayLabels(), []);
  const todayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between">
        <Text className={`font-semibold tracking-tight text-ink ${compact ? 'text-[15px]' : 'text-lg'}`}>
          {monthLabel(month)}
        </Text>

        <View className="flex-row items-center gap-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous month"
            onPress={() => setMonth(addMonths(month, -1))}
            className="h-8 w-8 items-center justify-center rounded-lg bg-sand"
          >
            <Icon name="chevron-left" size={15} tone="muted" />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Today"
            onPress={() => setMonth(new Date(todayStart.getFullYear(), todayStart.getMonth(), 1))}
            className="rounded-lg bg-sand px-2.5 py-1.5"
          >
            <Text className="text-xs font-semibold text-muted">Today</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next month"
            onPress={() => setMonth(addMonths(month, 1))}
            className="h-8 w-8 items-center justify-center rounded-lg bg-sand"
          >
            <Icon name="chevron-right" size={15} tone="muted" />
          </Pressable>
        </View>
      </View>

      <View className="flex-row">
        {weekdays.map((day) => (
          <View key={day} className="flex-1 items-center pb-1.5">
            <Text className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
              {day}
            </Text>
          </View>
        ))}
      </View>

      <View className="flex-row flex-wrap">
        {cells.map((cell) => {
          const dots = markers?.get(cell.key) ?? [];
          const isSelected = selected ? isSameDay(cell.date, selected) : false;
          const isPast = cell.date < todayStart;
          const disabled = disablePast && isPast;

          return (
            <View key={cell.key} style={{ width: `${100 / 7}%` }} className="items-center py-0.5">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={cell.date.toDateString()}
                accessibilityState={{ selected: isSelected, disabled }}
                disabled={disabled || !onSelectDay}
                onPress={() => onSelectDay?.(cell.date)}
                className={`w-full items-center justify-center rounded-xl ${
                  compact ? 'py-1.5' : 'py-2'
                } ${
                  isSelected
                    ? 'bg-ink'
                    : cell.isToday
                      ? 'bg-accent-soft'
                      : ''
                }`}
              >
                <Text
                  className={`${compact ? 'text-[13px]' : 'text-sm'} ${
                    isSelected
                      ? 'font-bold text-paper'
                      : cell.isToday
                        ? 'font-bold text-accent'
                        : cell.inMonth
                          ? disabled
                            ? 'text-subtle'
                            : 'text-ink'
                          : 'text-subtle/50'
                  }`}
                >
                  {cell.date.getDate()}
                </Text>

                {/* Fixed-height dot row keeps every cell the same height. */}
                <View className="mt-0.5 h-1.5 flex-row items-center gap-0.5">
                  {dots.slice(0, 3).map((marker, index) => (
                    <View
                      key={index}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        backgroundColor: isSelected
                          ? '#F7F5EE'
                          : marker.overdue
                            ? '#B0443E'
                            : marker.color,
                      }}
                    />
                  ))}
                  {dots.length > 3 ? (
                    <Text
                      className={`text-[9px] font-bold ${isSelected ? 'text-paper' : 'text-subtle'}`}
                    >
                      +
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export { dayKey };
