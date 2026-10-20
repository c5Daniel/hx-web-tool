// Offline support for the static build: hand-written, no dependencies, no
// build step (Vite copies public/ verbatim). The field has no network, so a
// page opened online once must open again without one.
//
// - Install caches the app shell: index.html plus the hashed assets it
//   references, found by reading index.html itself. That matters because the
//   very first visit loads its JS/CSS before this worker controls the page.
// - Navigations: network first, so a new deploy shows up whenever there is a
//   network; after NAV_TIMEOUT_MS or offline, the cached shell.
// - Hashed assets/ files: cache first (the name changes with the content).
// - Other same-origin GETs (manifest, icons): stale-while-revalidate.
//
// Every URL is resolved against the registration scope, so the site works
// under any GitHub Pages repo path (vite.config.ts uses base './').
// Bump VERSION when the caching logic here changes: activate drops the
// caches of every other version.

const VERSION = 'v1';
const PREFIX = 'hx-web-tool-';
const CACHE = PREFIX + VERSION;
const NAV_TIMEOUT_MS = 4000;
const STATIC = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

const scoped = (path) => new URL(path, self.registration.scope).href;
const isAsset = (url) => new URL(url).pathname.startsWith(new URL(scoped('assets/')).pathname);
const isShell = (url) => {
  const path = new URL(url).pathname;
  const root = new URL(scoped('./')).pathname;
  return path === root || path === `${root}index.html`;
};

/** Same-origin assets/ URLs referenced by src= / href= in the shell HTML. */
function shellAssets(html) {
  const out = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = new URL(m[1], scoped('./'));
    if (url.origin === self.location.origin && isAsset(url.href)) out.add(url.href);
  }
  return [...out];
}

/**
 * Store a fresh shell: its assets first, then the HTML, so the cached shell
 * never points at a file that is not cached. Assets of older deploys go.
 * The HTML is stored as a new Response, so a redirect that led to it can
 * never be replayed to a navigation (browsers reject redirected responses there).
 */
async function storeShell(response) {
  const cache = await caches.open(CACHE);
  const html = await response.text();
  const urls = shellAssets(html);
  await Promise.all(urls.map(async (u) => (await cache.match(u)) || cache.add(u)));
  await cache.put(scoped('./'), new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const keep = new Set(urls);
  for (const req of await cache.keys()) if (isAsset(req.url) && !keep.has(req.url)) await cache.delete(req);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await fetch(scoped('./'), { cache: 'no-cache' });
      if (shell.ok) await storeShell(shell);
      const cache = await caches.open(CACHE);
      await Promise.all(STATIC.map((p) => cache.add(scoped(p)).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function navigate(event) {
  const network = fetch(event.request);
  // Clone before the page starts reading the body: this reaction is registered first.
  event.waitUntil(
    network
      .then((res) => (res.ok && isShell(event.request.url) ? storeShell(res.clone()) : undefined))
      .catch(() => undefined),
  );
  try {
    return await withTimeout(network, NAV_TIMEOUT_MS);
  } catch {
    const cached = await caches.match(scoped('./'), { cacheName: CACHE });
    // Nothing cached yet: keep waiting for the network (or show the browser's offline page).
    return cached || network;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(navigate(event));
  } else if (isAsset(req.url)) {
    event.respondWith(cacheFirst(req));
  } else {
    const network = fetch(req);
    event.waitUntil(
      network
        .then((res) => {
          if (!res.ok) return undefined;
          const copy = res.clone();
          return caches.open(CACHE).then((cache) => cache.put(req, copy));
        })
        .catch(() => undefined),
    );
    event.respondWith(caches.match(req, { cacheName: CACHE }).then((hit) => hit || network));
  }
});
