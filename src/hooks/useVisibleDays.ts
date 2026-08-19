import { useCallback, useEffect, useState } from 'react';
import { feedback } from '@/lib/sound';

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const STORAGE_KEY = 'notomi:timetable-visible-days';
/** Every mounted selector, so toggling on one surface updates the others. */
const listeners = new Set<(days: number[]) => void>();

function read(): number[] {
  if (typeof localStorage === 'undefined') return ALL_DAYS;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return Array.isArray(saved) && saved.length > 0 ? (saved as number[]) : ALL_DAYS;
  } catch {
    return ALL_DAYS;
  }
}

/**
 * Which days of the week the grids show.
 *
 * One setting, shared. The dashboard and the timetable draw the same week from
 * the same data, and a student who hides the weekend on one and finds it back
 * on the other has been given two settings that look like one — which is worse
 * than having no setting at all.
 *
 * Kept in module scope rather than in a context because there is exactly one
 * of it, it is a scalar, and threading a provider through the whole workspace
 * to carry seven booleans would cost more than it explains.
 */
export function useVisibleDays(): {
  visibleDays: number[];
  toggleDay: (day: number) => void;
} {
  const [visibleDays, setVisibleDays] = useState<number[]>(read);

  useEffect(() => {
    listeners.add(setVisibleDays);
    // Another tab may have changed it while this one was in the background.
    setVisibleDays(read());
    return () => {
      listeners.delete(setVisibleDays);
    };
  }, []);

  const toggleDay = useCallback((day: number) => {
    const current = read();
    // Never all seven off: an empty grid is not a filter, it is a blank screen
    // with no way to tell what happened.
    const next = current.includes(day)
      ? current.length > 1
        ? current.filter((entry) => entry !== day)
        : current
      : [...current, day].sort((a, b) => a - b);

    feedback('toggle');
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode; the choice lasts the session */
    }
    for (const listener of listeners) listener(next);
  }, []);

  return { visibleDays, toggleDay };
}
