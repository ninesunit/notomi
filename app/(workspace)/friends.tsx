import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Icon, useTones } from '@/components/Icon';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import { ShareMaterial } from '@/components/social/ShareMaterial';
import { Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import { DAY_FULL, minutesToLabel, type ClassBlock, type RoutineBlock, type Subject } from '@/lib/schema';
import { feedback } from '@/lib/sound';
import { getDb } from '@/services/firebase';
import {
  acceptFriend,
  commonGaps,
  friendsPath,
  getPublicProfiles,
  loadBusyWeeks,
  myProfile,
  presenceQuery,
  profilePath,
  publishBusy,
  removeFriend,
  requestFriend,
  searchProfiles,
  loadSharedWeek,
  stopSharing,
  syncPublicCourses,
  toBusyIntervals,
  toSharedBlocks,
  usernameOf,
  type BusyInterval,
  type SharedBlock,
  type Friend,
  type Gap,
  type Presence,
  type Profile,
} from '@/services/social';
import { universityLabel, universitySearchKey } from '@/services/universities';

type DirectoryFilter = 'all' | 'university' | 'classmates';

const FILTERS: { id: DirectoryFilter; label: string; icon: 'users' | 'graduation-cap' | 'book-open' }[] = [
  { id: 'all', label: 'All Friends', icon: 'users' },
  { id: 'university', label: 'Same University', icon: 'graduation-cap' },
  { id: 'classmates', label: 'Classmates', icon: 'book-open' },
];

export default function Friends() {
  const uid = useUid();
  const db = getDb();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const desktop = width >= 1024;
  const friends = useCollection<Friend>(friendsPath(db, uid), [uid]);
  const classes = useCollection<ClassBlock>(paths.classes(db, uid), [uid]);
  const routines = useCollection<RoutineBlock>(paths.routines(db, uid), [uid]);
  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);
  const profile = useDocument<Profile>(profilePath(db, uid), [uid]);

  const accepted = useMemo(
    () => friends.data.filter((friend) => friend.status === 'accepted'),
    [friends.data]
  );
  const incoming = useMemo(
    () => friends.data.filter((friend) => friend.status === 'incoming'),
    [friends.data]
  );
  const acceptedIds = useMemo(() => accepted.map((friend) => friend.id), [accepted]);
  const acceptedKey = acceptedIds.join('|');
  const presence = useCollection<Presence>(presenceQuery(acceptedIds), [acceptedKey]);
  const presenceMap = useMemo(
    () => Object.fromEntries(presence.data.map((entry) => [entry.id, entry])),
    [presence.data]
  );

  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [lookup, setLookup] = useState('');
  const [results, setResults] = useState<Profile[]>([]);
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState<DirectoryFilter>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [busyWeeks, setBusyWeeks] = useState<Record<string, BusyInterval[]>>({});
  const [loadingGaps, setLoadingGaps] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The friend whose labelled week is open, if any. */
  const [viewingWeek, setViewingWeek] = useState<Friend | null>(null);

  useEffect(() => {
    void myProfile(uid).catch((caught) => console.warn('[social] Profile migration failed.', caught));
  }, [uid]);

  useEffect(() => {
    let active = true;
    if (!acceptedIds.length) {
      setProfiles({});
      return;
    }
    void getPublicProfiles(acceptedIds)
      .then((next) => active && setProfiles(next))
      .catch((caught) => active && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      active = false;
    };
  }, [acceptedKey]);

  useEffect(() => {
    if (classes.loading || routines.loading || friends.loading) return;
    if (accepted.length === 0) {
      void stopSharing(uid);
      return;
    }
    void publishBusy(
      uid,
      toBusyIntervals(classes.data, routines.data),
      // Labels only when the student has asked for them; the shape of the week
      // goes out either way, because the free-time matcher runs on that alone.
      profile.data?.shareSchedule === true ? toSharedBlocks(classes.data, routines.data) : []
    );
  }, [
    uid,
    accepted.length,
    classes.data,
    classes.loading,
    routines.data,
    routines.loading,
    friends.loading,
    profile.data?.shareSchedule,
  ]);

  useEffect(() => {
    if (profile.loading || subjects.loading) return;
    void syncPublicCourses(
      uid,
      profile.data,
      subjects.data.map((subject) => subject.moduleCode ?? '').filter(Boolean),
      subjects.data.reduce((total, subject) => total + (subject.documentCount ?? 0), 0)
    ).catch(() => undefined);
  }, [uid, profile.loading, profile.data, subjects.loading, subjects.data]);

  useEffect(() => {
    const query = lookup.trim();
    if (query.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void searchProfiles(query)
        .then((found) => {
          if (!active) return;
          setResults(found.filter((entry) => entry.id !== uid));
          setSearching(false);
        })
        .catch((caught) => {
          if (!active) return;
          setError(caught instanceof Error ? caught.message : String(caught));
          setSearching(false);
        });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [lookup, uid]);

  useEffect(() => {
    setSelected((current) => current.filter((id) => acceptedIds.includes(id)).slice(0, 3));
  }, [acceptedKey]);

  useEffect(() => {
    let active = true;
    if (!selected.length) {
      setBusyWeeks({});
      setLoadingGaps(false);
      return;
    }
    setLoadingGaps(true);
    void loadBusyWeeks(selected)
      .then((weeks) => active && setBusyWeeks(weeks))
      .catch((caught) => active && setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => active && setLoadingGaps(false));
    return () => {
      active = false;
    };
  }, [selected.join('|')]);

  const ownCodes = useMemo(
    () => new Set(subjects.data.map((subject) => subject.moduleCode?.toUpperCase()).filter(Boolean)),
    [subjects.data]
  );
  const visibleFriends = useMemo(
    () =>
      accepted.filter((friend) =>
        matchesDirectoryFilter(filter, profile.data, profiles[friend.id], ownCodes)
      ),
    [accepted, filter, profile.data, profiles, ownCodes]
  );
  const visibleResults = useMemo(
    () => results.filter((entry) => matchesDirectoryFilter(filter, profile.data, entry, ownCodes)),
    [results, filter, profile.data, ownCodes]
  );

  async function follow(them: Profile) {
    if (!profile.data?.username) {
      router.push('/profile');
      return;
    }
    setActionBusy(them.id);
    setError(null);
    try {
      const outcome = await requestFriend(uid, profile.data, them);
      setNotice(
        outcome === 'accepted'
          ? `You and ${them.displayName} are now friends.`
          : `Friend request sent to ${them.displayName}.`
      );
      feedback(outcome === 'accepted' ? 'success' : 'sent');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionBusy(null);
    }
  }

  function chooseForMatch(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((candidate) => candidate !== id);
      if (current.length >= 3) {
        setNotice('Choose up to three friends for one schedule match.');
        return current;
      }
      return [...current, id];
    });
  }

  return (
    <ScreenScroll maxWidth={1200}>
      <PageHeader
        title="Friends & Search"
        subtitle="Find classmates, share study material and plan time together without exposing private schedules."
      />

      <Card className="mb-6 gap-4 p-4 sm:p-5">
        <View className="flex-row items-center gap-3 rounded-xl border border-line bg-paper px-4">
          <Icon name="search" size={18} tone="muted" />
          <TextInput
            value={lookup}
            onChangeText={setLookup}
            placeholder="Search students by name, @username, or university..."
            placeholderTextColor="#9A9488"
            autoCapitalize="none"
            autoCorrect={false}
            className="min-w-0 flex-1 py-3.5 text-[15px] text-ink"
          />
          {searching ? <Icon name="loader" size={16} tone="accent" /> : null}
        </View>
        <View className="flex-row flex-wrap gap-2">
          {FILTERS.map((entry) => (
            <FilterPill
              key={entry.id}
              active={filter === entry.id}
              icon={entry.icon}
              label={entry.label}
              onPress={() => setFilter(entry.id)}
            />
          ))}
        </View>
      </Card>

      {error ? <View className="mb-4"><Notice title="That did not work" body={error} /></View> : null}
      {notice ? <View className="mb-4"><Notice tone="pine" title={notice} /></View> : null}
      {!profile.loading && !profile.data?.username ? (
        <View className="mb-4">
          <Notice
            tone="amber"
            title="Finish your public profile"
            body="Choose your username and university in Profile before sending friend requests."
          />
          <View className="mt-2 self-start">
            <Button label="Open Profile" icon="user" size="sm" onPress={() => router.push('/profile')} />
          </View>
        </View>
      ) : null}

      {lookup.trim().length >= 2 ? (
        <View className="mb-7 gap-3">
          <SectionTitle icon="search" label={`SEARCH RESULTS (${visibleResults.length})`} />
          {searching ? (
            <Loading label="Searching students..." />
          ) : visibleResults.length === 0 ? (
            <Card><Text className="text-sm text-muted">No students match this search and filter.</Text></Card>
          ) : (
            visibleResults.map((entry) => {
              const connected = acceptedIds.includes(entry.id);
              return (
                <StudentCard
                  key={entry.id}
                  profile={entry}
                  mutualCodes={mutualCourseCodes(ownCodes, entry.courseCodes)}
                  presence={presenceMap[entry.id]}
                  actions={
                    <>
                      <Button
                        label="View Profile"
                        icon="user"
                        variant="secondary"
                        size="sm"
                        onPress={() => router.push(`/profile/${entry.id}` as never)}
                      />
                      <Button
                        label={connected ? 'Friends' : 'Follow'}
                        icon={connected ? 'check' : 'user-plus'}
                        variant="secondary"
                        size="sm"
                        disabled={connected || actionBusy === entry.id}
                        loading={actionBusy === entry.id}
                        onPress={() => void follow(entry)}
                      />
                      <Button
                        label="Challenge"
                        icon="swords"
                        size="sm"
                        onPress={() => router.push(`/social?tab=arena&opponent=${entry.id}` as never)}
                      />
                    </>
                  }
                />
              );
            })
          )}
        </View>
      ) : null}

      {incoming.length > 0 ? (
        <View className="mb-7 gap-3">
          <SectionTitle icon="user-plus" label={`FRIEND REQUESTS (${incoming.length})`} />
          {incoming.map((friend) => (
            <Card key={friend.id} className="flex-row items-center gap-3">
              <Avatar name={friend.displayName} color={friend.color} />
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-semibold text-ink" numberOfLines={1}>{friend.displayName}</Text>
                <Text className="text-xs text-muted">@{usernameOf(friend)}</Text>
              </View>
              <Button
                label="Accept"
                icon="check"
                size="sm"
                onPress={() => void acceptFriend(uid, friend.id).catch((caught) => setError(String(caught)))}
              />
            </Card>
          ))}
        </View>
      ) : null}

      <View className={desktop ? 'flex-row items-start gap-6' : 'gap-6'}>
        <View className="min-w-0 gap-3" style={desktop ? { flex: 2 } : undefined}>
          <SectionTitle icon="users" label={`FRIENDS (${visibleFriends.length})`} />
          {friends.loading || profile.loading ? (
            <Loading label="Loading friends..." />
          ) : visibleFriends.length === 0 ? (
            <EmptyState
              icon="users"
              title={accepted.length ? 'No friends match this filter' : 'No friends yet'}
              body={
                accepted.length
                  ? 'Try All Friends, or enable classmate discovery from your Profile.'
                  : 'Search by name, username or university and send your first friend request.'
              }
            />
          ) : (
            visibleFriends.map((friend) => {
              const publicProfile = profiles[friend.id] ?? friendAsProfile(friend);
              return (
                <StudentCard
                  key={friend.id}
                  profile={publicProfile}
                  mutualCodes={mutualCourseCodes(ownCodes, publicProfile.courseCodes)}
                  presence={presenceMap[friend.id]}
                  selected={selected.includes(friend.id)}
                  actions={
                    <>
                      <Button
                        label="View Profile"
                        icon="user"
                        variant="secondary"
                        size="sm"
                        onPress={() => router.push(`/profile/${friend.id}` as never)}
                      />
                      <Button
                        label={selected.includes(friend.id) ? 'Selected' : 'Match Schedule'}
                        icon={selected.includes(friend.id) ? 'check' : 'calendar'}
                        variant="secondary"
                        size="sm"
                        onPress={() => chooseForMatch(friend.id)}
                      />
                      <Button
                        label="Their week"
                        icon="calendar"
                        variant="secondary"
                        size="sm"
                        onPress={() => setViewingWeek(friend)}
                      />
                      <Button
                        label="Challenge"
                        icon="swords"
                        size="sm"
                        onPress={() => router.push(`/social?tab=arena&opponent=${friend.id}` as never)}
                      />
                      <ShareMaterial friend={friend} />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${friend.displayName}`}
                        onPress={() => void removeFriend(uid, friend.id)}
                        className="h-9 w-9 items-center justify-center rounded-lg"
                      >
                        <Icon name="user-minus" size={15} tone="subtle" />
                      </Pressable>
                    </>
                  }
                />
              );
            })
          )}
        </View>

        <View className="min-w-0" style={desktop ? { flex: 1 } : undefined}>
          <ScheduleOverlap
            friends={accepted}
            selected={selected}
            busyWeeks={busyWeeks}
            mine={toBusyIntervals(classes.data, routines.data)}
            loading={loadingGaps}
            onToggle={chooseForMatch}
            onSprint={() => router.push('/tasks?tab=focus')}
          />
        </View>
      </View>

      <FriendWeek friend={viewingWeek} onClose={() => setViewingWeek(null)} />
    </ScreenScroll>
  );
}

/**
 * A friend's week, when they have chosen to publish it with its labels.
 *
 * Deliberately a read of one document rather than anything live: a timetable
 * changes a handful of times a semester, and the alternative — a listener per
 * friend — costs a connection each to watch something that does not move.
 */
function FriendWeek({ friend, onClose }: { friend: Friend | null; onClose: () => void }) {
  const [blocks, setBlocks] = useState<SharedBlock[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!friend) return;
    let live = true;
    setBlocks(null);
    setFailed(false);
    void loadSharedWeek(friend.id)
      .then((found) => live && setBlocks(found))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [friend?.id]);

  const byDay = useMemo(() => {
    const days: SharedBlock[][] = Array.from({ length: 7 }, () => []);
    for (const block of blocks ?? []) days[block.day]?.push(block);
    return days;
  }, [blocks]);

  return (
    <Sheet
      visible={friend !== null}
      onClose={onClose}
      title={friend ? `${friend.displayName}’s week` : 'Their week'}
      icon="calendar"
    >
      {failed ? (
        <Notice title="Could not open their week" body="Try again in a moment." />
      ) : blocks === null ? (
        <Loading label="Opening their week…" />
      ) : blocks.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="Not shared"
          body={`${friend?.displayName ?? 'They'} has not turned on schedule sharing. You can still use Match Schedule to find time you are both free.`}
        />
      ) : (
        <View className="gap-3">
          {byDay.map((entries, day) =>
            entries.length === 0 ? null : (
              <View key={day} className="gap-1.5">
                <Text className="text-[11px] font-bold uppercase tracking-wider text-muted">
                  {DAY_FULL[day]}
                </Text>
                {entries.map((block, index) => (
                  <View
                    key={`${day}-${index}`}
                    className="flex-row items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5"
                  >
                    <Text className="w-28 shrink-0 text-xs font-semibold tabular-nums text-muted">
                      {minutesToLabel(block.start)}–{minutesToLabel(block.end)}
                    </Text>
                    <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
                      {block.title}
                    </Text>
                  </View>
                ))}
              </View>
            )
          )}
        </View>
      )}
    </Sheet>
  );
}

function ScheduleOverlap({
  friends,
  selected,
  busyWeeks,
  mine,
  loading,
  onToggle,
  onSprint,
}: {
  friends: Friend[];
  selected: string[];
  busyWeeks: Record<string, BusyInterval[]>;
  mine: BusyInterval[];
  loading: boolean;
  onToggle: (id: string) => void;
  onSprint: () => void;
}) {
  const complete = selected.every((id) => busyWeeks[id] !== undefined);
  const gaps = useMemo(
    () => (selected.length && complete ? commonGaps([mine, ...selected.map((id) => busyWeeks[id])]) : []),
    [selected, complete, busyWeeks, mine]
  );
  const ordered = useMemo(() => orderFromToday(gaps), [gaps]);

  return (
    <Card className="gap-4 p-5">
      <View className="flex-row items-start gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-pine-soft">
          <Icon name="clock" size={18} tone="pine" />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="font-heading text-lg font-semibold text-ink">Find Shared Free Time</Text>
          <Text className="text-xs leading-5 text-muted">Select up to three friends. Schedules load only when selected.</Text>
        </View>
      </View>

      <View className="flex-row flex-wrap gap-2">
        {friends.map((friend) => (
          <Pressable
            key={friend.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected.includes(friend.id) }}
            onPress={() => onToggle(friend.id)}
            className={`flex-row items-center gap-1.5 rounded-full border px-3 py-2 ${
              selected.includes(friend.id) ? 'border-ink bg-ink' : 'border-line bg-paper'
            }`}
          >
            {selected.includes(friend.id) ? <Icon name="check" size={13} tone="inverse" /> : null}
            <Text className={`text-xs font-semibold ${selected.includes(friend.id) ? 'text-paper' : 'text-muted'}`}>
              {friend.displayName.split(' ')[0]}
            </Text>
          </Pressable>
        ))}
      </View>

      {!selected.length ? (
        <View className="rounded-xl border border-dashed border-line bg-paper px-4 py-6">
          <Text className="text-center text-sm text-muted">Choose a friend to calculate shared gaps.</Text>
        </View>
      ) : loading ? (
        <Loading label="Matching schedules..." />
      ) : !complete ? (
        <Notice tone="amber" title="A selected friend has not shared their busy hours yet" />
      ) : ordered.length === 0 ? (
        <Notice tone="amber" title="No shared one-hour gap between 8 AM and 8 PM" />
      ) : (
        <View className="gap-2">
          {ordered.slice(0, 5).map((gap) => (
            <View key={`${gap.day}-${gap.start}`} className="rounded-xl bg-pine-soft px-3 py-3">
              <Text className="text-xs font-bold uppercase tracking-wider text-pine">{relativeDay(gap.day)}</Text>
              <Text className="mt-1 text-sm font-semibold text-ink">
                {minutesToLabel(gap.start)} – {minutesToLabel(gap.end)}
              </Text>
              <Text className="mt-0.5 text-xs text-muted">{formatDuration(gap.end - gap.start)}</Text>
            </View>
          ))}
        </View>
      )}

      <Button
        label="Schedule Study Sprint"
        icon="plus"
        disabled={!selected.length || !ordered.length}
        onPress={onSprint}
      />
      <Text className="text-[11px] leading-4 text-subtle">
        Matching happens on this device using anonymous busy intervals. Course names, rooms and marks are never shared.
      </Text>
    </Card>
  );
}

function StudentCard({
  profile,
  presence,
  mutualCodes,
  selected = false,
  actions,
}: {
  profile: Profile;
  presence?: Presence;
  mutualCodes: string[];
  selected?: boolean;
  actions: React.ReactNode;
}) {
  const tones = useTones();
  const state = presenceState(presence);
  return (
    <Card className={`gap-4 p-4 sm:p-5 ${selected ? 'border-pine' : ''}`}>
      <View className="flex-row items-start gap-3">
        <Avatar
          name={profile.displayName}
          color={profile.avatarPreset || profile.color || tones.accent}
          avatarUrl={profile.avatarUrl}
          statusColor={state.color}
        />
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-semibold text-ink" numberOfLines={1}>{profile.displayName}</Text>
          <Text className="text-xs text-muted" numberOfLines={1}>@{profile.username || 'student'}</Text>
          <View className="mt-1 flex-row flex-wrap gap-1.5">
            {profile.university ? (
              <View className="rounded-full bg-sand px-2.5 py-1">
                <Text className="text-[11px] font-semibold text-muted" numberOfLines={1}>
                  {universityLabel(profile)}
                </Text>
              </View>
            ) : null}
            {mutualCodes.length ? (
              <View className="rounded-full bg-accent-soft px-2.5 py-1">
                <Text className="text-[11px] font-semibold text-accent">
                  {mutualCodes.length} {mutualCodes.length === 1 ? 'class' : 'classes'} together
                </Text>
              </View>
            ) : null}
          </View>
          <Text className="mt-1 text-xs font-medium" style={{ color: state.color }}>{state.label}</Text>
        </View>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">{actions}</View>
    </Card>
  );
}

function Avatar({
  name,
  color,
  avatarUrl,
  statusColor,
}: {
  name: string;
  color: string;
  avatarUrl?: string | null;
  statusColor?: string;
}) {
  return (
    <View>
      {avatarUrl ? (
        <Image source={{ uri: avatarUrl }} className="h-12 w-12 rounded-full" />
      ) : (
        <View className="h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: `${color}24` }}>
          <Text className="text-base font-bold" style={{ color }}>{name.charAt(0).toUpperCase()}</Text>
        </View>
      )}
      {statusColor ? (
        <View
          className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface"
          style={{ backgroundColor: statusColor }}
        />
      ) : null}
    </View>
  );
}

function FilterPill({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  icon: 'users' | 'graduation-cap' | 'book-open';
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`flex-row items-center gap-2 rounded-full px-3 py-2 ${active ? 'bg-ink' : 'bg-sand'}`}
    >
      <Icon name={icon} size={14} tone={active ? 'inverse' : 'muted'} />
      <Text className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}>{label}</Text>
    </Pressable>
  );
}

function SectionTitle({ icon, label }: { icon: 'search' | 'users' | 'user-plus'; label: string }) {
  return (
    <View className="flex-row items-center gap-2">
      <Icon name={icon} size={15} tone="muted" />
      <Text className="text-xs font-bold uppercase tracking-wider text-muted">{label}</Text>
    </View>
  );
}

function friendAsProfile(friend: Friend): Profile {
  return {
    id: friend.id,
    username: usernameOf(friend),
    displayName: friend.displayName,
    color: friend.color,
    avatarUrl: null,
    avatarPreset: friend.color,
    university: '',
    major: '',
    bio: '',
    updatedAt: null,
  };
}

function mutualCourseCodes(ownCodes: Set<string | undefined>, otherCodes: string[] | undefined): string[] {
  return (otherCodes ?? []).filter((code) => ownCodes.has(code.toUpperCase())).slice(0, 4);
}

function matchesDirectoryFilter(
  filter: DirectoryFilter,
  me: Profile | null,
  them: Profile | undefined,
  ownCodes: Set<string | undefined>
): boolean {
  if (filter === 'all') return true;
  if (!them) return false;
  if (filter === 'university') {
    if (me?.universityId && them.universityId) return me.universityId === them.universityId;
    return Boolean(me?.university && universitySearchKey(me.university) === universitySearchKey(them.university));
  }
  return mutualCourseCodes(ownCodes, them.courseCodes).length > 0;
}

function presenceState(presence: Presence | undefined): { label: string; color: string } {
  const until = presence?.until?.toDate?.().getTime() ?? 0;
  if (!presence || (until && until <= Date.now())) return { label: 'Free', color: '#2E8B57' };
  if (presence.status === 'focus') {
    return { label: presence.subjectName ? `Deep Focus · ${presence.subjectName}` : 'Deep Focus', color: '#7C3AED' };
  }
  if (presence.status === 'class') {
    return { label: presence.subjectName ? `In Class · ${presence.subjectName}` : 'In Class', color: '#B0443E' };
  }
  if (presence.status === 'reel') return { label: 'Learning on Notomi Reel', color: '#2E8B57' };
  return { label: 'Free', color: '#2E8B57' };
}

function todayIndex(): number {
  return (new Date().getDay() + 6) % 7;
}

function orderFromToday(gaps: Gap[]): Gap[] {
  const today = todayIndex();
  return [...gaps].sort(
    (left, right) => ((left.day - today + 7) % 7) - ((right.day - today + 7) % 7) || left.start - right.start
  );
}

function relativeDay(day: number): string {
  const offset = (day - todayIndex() + 7) % 7;
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  return DAY_FULL[day];
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder} min`;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}
