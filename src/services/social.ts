import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore,
  type Timestamp,
} from 'firebase/firestore';
import { DAY_FULL, minutesToLabel, type ClassBlock, type RoutineBlock } from '@/lib/schema';
import { getDb } from '@/services/firebase';

/**
 * Friends, without handing over your timetable.
 *
 * The thing students actually want from each other's schedules is one answer —
 * when are we all free — and that answer needs only the shape of a week, not
 * its contents. So what leaves an account is a list of busy intervals: day,
 * start, end. No subject, no room, no code. A friend can see that you are busy
 * Tuesday 2–4; they cannot see what you are doing, and nothing in the data
 * would let them work it out.
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
  handle: string;
  displayName: string;
  color: string;
  updatedAt: Timestamp | null;
};

export type Friend = {
  id: string;
  handle: string;
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
  status: 'focus' | 'idle';
  subjectName: string | null;
  /** When the current block ends, so a stale doc expires by itself. */
  until: Timestamp | null;
  updatedAt: Timestamp | null;
};

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/** Lowercase, letters, digits and dots — what a student can type from memory. */
export function normaliseHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 24);
}

export async function claimHandle(
  uid: string,
  handle: string,
  displayName: string,
  color: string
): Promise<void> {
  const clean = normaliseHandle(handle);
  if (clean.length < 3) throw new Error('A handle needs at least three characters.');

  const db = getDb();
  const taken = await getDocs(
    query(social.profiles(db), where('handle', '==', clean), limit(1))
  );
  if (!taken.empty && taken.docs[0].id !== uid) {
    throw new Error(`“${clean}” is taken. Try another.`);
  }

  await setDoc(social.profile(db, uid), {
    handle: clean,
    displayName: displayName.trim() || clean,
    color,
    updatedAt: serverTimestamp(),
  });
}

export async function findByHandle(handle: string): Promise<Profile | null> {
  const clean = normaliseHandle(handle);
  if (!clean) return null;

  const found = await getDocs(
    query(social.profiles(getDb()), where('handle', '==', clean), limit(1))
  );
  if (found.empty) return null;

  const entry = found.docs[0];
  return { id: entry.id, ...entry.data() } as Profile;
}

export async function myProfile(uid: string): Promise<Profile | null> {
  const snapshot = await getDoc(social.profile(getDb(), uid));
  return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as Profile) : null;
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
    handle: them.handle,
    displayName: them.displayName,
    color: them.color,
    status: 'sent',
    createdAt: serverTimestamp(),
  });
  await setDoc(social.friend(db, them.id, uid), {
    handle: me.handle,
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

export async function publishBusy(uid: string, intervals: BusyInterval[]): Promise<void> {
  await setDoc(busyPath(getDb(), uid), {
    intervals,
    updatedAt: serverTimestamp(),
  });
}

export async function stopSharing(uid: string): Promise<void> {
  await deleteDoc(busyPath(getDb(), uid)).catch(() => undefined);
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
  input: { status: 'focus' | 'idle'; subjectName?: string | null; minutes?: number }
): Promise<void> {
  const db = getDb();

  if (input.status === 'idle') {
    await setDoc(presencePath(db, uid), {
      status: 'idle',
      subjectName: null,
      until: null,
      updatedAt: serverTimestamp(),
    });
    return;
  }

  const until = new Date(Date.now() + (input.minutes ?? 25) * 60_000);
  await setDoc(presencePath(db, uid), {
    status: 'focus',
    subjectName: input.subjectName ?? null,
    until,
    updatedAt: serverTimestamp(),
  });
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
