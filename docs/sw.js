/* 小小理財島 — Service Worker
   只做一件事：加到主畫面之後，沒有網路也打得開。
   策略是「先給快取、背景更新」：開啟永遠是瞬間的；新版抓到以後會通知頁面，
   頁面自己跳「有新版本」的提示，點一下就換。
   帳本資料都在 localStorage 與 IndexedDB，不經過這裡。 */
'use strict';

const VERSION = 'v1';
const PREFIX = 'money-island-';
const CACHE = `${PREFIX}${VERSION}`;
/* 核心：缺一個就不准啟用新版——網路不穩時，寧可繼續用完整的舊版，
   也不要拿殘缺的新版把它換掉（activate 會刪舊快取，換錯就回不去了）。
   ↓ js/ 底下每一支模組都要列進來；之後新增檔案記得補這份清單 */
const CORE = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/util.js',
  './js/db.js',
  './js/state.js',
  './js/pin.js',
  './js/store.js',
  './js/quotes.js',
  './js/backup.js',
  './js/gist.js',
  './js/ui/common.js',
  './js/ui/home.js',
  './js/ui/dreams.js',
  './js/ui/history.js',
  './js/ui/parent.js',
  './js/ui/setup.js'
];
/* 加分：抓不到也沒關係，之後上線時會自己補 */
const EXTRA = [
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.ico'
];
/* 導覽請求一律對應到這一把鑰匙，不管網址後面帶了什麼參數，頁面永遠只有一份 */
const SHELL_KEY = './index.html';

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);                       /* 失敗就讓 install 整個失敗，保住舊版 */
    await Promise.all(EXTRA.map(u => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    /* 只清自己的舊版本。caches.keys() 是整個網域共用的，
       如果照著「不是我就刪」寫，同一個網域下的其他 app 離線快取會被一起清掉。 */
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  /* 只管自己這個資料夾底下的東西；同網域的其他 app 不碰 */
  const base = new URL('./', self.registration.scope).pathname;
  if (!url.pathname.startsWith(base)) return;

  const isShellNav = req.mode === 'navigate'
    && (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'));
  const key = isShellNav ? SHELL_KEY : req;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key) || (isShellNav ? await cache.match('./') : null);
    const fresh = fetch(req).then(async res => {
      if (!res || !res.ok || res.type !== 'basic') return res;
      if (isShellNav) {
        const old = await cache.match(key);
        await cache.put(key, res.clone());
        if (old && changed(old, res)) notifyClients();
      } else {
        cache.put(key, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => null);

    if (cached) { try { e.waitUntil(fresh); } catch (err) {} return cached; }

    const res = await fresh;
    if (res) return res;

    if (isShellNav) {
      const shell = await cache.match(SHELL_KEY) || await cache.match('./');
      if (shell) return shell;
    }
    return new Response('離線中，而且這個檔案還沒有被快取。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
  })());
});

/* 比對是不是同一份檔案：先看 ETag，其次 Last-Modified，最後看長度 */
function changed(a, b) {
  const tag = r => r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length') || '';
  const x = tag(a), y = tag(b);
  return !!x && !!y && x !== y;
}
function notifyClients() {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(list => list.forEach(c => c.postMessage({ type: 'shell-updated' })))
    .catch(() => {});
}

self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });
