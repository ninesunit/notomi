import { Platform } from 'react-native';

/**
 * Keeps an installed PWA on the current build.
 *
 * Registers the worker, then checks for a new one on launch and whenever the
 * app comes back to the foreground — which on a home-screen install is the only
 * moment it reliably gets to run. When a new worker takes control the page
 * reloads once, so the student never has to reinstall to get a deploy.
 */

const RELOAD_GUARD = 'notomi:reloading-for-update';

export function registerServiceWorker(): void {
  if (Platform.OS !== 'web') return;
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  // A worker served from localhost during `expo start` would cache the dev
  // bundle and shadow Metro's own reloading.
  if (__DEV__) return;

  const container = navigator.serviceWorker;

  /**
   * controllerchange fires when a new worker takes over. Reload once so the
   * page is running the code the new worker will serve; the session-scoped
   * guard stops a reload loop if anything re-registers on the way back up.
   */
  container.addEventListener('controllerchange', () => {
    if (sessionStorage.getItem(RELOAD_GUARD)) return;
    sessionStorage.setItem(RELOAD_GUARD, '1');
    window.location.reload();
  });

  window.addEventListener('load', () => {
    void container
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        // A worker already waiting means a deploy landed while the app was
        // closed. Take it now rather than on some future tab close.
        if (registration.waiting) registration.waiting.postMessage('SKIP_WAITING');

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && container.controller) {
              installing.postMessage('SKIP_WAITING');
            }
          });
        });

        const check = () => void registration.update().catch(() => undefined);

        check();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
        // A long-lived standalone app may never be backgrounded; check hourly.
        window.setInterval(check, 60 * 60 * 1000);
      })
      .catch(() => {
        /* No service worker is a degraded PWA, not a broken app. */
      });
  });

  // Clear the guard once the app has settled, so a later update can reload.
  window.setTimeout(() => sessionStorage.removeItem(RELOAD_GUARD), 10_000);
}
