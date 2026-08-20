import { createPreference } from '@/lib/preference';

export type WeekStyle = 'grid' | 'agenda';

/**
 * How the week is drawn, everywhere it is drawn.
 *
 * Not a phone fallback — a preference at every width. The timetable and the
 * dashboard both render the same week from the same data, so a student who
 * picks the agenda on one and finds a grid on the other has been given two
 * settings wearing one name.
 *
 * Defaults to the grid because that is what is on screen today, and a
 * preference that silently changes what an existing user sees on first load is
 * not a preference, it is a surprise.
 */
export const weekStyle = createPreference<WeekStyle>({
  key: 'notomi:week-style',
  fallback: 'grid',
  parse: (raw) => (raw === 'grid' || raw === 'agenda' ? raw : null),
});

export const useWeekStyle = weekStyle.use;
