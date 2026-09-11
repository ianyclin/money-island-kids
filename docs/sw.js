/* 小小理財島 — Service Worker
   只做一件事：加到主畫面之後，沒有網路也打得開。
   策略是「整組版本快取」：安裝時把 CORE 全部抓齊放進 money-island-<VERSION>，
   之後每個檔案都從這一組拿，不逐檔背景更新。
   為什麼不逐檔更新：app 拆成十幾支 ES module，逐檔 stale-while-revalidate 會讓
   「新的 index.html 配舊的 store.js」這種混版出現，不如整組一起換。
   要出新版：改下面的 VERSION（改了程式一定要改），瀏覽器抓到新的 sw.js 就會重新抓整組，
   啟用後通知頁面跳「有新版本」，點一下重新載入就是新版。
   帳本資料都在 localStorage 與 IndexedDB，不經過這裡。 */
'use strict';

const VERSION = 'v6';
const PREFIX = 'money-island-';
const CACHE = `${PREFIX}${VERSION}`;
/* 核心：缺一個就不准啟用新版——網路不穩時，寧可繼續用完整的舊版，
   也不要拿殘缺的新版把它換掉（activate 會刪舊快取，換錯就回不去了）。
   ↓ js/ 底下每一支模組都要列進來；之後新增檔案記得補這份清單 */
const CORE = [
  './',
  './index.html',
  './app.css',
  './css/home.css',
  './css/growth.css',
  './css/dreams.css',
  './css/history.css',
  './css/more.css',
  './css/parent.css',
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
  './js/ui/growth.js',
  './js/ui/dreams.js',
  './js/ui/more.js',
  './js/ui/history.js',
  './js/ui/parent.js',
  './js/ui/parent-investments.js',
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

/* cache:'reload' 是關鍵：略過瀏覽器自己的 HTTP 快取直接問伺服器，
   不然 GitHub Pages 那 10 分鐘的 max-age 會讓新版 sw.js 抓到一組舊模組 */
const freshRequest = (u) => new Request(u, { cache: 'reload' });

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE.map(freshRequest));      /* 失敗就讓 install 整個失敗，保住舊版 */
    await Promise.all(EXTRA.map(u => cache.add(freshRequest(u)).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    /* 只清自己的舊版本。caches.keys() 是整個網域共用的，
       如果照著「不是我就刪」寫，同一個網域下的其他 app 離線快取會被一起清掉。 */
    const keys = await caches.keys();
    const stale = keys.filter(k => k.startsWith(PREFIX) && k !== CACHE);
    await Promise.all(stale.map(k => caches.delete(k)));
    await self.clients.claim();
    /* 有舊版被換掉＝這是一次升級，不是第一次安裝：叫頁面跳「有新版本」 */
    if (stale.length) notifyClients();
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
  /* dev/ 底下的自我測試不走快取，改了立刻看得到 */
  if (url.pathname.startsWith(base + 'dev/')) return;

  const isShellNav = req.mode === 'navigate'
    && (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'));
  const key = isShellNav ? SHELL_KEY : new URL(url.pathname, url.origin).href;   /* 去掉 ?query，模組只有一份 */

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key) || (isShellNav ? await cache.match('./') : null);
    if (cached) return cached;

    /* 不在這一版的清單裡（例如新加的圖）：問網路，成功就順手收進來 */
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') cache.put(key, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      if (isShellNav) {
        const shell = await cache.match(SHELL_KEY) || await cache.match('./');
        if (shell) return shell;
      }
      return new Response('離線中，而且這個檔案還沒有被快取。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }
      });
    }
  })());
});

function notifyClients() {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(list => list.forEach(c => c.postMessage({ type: 'shell-updated' })))
    .catch(() => {});
}

self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });
