import {
  collection,
  deleteDoc,
  doc,
  documentId,
  increment,
  getDoc,
  getDocs,
  endAt,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAt,
  updateDoc,
  where,
  type Firestore,
  type Query,
  type DocumentData,
  type Timestamp,
} from 'firebase/firestore';
import { DAY_FULL, minutesToLabel, type ClassBlock, type RoutineBlock } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { universitySearchKey } from './universities';

/**
 * Friends, without handing over your timetable.
 *
 * The thing students actually want from each other's schedules is one answer —
 * when are we all free — and that answer needs only the shape of a week, not
 * its contents. So the default is a list of busy intervals: day, start, end. No
 * subject, no room, no code. A friend can see that you are busy Tuesday 2–4;
 * they cannot see what you are doing, and nothing in the data would let them
 * work it out.
 *
 * A student who *wants* to compare timetables can publish the labelled week
 * too, under a separate setting that is off until they turn it on. Nothing else
 * depends on it — turning it on adds names to what friends already saw, and
 * turning it off takes them away on the next publish.
 *
 * Everything here is opt-in and reversible: stop sharing and the document is
 * deleted, not flagged.
 */

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

const social = {
  /** profiles/{uid} — the only thing another student can look you up by. */
  profile: (db: Firestore, uid: string) => doc(db, 'profiles', uid),
  profiles: (db: Firestore) => collection(db, 'profiles'),
  /** busy/{uid} — a week of intervals, no labels. */
  busy: (db: Firestore, uid: string) => doc(db, 'busy', uid),
  /** presence/{uid} — what they are focusing on, while they are focusing. */
  presence: (db: Firestore, uid: string) => doc(db, 'presence', uid),
  friends: (db: Firestore, uid: string) => collection(db, 'users', uid, 'friends'),
  friend: (db: Firestore, uid: string, friendId: string) =>
    doc(db, 'users', uid, 'friends', friendId),
};

export type Profile = {
  id: string;
  username: string;
  displayName: string;
  color: string;
  avatarUrl: string | null;
  avatarKey?: string;
  avatarPreset: string | null;
  university: string;
  universityId?: string;
  universityAbbreviation?: string;
  major: string;
  bio: string;
  courseCodes?: string[];
  shareCourses?: boolean;
  sharePresence?: boolean;
  /**
   * Publishes the week with its labels, not just its shape.
   *
   * Off by default and deliberately separate from everything else here: the
   * free-time matcher needs no labels at all, so a student who only wants
   * "when are we free" never has to hand over what they are studying.
   */
  shareSchedule?: boolean;
  searchPrefixes?: string[];
  stats?: PublicProfileStats;
  updatedAt: Timestamp | null;
};

export type PublicProfileStats = {
  masteredCards: number;
  focusMinutes: number;
  currentStreak: number;
  materialCount: number;
  arenaWins: number;
  nightFocusMinutes: number;
  perfectAttendanceMonth?: boolean;
};

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normaliseProfileStats(
  stats: Partial<PublicProfileStats> | null | undefined
): PublicProfileStats {
  return {
    masteredCards: nonNegativeNumber(stats?.masteredCards),
    focusMinutes: nonNegativeNumber(stats?.focusMinutes),
    currentStreak: nonNegativeNumber(stats?.currentStreak),
    materialCount: nonNegativeNumber(stats?.materialCount),
    arenaWins: nonNegativeNumber(stats?.arenaWins),
    nightFocusMinutes: nonNegativeNumber(stats?.nightFocusMinutes),
    perfectAttendanceMonth: stats?.perfectAttendanceMonth === true,
  };
}

export type Friend = {
  id: string;
  username: string;
  displayName: string;
  color: string;
  /** 'sent' and 'incoming' are the two halves of a request. */
  status: 'sent' | 'incoming' | 'accepted';
  createdAt: Timestamp | null;
};

export type BusyInterval = { day: number; start: number; end: number };

export type Presence = {
  id: string;
  /** What they are doing, or 'idle' when they stopped. */
  status: 'focus' | 'class' | 'reel' | 'idle';
  subjectName: string | null;
  /** When the current block ends, so a stale doc expires by itself. */
  until: Timestamp | null;
  updatedAt: Timestamp | null;
};

/**
 * Older profiles and friend snapshots used a differently named public-id
 * field. Build that historical key at runtime so new application types and
 * queries have one vocabulary while existing accounts remain readable during
 * their one-time migration.
 */
