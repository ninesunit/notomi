import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { onSnapshot } from 'firebase/firestore';
import { ScreenScroll } from '@/components/ScreenScroll';
import { FadeIn } from '@/components/motion';
import { Button, Card, EmptyState, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import { minutesToLabel, DAY_FULL, type ClassBlock, type RoutineBlock } from '@/lib/schema';
import { feedback } from '@/lib/sound';
import { getDb } from '@/services/firebase';
import {
  acceptFriend,
  busyPath,
  claimHandle,
  commonGaps,
  describeGap,
  findByHandle,
  friendsPath,
  isFocusing,
  myProfile,
  normaliseHandle,
  presencePath,
  publishBusy,
  removeFriend,
  requestFriend,
  stopSharing,
  toBusyIntervals,
  type BusyInterval,
  type Friend,
  type Presence,
  type Profile,
} from '@/services/social';

/**
 * Friends, and the one question they are for.
 *
 * "When are we all free" is the thing a group chat spends twenty messages
 * failing to answer. Notomi already knows every member's week, so it can answer
 * it in a line — and it can do that while sharing strictly less than a
 * screenshot of a timetable would.
 */
export default function Friends() {
  const uid = useUid();
  const { user } = useAuth();
  const db = getDb();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [handle, setHandle] = useState('');
  const [lookup, setLookup] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const friends = useCollection<Friend>(friendsPath(db, uid), [uid]);
  const classes = useCollection<ClassBlock>(paths.classes(db, uid), [uid]);
  const routines = useCollection<RoutineBlock>(paths.routines(db, uid), [uid]);

  useEffect(() => {
    let live = true;
    void myProfile(uid)
      .then((found) => {
        if (!live) return;
        setProfile(found);
        setHandle(found?.handle ?? '');
      })
      .finally(() => live && setLoadingProfile(false));
    return () => {
      live = false;
    };
  }, [uid]);

  const accepted = friends.data.filter((friend) => friend.status === 'accepted');
  const incoming = friends.data.filter((friend) => friend.status === 'incoming');

  /**
   * Publishing is a side effect of having friends, not a separate switch to
   * forget: the moment there is nobody to share with, the document goes.
   */
  useEffect(() => {
    if (loadingProfile || classes.loading || routines.loading) return;

    if (accepted.length === 0) {
      void stopSharing(uid);
      return;
    }
    void publishBusy(uid, toBusyIntervals(classes.data, routines.data));
  }, [uid, accepted.length, classes.data, classes.loading, routines.data, routines.loading, loadingProfile]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await claimHandle(
        uid,
        handle,
        user?.displayName || user?.email?.split('@')[0] || 'Student',
        '#B4552D'
      );
      setProfile(await myProfile(uid));
      feedback('success');
      setNotice('Your handle is set. Share it and friends can add you.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      feedback('error');
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!profile) {
      setError('Pick a handle first so they can see who is asking.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const them = await findByHandle(lookup);
      if (!them) throw new Error(`Nobody here goes by “${normaliseHandle(lookup)}”.`);
      const outcome = await requestFriend(uid, profile, them);
      setLookup('');
      setNotice(
        outcome === 'accepted'
          ? `You and ${them.displayName} are now friends.`
          : `Request sent to ${them.displayName}.`
      );
      feedback(outcome === 'accepted' ? 'success' : 'sent');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      feedback('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenScroll>
      <PageHeader title="Friends" subtitle="Find the gaps you all share." />

      {error ? <View className="mb-4"><Notice title="That did not work" body={error} /></View> : null}
      {notice ? <View className="mb-4"><Notice tone="pine" title={notice} /></View> : null}

      {loadingProfile ? (
        <Loading label="Loading…" />
      ) : (
        <>
          <Card className="mb-6 gap-3">
            <Text className="text-[15px] font-semibold text-ink">
              {profile ? 'Your handle' : 'Pick a handle'}
            </Text>
            <Text className="text-xs leading-5 text-subtle">
              It is the only thing about you another student can search for. Your classes, notes
              and marks are never shared — friends see when you are busy, not what you are doing.
            </Text>
            <View className="flex-row items-end gap-2">
              <View className="flex-1">
                <Field
                  value={handle}
                  onChangeText={(value) => setHandle(normaliseHandle(value))}
                  placeholder="mika"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <Button
                label={profile ? 'Update' : 'Claim'}
                size="sm"
                loading={busy}
                disabled={busy || handle.trim().length < 3}
                onPress={() => void save()}
              />
            </View>
          </Card>

          <Card className="mb-6 gap-3">
            <Text className="text-[15px] font-semibold text-ink">Add a friend</Text>
            <View className="flex-row items-end gap-2">
              <View className="flex-1">
                <Field
                  value={lookup}
                  onChangeText={setLookup}
                  placeholder="their handle"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <Button
                label="Send"
                icon="user-plus"
                size="sm"
                loading={busy}
                disabled={busy || lookup.trim().length < 3}
                onPress={() => void add()}
              />
            </View>
          </Card>

          {incoming.length > 0 ? (
            <View className="mb-6 gap-2">
              <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                Waiting on you
              </Text>
              {incoming.map((friend) => (
                <Card key={friend.id} className="flex-row items-center gap-3">
                  <Avatar name={friend.displayName} color={friend.color} />
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-ink">{friend.displayName}</Text>
                    <Text className="text-xs text-subtle">@{friend.handle}</Text>
                  </View>
                  <Button
                    label="Accept"
                    size="sm"
                    onPress={() => {
                      feedback('success');
                      void acceptFriend(uid, friend.id).catch((caught) =>
                        setError(String(caught))
                      );
                    }}
                  />
                </Card>
              ))}
            </View>
          ) : null}

          {accepted.length === 0 ? (
            <EmptyState
              icon="users"
              title="No friends yet"
              body="Add someone by their handle. Once you both accept, Notomi overlays your weeks and shows the hours you are all free — without either of you sharing a timetable."
            />
          ) : (
            <>
              <FreeTogether uid={uid} friends={accepted} mine={classes.data} routines={routines.data} />

              <View className="mt-8 gap-2">
                <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                  {accepted.length} {accepted.length === 1 ? 'friend' : 'friends'}
                </Text>
                {accepted.map((friend, index) => (
                  <FadeIn key={friend.id} index={index}>
                    <FriendRow
                      friend={friend}
                      onRemove={() => void removeFriend(uid, friend.id)}
                    />
                  </FadeIn>
                ))}
              </View>
            </>
          )}
        </>
      )}
    </ScreenScroll>
  );
}

/* ------------------------------------------------------------------ *
 * The answer
 * ------------------------------------------------------------------ */

function FreeTogether({
  uid,
  friends,
  mine,
  routines,
}: {
  uid: string;
  friends: Friend[];
  mine: ClassBlock[];
  routines: RoutineBlock[];
}) {
  const db = getDb();
  const [weeks, setWeeks] = useState<Record<string, BusyInterval[]>>({});
  const [chosen, setChosen] = useState<string[]>(() => friends.map((friend) => friend.id));

  // One subscription per friend rather than a query: a friend's busy document
  // is readable only by name, which is what keeps the rule a single check.
  useEffect(() => {
    setChosen((current) => current.filter((id) => friends.some((friend) => friend.id === id)));
  }, [friends]);

  useEffect(() => {
    const stops = friends.map((friend) =>
      onSnapshot(
        busyPath(db, friend.id),
        (snapshot) => {
          const intervals = (snapshot.data()?.intervals ?? []) as BusyInterval[];
          setWeeks((current) => ({ ...current, [friend.id]: intervals }));
        },
        // A friend who has stopped sharing is not an error worth showing.
        () => undefined
      )
    );
    return () => stops.forEach((stop) => stop());
  }, [db, friends]);

  const gaps = useMemo(() => {
    const included = friends.filter((friend) => chosen.includes(friend.id));
    return commonGaps([
      toBusyIntervals(mine, routines),
      ...included.map((friend) => weeks[friend.id] ?? []),
    ]);
  }, [friends, chosen, weeks, mine, routines]);

  const missing = friends.filter(
    (friend) => chosen.includes(friend.id) && weeks[friend.id] === undefined
  );

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-2">
        <Feather name="clock" size={15} color="#2E6F5E" />
        <Text className="text-[15px] font-semibold text-ink">Free together</Text>
      </View>

      <View className="flex-row flex-wrap gap-1.5">
        {friends.map((friend) => {
          const on = chosen.includes(friend.id);
          return (
            <Pressable
              key={friend.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={friend.displayName}
              aria-checked={on}
              onPress={() => {
                feedback('toggle');
                setChosen((current) =>
                  on ? current.filter((id) => id !== friend.id) : [...current, friend.id]
                );
              }}
              className={`rounded-lg px-3 py-1.5 ${on ? 'bg-ink' : 'bg-sand'}`}
            >
              <Text className={`text-xs font-semibold ${on ? 'text-paper' : 'text-muted'}`}>
                {friend.displayName}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {missing.length > 0 ? (
        <Text className="text-xs text-subtle">
          {missing.map((friend) => friend.displayName).join(', ')} has not shared a week yet.
        </Text>
      ) : null}

      {gaps.length === 0 ? (
        <Text className="text-sm text-muted">
          No hour between 8am and 8pm works for everyone selected.
        </Text>
      ) : (
        <View className="gap-1.5">
          {gaps.slice(0, 6).map((gap) => (
            <View
              key={`${gap.day}-${gap.start}`}
              className="flex-row items-center gap-2 rounded-xl bg-pine-soft px-3 py-2"
            >
              <Text className="w-9 text-[11px] font-bold uppercase tracking-wider text-pine">
                {DAY_FULL[gap.day].slice(0, 3)}
              </Text>
              <Text className="flex-1 text-sm font-semibold text-ink">
                {minutesToLabel(gap.start)}–{minutesToLabel(gap.end)}
              </Text>
              <Text className="text-xs text-muted">
                {Math.round((gap.end - gap.start) / 60)} h
              </Text>
            </View>
          ))}
        </View>
      )}

      <Text className="text-[11px] leading-4 text-subtle">
        Worked out on your device from the hours each of you is busy. Nobody sees anyone’s
        subjects, rooms or marks.
      </Text>
    </Card>
  );
}

function FriendRow({ friend, onRemove }: { friend: Friend; onRemove: () => void }) {
  const presence = useDocument<Presence>(presencePath(getDb(), friend.id), [friend.id]);
  const focusing = isFocusing(presence.data);

  return (
    <Card className="flex-row items-center gap-3">
      <Avatar name={friend.displayName} color={friend.color} focusing={focusing} />
      <View className="flex-1">
        <Text className="text-sm font-semibold text-ink">{friend.displayName}</Text>
        <Text className="text-xs text-subtle" numberOfLines={1}>
          {focusing
            ? `In deep focus${presence.data?.subjectName ? ` · ${presence.data.subjectName}` : ''}`
            : `@${friend.handle}`}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${friend.displayName}`}
        onPress={onRemove}
        className="h-9 w-9 items-center justify-center rounded-lg"
      >
        <Feather name="user-minus" size={15} color="#9A9488" />
      </Pressable>
    </Card>
  );
}

function Avatar({
  name,
  color,
  focusing = false,
}: {
  name: string;
  color: string;
  focusing?: boolean;
}) {
  return (
    <View>
      <View
        className="h-10 w-10 items-center justify-center rounded-full"
        style={{ backgroundColor: `${color}24` }}
      >
        <Text className="text-sm font-bold" style={{ color }}>
          {name.charAt(0).toUpperCase()}
        </Text>
      </View>
      {focusing ? (
        <View className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface bg-rose" />
      ) : null}
    </View>
  );
}
