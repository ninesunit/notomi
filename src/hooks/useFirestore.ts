import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getDocs,
  onSnapshot,
  type DocumentReference,
  type Query,
  type DocumentData,
} from 'firebase/firestore';

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
/**
 * A collection read once, not watched.
 *
 * The listener in `useCollection` is right for data that changes while you are
 * looking at it — a chat, a room, a subject someone else is editing. It is
 * wrong for a list you opened to work through, where every card kept open a
 * subscription and every write anywhere in the collection billed a re-read to
 * everyone.
 *
 * `refresh` is the other half of the trade: without a listener, the caller
 * re-reads after its own mutations.
 */
export function useQueryOnce<T>(
  query: Query<DocumentData> | null,
  deps: unknown[]
): State<T[]> & { refresh: () => void } {
  const [state, setState] = useState<State<T[]>>({ data: [], loading: true, error: null });
  const [nonce, setNonce] = useState(0);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const current = queryRef.current;
    if (!current) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    let active = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    getDocs(current)
      .then((snapshot) => {
        if (!active) return;
        setState({
          data: snapshot.docs.map((d) => ({ id: d.id, ...d.data() }) as T),
          loading: false,
          error: null,
        });
      })
      .catch((error) => active && setState({ data: [], loading: false, error }));

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, refresh: () => setNonce((value) => value + 1) };
}

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
