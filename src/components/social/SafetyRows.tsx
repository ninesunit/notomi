import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Sheet } from '@/components/Sheet';
import { Button, Card, EmptyState, Loading, Notice, Touchable } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { play } from '@/lib/sound';
import { revokeShare, sentShares, type SentShare } from '@/services/sharing';
import { universityLabel } from '@/services/universities';
import {
  blockedUsers,
  myProfile,
  privacyOf,
  unblockUser,
  type BlockedUser,
  type PrivacySettings,
  type Profile,
} from '@/services/social';

/**
 * The three things a privacy switch cannot tell you.
 *
 * A toggle says what *will* happen. These say what already has: who you have
 * blocked, what you have handed out, and what the switches above actually add
 * up to when somebody else looks at you. All three are read on demand — a
 * settings screen should not spend a query on a list nobody opened.
 */
export function SafetyRows({ privacy }: { privacy: PrivacySettings | null }) {
  const uid = useUid();
  const [open, setOpen] = useState<'preview' | 'blocked' | 'shares' | null>(null);
  const [blocked, setBlocked] = useState<BlockedUser[] | null>(null);
  const [shares, setShares] = useState<SentShare[] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (which: 'preview' | 'blocked' | 'shares') => {
      setOpen(which);
      setError(null);
      if (which === 'blocked' && blocked === null) {
        void blockedUsers(uid)
          .then(setBlocked)
          .catch(() => setError('Could not open your blocked list. Try again in a moment.'));
      }
      if (which === 'shares' && shares === null) {
        void sentShares(uid)
          .then(setShares)
          .catch(() => setError('Could not open what you have shared. Try again in a moment.'));
      }
      if (which === 'preview' && profile === null) {
        void myProfile(uid)
          .then(setProfile)
          .catch(() => setError('Could not load your profile.'));
      }
    },
    [uid, blocked, shares, profile]
  );

  return (
    <View className="gap-1">
      <Row icon="eye" label="Preview what others see" onPress={() => load('preview')} />
      <Row icon="shield" label="Blocked people" onPress={() => load('blocked')} />
      <Row icon="share-2" label="Material you have shared" onPress={() => load('shares')} />

      <Sheet
        visible={open === 'preview'}
        onClose={() => setOpen(null)}
        title="What others see"
        icon="eye"
        variant="fullscreen-mobile"
        maxHeight={560}
      >
        {error ? <Notice title="That did not work" body={error} /> : null}
        {profile === null ? (
          <Loading label="Loading your profile…" />
        ) : (
          <ProfilePreview profile={profile} privacy={privacy ?? privacyOf(profile)} />
        )}
      </Sheet>

      <Sheet
        visible={open === 'blocked'}
        onClose={() => setOpen(null)}
        title="Blocked people"
        icon="shield"
        variant="auto"
      >
        {error ? <Notice title="That did not work" body={error} /> : null}
        {blocked === null && !error ? (
          <Loading label="Loading…" />
        ) : !blocked?.length ? (
          <EmptyState
            icon="shield"
            title="Nobody is blocked"
            body="Blocking someone ends the friendship, hides them from your search results and stops any new request. They are never told."
          />
        ) : (
          <View className="gap-2">
            {blocked.map((entry) => (
              <Card key={entry.id} className="gap-2 p-3">
                <View className="flex-row items-center gap-3">
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                      {entry.displayName || 'Student'}
                    </Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      @{entry.username || 'student'}
                      {entry.createdAt ? ` · ${shortDate(entry.createdAt.toDate())}` : ''}
                    </Text>
                  </View>
                  <Button
                    label="Unblock"
                    icon="user-plus"
                    variant="secondary"
                    size="sm"
                    onPress={() => {
                      setBlocked((current) => (current ?? []).filter((row) => row.id !== entry.id));
                      play('toggle');
                      void unblockUser(uid, entry.id).catch(() => {
                        setBlocked((current) => [...(current ?? []), entry]);
                        setError('That did not save. Check your connection and try again.');
                      });
                    }}
                  />
                </View>
                {entry.reason ? (
                  <View className="rounded-xl bg-sand px-3 py-2">
                    <Text className="text-[11px] font-bold uppercase tracking-wider text-muted">
                      What you recorded
                    </Text>
                    <Text className="mt-1 text-xs leading-5 text-ink">{entry.reason}</Text>
                  </View>
                ) : null}
              </Card>
            ))}
            <Text className="text-[11px] leading-4 text-subtle">
              Reasons are kept in your account as your own record. Notomi has no moderation queue
              behind them, so nobody else reads them.
            </Text>
          </View>
        )}
      </Sheet>

      <Sheet
        visible={open === 'shares'}
        onClose={() => setOpen(null)}
        title="Material you have shared"
        icon="share-2"
        variant="auto"
      >
        {error ? <Notice title="That did not work" body={error} /> : null}
        {shares === null && !error ? (
          <Loading label="Loading…" />
        ) : !shares?.length ? (
          <EmptyState
            icon="share-2"
            title="Nothing shared yet"
            body="Read-only copies you send to a friend appear here, and can be taken back from here."
          />
        ) : (
          <View className="gap-2">
            {shares.map((share) => (
              <Card key={share.id} className="flex-row items-center gap-3 p-3">
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-semibold text-ink" numberOfLines={1}>{share.title}</Text>
                  <Text className="text-xs text-muted" numberOfLines={1}>
                    {share.recipientName || 'A friend'}
                    {share.createdAt ? ` · ${shortDate(share.createdAt.toDate())}` : ''}
                  </Text>
                </View>
                <Button
                  label="Take back"
                  icon="trash-2"
                  variant="danger"
                  size="sm"
                  onPress={() => {
                    setShares((current) => (current ?? []).filter((row) => row.id !== share.id));
                    void revokeShare(uid, share).catch(() => {
                      setShares((current) => [share, ...(current ?? [])]);
                      setError('Could not take that copy back. Try again in a moment.');
                    });
                  }}
                />
              </Card>
            ))}
            <Text className="text-[11px] leading-4 text-subtle">
              Taking a copy back deletes it from their Library. Anything they exported or wrote
              down before then is theirs, as it would be with a printout.
            </Text>
          </View>
        )}
      </Sheet>
    </View>
  );
}

