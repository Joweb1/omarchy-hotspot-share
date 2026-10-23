const VERSION = '__VERSION__';
const CACHE = `hotspot-share-${VERSION}`;
const SHELL = [
  '/', '/index.html', '/style.css', '/app.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png',
  '/vendor/qrcode.js', '/vendor/jetbrains-mono-latin-400-normal.woff2', '/vendor/jetbrains-mono-latin-600-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // Pages always open from the cache, so the app works with no connection.
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('/index.html').then((r) => r || fetch(req)));
    return;
  }

  // Assets: cached copy now, refreshed in the background.
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const fresh = fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || fresh;
    }),
  );
});
