// 小小理財島 PWA：本機儲存。
// 三層備份：localStorage（主）→ IndexedDB 快照（誤刪救命索）→ GitHub Gist（換手機）。
// 快照與雲端的排程從 ../stamps/index.html 1037–1082、1363–1418 行搬過來，註解保留。

import { taipeiDate, uuid, nowIso } from "./util.js";
import { coerceLedger } from "./state.js";
import { showStatus, setSaveErrorProvider } from "./ui/common.js";

export const KEY = "money-island.v1";
/* 讀不出來的帳本只另存這一份（以前每開一次 app 就多一份 .broken.<時間>，反而把容量吃光） */
const BROKEN_KEY = KEY + ".broken";

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

/* 上一次 load() 讀不出來的原因；app.js 的「讀不出來」畫面拿來顯示，store.js 換帳本前靠它決定要不要先留存原始內容 */
let loadProblem = "";
export function loadError() { return loadProblem; }

export function load() {
  loadProblem = "";
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) {}
  if (!raw) return null;
  try {
    return coerceLedger(JSON.parse(raw));
  } catch (e) {
    /* 讀不懂就先把原始內容另存一份再退回空白，
       不然之後的第一次 save() 會把使用者幾個月的紀錄直接蓋掉。
       這時候不吐司：開機畫面本身就是「讀不出來」的說明與出路。 */
    markBroken(e instanceof SyntaxError ? "內容不是完整的帳本格式"
      : e && e.message ? String(e.message).replace(/^備份檔內容不正確：/, "") : "內容不是帳本");
    return null;
  }
}

/* 開機時 load() 過了、但放進 store 才炸（例如欄位型別怪到排序都排不動）：一樣當成讀不出來 */
export function markBroken(message) {
  loadProblem = String(message || "內容不是帳本");
  preserveBrokenLedger();
}

export function hasBrokenLedger() { return Boolean(loadProblem) && hasState(); }

/* 把目前 localStorage 裡那份（讀不出來的）原始內容留存到 BROKEN_KEY。
   已經是同一份就不重寫；回傳 true＝確定留存好了（或根本沒有東西要留）。 */
export function preserveBrokenLedger() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) { return false; }
  if (raw === null) return true;
  try {
    if (localStorage.getItem(BROKEN_KEY) === raw) return true;
    localStorage.setItem(BROKEN_KEY, raw);
    return localStorage.getItem(BROKEN_KEY) === raw;
  } catch (e) {
    return false;
  }
}

/* 另一個分頁（或另一個視窗）改了帳本：瀏覽器只會對「其他」分頁發 storage 事件。
   key 是 null 表示整個 localStorage 被清掉，也要重讀。 */
export function watchExternalChanges(onChange) {
  addEventListener("storage", (event) => {
    if (event.key !== KEY && event.key !== null) return;
    try { if (event.storageArea && event.storageArea !== localStorage) return; } catch (e) {}
    onChange(event);
  });
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
    loadProblem = "";        /* 已經換成一份讀得懂的帳本了 */
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

/* 「還原前」快照：換掉整份帳本（還原備份檔、雲端拿回、還原本機快照）之前先存的那一份。
   清理時固定留最近 3 份，不會被一般快照擠掉。 */
export const PRE_RESTORE = "pre-restore";
const KEEP_PRE_RESTORE = 3;
let lastSnapTs = 0;

/* 回傳 true 只代表「這一份確定寫進 IndexedDB 了」（交易 complete）；開不了資料庫、寫入失敗都回 false。
   內容在呼叫當下就先序列化：等資料庫打開的那幾毫秒裡帳本若被換掉，存的仍是呼叫當時那一份。 */
export async function takeSnapshot(state, reason, options = {}) {
  const raw = JSON.stringify(state);
  const db = await openDB();
  if (!db) return false;
  /* ts 是主鍵：同一毫秒存兩份會互相蓋掉，所以保證遞增 */
  const now = Math.max(Date.now(), lastSnapTs + 1);
  lastSnapTs = now;
  const rec = {
    ts: now,
    day: taipeiDate(),
    raw,
    reason: reason || "",
    familyName: state.family && state.family.name ? state.family.name : "",
    profiles: (state.profiles || []).length,
    activities: (state.activities || []).length,
  };
  if (options.preRestore) rec.kind = PRE_RESTORE;
  const written = await new Promise(res => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => res(true); tx.onerror = () => res(false); tx.onabort = () => res(false);
    } catch (e) { res(false); }
  });
  if (!written) return false;
  try { await pruneSnapshots(db); } catch (e) {}
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
// 讀不到就丟錯，呼叫端才不會在什麼都沒換的情況下說「已還原」。
export async function restoreSnapshot(ts) {
  const db = await openDB();
  if (!db) throw new Error("這台裝置現在讀不到本機快照，請稍後再試");
  const rec = await new Promise(res => {
    try {
      const q = db.transaction(STORE).objectStore(STORE).get(Number(ts));
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    } catch (e) { res(null); }
  });
  if (!rec || !rec.raw) throw new Error("找不到這份快照，可能已經被清掉了");
  try { return coerceLedger(JSON.parse(rec.raw)); } catch (e) { throw new Error("這份快照讀不出來"); }
}

async function pruneSnapshots(db) {
  const all = await listSnapshots();
  if (all.length <= 20) return;
  const keep = new Set(all.slice(0, 20).map(r => r.ts));      /* 最近 20 份一定留著 */
  all.filter(r => r.kind === PRE_RESTORE).slice(0, KEEP_PRE_RESTORE).forEach(r => keep.add(r.ts));   /* 最近 3 份「還原前」也一定留著 */
  const seenDay = new Set(); const cutoff = Date.now() - 60 * 864e5;
  for (const r of all) {
    if (keep.has(r.ts)) { seenDay.add(r.day); continue; }
    if (r.ts >= cutoff && !seenDay.has(r.day)) { seenDay.add(r.day); keep.add(r.ts); }   /* 每天再留最新的一份 */
  }
  const drop = all.filter(r => !keep.has(r.ts)).map(r => r.ts);
  if (!drop.length) return;
  await new Promise(res => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const os = tx.objectStore(STORE);
      drop.forEach(ts => os.delete(ts));
      tx.oncomplete = res; tx.onerror = res; tx.onabort = res;
    } catch (e) { res(); }
  });
}

/* 頁首常駐的「還沒存好」標記（common.appShell）讀這個；common 不能反過來 import db */
setSaveErrorProvider(saveError);
