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
      // `parse` sees whatever was stored, JSON or not. A key that predates this
      // factory may hold a bare string, and reading that as "unrecognised" would
      // silently reset a setting the student had chosen — which for the sound
      // toggle would mean un-muting them.
      let value: unknown = raw;
      try {
        value = JSON.parse(raw);
      } catch {
        /* Not JSON. Hand the raw string to parse and let it decide. */
      }
      return parse(value) ?? fallback;
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

  /**
   * For code that needs every value, outside React — a module that caches the
   * setting because it is consulted far too often to re-read the store each
   * time. Returns its own unsubscribe.
   */
  const subscribe = (listener: (value: T) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

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

  return { use: usePreference, get, set, subscribe };
}