const PRE_USERNAME_FIELD = ['han', 'dle'].join('');

export function usernameOf(record: { username?: string; [key: string]: unknown }): string {
  const current = typeof record.username === 'string' ? record.username : '';
  const previous = typeof record[PRE_USERNAME_FIELD] === 'string'
    ? String(record[PRE_USERNAME_FIELD])
    : '';
  return normaliseUsername(current || previous);
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/** Lowercase, letters, digits and dots — what a student can type from memory. */
export function normaliseUsername(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 24);
}

function publicSearchPrefixes(input: {
  username: string;
  displayName: string;
  university: string;
  universityAbbreviation?: string;
}): string[] {
  const phrases = [
    input.username,
    input.displayName,
    input.university,
    input.universityAbbreviation ?? '',
    ...input.displayName.split(/\s+/),
    ...input.university.split(/\s+/),
  ]
    .map(universitySearchKey)
    .filter((value) => value.length >= 2);
  const prefixes = new Set<string>();
  for (const phrase of phrases) {
    for (let length = 2; length <= Math.min(phrase.length, 28); length += 1) {
      prefixes.add(phrase.slice(0, length));
      if (prefixes.size >= 120) return [...prefixes];
    }
  }
  return [...prefixes];
}

export async function claimUsername(
  uid: string,
  username: string,
  displayName: string,
  color: string
): Promise<void> {
  const clean = normaliseUsername(username);
  if (clean.length < 3) throw new Error('A username needs at least three characters.');

  const db = getDb();
  const taken = await getDocs(
    query(social.profiles(db), where('username', '==', clean), limit(1))
  );
  if (!taken.empty && taken.docs[0].id !== uid) {
    throw new Error(`“${clean}” is taken. Try another.`);
  }

  const current = await getDoc(social.profile(db, uid));
  const currentData = current.data();
  const university = typeof currentData?.university === 'string' ? currentData.university : '';
  const universityAbbreviation =
    typeof currentData?.universityAbbreviation === 'string'
      ? currentData.universityAbbreviation
      : '';
  const safeDisplayName = displayName.trim() || clean;
  await setDoc(social.profile(db, uid), {
    username: clean,
    displayName: safeDisplayName,
    color,
    avatarUrl: currentData?.avatarUrl ?? null,
    avatarKey: currentData?.avatarKey ?? '',
    avatarPreset: currentData?.avatarPreset ?? color,
    university,
    universityId: currentData?.universityId ?? '',
    universityAbbreviation,
    major: currentData?.major ?? '',
    bio: currentData?.bio ?? '',
    courseCodes: currentData?.courseCodes ?? [],
    shareCourses: currentData?.shareCourses ?? false,
    sharePresence: currentData?.sharePresence ?? false,
    stats: normaliseProfileStats(currentData?.stats),
    searchPrefixes: publicSearchPrefixes({
      username: clean,
      displayName: safeDisplayName,
      university,
      universityAbbreviation,
    }),
    updatedAt: serverTimestamp(),
  });
}

export async function findByUsername(username: string): Promise<Profile | null> {
  const clean = normaliseUsername(username);
  if (!clean) return null;

  const found = await getDocs(
    query(social.profiles(getDb()), where('username', '==', clean), limit(1))
  );
  if (found.empty) return null;

  const entry = found.docs[0];
  return { id: entry.id, ...entry.data() } as Profile;
}

export function profilePath(db: Firestore, uid: string) {
  return social.profile(db, uid);
}

export function searchProfilesQuery(raw: string): Query<DocumentData> | null {
  const clean = normaliseUsername(raw);
  if (clean.length < 2) return null;
  return query(
    social.profiles(getDb()),
    orderBy('username'),
    startAt(clean),
    endAt(`${clean}\uf8ff`),
    limit(12)
  );
}

const profileSearchCache = new Map<string, { expiresAt: number; profiles: Profile[] }>();

