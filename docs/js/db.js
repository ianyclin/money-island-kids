// 小小理財島 PWA：本機儲存。
// 三層備份：localStorage（主）→ IndexedDB 快照（誤刪救命索）→ GitHub Gist（換手機）。
// 快照與雲端的排程從 ../stamps/index.html 1037–1082、1363–1418 行搬過來，註解保留。

import { taipeiDate, uuid, nowIso } from "./util.js";
import { showStatus } from "./ui/common.js";

export const KEY = "money-island.v1";

/* 雲端那一層由 gist.js 自己掛進來（gist.js 會 import store.js，store.js 會 import db.js；
   db.js 反過來 import gist.js 就成了循環相依）。沒掛就是沒開雲端備份。 */
let cloudBridge = null;
export function setCloudBridge(bridge) { cloudBridge = bridge; }
function cloudStatus() {
  try { return cloudBridge && cloudBridge.status ? cloudBridge.status() : null; } catch (e) { return null; }
}
function scheduleCloudSync() {
  try { if (cloudBridge && cloudBridge.schedule) cloudBridge.schedule(); } catch (e) {}
}

/* 存不進去是最嚴重的狀況：畫面上數字都在、其實一關 app 就沒了。
   所以除了跳一次提示，state.backupHealth 也留一個常駐標記（頂端的儲存狀態會一直寫著），
   不會被下一個 toast 蓋掉。 */
let lastSaveError = "";
export function saveError() { return lastSaveError; }

const SIZE_WARN_BYTES = 3.5 * 1024 * 1024;
let sizeWarned = false;

export function hasState() {
  try { return localStorage.getItem(KEY) !== null; } catch (e) { return false; }
}

export function load() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) {}
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.profiles)) throw new Error("內容不是帳本");
    return parsed;
  } catch (e) {
    /* 讀不懂就先把原始內容另存一份再退回空白，
       不然啟動時的第一次 save() 會把使用者幾個月的紀錄直接蓋掉 */
    try { localStorage.setItem(KEY + ".broken." + Date.now(), raw); } catch (e2) {}
    setTimeout(() => showStatus("資料讀取失敗，原始內容已另外保留，請先到家長區「資料與備份」下載備份", "error", { ms: 8000 }), 400);
    return null;
  }
}

export function estimateSize(state) {
  try { return JSON.stringify(state).length; } catch (e) { return 0; }
}

export function save(state, reason) {
  /* 快照與雲端不依賴 localStorage，一定要排在 try 外面：
     容量滿的那一刻，正是最需要備份還活著的一刻 */
  scheduleSnapshot(state, reason);
  scheduleCloudSync();

  const cloud = cloudStatus();
  const stamp = nowIso();
  // copyStatus 反映的是「雲端那一份的狀態」：沒開雲端就是這台裝置存好了 = ready。
  const copyStatus = !cloud ? "ready" : cloud === "synced" ? "ready" : cloud === "failed" ? "failed" : "pending";
  state.latestBackup = { id: uuid(), reason: reason || "資料異動", createdAt: stamp, copyStatus };
  state.backupHealth = copyStatus === "failed"
    ? { status: "failed", message: "帳本已儲存在這台裝置，雲端備份稍後重試" }
    : copyStatus === "pending"
      ? { status: "pending" }
      : { status: "ready" };
  if (state.meta) state.meta.updatedAt = stamp;

  let json = "";
  try {
    json = JSON.stringify(state);
  } catch (e) {
    lastSaveError = "帳本內容無法序列化";
    state.backupHealth = { status: "failed", message: lastSaveError };
    showStatus("這一筆存不進去（帳本內容有問題），請先到家長區下載備份", "error", { ms: 8000 });
    return false;
  }

  if (json.length > SIZE_WARN_BYTES && !sizeWarned) {
    sizeWarned = true;
    showStatus("帳本已經很大了（超過 3.5 MB），請到家長區下載一份備份，並考慮清掉太舊的照片", "waiting", { ms: 8000 });
  }

  try {
    localStorage.setItem(KEY, json);
    lastSaveError = "";
    return true;
  } catch (e) {
    lastSaveError = "存不進去（可能容量滿了或在私密瀏覽）";
    state.backupHealth = { status: "failed", message: lastSaveError + "，請先到家長區「資料與備份」下載備份" };
    showStatus("存不進去（可能容量滿了或在私密瀏覽），請先到家長區下載備份", "error", {
      ms: 8000,
      action: "去備份",
      onAction: () => { location.hash = "#/parent"; },
    });
    return false;
  }
}

