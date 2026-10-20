// Offline support for the static build: hand-written, no dependencies, no
// build step (Vite copies public/ verbatim). The field has no network, so a
// page opened online once must open again without one.
//
// - Two pages, two shells: the Modbus tool at ./ and the Bluetooth status
//   page at ./ble/. One worker at the site root serves both.
// - Install caches each shell: its HTML plus the hashed assets it references,
//   found by reading that HTML. That matters because the very first visit
//   loads its JS/CSS before this worker controls the page.
// - Navigations: network first, so a new deploy shows up whenever there is a
//   network; after NAV_TIMEOUT_MS or offline, the cached shell of that page.
// - Hashed assets/ files: cache first (the name changes with the content).
// - Other same-origin GETs (manifest, icons): stale-while-revalidate.
//
// Every URL is resolved against the registration scope, so the site works
// under any GitHub Pages repo path (vite.config.ts uses base './').
// Bump VERSION when the caching logic here changes: activate drops the
// caches of every other version.

const VERSION = 'v2';
const PREFIX = 'hx-web-tool-';
const CACHE = PREFIX + VERSION;
const NAV_TIMEOUT_MS = 4000;
const STATIC = ['manifest.webmanifest', 'ble/manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
// Shell paths relative to the scope. The BLE page first: its prefix is the more specific.
const SHELLS = ['ble/', './'];

const scoped = (path) => new URL(path, self.registration.scope).href;
const isAsset = (url) => new URL(url).pathname.startsWith(new URL(scoped('assets/')).pathname);
/** The shell a URL is the page of: exactly its path or its index.html, else null. */
const shellOf = (url) => {
  const path = new URL(url).pathname;
  for (const shell of SHELLS) {
    const base = new URL(scoped(shell)).pathname;
    if (path === base || path === `${base}index.html`) return shell;
  }
  return null;
};
/** The shell to fall back to offline: the BLE page for anything under ble/, else the tool. */
const fallbackShellOf = (url) => {
  const path = new URL(url).pathname;
  return path.startsWith(new URL(scoped('ble')).pathname) ? 'ble/' : './';
};

/** Same-origin assets/ URLs referenced by src= / href= in a shell's HTML (relative to that shell). */
function shellAssets(html, shell) {
  const out = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = new URL(m[1], scoped(shell));
    if (url.origin === self.location.origin && isAsset(url.href)) out.add(url.href);
  }
  return [...out];
}

/**
 * Store a fresh shell: its assets first, then the HTML, so a cached shell
 * never points at a file that is not cached. Then drop assets no cached shell
 * references any more (the two pages share chunks, so one page's deploy must
 * not prune what the other still uses).
 * The HTML is stored as a new Response, so a redirect that led to it can
 * never be replayed to a navigation (browsers reject redirected responses there).
 */
async function storeShell(response, shell) {
  const cache = await caches.open(CACHE);
  const html = await response.text();
  const urls = shellAssets(html, shell);
  await Promise.all(urls.map(async (u) => (await cache.match(u)) || cache.add(u)));
  await cache.put(scoped(shell), new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const keep = new Set();
  for (const s of SHELLS) {
    const cached = await cache.match(scoped(s));
    if (cached) for (const u of shellAssets(await cached.text(), s)) keep.add(u);
  }
  for (const req of await cache.keys()) if (isAsset(req.url) && !keep.has(req.url)) await cache.delete(req);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      for (const shell of SHELLS) {
        const res = await fetch(scoped(shell), { cache: 'no-cache' }).catch(() => null);
        if (res && res.ok) await storeShell(res, shell);
      }
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
  const shell = shellOf(event.request.url);
  event.waitUntil(
    network
      .then((res) => (res.ok && shell ? storeShell(res.clone(), shell) : undefined))
      .catch(() => undefined),
  );
  try {
    return await withTimeout(network, NAV_TIMEOUT_MS);
  } catch {
    const cached = await caches.match(scoped(fallbackShellOf(event.request.url)), { cacheName: CACHE });
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
