import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform, Text, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
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
import { subjectInk, subjectTint } from '@/lib/color';

const RULER_WIDTH = 22;
const HEADER_HEIGHT = 26;
const FOOTER_HEIGHT = 28;
/** Below this an hour row is too short to hold even one line of text. */
const MIN_HOUR_HEIGHT = 26;
const MAX_HOUR_HEIGHT = 56;
const DEFAULT_HOUR_HEIGHT = 34;

/**
 * Wide enough for a course code, a time and a room without wrapping.
 *
 * Measured rather than guessed: "CQCR2003-FCI" at the 8pt the cells use is
 * about eighty points, so a column narrower than this cannot show a room no
 * matter how the text is arranged.
 */
const DETAIL_COLUMN_WIDTH = 85;

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** "LDCW6123" reads as "LDCW" — the letters are what a student recognises. */
function abbreviate(block: ResolvedClass): string {
  const source = block.code || block.subjectName || block.title || '';
  const letters = source.replace(/[^A-Za-z]/g, '');
  return (letters.slice(0, 4) || source.slice(0, 4)).toUpperCase();
}

/**
 * The teaching week as a time grid, on a phone, showing only the days asked for.
 *
 * Two constraints fight here and the resolution is to let the student pick
 * which one binds. Seven columns on a phone leaves fifty points each, which
 * fits a four-letter abbreviation and nothing else — enough to see the *shape*
 * of a week, which is what a whole-week view is for. Hide the weekend and the
 * five remaining columns stretch past eighty-five points, where a code, a time
 * and a room all fit. So the same grid is a heatmap or a detail view depending
 * on how much week is on screen, and it changes by itself rather than asking.
 *
 * Vertical never scrolls when `fitViewport` is set: the hour rows divide
 * whatever height is actually available instead of assuming one. Combined with
 * cropping the range to the hours taught *on the visible days*, hiding a day
 * with an early class reclaims that hour for everything else.
 */