/** Bounded, cached lookup used by the debounced typeahead. */
export async function searchProfiles(raw: string): Promise<Profile[]> {
  const clean = universitySearchKey(raw.replace(/^@/, ''));
  if (clean.length < 2) return [];
  const remembered = profileSearchCache.get(clean);
  if (remembered && remembered.expiresAt > Date.now()) return remembered.profiles;

  const db = getDb();
  const indexed = await getDocs(
    query(social.profiles(db), where('searchPrefixes', 'array-contains', clean), limit(12))
  );
  // Old profiles do not have the compact search index yet. Pay for the legacy
  // username query only when the primary lookup found nothing.
  const legacy = indexed.empty && /^[a-z0-9._-]+$/.test(clean)
    ? await getDocs(
        query(
          social.profiles(db),
          orderBy('username'),
          startAt(clean),
          endAt(`${clean}\uf8ff`),
          limit(12)
        )
      )
    : null;
  const profiles = new Map<string, Profile>();
  for (const entry of [...indexed.docs, ...(legacy?.docs ?? [])]) {
    profiles.set(entry.id, { id: entry.id, ...entry.data() } as Profile);
  }
  const result = [...profiles.values()].slice(0, 12);
  profileSearchCache.set(clean, { expiresAt: Date.now() + 5 * 60_000, profiles: result });
  return result;
}

const publicProfileCache = new Map<string, { expiresAt: number; profile: Profile }>();

export async function getPublicProfiles(ids: string[]): Promise<Record<string, Profile>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const output: Record<string, Profile> = {};
  const missing: string[] = [];
  for (const id of unique) {
    const cached = publicProfileCache.get(id);
    if (cached && cached.expiresAt > Date.now()) output[id] = cached.profile;
    else missing.push(id);
  }

  for (let index = 0; index < missing.length; index += 10) {
    const chunk = missing.slice(index, index + 10);
    const snapshot = await getDocs(
      query(social.profiles(getDb()), where(documentId(), 'in', chunk), limit(10))
    );
    for (const entry of snapshot.docs) {
      const profile = { id: entry.id, ...entry.data() } as Profile;
      output[entry.id] = profile;
      publicProfileCache.set(entry.id, { expiresAt: Date.now() + 15 * 60_000, profile });
    }
  }
  return output;
}

export async function saveProfile(
  uid: string,
  input: Omit<Profile, 'id' | 'updatedAt'>
): Promise<void> {
  const username = normaliseUsername(input.username);
  if (username.length < 3) throw new Error('A username needs at least three characters.');
  const taken = await getDocs(
    query(social.profiles(getDb()), where('username', '==', username), limit(1))
  );
  if (!taken.empty && taken.docs[0].id !== uid) {
    throw new Error(`“${username}” is taken. Try another.`);
  }
  await setDoc(
    social.profile(getDb(), uid),
    {
      ...input,
      username,
      displayName: input.displayName.trim() || username,
      avatarUrl: input.avatarUrl?.trim() || null,
      avatarKey: input.avatarKey?.trim().slice(0, 220) || '',
      avatarPreset: input.avatarPreset || input.color,
      university: input.university.trim().slice(0, 100),
      universityId: input.universityId?.trim().slice(0, 160) || '',
      universityAbbreviation: input.universityAbbreviation?.trim().slice(0, 12) || '',
      major: input.major.trim().slice(0, 100),
      bio: input.bio.trim().slice(0, 280),
      courseCodes: input.shareCourses ? (input.courseCodes ?? []).slice(0, 30) : [],
      shareCourses: input.shareCourses === true,
      sharePresence: input.sharePresence === true,
      shareSchedule: input.shareSchedule === true,
      stats: normaliseProfileStats(input.stats),
      searchPrefixes: publicSearchPrefixes({
        username,
        displayName: input.displayName.trim() || username,
        university: input.university,
        universityAbbreviation: input.universityAbbreviation,
      }),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`notomi:share-presence-v1:${uid}`, input.sharePresence === true ? '1' : '0');
    }
  } catch {
    /* Preference still lives in Firestore. */
  }
}

export type PrivacySettings = {
  /** Let classmates find you by the courses you share. */
  shareCourses: boolean;
  /** Let friends see whether you are free, in class or focusing. */
  sharePresence: boolean;
  /** Let friends see your week as busy/free blocks. */
  shareSchedule: boolean;
};

export function privacyOf(profile: Profile | null | undefined): PrivacySettings {
  return {
    shareCourses: profile?.shareCourses === true,
    sharePresence: profile?.sharePresence === true,
    shareSchedule: profile?.shareSchedule === true,
  };
}

