/* ═══════════════════════════════════════════════════
   TimeGrid Service Worker
   - Cache static assets for offline shell
   - Network-first for API calls (always fresh data)
   ═══════════════════════════════════════════════════ */

const VERSION = 'v1.0.2';
const STATIC_CACHE = `timegrid-static-${VERSION}`;
const RUNTIME_CACHE = `timegrid-runtime-${VERSION}`;

// Resolve paths relative to this SW (handles subdirectory hosting)
const BASE = new URL('./', self.location).pathname;

const STATIC_ASSETS = [
  BASE,
  BASE + 'index.html',
  BASE + 'css/style.css',
  BASE + 'js/api.js',
  BASE + 'js/state.js',
  BASE + 'js/timeline.js',
  BASE + 'js/events.js',
  BASE + 'js/app.js',
  BASE + 'manifest.webmanifest',
  BASE + 'icons/icon.svg',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {
        // Ignore individual failures (icons may be missing on first deploy)
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
                     .map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ignore cross-origin (Google Fonts etc.)
  if (url.origin !== self.location.origin) return;

  // API calls: network-first, fall back to cached "offline" stub
  if (url.pathname.endsWith('/api.php')) {
    event.respondWith(
      fetch(req)
        .catch(() => new Response(
          JSON.stringify({ error: 'オフラインです。ネットワーク接続を確認してください。' }),
          { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        ))
    );
    return;
  }

  // Navigation: network-first, fall back to cached index.html for SPA
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match(BASE + 'index.html') || caches.match(BASE))
    );
    return;
  }

  // Static assets: cache-first, update in background
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Allow page to trigger an update check
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