export function CompactWeekGrid({
  classes,
  routines = [],
  visibleDays = ALL_DAYS,
  onSelect,
  onSelectRoutine,
  dates,
  now,
  fitViewport = false,
}: {
  classes: ResolvedClass[];
  routines?: RoutineBlock[];
  /** Day indices to render, Monday 0. Defaults to the whole week. */
  visibleDays?: number[];
  onSelect?: (block: ResolvedClass) => void;
  onSelectRoutine?: (block: RoutineBlock) => void;
  dates?: Date[] | null;
  /** Minutes since midnight, for the current-time line. Omit to hide it. */
  now?: number | null;
  /** Size the hour rows to the space left on screen, so nothing scrolls. */
  fitViewport?: boolean;
}) {
  const today = todayIndex();
  const days = visibleDays.length > 0 ? [...visibleDays].sort((a, b) => a - b) : ALL_DAYS;

  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const containerRef = useRef<View>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const [gridWidth, setGridWidth] = useState<number>(windowWidth);

  /**
   * How much screen is left below the top of the grid.
   *
   * Measured in window coordinates because the grid does not know what sits
   * above it — a page header on one screen, two rows of filters on another —
   * and hard-coding that offset is how a "fits exactly" layout stops fitting
   * the moment anything above it changes.
   */
  const measure = useCallback(
    (event: LayoutChangeEvent) => {
      setGridWidth(event.nativeEvent.layout.width);
      if (!fitViewport) return;
      containerRef.current?.measureInWindow((_x, y) => {
        // 16 points of breathing room at the bottom, plus the home indicator.
        const remaining = windowHeight - y - 32;
        setAvailable(remaining > 120 ? remaining : null);
      });
    },
    [fitViewport, windowHeight]
  );

  /** The hours taught on the days actually on screen, padded by one either side. */
  const [firstHour, lastHour] = useMemo(() => {
    const shown = new Set(days);
    const blocks = [
      ...classes.filter((block) => shown.has(block.day)),
      ...routines.filter((block) => shown.has(block.day)),
    ];
    if (blocks.length === 0) return [8, 18];
    const start = Math.min(...blocks.map((block) => block.startMinute));
    const end = Math.max(...blocks.map((block) => block.endMinute));
    return [Math.max(0, Math.floor(start / 60) - 1), Math.min(24, Math.ceil(end / 60) + 1)];
  }, [classes, routines, days]);

  const hours = Array.from({ length: Math.max(1, lastHour - firstHour) }, (_, i) => firstHour + i);

  const hourHeight = useMemo(() => {
    if (!fitViewport || available === null) return DEFAULT_HOUR_HEIGHT;
    const forRows = available - HEADER_HEIGHT - FOOTER_HEIGHT;
    return Math.max(MIN_HOUR_HEIGHT, Math.min(MAX_HOUR_HEIGHT, forRows / hours.length));
  }, [fitViewport, available, hours.length]);

  const height = hours.length * hourHeight;

  /** Detail or heatmap, decided by the width each column actually gets. */
  const columnWidth = Math.max(1, (gridWidth - RULER_WIDTH) / days.length);
  const detail = columnWidth >= DETAIL_COLUMN_WIDTH;

  const nowOffset =
    typeof now === 'number' && now >= firstHour * 60 && now <= lastHour * 60
      ? ((now - firstHour * 60) / 60) * hourHeight
      : null;

  return (
    <View
      ref={containerRef}
      onLayout={measure}
      className="overflow-hidden rounded-2xl border border-line bg-surface"
    >
      <View className="flex-row">
        <View className="shrink-0" style={{ width: RULER_WIDTH }}>
          <View className="border-b border-r border-line bg-sand" style={{ height: HEADER_HEIGHT }} />
          <View className="border-r border-line" style={{ height }}>
            {hours.map((hour) => (
              <View key={hour} style={{ height: hourHeight }} className="items-end pr-1 pt-0.5">
                <Text className="text-[9px] font-medium text-subtle">{((hour + 11) % 12) + 1}</Text>
              </View>
            ))}
          </View>
        </View>

        <View className="flex-1">
          <View className="flex-row border-b border-line bg-sand" style={{ height: HEADER_HEIGHT }}>
            {days.map((day) => (
              <View
                key={day}
                className={`flex-1 items-center justify-center border-l border-line ${
                  day === today ? 'bg-accent-soft' : ''
                }`}
              >
                <Text
                  className={`text-[10px] font-bold ${day === today ? 'text-accent' : 'text-muted'}`}
                >
                  {detail ? DAY_FULL[day].slice(0, 3) : DAY_FULL[day][0]}
                  {dates?.[day] ? (
                    <Text className="font-medium text-subtle"> {dates[day].getDate()}</Text>
                  ) : null}
                </Text>
              </View>
            ))}
          </View>

          <View className="flex-row" style={{ height }}>
            {days.map((day) => (
              <View
                key={day}
                className={`flex-1 border-l border-line ${day === today ? 'bg-accent-soft/25' : ''}`}
              >
                {hours.map((hour) => (
                  <View
                    key={hour}
                    style={{ height: hourHeight }}
                    className="border-b border-line/60"
                  />
                ))}

                {routines
                  .filter((block) => block.day === day)
                  .map((block) => {
                    const top = ((block.startMinute - firstHour * 60) / 60) * hourHeight;
                    const blockHeight = Math.max(
                      12,
                      ((block.endMinute - block.startMinute) / 60) * hourHeight - 2
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
                        className={`absolute left-0.5 right-0.5 overflow-hidden rounded ${
                          detail ? 'px-1 py-0.5' : 'items-center justify-center'
                        }`}
                        style={{
                          top: top + 1,
                          height: blockHeight,
                          backgroundColor: subjectTint(block.color, 0.07),
                          borderWidth: 1,
                          borderStyle: 'dashed',
                          borderColor: subjectTint(block.color, 0.3),
                        }}
                      >
                        {detail ? (
                          <View className="flex-row items-center gap-1">
                            <Icon name={meta?.icon ?? 'circle'} size={9} color={subjectInk(block.color)} />
                            <Text className="flex-1 text-[9px] text-muted" numberOfLines={1}>
                              {block.title}
                            </Text>
                          </View>
                        ) : (
                          <Icon name={meta?.icon ?? 'circle'} size={9} color={subjectInk(block.color)} />
                        )}
                      </Touchable>
                    );
                  })}

                {laneOut(classes.filter((block) => block.day === day)).map(
                  ({ block, lane, lanes }) => {
                    const top = ((block.startMinute - firstHour * 60) / 60) * hourHeight;
                    const blockHeight = Math.max(
                      16,
                      ((block.endMinute - block.startMinute) / 60) * hourHeight - 2
                    );

                    return (
                      <Touchable
                        key={block.id}
                        accessibilityRole="button"
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
                        className={`absolute overflow-hidden rounded ${
                          detail ? 'px-1 py-0.5' : 'items-center justify-center px-0.5'
                        }`}
                        style={{
                          top: top + 1,
                          height: blockHeight,
                          left: `${(lane / lanes) * 100}%`,
                          width: `${(1 / lanes) * 100}%`,
                          backgroundColor: subjectTint(block.color, 0.15),
                          borderLeftWidth: 2,
                          borderLeftColor: block.color,
                        }}
                      >
                        {detail ? (
                          <>
                            <Text
                              className="text-[9px] font-bold leading-[11px] text-ink"
                              numberOfLines={1}
                            >
                              {block.code || block.subjectName || block.title}
                            </Text>
                            {blockHeight >= 32 ? (
                              <Text className="text-[8px] leading-[10px] text-muted" numberOfLines={1}>
                                {minutesToLabel(block.startMinute)}
                              </Text>
                            ) : null}
                            {blockHeight >= 46 && block.venue ? (
                              <Text
                                className="text-[8px] leading-[10px] text-subtle"
                                numberOfLines={1}
                              >
                                {block.venue}
                              </Text>
                            ) : null}
                          </>
                        ) : (
                          /* Heatmap: the abbreviation and nothing else. Four
                             letters is what fifty points holds, and a truncated
                             room number is noise rather than information. */
                          <Text
                            className="text-center text-[9px] font-bold leading-[11px] text-ink"
                            numberOfLines={1}
                          >
                            {abbreviate(block)}
                          </Text>
                        )}
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

      <View
        className="justify-center border-t border-line bg-sand px-2.5"
        style={{ height: FOOTER_HEIGHT }}
      >
        <Text className="text-[10px] text-subtle">
          {detail
            ? 'Tap any class for its room, type and times.'
            : 'Tap any class for its full detail. Hide days to see more.'}
        </Text>
      </View>
    </View>
  );
}

/** Kept for the platform check that decides whether measurement is available. */
export const supportsViewportFit = Platform.OS === 'web';
