import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Touchable } from '@/components/ui';
import {
  DAY_FULL,
  minutesToLabel,
  ROUTINE_CATEGORIES,
  todayIndex,
  type RoutineBlock,
} from '@/lib/schema';
import { laneOut } from '@/lib/timetableLayout';
import type { ResolvedClass } from '@/services/timetable';

/** Compressed from the desktop grid's 56, chosen so a normal week clears the fold. */
const HOUR_HEIGHT = 34;
/** Just wide enough for "10a" without wrapping. */
const RULER_WIDTH = 22;
const HEADER_HEIGHT = 26;

/** One letter per day is all seven columns can afford at this width. */
const INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * The whole teaching week as a time grid, on a phone.
 *
 * The row-per-day list this replaces was a reasonable answer to a hard
 * constraint, but it loses the thing a timetable is actually for: seeing at a
 * glance that Tuesday is empty until noon and Wednesday is solid from nine.
 * Shape carries that; a list does not.
 *
 * The constraint is real and worth being plain about. Seven columns on a
 * 390-point screen leaves about fifty points each — roughly seven characters.
 * No amount of layout puts "Fundamentals of Digital Comp", its venue, its
 * section and its type inside that. So this grid carries what identifies a
 * class at a glance — colour, position, and the module code — and a tap opens
 * the full detail. Nothing is lost; it is one touch away instead of shouted.
 *
 * Vertical extent is bounded by the caller trimming the hour range to the
 * hours actually taught, so a normal week is about four hundred points: no
 * side scrolling, and no scrolling down through an ocean of empty night.
 */