/**
 * Changes what other people can see, and nothing else.
 *
 * Separate from `saveProfile` deliberately. That function takes the whole
 * profile and checks the username for uniqueness first, so routing a privacy
 * change through it would spend a query on every toggle and could fail with a
 * message about a username — for someone who was turning presence off.
 *
 * Turning course sharing off empties `courseCodes` rather than only clearing
 * the flag. A switch that says "stop sharing" and leaves the data behind is
 * not a privacy control.
 */
export async function savePrivacy(uid: string, next: PrivacySettings): Promise<void> {
  await setDoc(
    social.profile(getDb(), uid),
    {
      shareCourses: next.shareCourses,
      sharePresence: next.sharePresence,
      shareSchedule: next.shareSchedule,
      ...(next.shareCourses ? {} : { courseCodes: [] }),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`notomi:share-presence-v1:${uid}`, next.sharePresence ? '1' : '0');
    }
  } catch {
    /* The setting still lives in Firestore. */
  }
}

export async function myProfile(uid: string): Promise<Profile | null> {
  const snapshot = await getDoc(social.profile(getDb(), uid));
  if (!snapshot.exists()) return null;

  const data = snapshot.data();
  const username = usernameOf(data);
  const profile: Profile = {
    id: snapshot.id,
    username,
    displayName: typeof data.displayName === 'string' ? data.displayName : username || 'Student',
    color: typeof data.color === 'string' ? data.color : '#B4552D',
    avatarUrl: typeof data.avatarUrl === 'string' ? data.avatarUrl : null,
    avatarKey: typeof data.avatarKey === 'string' ? data.avatarKey : '',
    avatarPreset: typeof data.avatarPreset === 'string' ? data.avatarPreset : null,
    university: typeof data.university === 'string' ? data.university : '',
    universityId: typeof data.universityId === 'string' ? data.universityId : '',
    universityAbbreviation:
      typeof data.universityAbbreviation === 'string' ? data.universityAbbreviation : '',
    major: typeof data.major === 'string' ? data.major : '',
    bio: typeof data.bio === 'string' ? data.bio : '',
    courseCodes: Array.isArray(data.courseCodes)
      ? data.courseCodes.filter((code): code is string => typeof code === 'string').slice(0, 30)
      : [],
    shareCourses: data.shareCourses === true,
    sharePresence: data.sharePresence === true,
    searchPrefixes: Array.isArray(data.searchPrefixes) ? data.searchPrefixes : [],
    stats: normaliseProfileStats(data.stats),
    updatedAt: data.updatedAt ?? null,
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`notomi:share-presence-v1:${uid}`, profile.sharePresence ? '1' : '0');
    }
  } catch {
    /* Preference still lives in Firestore. */
  }

  if (!data.username && username) {
    try {
      await claimUsername(uid, username, profile.displayName, profile.color);
    } catch (error) {
      console.warn('[social] Existing public identifier needs manual migration.', error);
      return { ...profile, username: '' };
    }
  }

  if (!Array.isArray(data.searchPrefixes) && profile.username) {
    void updateDoc(social.profile(getDb(), uid), {
      searchPrefixes: publicSearchPrefixes(profile),
    }).catch(() => undefined);
  }

  return profile;
}

export async function canSharePresence(uid: string): Promise<boolean> {
  try {
    if (typeof localStorage !== 'undefined') {
      const remembered = localStorage.getItem(`notomi:share-presence-v1:${uid}`);
      if (remembered !== null) return remembered === '1';
    }
  } catch {
    /* Fall through to the source of truth. */
  }
  return (await myProfile(uid))?.sharePresence === true;
}

/* ------------------------------------------------------------------ *
 * Friends
 * ------------------------------------------------------------------ */

/**
 * A request writes both halves at once.
 *
 * The alternative — write your side, let a function write theirs — needs a
 * backend this app does not have. Writing both is safe because the rules only
 * let you create a doc under someone else's account when it names you and is
 * marked incoming.
 */
export async function requestFriend(
  uid: string,
  me: Profile,
  them: Profile
): Promise<'sent' | 'accepted'> {
  if (them.id === uid) throw new Error('That is you.');

  const db = getDb();

  // They may have got there first. Adding someone who already added you is
  // plainly an acceptance, and treating it as a second request would fail —
  // only the recipient of a request can promote it.
  const existing = await getDoc(social.friend(db, uid, them.id));
  if (existing.exists()) {
    const status = existing.data().status as Friend['status'];
    if (status === 'incoming') {
      await acceptFriend(uid, them.id);
      return 'accepted';
    }
    return status === 'accepted' ? 'accepted' : 'sent';
  }

  await setDoc(social.friend(db, uid, them.id), {
    username: them.username,
    displayName: them.displayName,
    color: them.color,
    status: 'sent',
    createdAt: serverTimestamp(),
  });
  await setDoc(social.friend(db, them.id, uid), {
    username: me.username,
    displayName: me.displayName,
    color: me.color,
    status: 'incoming',
    createdAt: serverTimestamp(),
  });
  return 'sent';
}

