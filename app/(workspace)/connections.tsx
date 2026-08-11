import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Button, Card, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { feedback } from '@/lib/sound';
import {
  beginConnect,
  completeConnect,
  connectedAccount,
  disconnect,
  isConfigured,
  isConnected,
} from '@/services/microsoft';
import { describeSync, pullAssignments, removeCalendar, syncCalendar } from '@/services/msSync';

/**
 * Connections.
 *
 * One screen, one account, and no ambiguity about what crosses the line. A
 * student handing an app access to their university mail account deserves to
 * read exactly what it will do with it before they click, so the permissions
 * are spelled out here rather than left to the consent dialog.
 */
export default function Connections() {
  const uid = useUid();

  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<'connect' | 'calendar' | 'teams' | 'remove' | null>(null);

  // The redirect from Microsoft lands back on this screen with a code in the
  // query string, so finishing the handshake is the first thing it does.
  useEffect(() => {
    let live = true;
    void completeConnect()
      .then((outcome) => {
        if (!live) return;
        if (outcome) {
          setStatus('Connected.');
          feedback('success');
        }
        setConnected(isConnected());
        setAccount(connectedAccount());
      })
      .catch((caught) => {
        if (!live) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      live = false;
    };
  }, []);

  const run = useCallback(
    async (which: 'calendar' | 'teams', work: () => Promise<string>) => {
      setBusy(which);
      setError(null);
      setStatus(null);
      try {
        setStatus(await work());
        feedback('success');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        feedback('error');
        setConnected(isConnected());
      } finally {
        setBusy(null);
      }
    },
    []
  );

  if (!isConfigured()) {
    return (
      <ScreenScroll maxWidth={760}>
        <PageHeader title="Connections" subtitle="Bring your other accounts into Notomi." />
        <Card className="gap-2">
          <Text className="text-[15px] font-semibold text-ink">Microsoft 365</Text>
          <Text className="text-sm leading-5 text-muted">
            Not available in this build. Once it is switched on you will be able to publish your
            timetable to Outlook and pull assignments out of Teams.
          </Text>
        </Card>
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll maxWidth={760}>
      <PageHeader title="Connections" subtitle="Bring your other accounts into Notomi." />

      {error ? (
        <View className="mb-4">
          <Notice title="That did not work" body={error} />
        </View>
      ) : null}
      {status ? (
        <View className="mb-4">
          <Notice tone="pine" title={status} />
        </View>
      ) : null}

      <Card className="mb-6 gap-4">
        <View className="flex-row items-center gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-sand">
            <Feather name="grid" size={17} color="#6F6A5F" />
          </View>
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-ink">Microsoft 365</Text>
            <Text className="text-xs text-muted" numberOfLines={1}>
              {connected ? (account ?? 'Connected on this device') : 'Outlook Calendar and Teams'}
            </Text>
          </View>
          {connected ? (
            <View className="h-2.5 w-2.5 rounded-full bg-pine" />
          ) : null}
        </View>

        {connected ? (
          <Button
            label="Disconnect"
            variant="secondary"
            size="sm"
            icon="log-out"
            onPress={() => {
              disconnect();
              setConnected(false);
              setAccount(null);
              setStatus('Disconnected. Nothing was removed from your calendar.');
              feedback('toggle');
            }}
          />
        ) : (
          <Button
            label="Connect Microsoft 365"
            icon="link"
            loading={busy === 'connect'}
            onPress={() => {
              setBusy('connect');
              setError(null);
              void beginConnect().catch((caught) => {
                setError(caught instanceof Error ? caught.message : String(caught));
                setBusy(null);
              });
            }}
          />
        )}

        <View className="gap-1.5 rounded-xl bg-paper p-3">
          <Permission
            icon="calendar"
            title="Your calendar"
            body="Notomi creates one calendar of its own and only ever writes there. Your existing events are never read or changed."
          />
          <Permission
            icon="book-open"
            title="Your assignments"
            body="Titles and due dates only. Submissions, marks and feedback are never requested."
          />
          <Permission
            icon="smartphone"
            title="This device"
            body="The connection is stored on this device and nowhere else, so it is not carried to your other devices — and a signed-out browser has nothing left in it."
          />
        </View>
      </Card>

      {connected ? (
        <>
          <Card className="mb-4 gap-3">
            <Text className="text-[15px] font-semibold text-ink">Outlook Calendar</Text>
            <Text className="text-sm leading-5 text-muted">
              Publishes every class as a weekly appointment. Move one in Outlook and the next sync
              brings the new day, time and room back into your timetable.
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Button
                label="Sync now"
                icon="refresh-cw"
                size="sm"
                loading={busy === 'calendar'}
                disabled={busy !== null}
                onPress={() =>
                  void run('calendar', async () => describeSync(await syncCalendar(uid)))
                }
              />
              <Button
                label="Remove from Outlook"
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onPress={() =>
                  void run('calendar', async () => {
                    await removeCalendar(uid);
                    return 'The Notomi calendar has been deleted from Outlook.';
                  })
                }
              />
            </View>
          </Card>

          <Card className="gap-3">
            <Text className="text-[15px] font-semibold text-ink">Teams assignments</Text>
            <Text className="text-sm leading-5 text-muted">
              Pulls work your professors have posted into your task list, filed under the matching
              subject and dated to its deadline. Anything already pulled is left alone.
            </Text>
            <Button
              label="Pull assignments"
              icon="download"
              size="sm"
              loading={busy === 'teams'}
              disabled={busy !== null}
              onPress={() =>
                void run('teams', async () => {
                  const pull = await pullAssignments(uid);
                  const lead =
                    pull.added === 0
                      ? 'Nothing new to bring across.'
                      : `${pull.added} assignment${pull.added === 1 ? '' : 's'} added to your tasks.`;
                  return pull.unmatched.length
                    ? `${lead} No subject in your library matches ${pull.unmatched.join(', ')} — those went in unfiled.`
                    : lead;
                })
              }
            />
          </Card>
        </>
      ) : null}
    </ScreenScroll>
  );
}

function Permission({
  icon,
  title,
  body,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  title: string;
  body: string;
}) {
  return (
    <View className="flex-row gap-2.5 py-1">
      <Feather name={icon} size={13} color="#9A9488" style={{ marginTop: 2 }} />
      <View className="flex-1">
        <Text className="text-xs font-semibold text-ink">{title}</Text>
        <Text className="text-xs leading-4 text-subtle">{body}</Text>
      </View>
    </View>
  );
}