export function CompactWeekGrid({
  classes,
  routines = [],
  firstHour,
  lastHour,
  onSelect,
  onSelectRoutine,
  dates,
  now,
}: {
  classes: ResolvedClass[];
  routines?: RoutineBlock[];
  firstHour: number;
  lastHour: number;
  onSelect?: (block: ResolvedClass) => void;
  onSelectRoutine?: (block: RoutineBlock) => void;
  /** The seven dates of the current teaching week, when a term is running. */
  dates?: Date[] | null;
  /** Minutes since midnight, for the current-time line. Omit to hide it. */
  now?: number | null;
}) {
  const hours = Array.from({ length: Math.max(1, lastHour - firstHour) }, (_, i) => firstHour + i);
  const height = hours.length * HOUR_HEIGHT;
  const today = todayIndex();

  const nowOffset =
    typeof now === 'number' && now >= firstHour * 60 && now <= lastHour * 60
      ? ((now - firstHour * 60) / 60) * HOUR_HEIGHT
      : null;

  return (
    <View className="overflow-hidden rounded-2xl border border-line bg-surface">
      <View className="flex-row">
        {/* Hour ruler */}
        <View className="shrink-0" style={{ width: RULER_WIDTH }}>
          <View className="border-b border-r border-line bg-sand" style={{ height: HEADER_HEIGHT }} />
          <View className="border-r border-line" style={{ height }}>
            {hours.map((hour) => (
              <View key={hour} style={{ height: HOUR_HEIGHT }} className="items-end pr-1 pt-0.5">
                {/* Bare hour, no meridiem: "10" reads fine in a column that is
                    obviously a clock, and "10am" does not fit at all. */}
                <Text className="text-[9px] font-medium text-subtle">
                  {((hour + 11) % 12) + 1}
                </Text>
              </View>
            ))}
          </View>
        </View>

        <View className="flex-1">
          {/* Day header */}
          <View className="flex-row border-b border-line bg-sand" style={{ height: HEADER_HEIGHT }}>
            {INITIALS.map((initial, day) => (
              <View
                key={day}
                className={`flex-1 items-center justify-center border-l border-line ${
                  day === today ? 'bg-accent-soft' : ''
                }`}
              >
                <Text
                  className={`text-[10px] font-bold ${
                    day === today ? 'text-accent' : 'text-muted'
                  }`}
                >
                  {initial}
                  {dates?.[day] ? (
                    <Text className="font-medium text-subtle"> {dates[day].getDate()}</Text>
                  ) : null}
                </Text>
              </View>
            ))}
          </View>

          {/* Day columns */}
          <View className="flex-row" style={{ height }}>
            {INITIALS.map((_, day) => (
              <View
                key={day}
                className={`flex-1 border-l border-line ${day === today ? 'bg-accent-soft/25' : ''}`}
              >
                {hours.map((hour) => (
                  <View key={hour} style={{ height: HOUR_HEIGHT }} className="border-b border-line/60" />
                ))}

                {/* Routines behind, inset and dashed, so a class always reads
                    as the thing in front. */}
                {routines
                  .filter((block) => block.day === day)
                  .map((block) => {
                    const top = ((block.startMinute - firstHour * 60) / 60) * HOUR_HEIGHT;
                    const blockHeight = Math.max(
                      12,
                      ((block.endMinute - block.startMinute) / 60) * HOUR_HEIGHT - 2
                    );
                    const meta = ROUTINE_CATEGORIES.find((entry) => entry.id === block.category);

                    return (
                      <Touchable
                        key={block.id}
                        accessibilityRole="button"
                        accessibilityLabel={`${block.title}, ${DAY_FULL[day]} ${minutesToLabel(
                          block.startMinute
                        )}`}
                        cue="tap"
                        onPress={() => onSelectRoutine?.(block)}
                        className="absolute left-0.5 right-0.5 items-center justify-center overflow-hidden rounded"
                        style={{
                          top: top + 1,
                          height: blockHeight,
                          backgroundColor: `${block.color}12`,
                          borderWidth: 1,
                          borderStyle: 'dashed',
                          borderColor: `${block.color}4D`,
                        }}
                      >
                        <Icon name={meta?.icon ?? 'circle'} size={9} color={block.color} />
                      </Touchable>
                    );
                  })}

                {laneOut(classes.filter((block) => block.day === day)).map(
                  ({ block, lane, lanes }) => {
                    const top = ((block.startMinute - firstHour * 60) / 60) * HOUR_HEIGHT;
                    const blockHeight = Math.max(
                      16,
                      ((block.endMinute - block.startMinute) / 60) * HOUR_HEIGHT - 2
                    );

                    return (
                      <Touchable
                        key={block.id}
                        accessibilityRole="button"
                        // The label carries everything the cell cannot show, so
                        // a screen reader is not held to the same fifty points.
                        accessibilityLabel={[
                          block.subjectName || block.title,
                          block.section,
                          block.venue,
                          `${DAY_FULL[day]} ${minutesToLabel(block.startMinute)} to ${minutesToLabel(
                            block.endMinute
                          )}`,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                        cue="tap"
                        onPress={() => onSelect?.(block)}
                        className="absolute overflow-hidden rounded px-0.5 py-0.5"
                        style={{
                          top: top + 1,
                          height: blockHeight,
                          left: `${(lane / lanes) * 100}%`,
                          width: `${(1 / lanes) * 100}%`,
                          backgroundColor: `${block.color}26`,
                          borderLeftWidth: 2,
                          borderLeftColor: block.color,
                        }}
                      >
                        {/* The code identifies the class in seven characters
                            where the name needs thirty. Falls back to the name
                            for anything without one. */}
                        <Text
                          className="text-[8px] font-bold leading-[10px] text-ink"
                          numberOfLines={blockHeight > 30 ? 2 : 1}
                        >
                          {block.code || block.subjectName || block.title}
                        </Text>
                        {blockHeight >= 44 && block.section ? (
                          <Text className="text-[7px] leading-[9px] text-muted" numberOfLines={1}>
                            {block.section}
                          </Text>
                        ) : null}
                        {blockHeight >= 62 && block.venue ? (
                          <Text className="text-[7px] leading-[9px] text-subtle" numberOfLines={1}>
                            {block.venue}
                          </Text>
                        ) : null}
                      </Touchable>
                    );
                  }
                )}

                {day === today && nowOffset !== null ? (
                  <View
                    pointerEvents="none"
                    className="absolute left-0 right-0 flex-row items-center"
                    style={{ top: nowOffset }}
                  >
                    <View className="h-1 w-1 rounded-full bg-accent" />
                    <View className="h-px flex-1 bg-accent" />
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        </View>
      </View>

      <View className="border-t border-line bg-sand px-2.5 py-1.5">
        <Text className="text-[10px] text-subtle">Tap any class for its room, type and times.</Text>
      </View>
    </View>
  );
}
