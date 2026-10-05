// Sauna Conductor service worker: makes the app installable and quick to open.
// Pages come from the network first (so updates show up at once), with the last copy as a fallback
// when offline. Versioned files (?v=…) never change, so they are served from the cache.
const VERSION = 'dev';                 // replaced by tools/build.py
const CACHE = 'sc-' + VERSION;
const SHELL = ['./', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './favicon.ico'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sc-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // Spotify, Supabase, ElevenLabs: never cached
  if (req.mode === 'navigate') {
    // Only the app's own page is kept for offline use (not the privacy or recording pages).
    const isApp = /\/(index\.html)?$/.test(url.pathname);
    e.respondWith(fetch(req).then((r) => {
      if (r.ok && isApp) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('./', copy)); }
      return r;
    }).catch(() => (isApp ? caches.match('./') : Promise.resolve(null)).then((hit) => hit || Response.error())));
    return;
  }
  if (url.searchParams.has('v') || SHELL.some((p) => url.pathname.endsWith(p.replace('./', '/')))) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return r;
    })));
  }
});
