import { Text, View } from 'react-native';
import { Touchable } from '@/components/ui';
import { DAY_FULL } from '@/lib/schema';

/**
 * Seven pills deciding how much week is on screen.
 *
 * Shared by the dashboard and the timetable so the control looks and behaves
 * the same in both, and so neither can drift into its own idea of what a day
 * toggle is. Fewer days means wider columns, which is what lets the grid show
 * a room and a time instead of an abbreviation — so this is a detail dial as
 * much as a filter, and it sits directly above the thing it changes.
 */
export function DayFilter({
  visibleDays,
  onToggle,
}: {
  visibleDays: number[];
  onToggle: (day: number) => void;
}) {
  return (
    <View className="mb-3 flex-row items-center gap-1">
      {DAY_FULL.map((full, day) => {
        const on = visibleDays.includes(day);
        return (
          <Touchable
            key={full}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${full}${on ? ', showing' : ', hidden'}`}
            cue="none"
            onPress={() => onToggle(day)}
            className={`h-8 flex-1 items-center justify-center rounded-lg border ${
              on ? 'border-ink bg-ink' : 'border-line bg-surface'
            }`}
          >
            <Text className={`text-[11px] font-bold ${on ? 'text-paper' : 'text-subtle'}`}>
              {full[0]}
            </Text>
          </Touchable>
        );
      })}
    </View>
  );
}
