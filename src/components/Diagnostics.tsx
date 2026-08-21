import { useCallback, useMemo, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Button, Card } from '@/components/ui';
import { AI_BUDGET, describeWait, usageSnapshot } from '@/lib/budget';
import { currentModel, lastAiOutcome } from '@/lib/ai';
import { isDriveConfigured, isDriveConnected, isDrivePermanent } from '@/lib/driveUtils';
import { isAppCheckEnabled, isFirebaseConfigured, missingFirebaseConfigKeys } from '@/services/firebase';

const APP_VERSION = '1.0.0';

/**
 * What is actually going on, in a form a student can hand to someone.
 *
 * Every support conversation about this app has started with "it didn't work"
 * and spent ten messages establishing which browser, whether attestation was
 * on, whether Drive was connected and whether the AI had anything left for
 * today. All of that is knowable from inside the app, so it is written down
 * here and copyable in one tap.
 *
 * Nothing here is private. No document text, no chat, no file names, no email
 * address, no tokens — a student pasting this into a group chat should not be
 * pasting their coursework with it. That constraint is what decides what is on
 * this list, not what would be most useful to debug with.
 */
export function DiagnosticsCard() {
  const [copied, setCopied] = useState(false);
  /** Re-read on demand: these are live numbers, and a stale panel is a lie. */
  const [tick, setTick] = useState(0);

  const lines = useMemo(() => {
    void tick;
    const usage = usageSnapshot();
    const outcome = lastAiOutcome();
    const browser =
      typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent.slice(0, 120);

    return [
      ['App version', APP_VERSION],
      ['Platform', `${Platform.OS}${Platform.OS === 'web' ? ` · ${browser}` : ''}`],
      [
        'Configuration',
        isFirebaseConfigured
          ? 'complete'
          : `incomplete — missing ${missingFirebaseConfigKeys.join(', ')}`,
      ],
      ['App Check', isAppCheckEnabled() ? 'enabled' : 'not configured'],
      [
        'File storage',
        !isDriveConfigured()
          ? 'Drive not configured for this build'
          : isDrivePermanent()
            ? 'Google Drive · linked permanently'
            : isDriveConnected()
              ? 'Google Drive · connected for this session'
              : 'Google Drive · not connected',
      ],
      ['AI model', currentModel()],
      [
        'Last AI request',
        outcome
          ? `${outcome.operation} · ${outcome.model} · ${outcome.ms}ms · ${outcome.status}${
              outcome.httpStatus ? ` (HTTP ${outcome.httpStatus})` : ''
            }`
          : 'none this session',
      ],
      [
        'AI used today',
        `${usage.ai.standard}/${usage.ai.standardLimit} requests · ${usage.ai.heavy}/${usage.ai.heavyLimit} file analyses`,
      ],
      [
        'AI state',
        usage.pausedUntil
          ? `paused until ${usage.pausedUntil.toLocaleTimeString()}`
          : `available · resets ${describeWait(usage.resetsInSeconds)}`,
      ],
      [
        'Database activity today',
        `about ${usage.firestore.reads} reads · ${usage.firestore.writes} writes (estimated on this device)`,
      ],
    ] as [string, string][];
  }, [tick]);

  const copy = useCallback(async () => {
    const report = [`Notomi diagnostics`, ...lines.map(([label, value]) => `${label}: ${value}`)].join(
      '\n'
    );
    try {
      // Clipboard is the only place this can go: there is no support endpoint
      // to post it to, and inventing one would mean shipping telemetry nobody
      // asked for.
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(report);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
        return;
      }
    } catch {
      /* Falls through to the visible list, which is already readable. */
    }
    setCopied(false);
  }, [lines]);

  return (
    <Card className="mb-8 gap-4">
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
          <Icon name="activity" size={16} tone="muted" />
        </View>
        <View className="flex-1">
          <Text className="text-[15px] font-semibold text-ink">Diagnostics</Text>
          <Text className="text-xs leading-4 text-muted">
            What to send if something is not working. No document or message content is included.
          </Text>
        </View>
      </View>

      <View className="gap-0.5">
        {lines.map(([label, value]) => (
          <View key={label} className="flex-row flex-wrap items-baseline gap-x-2 py-1">
            <Text className="text-xs font-semibold text-muted">{label}</Text>
            <Text className="flex-1 text-right text-xs text-ink" selectable>
              {value}
            </Text>
          </View>
        ))}
      </View>

      <View className="flex-row flex-wrap gap-2">
        <Button
          label={copied ? 'Copied' : 'Copy diagnostics'}
          icon={copied ? 'check' : 'clipboard'}
          variant="secondary"
          size="sm"
          onPress={() => void copy()}
        />
        <Button
          label="Refresh"
          icon="refresh-cw"
          variant="ghost"
          size="sm"
          onPress={() => setTick((value) => value + 1)}
        />
      </View>

      <Text className="text-xs leading-5 text-subtle">
        Notomi limits itself to {AI_BUDGET.standardPerDay} AI requests and{' '}
        {AI_BUDGET.heavyPerDay} file analyses a day so the free allowance lasts the whole day for
        everyone using it. Schedules, tasks, notes, attendance and anything already generated keep
        working when it runs out.
      </Text>
    </Card>
  );
}
