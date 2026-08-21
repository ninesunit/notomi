import { useSyncExternalStore } from 'react';

import { createPreference } from '@/lib/preference';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

/**
 * Which palette is on screen.
 *
 * Three choices, two outcomes: `system` is not a third theme, it is a standing
 * instruction to follow the device. Storing the instruction rather than its
 * current answer is what lets a phone that switches at sunset take Notomi with
 * it without the student touching anything.
 *
 * Defaults to `system` because that is what every native app on the device
 * already does, and the brief was to feel native. It is the one preference in
 * the app that may change what an existing user sees on first load, which is
 * deliberate: a student whose phone is dark is surprised by a white page, not
 * by a dark one.
 */
export const themeChoice = createPreference<ThemeChoice>({
  key: 'notomi:theme',
  fallback: 'system',
  parse: (raw) => (raw === 'light' || raw === 'dark' || raw === 'system' ? raw : null),
});

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * The colour the browser paints its own chrome with — the iOS status bar in an
 * installed app, the address bar elsewhere. It has to move with the theme or a
 * dark app sits under a cream notch.
 */
const CHROME: Record<Theme, string> = { light: '#F7F5EE', dark: '#14130F' };

function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

function resolve(choice: ThemeChoice): Theme {
  if (choice === 'system') return prefersDark() ? 'dark' : 'light';
  return choice;
}

/**
 * One store, one media-query listener.
 *
 * Every icon in the app reads the resolved theme, so a hook that subscribed to
 * `matchMedia` per call site would attach a few hundred listeners to answer one
 * question. The question is answered once here and handed out.
 */
let current: Theme = resolve(themeChoice.get());
const listeners = new Set<() => void>();

/**
 * Writes the theme onto the document, which is what actually swaps the palette:
 * the channel triplets in global.css are keyed off this attribute.
 */
function paint(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', CHROME[theme]);
}

function publish(next: Theme): void {
  if (next === current) return;
  current = next;
  paint(next);
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  // The inline script in index.html has already painted the first frame; this
  // only keeps the document in step afterwards, and covers the dev server,
  // which serves Expo's untouched template.
  paint(current);

  if (typeof window.matchMedia === 'function') {
    window.matchMedia(DARK_QUERY).addEventListener('change', () => {
      // Only the standing instruction follows the device. An explicit choice
      // outranks it, which is the whole reason for storing the choice.
      if (themeChoice.get() === 'system') publish(resolve('system'));
    });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The resolved theme for code that cannot hold a hook — the subject-colour
 * helpers in lib/color.ts, which are called inside render bodies at three
 * dozen sites and would otherwise each need one.
 *
 * Safe because the root layout subscribes with `useTheme()`, so a change
 * re-renders the whole tree and every reader picks the new value up in the
 * same pass. Anything that starts memoising components has to revisit this.
 */
export function getTheme(): Theme {
  return current;
}

/** The palette actually on screen, already resolved. */
export function useTheme(): Theme {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => 'light',
  );
}

/** The stored instruction, for the one screen that lets a student change it. */
export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, store] = themeChoice.use();
  return [
    choice,
    (next: ThemeChoice) => {
      store(next);
      publish(resolve(next));
    },
  ];
}
