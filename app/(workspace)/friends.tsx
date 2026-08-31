import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { Icon, type IconName } from '@/components/Icon';
import { Avatar } from '@/components/Avatar';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import { ShareMaterial } from '@/components/social/ShareMaterial';
import { Button, Card, EmptyState, Field, Loading, Notice, PageHeader, Touchable } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection, useDocument, useQueryOnce } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import { DAY_FULL, minutesToLabel, type ClassBlock, type RoutineBlock, type Semester, type Subject } from '@/lib/schema';
import { feedback, play } from '@/lib/sound';
import { getDb } from '@/services/firebase';
import {
  acceptFriend,
  blockUser,
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
  suggestClassmates,
  stopSharing,
  syncPublicCourses,
  toBusyIntervals,
  usernameOf,
  type BusyInterval,
  type Friend,
  type Gap,
  type Presence,
  type Profile,
} from '@/services/social';
import { universityLabel, universitySearchKey } from '@/services/universities';
import { subjectInk } from '@/lib/color';

/**
 * The social home.
 *
 * Two jobs used to share one screen and neither won. Finding a stranger is a
 * thing a student does a handful of times a term; seeing the people they
 * already know is why they open the page at all — and the search box, the four
 * filter pills and the results list sat above that list every single time.
 *
 * So finding people is a button that opens its own surface, and this screen is
 * the friends. Each friend is one row with one status line and one overflow
 * menu, because six buttons per person is not a list, it is a control panel
 * that happens to have names on it.
 */

type DirectoryFilter = 'all' | 'university' | 'classmates';

const FILTERS: { id: DirectoryFilter; label: string; icon: IconName }[] = [
  { id: 'all', label: 'Everyone', icon: 'users' },
  { id: 'university', label: 'Same university', icon: 'graduation-cap' },
  { id: 'classmates', label: 'Classmates', icon: 'book-open' },
];

