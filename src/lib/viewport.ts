import { useCallback, useEffect, useState } from 'react';
import type { TextInputProps } from 'react-native';

/**
 * Keeps the app exactly as tall as the part of the screen you can see.
 *
 * The shell is sized with `100dvh`, which tracks the browser's own chrome
 * appearing and disappearing — but not the keyboard. iOS does not shrink the
 * layout viewport when the keyboard opens; it slides a panel over the bottom
 * of it. So a page that is honestly 100dvh tall keeps rendering its last few
 * hundred points underneath the keys, which is where the compose box, the
 * to-do field and the chat input all live.
 *
 * visualViewport measures what is actually visible, keyboard included. Binding
 * the shell to that turns "my typing is hidden" into an ordinary layout: the
 * inner scroller shortens and the focused field comes with it.
 *
 * Falls back to 100dvh wherever visualViewport is missing, so nothing changes
 * on desktop or in an older browser — the CSS custom property simply stays
 * unset and the existing rule applies.
 */
export function trackViewportHeight(): () => void {
  if (typeof window === 'undefined') return () => {};

  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const apply = () => {
    document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);

    /*
     * iOS also scrolls the *layout* viewport to bring a focused field into
     * view, which on a shell that is `overflow: hidden` drags the whole app up
     * and leaves a strip of blank page above the header. Once the height is
     * correct that scroll is unnecessary, so it is undone.
     */
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };

  apply();
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);

  return () => {
    viewport.removeEventListener('resize', apply);
    viewport.removeEventListener('scroll', apply);
    document.documentElement.style.removeProperty('--app-height');
  };
}

type ScrollTarget = {
  scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
  isConnected?: boolean;
};

const focusTimers = new WeakMap<ScrollTarget, ReturnType<typeof setTimeout>>();

function scrollTargetIntoView(target: ScrollTarget, delay: number): ReturnType<typeof setTimeout> {
  const pending = focusTimers.get(target);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    focusTimers.delete(target);
    if (target.isConnected === false || typeof target.scrollIntoView !== 'function') return;
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    target.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'center',
      inline: 'nearest',
    });
  }, delay);
  focusTimers.set(target, timer);
  return timer;
}

/**
 * App-wide safety net for raw inputs that do not use the shared Field.
 *
 * React Native Web renders TextInput as an input or textarea. Listening once
 * at the document boundary keeps every older form keyboard-safe without
 * adding slightly different timers to dozens of screens. The delay gives iOS
 * time to publish the smaller visual viewport before centring the field.
 */
export function trackFocusedInputs(delay = 180): () => void {
  if (typeof document === 'undefined') return () => {};
  const onFocus = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
    scrollTargetIntoView(target, delay);
  };

  document.addEventListener('focusin', onFocus);
  return () => document.removeEventListener('focusin', onFocus);
}

export type VisualViewport = {
  /** What the student can actually see, keyboard subtracted. */
  height: number;
  /** How far the visual viewport has been pushed down the layout one. */
  offsetTop: number;
  /** Zero when the keyboard is closed. */
  keyboardHeight: number;
};

function measure(): VisualViewport {
  if (typeof window === 'undefined') return { height: 0, offsetTop: 0, keyboardHeight: 0 };
  const viewport = window.visualViewport;
  if (!viewport) return { height: window.innerHeight, offsetTop: 0, keyboardHeight: 0 };
  return {
    height: viewport.height,
    offsetTop: viewport.offsetTop,
    // The layout viewport does not shrink on iOS, so the difference between
    // the two is the panel covering the bottom — which is the keyboard.
    keyboardHeight: Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop),
  };
}

/**
 * The viewport as the student experiences it, for components that need to size
 * themselves against it rather than against the window.
 *
 * `useWindowDimensions` reports the layout viewport, which iOS does not shrink
 * when the keyboard opens — it slides a panel over the bottom instead. A sheet
 * sized at sixty percent of that believes it has room it does not have, and
 * puts its Save button under the keys.
 *
 * Falls back to the window on anything without visualViewport, which is every
 * desktop browser worth worrying about and where the two agree anyway.
 */
export function useVisualViewport(): VisualViewport {
  const [state, setState] = useState<VisualViewport>(measure);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setState(measure());
    update();

    const viewport = window.visualViewport;
    if (!viewport) {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }

    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);

  return state;
}

/**
 * onFocus handler for high-priority composers and shared fields.
 *
 * The document listener above covers every web input; this hook also makes the
 * intent explicit at the bottom-anchored controls most likely to be covered.
 * On native targets `scrollIntoView` is absent, so the callback is a no-op and
 * KeyboardAvoidingView keeps ownership of the platform-native behaviour.
 */
export function useAutoScrollOnFocus(delay = 180) {
  return useCallback(
    (event: Parameters<NonNullable<TextInputProps['onFocus']>>[0]) => {
      const target = event.target as unknown as ScrollTarget;
      if (typeof target?.scrollIntoView !== 'function') return;
      scrollTargetIntoView(target, delay);
    },
    [delay]
  );
}
