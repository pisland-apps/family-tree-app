// 家谱 · 家族树 —— Service Worker
// 负责：
// 1. 首次访问时把应用外壳（HTML/manifest/图标/世界地图 SVG）缓存起来，之后离线也能打开。
//    世界地图 SVG 现在是随应用打包的本地资源（assets/world-map.svg），
//    不再从 CDN 拉取，因此不需要额外的完整性校验。
// 2. 运行时仍会用到的外部资源（JSZip、字体等）采用"网络优先，失败退回缓存"
//    的策略——有网时总是拿最新的，没网时如果之前成功加载过，还能从缓存里读到。
// 注意：IndexedDB（用来存照片）不归 Service Worker 管，浏览器会自己持久化，
// 不需要在这里做任何处理。

const CACHE_VERSION = 'family-tree-v7.2'; // bump alongside APP_VERSION in app.js on every deploy
const APP_SHELL = [
  './',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './assets/world-map.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // don't try to cache POST/PUT/etc.

  if (req.mode === 'navigate') {
    // Cloudflare Pages 301/308-redirects /index.html -> / by default, and
    // Chrome will not let a service worker answer a navigation with a
    // redirected Response (net::ERR_FAILED). Rather than caching whatever
    // exact URL the visitor's browser/OS/shortcut happens to navigate to
    // (which is what broke this before — an installed shortcut launching at
    // /index.html), every navigation is served from the single canonical
    // './' cache entry, which Cloudflare serves directly with no redirect.
    event.respondWith(
      caches.match('./').then((cached) => {
        if (cached) return cached;
        return fetch('./')
          .then((res) => {
            if (!res.redirected){
              const clone = res.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put('./', clone));
            }
            return res;
          })
          .catch(() => caches.match('./'));
      })
    );
    return;
  }

  const isSameOrigin = new URL(req.url).origin === self.location.origin;

  if (isSameOrigin) {
    // Non-navigation same-origin requests (app.js, manifest.json, icons,
    // the world map SVG): cache-first, fall back to network. Navigations
    // are already handled above and never reach this branch.
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
            return res;
          })
          .catch(() => caches.match('./'));
      })
    );
  } else {
    // External CDN resources (JSZip, world map SVG, Google Fonts, etc.):
    // network-first so updates are picked up, cached as a fallback for offline use
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
