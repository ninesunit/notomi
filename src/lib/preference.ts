import { useEffect, useState } from 'react';

/**
 * A single setting, shared by every screen that reads it.
 *
 * Factored from the shape `useVisibleDays` arrived at, which is the best of the
 * three preference patterns in the app: a module-scope value, a listener set so
 * every mounted reader updates together, localStorage so it survives a reload,
 * and a re-read on mount because another tab may have changed it meanwhile.
 *
 * The listener set is the part that matters. Two screens holding their own
 * `useState` of the same setting is how the sound toggle ended up rendering
 * "Sound on" in the sidebar while Settings said it was off — each wrote the
 * store and neither heard the other.
 *
 * `useVisibleDays` is deliberately left on its own hand-rolled copy of this.
 * It works, it is live on two surfaces, and rewriting it onto the factory would
 * risk a working thing to save a few lines.
 */
export function createPreference<T>(options: {
  key: string;
  fallback: T;
  /** Returns the fallback for anything it does not recognise. */
  parse: (raw: unknown) => T | null;
}) {
  const { key, fallback, parse } = options;
  const listeners = new Set<(value: T) => void>();

  const read = (): T => {
    if (typeof localStorage === 'undefined') return fallback;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return parse(JSON.parse(raw)) ?? fallback;
    } catch {
      return fallback;
    }
  };

  const set = (value: T): void => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode; the choice lasts the session */
    }
    for (const listener of listeners) listener(value);
  };

  /** For code that needs the value once, outside React. */
  const get = read;

  function usePreference(): [T, (value: T) => void] {
    const [value, setValue] = useState<T>(read);

    useEffect(() => {
      listeners.add(setValue);
      // Another tab may have changed it while this one was in the background.
      setValue(read());
      return () => {
        listeners.delete(setValue);
      };
    }, []);

    return [value, set];
  }

  return { use: usePreference, get, set };
}
