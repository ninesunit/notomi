import { Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import {
  DAY_FULL,
  DAY_LABELS,
  minutesToLabel,
  ROUTINE_CATEGORIES,
  todayIndex,
  type RoutineBlock,
} from '@/lib/schema';
import { feedback } from '@/lib/sound';
import type { ResolvedClass } from '@/services/timetable';

/**
 * The whole week, in one screen.
 *
 * A time-proportional grid is the right shape on a desktop and the wrong one on
 * a phone: nine hours of ruler is seven hundred points of mostly-empty rows, so
 * either you scroll or every block shrinks to an unreadable sliver. This drops
 * the ruler and keeps the grid — a row per day, the classes stacked inside it —
 * which for a normal week fits on one screen with the code, the subject, the
 * hours and the room all legible.
 *
 * Days are always all seven, including the empty ones: a week with a gap in it
 * is information, and a list that silently omits Wednesday reads as a bug.
 */
export function WeekOverview({
  classes,
  routines = [],
  onSelect,
  onSelectRoutine,
}: {
  classes: ResolvedClass[];
  routines?: RoutineBlock[];
  onSelect?: (block: ResolvedClass) => void;
  onSelectRoutine?: (block: RoutineBlock) => void;
}) {
  const today = todayIndex();

  return (
    <View className="overflow-hidden rounded-2xl border border-line bg-surface">
      {DAY_LABELS.map((label, day) => {
        const blocks = classes
          .filter((block) => block.day === day)
          .sort((a, b) => a.startMinute - b.startMinute);
        const overlay = routines
          .filter((block) => block.day === day)
          .sort((a, b) => a.startMinute - b.startMinute);
        const empty = blocks.length === 0 && overlay.length === 0;

        return (
          <View
            key={label}
            className={`flex-row gap-2.5 px-3 ${empty ? 'py-1' : 'py-2'} ${
              day > 0 ? 'border-t border-line' : ''
            } ${day === today ? 'bg-accent-soft/40' : ''}`}
          >
            <View className={`w-9 shrink-0 ${empty ? 'pt-0.5' : 'pt-1.5'}`}>
              <Text
                className={`text-[11px] font-bold uppercase tracking-wider ${
                  day === today ? 'text-accent' : 'text-muted'
                }`}
              >
                {label}
              </Text>
            </View>

            <View className="flex-1 gap-1">
              {empty ? (
                <Text className="text-xs leading-5 text-subtle">
                  {day === today ? 'Nothing today' : 'Free'}
                </Text>
              ) : null}

              {blocks.map((block) => (
                <ClassChip
                  key={block.id}
                  block={block}
                  onPress={onSelect ? () => onSelect(block) : undefined}
                />
              ))}

              {overlay.map((block) => (
                <RoutineChip
                  key={block.id}
                  block={block}
                  onPress={onSelectRoutine ? () => onSelectRoutine(block) : undefined}
                />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function ClassChip({
  block,
  onPress,
}: {
  block: ResolvedClass;
  onPress?: () => void;
}) {
  const name = block.subjectName || block.title;
  const venue = block.venue?.trim() || 'Venue not set';

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'none'}
      accessibilityLabel={`${name}, ${DAY_FULL[block.day]} ${minutesToLabel(
        block.startMinute
      )} to ${minutesToLabel(block.endMinute)}, ${venue}`}
      disabled={!onPress}
      onPress={
        onPress
          ? () => {
              feedback('tap');
              onPress();
            }
          : undefined
      }
      className="overflow-hidden rounded-lg px-2.5 py-1"
      style={{
        backgroundColor: `${block.color}1A`,
        borderLeftWidth: 3,
        borderLeftColor: block.color,
      }}
    >
      {/* Two lines, not three: the week has to fit on one screen, and the name
          and the hours are what a student scans for. */}
      <View className="flex-row items-baseline gap-2">
        <Text className="flex-1 text-[13px] font-semibold leading-5 text-ink" numberOfLines={1}>
          {name}
        </Text>
        <Text className="shrink-0 text-[11px] font-bold text-ink" numberOfLines={1}>
          {minutesToLabel(block.startMinute)}–{minutesToLabel(block.endMinute)}
        </Text>
      </View>

      {block.code || block.section || block.kind ? (
        <Text className="text-[11px] leading-4 text-muted" numberOfLines={1}>
          {block.code ? (
            <Text className="font-bold" style={{ color: block.color }}>
              {block.code}
            </Text>
          ) : null}
          {block.code && (block.section || block.kind) ? ' · ' : ''}
          {[block.section, block.kind].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
      <View className="mt-0.5 flex-row items-center gap-1.5">
        <Icon name="map" size={11} color="#6F6A5F" />
        <Text className="min-w-0 flex-1 text-[11px] leading-4 text-muted" numberOfLines={1}>
          {venue}
        </Text>
      </View>
    </Pressable>
  );
}

function RoutineChip({ block, onPress }: { block: RoutineBlock; onPress?: () => void }) {
  const meta = ROUTINE_CATEGORIES.find((entry) => entry.id === block.category);

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'none'}
      accessibilityLabel={`${block.title}, ${DAY_FULL[block.day]} ${minutesToLabel(
        block.startMinute
      )}`}
      disabled={!onPress}
      onPress={
        onPress
          ? () => {
              feedback('tap');
              onPress();
            }
          : undefined
      }
      className="flex-row items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5"
      style={{ borderColor: `${block.color}59`, backgroundColor: `${block.color}0F` }}
    >
      <Icon name={meta?.icon ?? 'circle'} size={12} color={block.color} />
      <Text className="flex-1 text-[12px] font-medium text-muted" numberOfLines={1}>
        {block.title}
      </Text>
      <Text className="text-[11px] text-subtle">
        {minutesToLabel(block.startMinute)}–{minutesToLabel(block.endMinute)}
      </Text>
    </Pressable>
  );
}

/** A one-line summary of what is happening right now, for the dashboard. */
export function NowLine({ classes }: { classes: ResolvedClass[] }) {
  const today = todayIndex();
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();

  const todays = classes
    .filter((block) => block.day === today)
    .sort((a, b) => a.startMinute - b.startMinute);

  const live = todays.find(
    (block) => block.startMinute <= minutes && block.endMinute > minutes
  );
  const next = todays.find((block) => block.startMinute > minutes);

  if (!live && !next) return null;

  const block = live ?? next!;
  const away = block.startMinute - minutes;

  return (
    <View
      className="flex-row items-center gap-2.5 rounded-xl px-3.5 py-2.5"
      style={{ backgroundColor: `${block.color}1A` }}
    >
      <View className="h-2 w-2 rounded-full" style={{ backgroundColor: block.color }} />
      <Text className="text-[11px] font-bold uppercase tracking-wider" style={{ color: block.color }}>
        {live ? 'Now' : 'Next'}
      </Text>
      <Text className="flex-1 text-[13px] font-semibold text-ink" numberOfLines={1}>
        {block.subjectName || block.title}
      </Text>
      <Text className="text-[12px] font-medium text-muted">
        {live
          ? `ends ${minutesToLabel(block.endMinute)}`
          : away < 60
            ? `in ${away} min`
            : minutesToLabel(block.startMinute)}
      </Text>
      <Icon name="chevron-right" size={14} color="#9A9488" />
    </View>
  );
}
