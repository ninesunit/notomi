/**
 * Notomi service worker.
 *
 * Its whole job is to make a deploy reach an installed home-screen app without
 * the student reinstalling it. Two rules do that:
 *
 *   1. Navigations are network-first. index.html names the current bundle, so
 *      serving a stale one pins the app to an old build forever — which is
 *      exactly the failure this replaces. The cached copy is a fallback for
 *      being offline, nothing more.
 *   2. A new worker takes over immediately (skipWaiting + clientsClaim) instead
 *      of waiting for every tab to close, which on an iOS home-screen app can
 *      be never.
 *
 * Hashed bundle files under /_expo/static are content-addressed, so those are
 * cache-first and safe to keep forever.
 */

const VERSION = 'notomi-v5';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

/** Enough to open the app offline; everything else is fetched on demand. */
const PRECACHE = ['/', '/manifest.webmanifest', '/favicon.ico', '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Individually, so one 404 cannot fail the whole install.
      await Promise.allSettled(PRECACHE.map((path) => cache.add(path)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/** Lets the page ask a waiting worker to take over right now. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') void self.skipWaiting();
});

/**
 * Tapping a reminder focuses the app instead of opening a second copy.
 *
 * An installed PWA can already have a window open behind the notification, and
 * clients.openWindow() there gives the student two of the app.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clients) {
        if ('focus' in client) {
          if ('navigate' in client && target !== '/') await client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Only same-origin traffic. Firestore, Gemini and R2 must never be
  // intercepted — a cached auth or streaming response would be worse than none.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.startsWith('/_expo/static/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Icons, manifest, the pdf worker: try the network, fall back to cache.
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    // Navigations must bypass the browser's HTTP cache as well as this worker's
    // cache. Firebase Hosting otherwise gives rewritten `/` and deep links a
    // one-hour max-age, leaving a current worker paired with an old entry bundle.
    const response = await fetch(request, request.mode === 'navigate' ? { cache: 'no-store' } : undefined);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // A deep link offline still has to render something: fall back to the shell.
    if (request.mode === 'navigate') {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    throw new Error('offline');
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}
