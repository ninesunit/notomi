import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Icon, useTones } from '@/components/Icon';
import { useIngest } from '@/hooks/useIngest';
import { useAiActivity } from '@/lib/aiActivity';
import { stageLabel, STAGE_ORDER } from '@/services/ingestion';

const TONE = {
  pine: { surface: 'bg-pine-soft', text: 'text-pine', icon: 'check-circle' },
  amber: { surface: 'bg-amber-soft', text: 'text-amber', icon: 'alert-triangle' },
  rose: { surface: 'bg-rose-soft', text: 'text-rose', icon: 'alert-circle' },
} as const;

/**
 * Result of the last ingest, rendered in the shell so it survives whichever
 * screen or empty state started the upload. In-flow and `shrink-0`: it pushes
 * the scroll pane down rather than floating over it.
 */
export function IngestBanner() {
  const tones = useTones();
  const { summary, dismiss, busy, progress } = useIngest();
  const ai = useAiActivity();

  if (busy || ai.count > 0) {
    const stageIndex = progress ? STAGE_ORDER.indexOf(progress.stage) : -1;
    const ratio = progress
      ? Math.max(
          0.08,
          (progress.index - 1 + Math.max(0, stageIndex + 1) / STAGE_ORDER.length) /
            Math.max(1, progress.total)
        )
      : 0.08;
    const title = progress
      ? stageLabel(progress.stage, progress.kind)
      : busy
        ? 'Preparing your files…'
        : (ai.label ?? 'Notomi is working…');
    const detail = progress
      ? `${progress.fileName} · ${progress.index} of ${progress.total}`
      : ai.count > 1
        ? `${ai.count} AI jobs are running. You can keep using the app.`
        : 'You can keep using the app and come back when it is ready.';

    return (
      <View
        accessibilityLiveRegion="polite"
        className="shrink-0 gap-2 border-b border-line bg-accent-soft/70 px-5 py-3 md:px-10"
      >
        <View className="flex-row items-center gap-3">
          <ActivityIndicator size="small" color={tones.accent} />
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-semibold text-accent" numberOfLines={1}>
              {title}
            </Text>
            <Text className="text-xs text-ink/70" numberOfLines={1}>
              {detail}
            </Text>
          </View>
        </View>
        {progress ? (
          <View className="h-1 overflow-hidden rounded-full bg-surface/70">
            <View
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
            />
          </View>
        ) : null}
      </View>
    );
  }

  if (!summary) return null;

  const tone = TONE[summary.tone];

  return (
    <View className={`shrink-0 flex-row gap-3 border-b border-line px-5 py-3.5 md:px-10 ${tone.surface}`}>
      <Icon name={tone.icon} size={16} tone={summary.tone} style={{ marginTop: 2 }} />

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
        <Icon name="x" size={14} tone={summary.tone} />
      </Pressable>
    </View>
  );
}