export async function acceptFriend(uid: string, friendId: string): Promise<void> {
  const db = getDb();
  await updateDoc(social.friend(db, uid, friendId), { status: 'accepted' });
  await updateDoc(social.friend(db, friendId, uid), { status: 'accepted' });
}

export async function removeFriend(uid: string, friendId: string): Promise<void> {
  const db = getDb();
  await deleteDoc(social.friend(db, uid, friendId));
  await deleteDoc(social.friend(db, friendId, uid)).catch(() => undefined);
}

export function friendsPath(db: Firestore, uid: string) {
  return social.friends(db, uid);
}

export function busyPath(db: Firestore, uid: string) {
  return social.busy(db, uid);
}

export function presencePath(db: Firestore, uid: string) {
  return social.presence(db, uid);
}

/** One bounded listener replaces one presence listener per friend. */
export function presenceQuery(friendIds: string[]): Query<DocumentData> | null {
  const ids = [...new Set(friendIds)].slice(0, 10);
  if (ids.length === 0) return null;
  return query(collection(getDb(), 'presence'), where(documentId(), 'in', ids), limit(10));
}

/* ------------------------------------------------------------------ *
 * Sharing a week without sharing a timetable
 * ------------------------------------------------------------------ */

/** Class and routine blocks, reduced to when — and only when — you are busy. */
export function toBusyIntervals(
  classes: ClassBlock[],
  routines: RoutineBlock[]
): BusyInterval[] {
  const raw = [...classes, ...routines]
    .map((block) => ({ day: block.day, start: block.startMinute, end: block.endMinute }))
    .sort((a, b) => a.day - b.day || a.start - b.start);

  // Merged, so two back-to-back classes read as one block of unavailability
  // and the count of intervals says nothing about the count of classes.
  const merged: BusyInterval[] = [];
  for (const interval of raw) {
    const last = merged[merged.length - 1];
    if (last && last.day === interval.day && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** One labelled block of a shared week — only ever published on request. */
export type SharedBlock = BusyInterval & { title: string };

/**
 * The same week, with names on it.
 *
 * Kept to the title and the room because that is what a friend comparing
 * timetables needs; the code, the lecturer and the section are not part of
 * "when are you in class". Trimmed hard so a long module name cannot be used
 * to smuggle a paragraph into a document strangers can be shown.
 */
export function toSharedBlocks(classes: ClassBlock[], routines: RoutineBlock[]): SharedBlock[] {
  return [
    ...classes.map((block) => ({
      day: block.day,
      start: block.startMinute,
      end: block.endMinute,
      title: (block.subjectName || block.title || 'Class').slice(0, 60),
    })),
    ...routines.map((block) => ({
      day: block.day,
      start: block.startMinute,
      end: block.endMinute,
      title: (block.title || 'Busy').slice(0, 60),
    })),
  ]
    .sort((a, b) => a.day - b.day || a.start - b.start)
    .slice(0, 60);
}

export async function publishBusy(
  uid: string,
  intervals: BusyInterval[],
  blocks: SharedBlock[] = []
): Promise<void> {
  const cacheKey = `notomi:published-busy-v1:${uid}`;
  const signature = JSON.stringify({ intervals, blocks });
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(cacheKey) === signature) return;
  } catch {
    /* Storage is an optimisation only. */
  }
  await setDoc(busyPath(getDb(), uid), {
    intervals,
    // Written every time, so turning the setting off removes the labels on the
    // next publish rather than leaving yesterday's week readable.
    blocks,
    updatedAt: serverTimestamp(),
  });
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(cacheKey, signature);
      localStorage.removeItem(`notomi:busy-cleared-v1:${uid}`);
    }
  } catch {
    /* Storage is an optimisation only. */
  }
}

const busyCache = new Map<string, { expiresAt: number; intervals: BusyInterval[] }>();

