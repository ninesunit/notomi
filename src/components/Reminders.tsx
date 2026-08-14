import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { useReminders } from '@/hooks/useReminders';
import { feedback } from '@/lib/sound';
import { describeWhen, LEAD_OPTIONS, notify } from '@/services/reminders';
import { FadeIn, Reveal } from './motion';
import { Button, Card, Notice } from './ui';

/**
 * The reminders card.
 *
 * It leads with what is actually coming rather than with a settings panel:
 * a student opening the dashboard wants "Databases in 25 min", not a permission
 * dialog. The settings sit behind the gear, and the honest limitation — these
 * are local notifications, so they need the app installed or open — is stated
 * where it matters instead of hidden.
 */
export function RemindersCard() {
  const { prefs, update, permission, enable, upcoming } = useReminders();
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  const next = upcoming.slice(0, 3);
  const unsupported = permission === 'unsupported';

  async function turnOn() {
    setBusy(true);
    setDenied(false);
    const result = await enable();
    if (result === 'granted') {
      feedback('chime');
      await notify('Reminders are on', 'Notomi will nudge you before each class.', 'notomi-test');
    } else if (result === 'denied') {
      setDenied(true);
      feedback('error');
    }
    setBusy(false);
  }

  return (
    <Card className="mb-8 gap-4">
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-accent-soft">
          <Icon name="bell" size={16} color="#B4552D" />
        </View>
        <View className="flex-1">
          <Text className="text-[15px] font-semibold text-ink">Reminders</Text>
          <Text className="text-xs text-muted">
            {prefs.enabled && permission === 'granted'
              ? `${prefs.leadMinutes} min before each class`
              : 'Off — no notifications will be sent'}
          </Text>
        </View>

        {prefs.enabled && permission === 'granted' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={settings ? 'Hide reminder settings' : 'Reminder settings'}
            onPress={() => {
              feedback('tap');
              setSettings((value) => !value);
            }}
            className="h-9 w-9 items-center justify-center rounded-lg bg-sand"
          >
            <Icon name={settings ? 'x' : 'settings'} size={15} color="#6F6A5F" />
          </Pressable>
        ) : null}
      </View>

      {unsupported ? (
        <Notice
          tone="amber"
          title="This browser cannot show notifications"
          body="On iPhone, add Notomi to your home screen first — installed web apps can notify, Safari tabs cannot."
        />
      ) : denied ? (
        <Notice
          tone="amber"
          title="Notifications are blocked"
          body="Your browser has blocked notifications for this site. Allow them in the site settings, then turn reminders on again."
        />
      ) : !prefs.enabled || permission !== 'granted' ? (
        <View className="gap-3">
          <Text className="text-sm leading-5 text-muted">
            Get a nudge before every class and twice before every deadline. Notomi schedules these
            on your device, so they arrive while the app is installed or open — nothing is sent from
            a server.
          </Text>
          <View className="flex-row">
            <Button
              label={busy ? 'Asking…' : 'Turn on reminders'}
              icon="bell"
              size="sm"
              loading={busy}
              disabled={busy}
              onPress={() => void turnOn()}
            />
          </View>
        </View>
      ) : (
        <>
          {next.length === 0 ? (
            <Text className="text-sm text-muted">
              Nothing to remind you about in the next day and a half.
            </Text>
          ) : (
            <View className="gap-2">
              {next.map((reminder, index) => (
                <FadeIn key={reminder.id} index={index}>
                  <View className="flex-row items-center gap-3 rounded-xl bg-paper px-3.5 py-3">
                    <Icon
                      name={
                        reminder.kind === 'deadline'
                          ? 'flag'
                          : reminder.kind === 'routine'
                            ? 'repeat'
                            : 'clock'
                      }
                      size={14}
                      color={reminder.kind === 'deadline' ? '#B0443E' : '#6F6A5F'}
                    />
                    <View className="flex-1 gap-0.5">
                      <Text className="text-sm font-medium text-ink" numberOfLines={1}>
                        {reminder.title}
                      </Text>
                      <Text className="text-xs text-subtle" numberOfLines={1}>
                        {reminder.body}
                      </Text>
                    </View>
                    <Text className="text-xs font-semibold text-muted">
                      {describeWhen(reminder.at)}
                    </Text>
                  </View>
                </FadeIn>
              ))}
            </View>
          )}

          <Reveal open={settings}>
            <View className="gap-4 border-t border-line pt-4">
              <View className="gap-2">
                <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                  Remind me before a class
                </Text>
                <View className="flex-row flex-wrap gap-1.5">
                  {LEAD_OPTIONS.map((minutes) => (
                    <Pressable
                      key={minutes}
                      accessibilityRole="button"
                      accessibilityState={{ selected: prefs.leadMinutes === minutes }}
                      onPress={() => {
                        feedback('toggle');
                        update({ leadMinutes: minutes });
                      }}
                      className={`rounded-lg px-3 py-2 ${
                        prefs.leadMinutes === minutes ? 'bg-ink' : 'bg-sand'
                      }`}
                    >
                      <Text
                        className={`text-xs font-semibold ${
                          prefs.leadMinutes === minutes ? 'text-paper' : 'text-ink'
                        }`}
                      >
                        {minutes} min
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View className="gap-2">
                {(
                  [
                    { key: 'classes' as const, label: 'Classes', hint: 'Every timetabled lecture, lab and tutorial' },
                    { key: 'routines' as const, label: 'Routines', hint: 'Gym, study blocks, commutes' },
                    { key: 'deadlines' as const, label: 'Deadlines', hint: 'A day before, and an hour before' },
                  ]
                ).map((option) => (
                  <Pressable
                    key={option.key}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: prefs[option.key] }}
                    accessibilityLabel={option.label}
                    onPress={() => {
                      feedback('toggle');
                      update({ [option.key]: !prefs[option.key] });
                    }}
                    className="flex-row items-center gap-3 rounded-xl bg-paper px-3.5 py-3"
                  >
                    <View
                      className={`h-[18px] w-[18px] items-center justify-center rounded-md border ${
                        prefs[option.key] ? 'border-pine bg-pine' : 'border-line bg-surface'
                      }`}
                    >
                      {prefs[option.key] ? (
                        <Icon name="check" size={11} color="#FFFFFF" />
                      ) : null}
                    </View>
                    <View className="flex-1">
                      <Text className="text-sm font-medium text-ink">{option.label}</Text>
                      <Text className="text-xs text-subtle">{option.hint}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>

              <View className="flex-row items-center gap-2">
                <Button
                  label="Send a test"
                  icon="send"
                  variant="secondary"
                  size="sm"
                  onPress={() =>
                    void notify('Test reminder', 'This is what a Notomi nudge looks like.', 'notomi-test')
                  }
                />
                <View className="flex-1" />
                <Button
                  label="Turn off"
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    feedback('toggle');
                    update({ enabled: false });
                    setSettings(false);
                  }}
                />
              </View>

              <Text className="text-[11px] leading-4 text-subtle">
                Reminders are scheduled on this device, not pushed from a server, so they arrive
                while Notomi is open or installed to your home screen. They do not follow you to
                another phone.
              </Text>
            </View>
          </Reveal>
        </>
      )}
    </Card>
  );
}
