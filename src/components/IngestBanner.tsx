import { Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { useIngest } from '@/hooks/useIngest';

const TONE = {
  pine: { surface: 'bg-pine-soft', text: 'text-pine', icon: 'check-circle', color: '#2E6F5E' },
  amber: { surface: 'bg-amber-soft', text: 'text-amber', icon: 'alert-triangle', color: '#B4832A' },
  rose: { surface: 'bg-rose-soft', text: 'text-rose', icon: 'alert-circle', color: '#B0443E' },
} as const;

/**
 * Result of the last ingest, rendered in the shell so it survives whichever
 * screen or empty state started the upload. In-flow and `shrink-0`: it pushes
 * the scroll pane down rather than floating over it.
 */
export function IngestBanner() {
  const { summary, dismiss } = useIngest();
  if (!summary) return null;

  const tone = TONE[summary.tone];

  return (
    <View className={`shrink-0 flex-row gap-3 border-b border-line px-5 py-3.5 md:px-10 ${tone.surface}`}>
      <Icon name={tone.icon} size={16} color={tone.color} style={{ marginTop: 2 }} />

      <View className="flex-1 gap-1">
        <Text className={`text-sm font-semibold ${tone.text}`}>{summary.title}</Text>
        {summary.body ? (
          <Text className="text-sm leading-5 text-ink/80">{summary.body}</Text>
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={dismiss}
        className="h-6 w-6 items-center justify-center rounded"
      >
        <Icon name="x" size={14} color={tone.color} />
      </Pressable>
    </View>
  );
}
