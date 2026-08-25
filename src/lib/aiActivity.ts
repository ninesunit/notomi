import { useSyncExternalStore } from 'react';

export type AiActivitySnapshot = {
  count: number;
  label: string | null;
  startedAt: number | null;
};

type Activity = { label: string; startedAt: number };

const listeners = new Set<() => void>();
const active = new Map<number, Activity>();
let nextId = 1;
let snapshot: AiActivitySnapshot = { count: 0, label: null, startedAt: null };

function publish(): void {
  const latest = Array.from(active.values()).at(-1) ?? null;
  snapshot = {
    count: active.size,
    label: latest?.label ?? null,
    startedAt: latest?.startedAt ?? null,
  };
  for (const listener of listeners) listener();
}

/**
 * Marks one real provider request as active.
 *
 * The store is deliberately in memory. It makes work visible across routes
 * without a database write, and a reload cannot resurrect a spinner for a
 * request the browser no longer owns.
 */
export function beginAiActivity(label: string): () => void {
  const id = nextId;
  nextId += 1;
  active.set(id, { label, startedAt: Date.now() });
  publish();

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    active.delete(id);
    publish();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AiActivitySnapshot {
  return snapshot;
}

/** One subscription shared by every AI surface in the workspace shell. */
export function useAiActivity(): AiActivitySnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

