import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Sheet } from '@/components/Sheet';
import { Button, Loading, Notice } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { formatBytes, useDriveMigration } from '@/hooks/useDriveMigration';
import { isDriveConfigured } from '@/lib/driveUtils';

/**
 * Moving what is already uploaded into the student's own Drive.
 *
 * The screen is mostly a count and a sentence, which is the point: a student
 * asked to move their whole semester wants to know how much is left and that
 * nothing has been lost. It never closes on a scrim tap while work is running —
 * an accidental dismissal mid-batch is how people end up with files in two
 * places and no idea which is which.
 */
export function DriveMigrationModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const uid = useUid();
  const { state, scan, start, cancel, reset } = useDriveMigration(uid);

  const running = state.phase === 'migrating' || state.phase === 'scanning';

  // Opening the sheet counts what is left; the number is the whole reason a
  // student would tap the button, so it should not need a second tap.
  useEffect(() => {
    if (visible) void scan();
    else reset();
  }, [visible]);

  if (!isDriveConfigured()) return null;

  const toMove = state.pending.length;
  const progress = state.total > 0 ? (state.completed + state.failed) / state.total : 0;

  return (
    <Sheet
      visible={visible}
      onClose={running ? () => undefined : onClose}
      title="Move files to your Drive"
      icon="upload-cloud"
      dismissOnScrim={!running}
      maxHeight={480}
    >
      <Text className="text-sm leading-5 text-muted">
        Your uploaded originals currently sit in Notomi&rsquo;s shared storage. This moves each one
        into your own Google Drive, under “Notomi Workspace”, sorted by course — then removes the
        shared copy.
      </Text>

      {state.phase === 'scanning' ? (
        <Loading label="Scanning your files…" />
      ) : null}

      {state.error ? <Notice title="Migration stopped" body={state.error} /> : null}

      {/* The count, which is what the student actually came for. */}
      {state.phase !== 'scanning' && !state.error ? (
        <View className="gap-2 rounded-xl bg-sand px-3.5 py-3">
          <View className="flex-row items-center gap-2">
            <Icon
              name={toMove === 0 && state.phase !== 'migrating' ? 'check-circle' : 'upload-cloud'}
              size={14}
              tone={toMove === 0 && state.phase !== 'migrating' ? 'pine' : 'muted'}
            />
            <Text className="flex-1 text-[13px] font-medium text-ink">
              {state.message ||
                (toMove === 0
                  ? 'Everything is already in your Drive.'
                  : `${toMove} file${toMove === 1 ? '' : 's'} to move.`)}
            </Text>
          </View>

          {state.phase === 'migrating' && state.total > 0 ? (
            <>
              {state.currentName ? (
                <Text className="text-[11px] text-subtle" numberOfLines={1}>
                  {state.currentName}
                </Text>
              ) : null}
              <View className="h-1.5 overflow-hidden rounded-full bg-line">
                <View
                  className="h-full rounded-full bg-pine"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </View>
            </>
          ) : null}

          {state.freedBytes > 0 ? (
            <Text className="text-[11px] text-pine">
              {formatBytes(state.freedBytes)} freed from shared storage.
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Failures are listed by name: "3 failed" is not something to act on. */}
      {state.problems.length > 0 ? (
        <View className="gap-1.5">
          <Text className="text-xs font-semibold text-ink">
            {state.problems.length} could not be moved
          </Text>
          {state.problems.slice(0, 5).map((problem) => (
            <View key={problem.fileName} className="rounded-lg bg-paper px-3 py-2">
              <Text className="text-xs font-medium text-ink" numberOfLines={1}>
                {problem.fileName}
              </Text>
              <Text className="text-[11px] leading-4 text-subtle">{problem.message}</Text>
            </View>
          ))}
          <Text className="text-[11px] leading-4 text-subtle">
            Their originals were left exactly where they were. Running this again retries only
            these.
          </Text>
        </View>
      ) : null}

      <View className="flex-row flex-wrap gap-2">
        {state.phase === 'migrating' ? (
          <Button label="Stop after this file" variant="secondary" size="sm" onPress={cancel} />
        ) : (
          <Button
            label={state.phase === 'done' && toMove === 0 ? 'Done' : 'Move to my Drive'}
            icon="upload-cloud"
            size="sm"
            disabled={state.phase === 'scanning' || (toMove === 0 && state.phase !== 'idle')}
            onPress={() =>
              toMove === 0 && state.phase === 'done' ? onClose() : void start()
            }
          />
        )}
        {!running ? (
          <Button label="Close" variant="ghost" size="sm" onPress={onClose} />
        ) : null}
      </View>

      <Text className="text-[11px] leading-4 text-subtle">
        Safe to interrupt. Each file is copied first and only removed from shared storage once your
        Drive has it, so closing this and coming back later carries on where it stopped without
        copying anything twice.
      </Text>
    </Sheet>
  );
}