/* ───────── 自動快照 ─────────
   每次改動後把整份資料另外存一份到 IndexedDB，保留最近 20 份與每天最後一份（60 天）。
   這是「誤刪、誤扣、資料毀損」的救命索 —— 但它跟主資料在同一支手機上，
   手機掉了或把 app 刪掉一樣會沒有，所以家長區還是會催你偶爾匯出一份。 */
const DB_NAME = "money_island", STORE = "snapshots";
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  let settledNull = false;
  dbPromise = new Promise(resolve => {
    try {
      const q = indexedDB.open(DB_NAME, 1);
      q.onupgradeneeded = () => {
        const db = q.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "ts" });
      };
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 3000);
    } catch (e) { resolve(null); }
  }).then(db => {
    /* 開失敗（含逾時）不要把 null 永久快取住：下一次呼叫再試一次 */
    if (!db && !settledNull) { settledNull = true; dbPromise = null; }
    return db;
  });
  return dbPromise;
}

let snapTimer = 0;
function scheduleSnapshot(state, reason) {
  clearTimeout(snapTimer);
  /* 節流：連改五筆只會在最後存一份，不會每按一下就寫一次資料庫 */
  snapTimer = setTimeout(() => { takeSnapshot(state, reason).catch(() => {}); }, 4000);
}

export async function takeSnapshot(state, reason) {
  const db = await openDB();
  if (!db) return false;
  const raw = JSON.stringify(state);
  const now = Date.now();
  const rec = {
    ts: now,
    day: taipeiDate(),
    raw,
    reason: reason || "",
    familyName: state.family && state.family.name ? state.family.name : "",
    profiles: (state.profiles || []).length,
    activities: (state.activities || []).length,
  };
  await new Promise(res => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = res; tx.onerror = res; tx.onabort = res;
    } catch (e) { res(); }
  });
  await pruneSnapshots(db);
  return true;
}

// 由新到舊；每一筆是 { ts, day, raw, familyName, profiles, activities }
export async function listSnapshots() {
  const db = await openDB();
  if (!db) return [];
  return new Promise(res => {
    try {
      const out = [];
      const cur = db.transaction(STORE).objectStore(STORE).openCursor(null, "prev");
      cur.onsuccess = () => { const c = cur.result; if (!c) return res(out); out.push(c.value); c.continue(); };
      cur.onerror = () => res(out);
    } catch (e) { res([]); }
  });
}

// 只把那一份快照的內容讀出來還原成物件；要不要採用由呼叫端（家長區）決定。
export async function restoreSnapshot(ts) {
  const db = await openDB();
  if (!db) return null;
  const rec = await new Promise(res => {
    try {
      const q = db.transaction(STORE).objectStore(STORE).get(Number(ts));
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    } catch (e) { res(null); }
  });
  if (!rec || !rec.raw) return null;
  try { return JSON.parse(rec.raw); } catch (e) { throw new Error("這份快照讀不出來"); }
}

async function pruneSnapshots(db) {
  const all = await listSnapshots();
  if (all.length <= 20) return;
  const keep = new Set(all.slice(0, 20).map(r => r.ts));      /* 最近 20 份一定留著 */
  const seenDay = new Set(); const cutoff = Date.now() - 60 * 864e5;
  for (const r of all) {
    if (keep.has(r.ts)) { seenDay.add(r.day); continue; }
    if (r.ts >= cutoff && !seenDay.has(r.day)) { seenDay.add(r.day); keep.add(r.ts); }   /* 每天再留最新的一份 */
  }
  const drop = all.filter(r => !keep.has(r.ts)).map(r => r.ts);
  if (!drop.length) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    drop.forEach(ts => os.delete(ts));
  } catch (e) {}
}