/** The windows a study block realistically falls into. */
const RANGES: { id: string; label: string; from: number; to: number }[] = [
  { id: 'any', label: 'Any time', from: 8 * 60, to: 20 * 60 },
  { id: 'morning', label: 'Morning', from: 8 * 60, to: 12 * 60 },
  { id: 'afternoon', label: 'Afternoon', from: 12 * 60, to: 17 * 60 },
  { id: 'evening', label: 'Evening', from: 17 * 60, to: 21 * 60 },
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
  const semesters = useQueryOnce<Semester>(paths.semesters(db, uid), [uid]);
  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);
  const profile = useDocument<Profile>(profilePath(db, uid), [uid]);
  const currentSemesterId = useMemo(
    () => semesters.data.find((semester) => semester.isCurrent)?.id ?? semesters.data[0]?.id ?? null,
    [semesters.data]
  );
  const currentClasses = useMemo(
    () => classes.data.filter((block) => !currentSemesterId || !block.semesterId || block.semesterId === currentSemesterId),
    [classes.data, currentSemesterId]
  );

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
  const [suggested, setSuggested] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busyWeeks, setBusyWeeks] = useState<Record<string, BusyInterval[]>>({});
  const [loadingGaps, setLoadingGaps] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Surfaces. Only one of these is ever open, but each owns its own state. */
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [sharedTimeOpen, setSharedTimeOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<Friend | null>(null);
  const [sharingWith, setSharingWith] = useState<Friend | null>(null);
  const [blocking, setBlocking] = useState<Friend | null>(null);
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
    if (classes.loading || routines.loading || semesters.loading || friends.loading || profile.loading) return;
    if (accepted.length === 0 || profile.data?.shareSchedule !== true) {
      void stopSharing(uid);
      return;
    }
    void publishBusy(
      uid,
      toBusyIntervals(currentClasses, routines.data)
    );
  }, [
    uid,
    accepted.length,
    currentClasses,
    classes.loading,
    routines.data,
    routines.loading,
    semesters.loading,
    friends.loading,
    profile.loading,
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

  const ownCodes = useMemo(
    () => new Set(subjects.data.map((subject) => subject.moduleCode?.toUpperCase()).filter(Boolean)),
    [subjects.data]
  );
  const codeList = useMemo(() => [...ownCodes].filter(Boolean) as string[], [ownCodes]);
  const codeKey = codeList.join(',');

  // One capped query, cached for the session inside the service. Classmates
  // change when somebody enrols, not while the screen is open.
  useEffect(() => {
    if (subjects.loading || !codeList.length) return;
    let active = true;
    void suggestClassmates(uid, codeList)
      .then((found) => active && setSuggested(found))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [uid, codeKey, subjects.loading]);

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

  const addFriend = useCallback(
    async (them: Profile) => {
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
    },
    [profile.data, uid, router]
  );

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

  const online = accepted.filter((friend) => presenceState(presenceMap[friend.id]).active);
  const newFaces = suggested.filter((entry) => !acceptedIds.includes(entry.id)).slice(0, 3);

  return (
    <ScreenScroll maxWidth={1100}>
      <PageHeader
        title="Friends"
        subtitle={
          friends.loading
            ? undefined
            : accepted.length
              ? `${accepted.length} ${accepted.length === 1 ? 'friend' : 'friends'}`
              : 'Study alongside people on your course.'
        }
      />

      {/*
        Finding people is a thing you go and do, not a field you scroll past.
        One button, the count of anyone waiting, and the way back to the
        switches that decide what any of this shows.
      */}
      <View className="mb-6 flex-row flex-wrap items-center gap-2">
        <Button label="Find people" icon="search" size="sm" onPress={() => setDiscoverOpen(true)} />
        {incoming.length > 0 ? (
          <View className="flex-row items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5">
            <Icon name="user-plus" size={13} tone="accent" />
            <Text className="text-xs font-semibold text-accent">{incoming.length} waiting</Text>
          </View>
        ) : null}
        <View className="flex-1" />
        <Link href="/settings" asChild>
          <Touchable
            accessibilityRole="link"
            accessibilityLabel="Privacy and social settings"
            className="h-9 flex-row items-center gap-1.5 rounded-lg border border-line px-3"
          >
            <Icon name="eye" size={14} tone="muted" />
            <Text className="text-xs font-semibold text-muted">Privacy</Text>
          </Touchable>
        </Link>
      </View>

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

      {incoming.length > 0 ? (
        <View className="mb-7 gap-2">
          <SectionTitle icon="user-plus" label={`REQUESTS (${incoming.length})`} />
          {incoming.map((friend) => (
            <Card key={friend.id} className="flex-row items-center gap-3 p-3">
              <Avatar name={friend.displayName} color={friend.color} size={40} />
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-semibold text-ink" numberOfLines={1}>{friend.displayName}</Text>
                <Text className="text-xs text-muted" numberOfLines={1}>@{usernameOf(friend)}</Text>
              </View>
              <Button
                label="Accept"
                icon="check"
                size="sm"
                onPress={() => void acceptFriend(uid, friend.id).catch((caught) => setError(String(caught)))}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Ignore the request from ${friend.displayName}`}
                onPress={() => void removeFriend(uid, friend.id).catch(() => undefined)}
                className="h-9 w-9 items-center justify-center rounded-lg"
              >
                <Icon name="x" size={15} tone="subtle" />
              </Pressable>
            </Card>
          ))}
        </View>
      ) : null}

      {online.length > 0 ? (
        <View className="mb-7 gap-2">
          <SectionTitle icon="zap" label={`ACTIVE NOW (${online.length})`} />
          <View className="flex-row flex-wrap gap-2">
            {online.map((friend) => {
              const state = presenceState(presenceMap[friend.id]);
              return (
                <Touchable
                  key={friend.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${friend.displayName}. ${state.label}.`}
                  onPress={() => router.push(`/profile/${friend.id}` as never)}
                  className="flex-row items-center gap-2 rounded-full border border-line bg-surface py-1.5 pl-1.5 pr-3"
                >
                  <Avatar
                    name={friend.displayName}
                    color={profiles[friend.id]?.avatarPreset || friend.color}
                    avatarUrl={profiles[friend.id]?.avatarUrl}
                    icon={profiles[friend.id]?.avatarIcon}
                    statusColor={state.color}
                    size={26}
                  />
                  <Text className="text-xs font-semibold text-ink" numberOfLines={1}>
                    {friend.displayName.split(' ')[0]}
                  </Text>
                  <Text className="text-[11px] text-muted" numberOfLines={1}>{state.short}</Text>
                </Touchable>
              );
            })}
          </View>
        </View>
      ) : null}

      <View className={desktop ? 'flex-row items-start gap-6' : 'gap-7'}>
        <View className="min-w-0 gap-2" style={desktop ? { flex: 2 } : undefined}>
          <SectionTitle icon="users" label={`FRIENDS (${accepted.length})`} />
          {friends.loading || profile.loading ? (
            <Loading label="Loading friends..." />
          ) : accepted.length === 0 ? (
            <EmptyState
              icon="users"
              title="No friends yet"
              body="Search by name, username or university and send your first friend request."
              action={<Button label="Find people" icon="search" size="sm" onPress={() => setDiscoverOpen(true)} />}
            />
          ) : (
            accepted.map((friend) => (
              <FriendRow
                key={friend.id}
                friend={friend}
                profile={profiles[friend.id] ?? friendAsProfile(friend)}
                state={presenceState(presenceMap[friend.id])}
                mutual={mutualCourseCodes(ownCodes, profiles[friend.id]?.courseCodes).length}
                onOpen={() => router.push(`/profile/${friend.id}` as never)}
                onMenu={() => setMenuFor(friend)}
              />
            ))
          )}

          {newFaces.length > 0 ? (
            <View className="mt-5 gap-2">
              <SectionTitle icon="sparkles" label="SUGGESTED CLASSMATES" />
              {newFaces.map((entry) => (
                <Card key={entry.id} className="flex-row items-center gap-3 p-3">
                  <Avatar
                    name={entry.displayName}
                    color={entry.avatarPreset || entry.color}
                    avatarUrl={entry.avatarUrl}
                    icon={entry.avatarIcon}
                    size={40}
                  />
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-semibold text-ink" numberOfLines={1}>{entry.displayName}</Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {sharedClassLine(mutualCourseCodes(ownCodes, entry.courseCodes)) ?? `@${entry.username || 'student'}`}
                    </Text>
                  </View>
                  <Button
                    label="Add"
                    icon="user-plus"
                    variant="secondary"
                    size="sm"
                    loading={actionBusy === entry.id}
                    disabled={actionBusy === entry.id}
                    onPress={() => void addFriend(entry)}
                  />
                </Card>
              ))}
            </View>
          ) : null}
        </View>

        {/*
          The matcher is a flow, not a panel. It used to sit open in a column
          with every friend listed a second time as a chip; now it is one card
          that says what it does and a sheet that walks through it.
        */}
        <View className="min-w-0" style={desktop ? { flex: 1 } : undefined}>
          <Card className="gap-3 p-5">
            <View className="flex-row items-start gap-3">
              <View className="h-10 w-10 items-center justify-center rounded-xl bg-pine-soft">
                <Icon name="clock" size={18} tone="pine" />
              </View>
              <View className="min-w-0 flex-1 gap-1">
                <Text className="font-heading text-lg font-semibold text-ink">Find Shared Time</Text>
                <Text className="text-xs leading-5 text-muted">
                  Pick up to three friends and see the hours you are all free.
                </Text>
              </View>
            </View>
            <Button
              label={selected.length ? `Continue with ${selected.length}` : 'Start'}
              icon="calendar"
              size="sm"
              disabled={accepted.length === 0}
              onPress={() => setSharedTimeOpen(true)}
            />
            <Text className="text-[11px] leading-4 text-subtle">
              Matching happens on this device using anonymous busy intervals. Course names, rooms and marks are never shared.
            </Text>
          </Card>
        </View>
      </View>

      <DiscoverSheet
        visible={discoverOpen}
        onClose={() => setDiscoverOpen(false)}
        uid={uid}
        me={profile.data}
        ownCodes={ownCodes}
        acceptedIds={acceptedIds}
        suggested={suggested}
        busyId={actionBusy}
        onAddFriend={addFriend}
        onError={setError}
      />

      <SharedTimeSheet
        visible={sharedTimeOpen}
        onClose={() => setSharedTimeOpen(false)}
        friends={accepted}
        selected={selected}
        busyWeeks={busyWeeks}
        mine={toBusyIntervals(classes.data, routines.data)}
        loading={loadingGaps}
        onToggle={chooseForMatch}
        onSprint={() => {
          setSharedTimeOpen(false);
          router.push('/tasks?tab=focus');
        }}
      />

      <FriendMenu
        friend={menuFor}
        onClose={() => setMenuFor(null)}
        onMatch={(friend) => {
          if (!selected.includes(friend.id)) chooseForMatch(friend.id);
          setSharedTimeOpen(true);
        }}
        onWeek={setViewingWeek}
        onShare={setSharingWith}
        onChallenge={(friend) => router.push(`/social?tab=arena&opponent=${friend.id}` as never)}
        onRemove={(friend) => {
          void removeFriend(uid, friend.id).catch((caught) => setError(String(caught)));
          setNotice(`${friend.displayName} is no longer a friend.`);
        }}
        onBlock={setBlocking}
      />

      <BlockSheet
        friend={blocking}
        onClose={() => setBlocking(null)}
        onConfirm={async (friend, reason) => {
          try {
            await blockUser(uid, { id: friend.id, displayName: friend.displayName, username: usernameOf(friend) }, reason);
            setNotice(`${friend.displayName} is blocked. You can undo this in Settings.`);
            play('success');
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
          }
        }}
      />

      {/*
        Mounted only while it is open. It loads a term of subjects, documents
        and flashcards to fill its pickers, and a friends list of twenty would
        otherwise start twenty copies of that on render.
      */}
      {sharingWith ? (
        <ShareMaterial friend={sharingWith} open onClose={() => setSharingWith(null)} />
      ) : null}

      <FriendWeek friend={viewingWeek} onClose={() => setViewingWeek(null)} />
    </ScreenScroll>
  );
}

