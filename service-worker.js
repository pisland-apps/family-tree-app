// 家谱 · 家族树 —— Service Worker
// 负责：
// 1. 首次访问时把应用外壳（HTML/manifest/图标/世界地图 SVG）缓存起来，之后离线也能打开。
//    世界地图 SVG 现在是随应用打包的本地资源（assets/world-map.svg），
//    不再从 CDN 拉取，因此不需要额外的完整性校验。
// 2. 跨域资源（目前只有 cdnjs 上的 JSZip）完全不拦截，交给浏览器按页面自己的
//    CSP（script-src）正常请求——不能在这里改成"本 Service Worker 自己
//    fetch() 再转发"，因为 Service Worker 自身的 fetch() 要遵守的是
//    service-worker.js 这个脚本自己的响应头里那份 CSP（connect-src），
//    而不是页面的 script-src；两者不是一回事，之前就是因为这里拦截了
//    JSZip 的请求、自己在 Service Worker 里重新 fetch()，结果被
//    connect-src 'self' 挡掉，导致 JSZip 加载失败、导入导出报错
//    "JSZip is not defined"。
// 注意：IndexedDB（用来存照片）不归 Service Worker 管，浏览器会自己持久化，
// 不需要在这里做任何处理。

const CACHE_VERSION = 'family-tree-v7.4'; // bump alongside APP_VERSION in app.js on every deploy
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
  if (!isSameOrigin) {
    // External CDN resources (currently just JSZip from cdnjs.cloudflare.com):
    // deliberately NOT intercepted. A worker's own fetch() calls are subject
    // to whatever Content-Security-Policy was delivered on the worker
    // script's *own* HTTP response (this is real behavior, not a browser
    // quirk — see MDN's CSP docs) — and our _headers file applies the same
    // strict CSP (connect-src 'self') to every path, service-worker.js
    // included. Re-fetching a cross-origin URL from inside this handler was
    // therefore silently blocked, JSZip never loaded, and both export and
    // import broke with "JSZip is not defined". Not calling respondWith()
    // here lets the browser fetch it directly instead, which is governed by
    // the *page's* CSP (script-src, which does allow cdnjs) rather than the
    // worker's. The trade-off is this resource is no longer explicitly
    // cached for offline use — acceptable, since the browser's normal HTTP
    // cache already keeps a version-pinned CDN URL like this one for a long
    // time regardless.
    return;
  }

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
});