/**
 * The switches above, read back as a person rather than as settings.
 *
 * Two audiences, because the app has exactly two: anyone who can find you, and
 * the friends you accepted. Each line is written to be checkable — a student
 * should be able to look at this and say "no, I did not mean that", which no
 * list of toggles ever lets them do.
 */
function ProfilePreview({ profile, privacy }: { profile: Profile; privacy: PrivacySettings }) {
  const courses = privacy.shareCourses ? (profile.courseCodes ?? []) : [];

  return (
    <View className="gap-5">
      <View className="gap-2">
        <Text className="text-xs font-bold uppercase tracking-wider text-muted">
          Anyone who searches for you
        </Text>
        <Card className="gap-1 p-4">
          <Text className="text-base font-semibold text-ink">{profile.displayName}</Text>
          <Text className="text-xs text-muted">@{profile.username || 'not set yet'}</Text>
          {profile.university ? (
            <Text className="mt-1 text-xs text-muted">{universityLabel(profile)}</Text>
          ) : null}
          {profile.major ? <Text className="text-xs text-muted">{profile.major}</Text> : null}
          {profile.bio ? <Text className="mt-1 text-sm leading-5 text-ink">{profile.bio}</Text> : null}
          {courses.length ? (
            <Text className="mt-2 text-xs text-muted">
              Course codes · {courses.slice(0, 6).join(', ')}
              {courses.length > 6 ? ` +${courses.length - 6}` : ''}
            </Text>
          ) : (
            <Text className="mt-2 text-xs text-subtle">No course codes — classmates cannot find you this way.</Text>
          )}
        </Card>
      </View>

      <View className="gap-2">
        <Text className="text-xs font-bold uppercase tracking-wider text-muted">Your friends also see</Text>
        <View className="gap-1.5">
          <PreviewLine
            on={privacy.sharePresence}
            on_="Whether you are free, in class or focusing right now."
            off="Nothing about what you are doing right now."
          />
          <PreviewLine
            on={privacy.shareSchedule}
            on_="Your week with its labels — class names and rooms — and the hours you are free."
            off="Only the hours you are free, as blank and busy blocks with no labels."
          />
        </View>
      </View>

      <View className="gap-2">
        <Text className="text-xs font-bold uppercase tracking-wider text-muted">Nobody ever sees</Text>
        <Card className="gap-1 p-4">
          {['Your notes, documents and flashcards', 'Your marks, GPA and attendance', 'Your tasks and deadlines', 'Your email address'].map(
            (line) => (
              <View key={line} className="flex-row items-center gap-2">
                <Icon name="lock" size={13} tone="subtle" />
                <Text className="flex-1 text-xs text-muted">{line}</Text>
              </View>
            )
          )}
        </Card>
      </View>
    </View>
  );
}

function PreviewLine({ on, on_, off }: { on: boolean; on_: string; off: string }) {
  return (
    <View className="flex-row items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2.5">
      <View className="mt-0.5">
        <Icon name={on ? 'eye' : 'eye-off'} size={14} tone={on ? 'pine' : 'subtle'} />
      </View>
      <Text className="flex-1 text-xs leading-5 text-muted">{on ? on_ : off}</Text>
    </View>
  );
}

function Row({
  icon,
  label,
  onPress,
}: {
  icon: 'eye' | 'shield' | 'share-2';
  label: string;
  onPress: () => void;
}) {
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-xl border border-line px-3 py-2.5"
    >
      <Icon name={icon} size={15} tone="muted" />
      <Text className="flex-1 text-sm font-medium text-ink">{label}</Text>
      <Icon name="chevron-right" size={15} tone="subtle" />
    </Touchable>
  );
}

function shortDate(date: Date): string {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
