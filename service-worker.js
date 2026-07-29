// 家谱 · 家族树 —— Service Worker
// 负责：
// 1. 首次访问时把应用外壳（HTML/manifest/图标）缓存起来，之后离线也能打开。
// 2. 运行时用到的外部资源（JSZip、世界地图 SVG、字体等）采用"网络优先，
//    失败退回缓存"的策略——有网时总是拿最新的，没网时如果之前成功加载过，
//    还能从缓存里读到。
// 注意：IndexedDB（用来存照片）不归 Service Worker 管，浏览器会自己持久化，
// 不需要在这里做任何处理。

const CACHE_VERSION = 'family-tree-v3';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
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

  const isSameOrigin = new URL(req.url).origin === self.location.origin;

  if (isSameOrigin) {
    // App shell: cache-first, fall back to network, then to index.html if all else fails
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
            return res;
          })
          .catch(() => caches.match('./index.html'));
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
