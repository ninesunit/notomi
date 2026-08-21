import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { useWeekStyle } from '@/hooks/useWeekStyle';
import { feedback } from '@/lib/sound';

/**
 * Grid or list, wherever the week is drawn.
 *
 * Reads the preference itself rather than taking it as a prop: it is a setting,
 * not state a parent owns, and threading it through three screens would give
 * three chances to pass the wrong one.
 *
 * `compact` drops the labels and keeps the icons, which is what lets it sit in
 * a row beside seven day pills on a 390pt phone. The name it loses moves to the
 * accessibility label, where it was already carrying the fuller description.
 */
export function WeekStyleToggle({ compact = false }: { compact?: boolean }) {
  const [style, setStyle] = useWeekStyle();

  return (
    <View className="shrink-0 flex-row overflow-hidden rounded-lg border border-line">
      {(['grid', 'agenda'] as const).map((option) => {
        const active = style === option;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={option === 'grid' ? 'Time grid' : 'Day-by-day list'}
            onPress={() => {
              if (active) return;
              feedback('toggle');
              setStyle(option);
            }}
            className={`flex-row items-center justify-center gap-1.5 py-1.5 ${
              compact ? 'h-8 w-9' : 'px-3'
            } ${active ? 'bg-ink' : 'bg-surface'}`}
          >
            <Icon
              name={option === 'grid' ? 'layout-dashboard' : 'list'}
              size={13}
              tone={active ? 'inverse' : 'muted'}
            />
            {compact ? null : (
              <Text
                className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}
              >
                {option === 'grid' ? 'Grid' : 'List'}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}
