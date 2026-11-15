/* Offline support: keeps a copy of the app files on the device.
   Bump VERSION whenever you change any app file so devices pick up the update. */
const VERSION = 'budget-v11';
const FILES = ['./', 'index.html', 'styles.css', 'core.js', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  // Files are cached one by one so a single missing file never blocks the update.
  e.waitUntil(caches.open(VERSION)
    .then((c) => Promise.all(FILES.map((f) => c.add(f).catch(() => null))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isLib = url.origin === 'https://cdnjs.cloudflare.com';               // Excel library: keep a copy for offline use
  if (url.origin !== self.location.origin && !isLib) return;                // Google requests go straight to the network
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request).then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