/* --------------------------- Friends list --------------------------- */

/**
 * One friend, one line.
 *
 * The row itself opens their profile, which is what a tap on a person means
 * everywhere else on a phone. Everything you can do *to* a friend — match a
 * schedule, share a file, challenge, remove, block — is behind the one menu,
 * because those are decisions, and decisions do not belong on a list you
 * scroll past to find someone's name.
 */
function FriendRow({
  friend,
  profile,
  state,
  mutual,
  onOpen,
  onMenu,
}: {
  friend: Friend;
  profile: Profile;
  state: PresenceState;
  mutual: number;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const detail = state.active
    ? state.label
    : mutual > 0
      ? `${mutual} ${mutual === 1 ? 'class' : 'classes'} together`
      : profile.university
        ? universityLabel(profile)
        : `@${profile.username || 'student'}`;

  return (
    <View className="flex-row items-center gap-1 rounded-2xl border border-line bg-surface pr-1">
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${friend.displayName}. ${detail}. Opens their profile.`}
        onPress={onOpen}
        className="min-w-0 flex-1 flex-row items-center gap-3 p-3"
      >
        <Avatar
          name={friend.displayName}
          color={profile.avatarPreset || profile.color || friend.color}
          avatarUrl={profile.avatarUrl}
          icon={profile.avatarIcon}
          statusColor={state.color}
          size={42}
        />
        <View className="min-w-0 flex-1">
          <Text className="text-[15px] font-semibold text-ink" numberOfLines={1}>{friend.displayName}</Text>
          <Text
            className="text-xs"
            numberOfLines={1}
            style={state.active ? { color: subjectInk(state.color) } : undefined}
          >
            <Text className={state.active ? '' : 'text-muted'}>{detail}</Text>
          </Text>
        </View>
      </Touchable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`More actions for ${friend.displayName}`}
        onPress={onMenu}
        className="h-10 w-10 items-center justify-center rounded-xl"
      >
        <Icon name="more-horizontal" size={18} tone="subtle" />
      </Pressable>
    </View>
  );
}

/** Everything you can do to one friend, in the order you are likely to want it. */
function FriendMenu({
  friend,
  onClose,
  onMatch,
  onWeek,
  onShare,
  onChallenge,
  onRemove,
  onBlock,
}: {
  friend: Friend | null;
  onClose: () => void;
  onMatch: (friend: Friend) => void;
  onWeek: (friend: Friend) => void;
  onShare: (friend: Friend) => void;
  onChallenge: (friend: Friend) => void;
  onRemove: (friend: Friend) => void;
  onBlock: (friend: Friend) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!friend) setConfirmRemove(false);
  }, [friend]);

  function run(action: (friend: Friend) => void) {
    if (!friend) return;
    const target = friend;
    onClose();
    action(target);
  }

  return (
    <Sheet
      visible={friend !== null}
      onClose={onClose}
      title={friend?.displayName ?? 'Friend'}
      icon="user"
      variant="compact"
    >
      <View className="gap-1">
        <MenuRow icon="clock" label="Find shared time" onPress={() => run(onMatch)} />
        <MenuRow icon="calendar" label="See their week" onPress={() => run(onWeek)} />
        <MenuRow icon="share-2" label="Share material" onPress={() => run(onShare)} />
        <MenuRow icon="swords" label="Challenge to a quiz" onPress={() => run(onChallenge)} />

        <View className="my-2 h-px bg-line" />

        {confirmRemove ? (
          <MenuRow
            icon="user-minus"
            label="Tap again to remove"
            tone="rose"
            onPress={() => run(onRemove)}
          />
        ) : (
          <MenuRow icon="user-minus" label="Remove friend" tone="rose" onPress={() => setConfirmRemove(true)} />
        )}
        <MenuRow icon="shield" label="Block or report" tone="rose" onPress={() => run(onBlock)} />
      </View>
    </Sheet>
  );
}

function MenuRow({
  icon,
  label,
  tone = 'ink',
  onPress,
}: {
  icon: IconName;
  label: string;
  tone?: 'ink' | 'rose';
  onPress: () => void;
}) {
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-xl px-2 py-3"
    >
      <Icon name={icon} size={17} tone={tone === 'rose' ? 'rose' : 'muted'} />
      <Text className={`flex-1 text-[15px] font-medium ${tone === 'rose' ? 'text-rose' : 'text-ink'}`}>
        {label}
      </Text>
    </Touchable>
  );
}

/**
 * Blocking, and saying why if you want to.
 *
 * The reason is kept for the student's own record — there is no moderation
 * queue behind it, and a screen implying one would be a lie told at the worst
 * possible moment. It says so, in the sheet, above the box.
 */
function BlockSheet({
  friend,
  onClose,
  onConfirm,
}: {
  friend: Friend | null;
  onClose: () => void;
  onConfirm: (friend: Friend, reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (friend) setReason('');
  }, [friend?.id]);

  async function confirm() {
    if (!friend) return;
    setBusy(true);
    await onConfirm(friend, reason);
    setBusy(false);
    onClose();
  }

  return (
    <Sheet
      visible={friend !== null}
      onClose={onClose}
      title={friend ? `Block ${friend.displayName}` : 'Block'}
      icon="shield"
      variant="form"
      dismissOnScrim={false}
      primaryAction={{ label: 'Block', onPress: () => void confirm(), loading: busy }}
    >
      <View className="gap-4">
        <Text className="text-sm leading-6 text-muted">
          They stop appearing in your search results, your friendship ends, and they cannot send
          you a new request. They are not told.
        </Text>
        <Field
          label="Reason (optional)"
          value={reason}
          onChangeText={setReason}
          multiline
          numberOfLines={3}
          placeholder="What happened?"
          maxLength={500}
          className="min-h-[88px]"
          hint="Kept in your account so you have a record. Nobody else reads it."
        />
        <Text className="text-[11px] leading-4 text-subtle">
          You can undo this any time in Settings → Privacy &amp; social.
        </Text>
      </View>
    </Sheet>
  );
}

/* ---------------------------- Discovery ---------------------------- */

/**
 * Finding somebody.
 *
 * Its own surface, and its own state: the query lives in here, so typing a
 * name does not re-render a list of friends that has nothing to do with it.
 * Full-screen on a phone because it is a search box, three filters and a list
 * of results, which is a screen's worth of screen.
 */
function DiscoverSheet({
  visible,
  onClose,
  uid,
  me,
  ownCodes,
  acceptedIds,
  suggested,
  busyId,
  onAddFriend,
  onError,
}: {
  visible: boolean;
  onClose: () => void;
  uid: string;
  me: Profile | null;
  ownCodes: Set<string | undefined>;
  acceptedIds: string[];
  suggested: Profile[];
  busyId: string | null;
  onAddFriend: (them: Profile) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [lookup, setLookup] = useState('');
  const [results, setResults] = useState<Profile[]>([]);
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState<DirectoryFilter>('all');
  /** Results are capped at twelve by the rules; this pages through them. */
  const [shown, setShown] = useState(6);

  useEffect(() => {
    if (!visible) return;
    const query = lookup.trim();
    if (query.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void searchProfiles(query, uid)
        .then((found) => {
          if (!active) return;
          setResults(found.filter((entry) => entry.id !== uid));
          setShown(6);
          setSearching(false);
        })
        .catch((caught) => {
          if (!active) return;
          onError(caught instanceof Error ? caught.message : String(caught));
          setSearching(false);
        });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [lookup, uid, visible]);

  const searching_ = lookup.trim().length >= 2;
  const pool = searching_ ? results : suggested;
  const visibleResults = useMemo(
    () => pool.filter((entry) => matchesDirectoryFilter(filter, me, entry, ownCodes)),
    [pool, filter, me, ownCodes]
  );

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Find people"
      icon="search"
      variant="fullscreen-mobile"
      maxHeight={620}
    >
      <View className="gap-4">
        <Field
          value={lookup}
          onChangeText={setLookup}
          placeholder="Name, @username or university"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search students"
        />

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

        {!searching_ && suggested.length > 0 ? (
          <SectionTitle icon="sparkles" label="PEOPLE ON YOUR COURSES" />
        ) : null}

        {searching ? (
          <Loading label="Searching students..." />
        ) : !searching_ && suggested.length === 0 ? (
          <EmptyState
            icon="search"
            title="Search for a classmate"
            body="Two letters is enough. You can look someone up by their name, their username or their university."
          />
        ) : visibleResults.length === 0 ? (
          <Card>
            <Text className="text-sm text-muted">
              {searching_
                ? 'No students match this search and filter.'
                : 'Nobody on your courses matches this filter yet.'}
            </Text>
          </Card>
        ) : (
          <View className="gap-2">
            {visibleResults.slice(0, shown).map((entry) => (
              <PersonCard
                key={entry.id}
                profile={entry}
                mutual={mutualCourseCodes(ownCodes, entry.courseCodes)}
                connected={acceptedIds.includes(entry.id)}
                busy={busyId === entry.id}
                onAdd={() => void onAddFriend(entry)}
              />
            ))}
            {visibleResults.length > shown ? (
              <Button
                label={`Show ${visibleResults.length - shown} more`}
                icon="chevron-down"
                variant="secondary"
                size="sm"
                onPress={() => setShown((current) => current + 6)}
              />
            ) : null}
          </View>
        )}
      </View>
    </Sheet>
  );
}

/** A stranger, compactly: who they are, what you have in common, one action. */
function PersonCard({
  profile,
  mutual,
  connected,
  busy,
  onAdd,
}: {
  profile: Profile;
  mutual: string[];
  connected: boolean;
  busy: boolean;
  onAdd: () => void;
}) {
  const detail = sharedClassLine(mutual) ?? (profile.university ? universityLabel(profile) : `@${profile.username || 'student'}`);
  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-line bg-surface p-3">
      <Avatar
        name={profile.displayName}
        color={profile.avatarPreset || profile.color}
        avatarUrl={profile.avatarUrl}
        icon={profile.avatarIcon}
        size={42}
      />
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] font-semibold text-ink" numberOfLines={1}>{profile.displayName}</Text>
        <Text className="text-xs text-muted" numberOfLines={1}>{detail}</Text>
      </View>
      <Button
        label={connected ? 'Friends' : 'Add Friend'}
        icon={connected ? 'check' : 'user-plus'}
        variant={connected ? 'secondary' : 'primary'}
        size="sm"
        disabled={connected || busy}
        loading={busy}
        onPress={onAdd}
      />
    </View>
  );
}

/* -------------------------- Shared free time ------------------------ */

/**
 * The matcher, as a flow: who, when, then the answer.
 *
 * It used to be a permanently open panel listing every friend a second time.
 * Nothing about it is expensive except the busy weeks it loads, and those are
 * loaded by the parent only for the friends actually selected — which is why
 * choosing somebody is the first step rather than a side effect of scrolling.
 */
function SharedTimeSheet({
  visible,
  onClose,
  friends,
  selected,
  busyWeeks,
  mine,
  loading,
  onToggle,
  onSprint,
}: {
  visible: boolean;
  onClose: () => void;
  friends: Friend[];
  selected: string[];
  busyWeeks: Record<string, BusyInterval[]>;
  mine: BusyInterval[];
  loading: boolean;
  onToggle: (id: string) => void;
  onSprint: () => void;
}) {
  const [range, setRange] = useState('any');
  /** -1 is every day; anything else is a weekday index. */
  const [day, setDay] = useState(-1);

  const window = RANGES.find((entry) => entry.id === range) ?? RANGES[0];
  const complete = selected.every((id) => busyWeeks[id] !== undefined);
  const gaps = useMemo(
    () =>
      selected.length && complete
        ? commonGaps([mine, ...selected.map((id) => busyWeeks[id])], { from: window.from, to: window.to })
        : [],
    [selected, complete, busyWeeks, mine, window.from, window.to]
  );
  const ordered = useMemo(
    () => orderFromToday(gaps).filter((gap) => day < 0 || gap.day === day),
    [gaps, day]
  );

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Find shared time"
      icon="clock"
      variant="fullscreen-mobile"
      maxHeight={620}
      primaryAction={
        ordered.length ? { label: 'Study sprint', onPress: onSprint } : undefined
      }
    >
      <View className="gap-5">
        <View className="gap-2">
          <StepLabel step={1} label="Who" hint="Up to three" />
          <View className="flex-row flex-wrap gap-2">
            {friends.map((friend) => (
              <Pressable
                key={friend.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected.includes(friend.id) }}
                accessibilityLabel={friend.displayName}
                onPress={() => onToggle(friend.id)}
                className={`flex-row items-center gap-1.5 rounded-full border px-3 py-2 ${
                  selected.includes(friend.id) ? 'border-ink bg-ink' : 'border-line bg-paper'
                }`}
              >
                {selected.includes(friend.id) ? <Icon name="check" size={13} tone="inverse" /> : null}
                <Text
                  className={`text-xs font-semibold ${selected.includes(friend.id) ? 'text-paper' : 'text-muted'}`}
                >
                  {friend.displayName.split(' ')[0]}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View className="gap-2">
          <StepLabel step={2} label="When" />
          <View className="flex-row flex-wrap gap-2">
            {RANGES.map((entry) => (
              <FilterPill
                key={entry.id}
                active={range === entry.id}
                label={entry.label}
                onPress={() => setRange(entry.id)}
              />
            ))}
          </View>
          <View className="flex-row flex-wrap gap-2">
            <FilterPill active={day < 0} label="Any day" onPress={() => setDay(-1)} />
            {DAY_FULL.map((name, index) => (
              <FilterPill
                key={name}
                active={day === index}
                label={name.slice(0, 3)}
                onPress={() => setDay(index)}
              />
            ))}
          </View>
        </View>

        <View className="gap-2">
          <StepLabel step={3} label="Free together" />
          {!selected.length ? (
            <View className="rounded-xl border border-dashed border-line bg-paper px-4 py-6">
              <Text className="text-center text-sm text-muted">Choose a friend to calculate shared gaps.</Text>
            </View>
          ) : loading ? (
            <Loading label="Matching schedules..." />
          ) : !complete ? (
            <Notice tone="amber" title="A selected friend has not shared their busy hours yet" />
          ) : ordered.length === 0 ? (
            <Notice tone="amber" title="No shared hour in that window" body="Try another day, or a wider time of day." />
          ) : (
            <View className="gap-2">
              {ordered.slice(0, 6).map((gap) => (
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
        </View>

        <Text className="text-[11px] leading-4 text-subtle">
          Matching happens on this device using anonymous busy intervals. Course names, rooms and marks are never shared.
        </Text>
      </View>
    </Sheet>
  );
}

function StepLabel({ step, label, hint }: { step: number; label: string; hint?: string }) {
  return (
    <View className="flex-row items-center gap-2">
      <View className="h-5 w-5 items-center justify-center rounded-full bg-ink">
        <Text className="text-[10px] font-bold text-paper">{step}</Text>
      </View>
      <Text className="text-xs font-bold uppercase tracking-wider text-muted">{label}</Text>
      {hint ? <Text className="text-[11px] text-subtle">{hint}</Text> : null}
    </View>
  );
}

/** A friend's busy intervals, loaded only when requested. */
function FriendWeek({ friend, onClose }: { friend: Friend | null; onClose: () => void }) {
  const [blocks, setBlocks] = useState<BusyInterval[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!friend) return;
    let live = true;
    setBlocks(null);
    setFailed(false);
    void loadBusyWeeks([friend.id])
      .then((found) => live && setBlocks(found[friend.id] ?? []))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [friend?.id]);

  const byDay = useMemo(() => {
    const days: BusyInterval[][] = Array.from({ length: 7 }, () => []);
    for (const block of blocks ?? []) days[block.day]?.push(block);
    return days;
  }, [blocks]);

  return (
    <Sheet
      visible={friend !== null}
      onClose={onClose}
      title={friend ? `${friend.displayName}’s busy week` : 'Their busy week'}
      icon="calendar"
    >
      {failed ? (
        <Notice title="Could not open their week" body="Try again in a moment." />
      ) : blocks === null ? (
        <Loading label="Opening their week…" />
      ) : blocks.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="Free-time matching is off"
          body={`${friend?.displayName ?? 'They'} has not shared their busy hours.`}
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
                    <Text className="flex-1 text-sm font-semibold text-ink">Busy</Text>
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

/* ------------------------------ Pieces ----------------------------- */

function FilterPill({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  icon?: IconName;
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
      {icon ? <Icon name={icon} size={14} tone={active ? 'inverse' : 'muted'} /> : null}
      <Text className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}>{label}</Text>
    </Pressable>
  );
}

function SectionTitle({ icon, label }: { icon: IconName; label: string }) {
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

function sharedClassLine(mutual: string[]): string | null {
  if (!mutual.length) return null;
  if (mutual.length === 1) return `Also takes ${mutual[0]}`;
  return `${mutual.length} classes together · ${mutual.slice(0, 2).join(', ')}`;
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

type PresenceState = { label: string; short: string; color: string; active: boolean };

function presenceState(presence: Presence | undefined): PresenceState {
  const free: PresenceState = { label: 'Free', short: 'Free', color: '#2E8B57', active: false };
  const until = presence?.until?.toDate?.().getTime() ?? 0;
  if (!presence || (until && until <= Date.now())) return free;
  if (presence.status === 'focus') {
    return {
      label: presence.subjectName ? `Deep Focus · ${presence.subjectName}` : 'Deep Focus',
      short: 'Focusing',
      color: '#7C3AED',
      active: true,
    };
  }
  if (presence.status === 'class') {
    return {
      label: presence.subjectName ? `In Class · ${presence.subjectName}` : 'In Class',
      short: 'In class',
      color: '#B0443E',
      active: true,
    };
  }
  // Nothing writes 'reel' any more; a presence doc from before the feed was
  // removed can still be read for a few minutes, so it keeps a sensible label.
  if (presence.status === 'reel') return { label: 'Studying', short: 'Studying', color: '#2E8B57', active: true };
  return free;
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
