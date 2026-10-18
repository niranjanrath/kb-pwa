// Offline app shell. Strategy:
//   * install: precache every file the app needs (all-or-nothing)
//   * fetch (same-origin GET): serve from cache immediately, refresh the cache in the background
//   * navigations that miss the cache fall back to the cached index.html
// Bump VERSION whenever any precached file changes so old caches are dropped.
// (npm run check verifies that this list matches the files on disk.)
const VERSION = 'v1';
const CACHE = `kb-shell-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'src/app.js',
  'src/db.js',
  'src/errors.js',
  'src/folderService.js',
  'src/importExport.js',
  'src/markdown.js',
  'src/noteService.js',
  'src/sample.js',
  'src/searchService.js',
  'src/treeView.js',
  'src/ui.js',
  'vendor/dexie.mjs',
  'vendor/highlight.mjs',
  'vendor/jszip.mjs',
  'vendor/marked.mjs',
  'vendor/purify.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('kb-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin traffic

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
      const refresh = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(refresh); // keep the worker alive until the background update finishes
        return cached;
      }
      const response = await refresh;
      if (response) return response;
      if (request.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      return new Response('Offline and not cached.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    })(),
  );
});
