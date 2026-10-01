// 跳蛙渡 Leap — offline shell.
//
// Two rules this file exists to obey, both learned the hard way in this wave:
//
// 1. Cache names carry a version, but the version is NOT the invalidation strategy. A hand-bumped
//    VERSION plus cache-first reads pins js/css to whatever the first visit ever fetched: a new
//    index.html served with old modules is a ghost state nobody can reproduce. So every same-origin
//    subresource below goes **network first**, and the cache is only what you fall back to when the
//    network is not there at all.
// 2. `install` must not be all-or-nothing. `cache.addAll()` rejects as a unit, so one typo in this
//    list would leave the whole service worker stuck in `installed` with nothing cached and an
//    offline page that never works. Each entry is settled separately and the misses are reported.
//
// Registered only from http(s) origins by js/main.js — a file:// page cannot scope a service
// worker, and attempting it throws an uncaught SecurityError.

const VERSION = 'leap-v2';
const RUNTIME = `${VERSION}-runtime`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/game.css',
  './js/main.js',
  './js/view.js',
  './js/audio.js',
  './js/core/game.js',
  './js/core/solve.js',
  './js/core/storage.js',
  './js/core/library.js',
  './js/core/make.js',
  './js/core/rng.js',
  './js/data/lots.js',
  './assets/icons/favicon-32.png',
  './assets/icons/favicon-48.png',
  './assets/icons/favicon.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-192-maskable.png',
  './assets/icons/icon-512-maskable.png',
  './assets/game/water.png',
  './assets/game/pad.png',
  './assets/game/ripple.png',
  './assets/game/splash.png',
  './assets/game/bank.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(RUNTIME);
    const settled = await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    const missed = settled.filter((r) => r.status === 'rejected').length;
    // A missing shell entry is a deploy bug, not a runtime condition: say it once, loudly, and
    // still activate so the entries that did land keep the page loadable offline.
    if (missed) console.warn(`[leap sw] ${missed}/${SHELL.length} shell entries unavailable`);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== RUNTIME && key.startsWith('leap-')) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (ev) => {
  if (ev.data === 'leap-skip') self.skipWaiting();
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // nothing here is cross-origin; never proxy a stranger

  ev.respondWith((async () => {
    const cache = await caches.open(RUNTIME);
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.status === 200 && (fresh.type === 'basic' || fresh.type === 'default')) {
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await cache.match(req);
      if (cached) return cached;
      // Only a navigation gets the offline shell; a missing texture must stay a missing texture
      // rather than silently turning into a document.
      if (req.mode === 'navigate') {
        const home = await cache.match('./index.html') || await cache.match('./');
        if (home) return home;
      }
      throw err;
    }
  })());
});
