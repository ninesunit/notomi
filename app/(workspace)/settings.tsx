import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { RemindersCard } from '@/components/Reminders';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Button, Card, PageHeader } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { isSoundEnabled, play, setSoundEnabled } from '@/lib/sound';

/**
 * Settings.
 *
 * This exists because the dashboard was carrying it. Reminders, sound and the
 * account were three cards competing with the two things a student actually
 * opens the app for, so they moved to the one place people already look.
 */
export default function Settings() {
  const { user, logOut } = useAuth();
  const [sound, setSound] = useState(isSoundEnabled);

  const displayName = user?.displayName || (user?.isAnonymous ? 'Guest' : user?.email) || 'You';

  return (
    <ScreenScroll>
      <PageHeader title="Settings" subtitle="Reminders, sound and your account." />

      <RemindersCard />

      <Card className="mb-8 gap-4">
        <View className="flex-row items-center gap-3">
          <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
            <Icon name={sound ? 'volume-2' : 'volume-x'} size={16} color="#6F6A5F" />
          </View>
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-ink">Sound and haptics</Text>
            <Text className="text-xs text-muted">
              Short cues when something saves, finishes or fails.
            </Text>
          </View>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: sound }}
            accessibilityLabel={sound ? 'Turn sound off' : 'Turn sound on'}
            onPress={() => {
              const next = !sound;
              setSoundEnabled(next);
              setSound(next);
              // Played after enabling so the switch confirms itself audibly.
              if (next) play('toggle');
            }}
            className={`h-7 w-12 justify-center rounded-full px-0.5 ${
              sound ? 'bg-pine' : 'bg-line'
            }`}
          >
            <View
              className={`h-6 w-6 rounded-full bg-surface ${sound ? 'self-end' : 'self-start'}`}
            />
          </Pressable>
        </View>
      </Card>

      <Card className="mb-8 gap-4">
        <View className="flex-row items-center gap-3">
          <View className="h-11 w-11 items-center justify-center rounded-full bg-accent-soft">
            <Text className="text-base font-bold text-accent">
              {displayName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-ink" numberOfLines={1}>
              {displayName}
            </Text>
            <Text className="text-xs text-muted" numberOfLines={1}>
              {user?.isAnonymous
                ? 'Temporary guest account'
                : (user?.email ?? '')}
            </Text>
          </View>
        </View>

        {user?.isAnonymous ? (
          <Text className="text-xs leading-5 text-subtle">
            Signing out permanently deletes this guest account and everything stored in it. Create
            a regular account before adding work you need to keep.
          </Text>
        ) : null}

        <View className="flex-row">
          <Button
            label="Sign out"
            icon="log-out"
            variant="secondary"
            size="sm"
            onPress={() => {
              void logOut().catch((error) =>
                Alert.alert(
                  'Could not sign out',
                  error instanceof Error ? error.message : 'Try again.'
                )
              );
            }}
          />
        </View>
      </Card>

      <Card className="gap-2">
        <Text className="text-[15px] font-semibold text-ink">About Notomi</Text>
        <Text className="text-sm leading-6 text-muted">
          Your whole semester in one place. Scan your timetable once and Notomi builds your
          subjects, your week and your deadlines, then helps you study from your own material —
          notes, flashcards, a tutor that only knows what you uploaded.
        </Text>
        <Row label="Version" value="1.0.0" />
        <Text className="mt-2 text-xs leading-5 text-subtle">
          Notomi updates itself: a new version is fetched in the background and applied the next
          time you open it.
        </Text>
      </Card>
    </ScreenScroll>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between border-t border-line py-2">
      <Text className="text-sm text-muted">{label}</Text>
      <Text className="text-sm font-medium text-ink">{value}</Text>
    </View>
  );
}
