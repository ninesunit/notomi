import { useEffect, useMemo, useRef, useState } from 'react';
import {
  onSnapshot,
  type DocumentReference,
  type Query,
  type DocumentData,
} from 'firebase/firestore';
import { recordReads } from '@/lib/budget';

type State<T> = { data: T; loading: boolean; error: Error | null };

/**
 * Real-time collection subscription.
 *
 * `query` is rebuilt on every render by callers, so the effect keys off an
 * explicit dependency list instead of the query object itself — otherwise the
 * listener would tear down and re-establish on each render.
 */
export function useCollection<T>(
  query: Query<DocumentData> | null,
  deps: unknown[]
): State<T[]> {
  const [state, setState] = useState<State<T[]>>({ data: [], loading: true, error: null });
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const current = queryRef.current;
    if (!current) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: null }));

    return onSnapshot(
      current,
      (snapshot) => {
        // Only what actually changed. A listener re-delivers the whole result
        // set on every update, but Firestore bills the documents that moved —
        // counting snapshot.docs would report a screen watching fifty subjects
        // as fifty reads a keystroke and make the estimate useless.
        recordReads(snapshot.docChanges().length);
        setState({
          data: snapshot.docs.map((d) => ({ id: d.id, ...d.data() }) as T),
          loading: false,
          error: null,
        });
      },
      (error) => setState({ data: [], loading: false, error })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

/** Real-time single-document subscription. */
export function useDocument<T>(
  ref: DocumentReference<DocumentData> | null,
  deps: unknown[]
): State<T | null> {
  const [state, setState] = useState<State<T | null>>({
    data: null,
    loading: true,
    error: null,
  });
  const refRef = useRef(ref);
  refRef.current = ref;

  useEffect(() => {
    const current = refRef.current;
    if (!current) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: null }));

    return onSnapshot(
      current,
      (snapshot) => {
        recordReads(1);
        setState({
          data: snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as T) : null,
          loading: false,
          error: null,
        });
      },
      (error) => setState({ data: null, loading: false, error })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

/** Stable memo helper for building queries inside components. */
export function useStable<T>(factory: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, deps);
}
