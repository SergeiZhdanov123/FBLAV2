// Bumping this cache name forces the old cache (and its stale app.js/styles.css)
// to be purged on activate. Increment it whenever the caching logic changes.
const STATIC_CACHE = 'fbla-hub-v2-static-v1';

// Only the rarely-changing shell is precached. The app code (app.js/styles.css)
// and the page itself are fetched network-first below so updates always land.
const PRECACHE = ['/manifest.json', '/app-icon.svg', '/favicon.png', '/FBLALogo.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll(PRECACHE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== STATIC_CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  const isAppCode = ['/app.js', '/hub.js', '/styles.css', '/hub.css'].includes(url.pathname);

  // Page loads and the app code are network-first: always try the live version,
  // fall back to cache only when offline. This is what stops a stale copy from
  // sticking on a phone. Successful responses refresh the cache for offline use.
  if (request.mode === 'navigate' || isAppCode) {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('/')))
    );
    return;
  }

  // Icons/manifest change rarely: serve from cache, fall back to network.
  const isShellAsset = ['/manifest.json', '/app-icon.svg', '/favicon.png', '/FBLALogo.png'].includes(url.pathname);
  if (!isShellAsset) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
