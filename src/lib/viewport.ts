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