/** Reads only selected friends, once per five minutes, for the on-demand matcher. */
export async function loadBusyWeeks(friendIds: string[]): Promise<Record<string, BusyInterval[]>> {
  const ids = [...new Set(friendIds)].slice(0, 3);
  const output: Record<string, BusyInterval[]> = {};
  await Promise.all(
    ids.map(async (id) => {
      const remembered = busyCache.get(id);
      if (remembered && remembered.expiresAt > Date.now()) {
        output[id] = remembered.intervals;
        return;
      }
      const snapshot = await getDoc(busyPath(getDb(), id));
      const intervals = snapshot.exists() && Array.isArray(snapshot.data().intervals)
        ? (snapshot.data().intervals as BusyInterval[])
        : [];
      output[id] = intervals;
      busyCache.set(id, { expiresAt: Date.now() + 5 * 60_000, intervals });
    })
  );
  return output;
}

/**
 * A friend's week, labelled — empty when they have not opted in.
 *
 * Read on demand rather than listened to: a timetable changes a few times a
 * semester, and one document per friend per open is cheaper than a listener
 * that lives for the session.
 */
export async function loadSharedWeek(friendId: string): Promise<SharedBlock[]> {
  const snapshot = await getDoc(busyPath(getDb(), friendId));
  if (!snapshot.exists()) return [];

  const blocks = snapshot.data().blocks;
  if (!Array.isArray(blocks)) return [];

  return blocks
    .filter(
      (block): block is SharedBlock =>
        typeof block?.day === 'number' &&
        typeof block?.start === 'number' &&
        typeof block?.end === 'number' &&
        typeof block?.title === 'string'
    )
    .sort((a, b) => a.day - b.day || a.start - b.start);
}

export async function syncPublicCourses(
  uid: string,
  profile: Profile | null,
  courseCodes: string[],
  materialCount = 0
): Promise<void> {
  if (!profile) return;
  const next = profile.shareCourses
    ? [...new Set(courseCodes.map((code) => code.trim().toUpperCase()).filter(Boolean))]
        .sort()
        .slice(0, 30)
    : [];
  const current = [...(profile.courseCodes ?? [])].sort();
  if (
    next.join('|') === current.join('|') &&
    (profile.stats?.materialCount ?? 0) === materialCount
  ) return;
  await updateDoc(social.profile(getDb(), uid), {
    courseCodes: next,
    'stats.materialCount': materialCount,
    updatedAt: serverTimestamp(),
  });
}

export async function syncPublicStudyStats(
  uid: string,
  profile: Profile | null,
  input: { focusMinutes: number; currentStreak: number; nightFocusMinutes: number }
): Promise<void> {
  if (!profile) return;
  if (
    (profile.stats?.focusMinutes ?? 0) === input.focusMinutes &&
    (profile.stats?.currentStreak ?? 0) === input.currentStreak &&
    (profile.stats?.nightFocusMinutes ?? 0) === input.nightFocusMinutes
  ) return;
  await updateDoc(social.profile(getDb(), uid), {
    'stats.focusMinutes': input.focusMinutes,
    'stats.currentStreak': input.currentStreak,
    'stats.nightFocusMinutes': input.nightFocusMinutes,
    updatedAt: serverTimestamp(),
  });
}

export async function syncPublicMasteredStats(uid: string, masteredCards: number): Promise<void> {
  const key = `notomi:mastered-stat-v1:${uid}`;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(key) === String(masteredCards)) return;
  } catch {
    /* Continue with the profile update. */
  }
  await updateDoc(social.profile(getDb(), uid), {
    'stats.masteredCards': masteredCards,
    updatedAt: serverTimestamp(),
  });
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(masteredCards));
  } catch {
    /* The public stat is already updated. */
  }
}

export async function syncPublicAttendanceBadge(uid: string, earned: boolean): Promise<void> {
  const key = `notomi:attendance-badge-v1:${uid}`;
  const encoded = earned ? '1' : '0';
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(key) === encoded) return;
  } catch {
    /* Continue with the profile update. */
  }
  await updateDoc(social.profile(getDb(), uid), {
    'stats.perfectAttendanceMonth': earned,
    updatedAt: serverTimestamp(),
  });
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, encoded);
  } catch {
    /* The public badge is already updated. */
  }
}

