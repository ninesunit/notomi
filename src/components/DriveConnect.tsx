import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Button, Card, Notice } from '@/components/ui';
import { feedback } from '@/lib/sound';
import {
  disconnectDrive,
  driveConfigHint,
  isDriveConfigured,
  isDriveConnected,
  isDriveLinked,
  isDrivePermanent,
  linkDrivePermanently,
  resumeDrive,
} from '@/lib/driveUtils';

/**
 * The one place a student says yes to Drive.
 *
 * Deliberately explicit about the bargain, because "sign in with Google" tells
 * somebody nothing about what an app will do with their files. Notomi asks for
 * the narrowest scope Google offers and this card says so in the words that
 * scope actually means: what it made, and what you hand it.
 */
export function DriveConnect({
  onConnected,
  compact = false,
}: {
  onConnected?: () => void;
  compact?: boolean;
}) {
  // Linked is the state a student recognises as "connected": consent given,
  // and renewable without being asked again. The live token underneath expires
  // hourly and is nobody's business.
  const [connected, setConnected] = useState(() => isDriveConnected() || isDriveLinked());
  /** Whether the connection survives closing the tab, or only lasts the hour. */
  const [permanent, setPermanent] = useState(isDrivePermanent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      setConnected(isDriveConnected() || isDriveLinked());
      setPermanent(isDrivePermanent());
    };
    void resumeDrive().then(sync);
    const timer = setInterval(sync, 30_000);
    return () => clearInterval(timer);
  }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Asks for a grant the Worker can renew. Falls back by itself to the
      // one-hour browser flow where no Worker can hold one, and reports which
      // it got so the card does not promise more than it delivered.
      setPermanent(await linkDrivePermanently());
      setConnected(true);
      feedback('success');
      onConnected?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      feedback('error');
    } finally {
      setBusy(false);
    }
  }, [onConnected]);

  if (!isDriveConfigured()) return null;

  if (compact) {
    return (
      <View className="gap-2">
        {error ? <Notice title="Drive did not connect" body={error} /> : null}
        <Button
          label={connected ? (permanent ? 'Drive connected' : 'Connected this session') : 'Connect Google Drive'}
          icon={connected ? 'check' : 'upload-cloud'}
          variant={connected ? 'secondary' : 'primary'}
          size="sm"
          loading={busy}
          disabled={connected || busy}
          onPress={() => void connect()}
        />
      </View>
    );
  }

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
          <Icon name="upload-cloud" size={16} color="#6F6A5F" />
        </View>
        <View className="flex-1">
          <Text className="text-[15px] font-semibold text-ink">Your Google Drive</Text>
          <Text className="text-xs text-muted">
            {connected
              ? permanent
                ? 'Connected — stays connected next time'
                : 'Connected for this session'
              : 'Keep your own copy of every file'}
          </Text>
        </View>
        {connected ? <View className="h-2.5 w-2.5 rounded-full bg-pine" /> : null}
      </View>

      <Text className="text-xs leading-5 text-subtle">
        Uploads go straight from this device into a “Notomi Workspace” folder in your Drive, sorted
        by course code. Notomi can only ever see the files it puts there and the ones you choose
        yourself — never the rest of your Drive.
      </Text>

      {error ? <Notice title="Drive did not connect" body={error} /> : null}
      {driveConfigHint() && !error ? (
        <Text className="text-xs text-subtle">{driveConfigHint()}</Text>
      ) : null}

      <View className="flex-row flex-wrap gap-2">
        {/*
          A session-only connection is a state the student can get out of, and
          until now the card described it without offering the way. It happens
          whenever the permanent grant could not be taken — a Worker that was
          not reachable, a consent screen dismissed early — and it leaves an
          hourly re-login the student has no reason to accept, because the only
          button on offer was Disconnect. This runs the same flow the first
          connection tries.
        */}
        {connected && !permanent ? (
          <Button
            label="Stay connected"
            icon="refresh-cw"
            size="sm"
            loading={busy}
            onPress={() => void connect()}
          />
        ) : null}

        {connected ? (
          <Button
            label="Disconnect"
            icon="log-out"
            variant="secondary"
            size="sm"
            onPress={() => {
              disconnectDrive();
              setConnected(false);
              setPermanent(false);
              feedback('toggle');
            }}
          />
        ) : (
          <Button
            label="Connect Google Drive"
            icon="upload-cloud"
            size="sm"
            loading={busy}
            onPress={() => void connect()}
          />
        )}
      </View>

      {connected ? (
        <Text className="text-[11px] leading-4 text-subtle">
          {permanent
            ? 'Disconnecting withdraws Notomi’s access to your Drive everywhere, not just on this device. Nothing is removed from your Drive.'
            : 'This connection lasts about an hour, then asks again. “Stay connected” makes it permanent so it survives closing the tab. Nothing is removed from your Drive.'}
        </Text>
      ) : null}
    </Card>
  );
}

/**
 * The line under a batch upload: "Uploading 2 of 5 files to Google Drive…".
 *
 * Its own component so the existing modal can render it without any of its
 * layout being rethought.
 */
export function DriveUploadProgress({
  index,
  total,
  name,
}: {
  index: number;
  total: number;
  name?: string;
}) {
  if (total === 0) return null;

  return (
    <View className="gap-1.5 rounded-xl bg-sand px-3 py-2.5">
      <View className="flex-row items-center gap-2">
        <Icon name="upload-cloud" size={13} color="#6F6A5F" />
        <Text className="flex-1 text-xs font-medium text-ink">
          Uploading {Math.min(index, total)} of {total}{' '}
          {total === 1 ? 'file' : 'files'} to Google Drive…
        </Text>
      </View>
      {name ? (
        <Text className="text-[11px] text-subtle" numberOfLines={1}>
          {name}
        </Text>
      ) : null}
      <View className="h-1 overflow-hidden rounded-full bg-line">
        <View
          className="h-full rounded-full bg-pine"
          style={{ width: `${Math.round((Math.min(index, total) / total) * 100)}%` }}
        />
      </View>
    </View>
  );
}
