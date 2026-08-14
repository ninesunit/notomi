import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { getFirebaseAuth } from '@/services/firebase';

type CacheRecord = {
  key: string;
  userId: string;
  value: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
};

interface AiCacheDatabase extends DBSchema {
  responses: {
    key: string;
    value: CacheRecord;
    indexes: { 'by-user': string; 'by-expiry': number };
  };
}

const DATABASE_NAME = 'notomi-ai-response-cache';
const CACHE_VERSION = 'response-v1';
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_RESPONSES_PER_USER = 120;
const inFlight = new Map<string, Promise<string>>();
const memory = new Map<string, CacheRecord>();
let databasePromise: Promise<IDBPDatabase<AiCacheDatabase>> | null = null;

function database(): Promise<IDBPDatabase<AiCacheDatabase>> | null {
  if (typeof indexedDB === 'undefined') return null;
  databasePromise ??= openDB<AiCacheDatabase>(DATABASE_NAME, 1, {
    upgrade(db) {
      const store = db.createObjectStore('responses', { keyPath: 'key' });
      store.createIndex('by-user', 'userId');
      store.createIndex('by-expiry', 'expiresAt');
    },
  });
  return databasePromise;
}

function fallbackHash(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function digest(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    owned.set(bytes);
    const result = await globalThis.crypto.subtle.digest('SHA-256', owned);
    return [...new Uint8Array(result)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  }
  return fallbackHash(bytes);
}

async function cacheKey(input: {
  namespace: string;
  payload: string;
  bytes?: ArrayBuffer;
}): Promise<{ key: string; userId: string }> {
  const userId = getFirebaseAuth().currentUser?.uid ?? 'signed-out';
  const mediaHash = input.bytes ? await digest(new Uint8Array(input.bytes)) : '';
  const encoded = new TextEncoder().encode(
    [CACHE_VERSION, userId, input.namespace, mediaHash, input.payload].join('|')
  );
  return { key: await digest(encoded), userId };
}

async function readRecord(key: string): Promise<CacheRecord | null> {
  const now = Date.now();
  const remembered = memory.get(key);
  if (remembered && remembered.expiresAt > now) return remembered;
  if (remembered) memory.delete(key);

  const db = await database();
  if (!db) return null;
  const stored = await db.get('responses', key);
  if (!stored) return null;
  if (stored.expiresAt <= now) {
    await db.delete('responses', key);
    return null;
  }
  stored.lastUsedAt = now;
  memory.set(key, stored);
  void db.put('responses', stored);
  return stored;
}

async function prune(db: IDBPDatabase<AiCacheDatabase>, userId: string): Promise<void> {
  const now = Date.now();
  const expiryKeys = await db.getAllKeysFromIndex('responses', 'by-expiry', IDBKeyRange.upperBound(now));
  await Promise.all(expiryKeys.map((key) => db.delete('responses', key)));

  const records = await db.getAllFromIndex('responses', 'by-user', userId);
  if (records.length <= MAX_RESPONSES_PER_USER) return;
  records.sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  await Promise.all(
    records.slice(MAX_RESPONSES_PER_USER).map((record) => db.delete('responses', record.key))
  );
}

/**
 * Reuses deterministic AI responses on this device and collapses simultaneous
 * identical requests into one network call. The key includes the signed-in
 * user, so cached study content can never cross accounts on a shared device.
 */
export async function withAiResponseCache(
  input: {
    namespace: string;
    payload: string;
    bytes?: ArrayBuffer;
    ttlMs?: number;
  },
  request: () => Promise<string>
): Promise<string> {
  const identity = await cacheKey(input);
  const cached = await readRecord(identity.key).catch(() => null);
  if (cached) return cached.value;

  const pending = inFlight.get(identity.key);
  if (pending) return pending;

  const task = request()
    .then(async (value) => {
      if (!value.trim()) return value;
      const now = Date.now();
      const record: CacheRecord = {
        key: identity.key,
        userId: identity.userId,
        value,
        createdAt: now,
        expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
        lastUsedAt: now,
      };
      memory.set(identity.key, record);
      const db = await database();
      if (db) {
        await db.put('responses', record);
        void prune(db, identity.userId).catch(() => undefined);
      }
      return value;
    })
    .finally(() => inFlight.delete(identity.key));

  inFlight.set(identity.key, task);
  return task;
}

/** Removes private cached responses before an anonymous account is deleted. */
export async function clearAiResponseCacheForUser(userId: string): Promise<void> {
  for (const [key, record] of memory) {
    if (record.userId === userId) memory.delete(key);
  }
  const db = await database();
  if (!db) return;
  const keys = await db.getAllKeysFromIndex('responses', 'by-user', userId);
  await Promise.all(keys.map((key) => db.delete('responses', key)));
}