export async function recordArenaWin(uid: string, roomId: string): Promise<void> {
  const key = `notomi:arena-win-v1:${uid}:${roomId}`;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1') return;
  } catch {
    /* Continue with the profile update. */
  }
  await updateDoc(social.profile(getDb(), uid), {
    'stats.arenaWins': increment(1),
    updatedAt: serverTimestamp(),
  });
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, '1');
  } catch {
    /* The public stat is already updated. */
  }
}

export async function stopSharing(uid: string): Promise<void> {
  const clearedKey = `notomi:busy-cleared-v1:${uid}`;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(clearedKey) === '1') return;
  } catch {
    /* Storage is an optimisation only. */
  }
  await deleteDoc(busyPath(getDb(), uid)).catch(() => undefined);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`notomi:published-busy-v1:${uid}`);
      localStorage.setItem(clearedKey, '1');
    }
  } catch {
    /* Storage is an optimisation only. */
  }
}

export type Gap = { day: number; start: number; end: number };

/**
 * When everyone is free at once.
 *
 * The intersection of the complements, computed on the device rather than
 * anywhere else: the inputs are already the least revealing form of a
 * timetable, and this way they are never assembled together on a server.
 */
export function commonGaps(
  weeks: BusyInterval[][],
  options: { from?: number; to?: number; minimumMinutes?: number } = {}
): Gap[] {
  const from = options.from ?? 8 * 60;
  const to = options.to ?? 20 * 60;
  const minimum = options.minimumMinutes ?? 60;

  const gaps: Gap[] = [];

  for (let day = 0; day < 7; day += 1) {
    // Everyone's busy blocks for this day, merged into one timeline.
    const busy = weeks
      .flatMap((week) => week.filter((interval) => interval.day === day))
      .sort((a, b) => a.start - b.start);

    let cursor = from;
    for (const interval of busy) {
      if (interval.end <= from || interval.start >= to) continue;
      if (interval.start > cursor) {
        gaps.push({ day, start: cursor, end: Math.min(interval.start, to) });
      }
      cursor = Math.max(cursor, interval.end);
    }
    if (cursor < to) gaps.push({ day, start: cursor, end: to });
  }

  return gaps.filter((gap) => gap.end - gap.start >= minimum);
}

export function describeGap(gap: Gap): string {
  return `${DAY_FULL[gap.day]} ${minutesToLabel(gap.start)}–${minutesToLabel(gap.end)}`;
}

/* ------------------------------------------------------------------ *
 * Presence
 * ------------------------------------------------------------------ */

/** Called when a focus block starts, and again when it ends. */
export async function setPresence(
  uid: string,
  input: { status: Presence['status']; subjectName?: string | null; minutes?: number }
): Promise<void> {
  const db = getDb();
  const cacheKey = `notomi:presence-write-v1:${uid}`;
  const signature = `${input.status}|${input.subjectName ?? ''}`;
  try {
    if (typeof localStorage !== 'undefined') {
      const cached = JSON.parse(localStorage.getItem(cacheKey) ?? 'null') as {
        signature?: string;
        until?: number;
      } | null;
      if (cached?.signature === signature && (cached.until ?? 0) > Date.now() + 60_000) return;
    }
  } catch {
    /* Presence still works when local storage is unavailable. */
  }

  if (input.status === 'idle') {
    await setDoc(presencePath(db, uid), {
      status: 'idle',
      subjectName: null,
      until: null,
      updatedAt: serverTimestamp(),
    });
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(cacheKey, JSON.stringify({ signature, until: Date.now() + 2 * 60_000 }));
      }
    } catch {
      /* Presence still works when local storage is unavailable. */
    }
    return;
  }

  const until = new Date(Date.now() + (input.minutes ?? 25) * 60_000);
  await setDoc(presencePath(db, uid), {
    status: input.status,
    subjectName: input.subjectName ?? null,
    until,
    updatedAt: serverTimestamp(),
  });
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(cacheKey, JSON.stringify({ signature, until: until.getTime() }));
    }
  } catch {
    /* Presence still works when local storage is unavailable. */
  }
}

/**
 * A presence doc outlives the session that wrote it — a closed tab writes
 * nothing — so anything past its own end time reads as idle.
 */
export function isFocusing(presence: Presence | null | undefined, now = new Date()): boolean {
  if (!presence || presence.status !== 'focus') return false;
  const until = presence.until?.toDate?.();
  return until ? until.getTime() > now.getTime() : false;
}
