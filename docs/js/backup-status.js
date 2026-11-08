// 小小理財島 PWA：備份狀態與裝置提醒（稽核批 3「備份可靠性」）。
// 判斷規則都寫成純函式（selftest 直接測），執行期只有三件事：
//   1. 開機跟瀏覽器要「長期保存」（navigator.storage.persist），記下結果給家長區備份卡片顯示；
//   2. 偵測私密瀏覽（localStorage／IndexedDB 寫不進去，或 storage.estimate 的容量小得不像一般模式）；
//   3. Safari 分頁警告的「我知道了，仍要在這裡用」記在 sessionStorage，只對這次有效。
// 結果是非同步回來的：到了之後直接改畫面上帶 data-persist-line／data-private-warning 的節點，不整頁重繪。

import { taipeiDate } from "./util.js";

// ---------- 上次備份 ----------
// 兩種備份取較新的那一個：存到手機（帳本 meta.lastFileBackupAt）與 GitHub 自動備份（雲端設定的 lastSyncAt）。
// 呼叫端傳的雲端時間一律先過 cloudBackupTime（雲端不正常時不算），不要直接傳 lastSyncAt。
export const BACKUP_KIND_LABEL = { file: "存到手機", cloud: "GitHub 自動備份" };

function validTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

// 批 3 驗收 C：GitHub 的「上次同步」只在雲端正常時才算這份帳本的備份時間。
// 下面幾種狀態裡，lastSyncAt 記的是另一份帳本、或已經不在雲端的那一份，一律不算（回 null）：
//   pending（凍結：等家長決定、備份不見了、還沒比對完都會落這個旗標）、card 有值（三張卡任一張掛著）、
//   swapSearch（換帳本後還沒成功上傳過）、lastSyncAt 不晚於 swapAt（換帳本那一刻；之後成功上傳一次才又算數）。
// 一般的同步錯誤（連不上、限制次數、金鑰失效）照算：那次同步確實發生過、雲端那份也還在。
// 「從雲端拿回」武裝的那 5 秒（pullFreeze）不算凍結：那只是畫面上的確認期，雲端那份沒有變。
// info＝gist.cloudInfo() 的樣子：{ on, lastSyncAt, pending, card, swapSearch, swapAt }
export function cloudBackupTime(info) {
  if (!info || !info.on) return null;
  const synced = validTime(info.lastSyncAt);
  if (synced === null) return null;
  if (info.pending || info.card || info.swapSearch) return null;
  const swapped = validTime(info.swapAt);
  if (swapped !== null && synced <= swapped) return null;
  return info.lastSyncAt;
}

export function lastBackupOf(state, cloudLastSyncAt) {
  const file = validTime(state && state.meta ? state.meta.lastFileBackupAt : null);
  const cloud = validTime(cloudLastSyncAt);
  if (file === null && cloud === null) return null;
  if (cloud !== null && (file === null || cloud > file)) return { at: new Date(cloud).toISOString(), kind: "cloud" };
  return { at: new Date(file).toISOString(), kind: "file" };
}

// 台北時間的日曆日差：今天＝0、昨天＝1（跟頁面上其他日期一樣以台北時間計）
export function daysSince(iso, now = new Date()) {
  const time = validTime(iso);
  if (time === null) return null;
  const from = Date.parse(`${taipeiDate(new Date(time))}T00:00:00Z`);
  const to = Date.parse(`${taipeiDate(now)}T00:00:00Z`);
  return Math.max(0, Math.round((to - from) / 86400000));
}

export function daysText(days) {
  return days === 0 ? "今天" : `${days} 天前`;
}

// 備份卡片的大字：「上次備份：N 天前」／「今天」／「還沒備份過」
export function lastBackupText(info, now = new Date()) {
  if (!info) return "還沒備份過";
  return daysText(daysSince(info.at, now));
}

// ---------- 備份提醒 ----------
// 「新紀錄」只看 activities（零用錢、花費、存錢這些紀錄）的 createdAt：
// 不看 meta.rev／meta.updatedAt——記下備份時間本身、關掉安裝提示也都是一次存檔，會讓它們永遠比備份時間新。
export const REMIND_AFTER_DAYS = 7;
export const REMIND_MIN_RECORDS = 3;

export function latestRecordAt(state) {
  let latest = null;
  for (const activity of (state && Array.isArray(state.activities) ? state.activities : [])) {
    const time = validTime(activity && activity.createdAt);
    if (time !== null && (latest === null || time > latest)) latest = time;
  }
  return latest;
}

// 回傳 null＝不用提醒；否則 { days, text }（days＝null 表示從沒備份過）
export function backupReminder(state, cloudLastSyncAt, now = new Date()) {
  if (!state || !Array.isArray(state.activities)) return null;
  const info = lastBackupOf(state, cloudLastSyncAt);
  if (!info) {
    return state.activities.length >= REMIND_MIN_RECORDS ? { days: null, text: "該備份了（還沒備份過）" } : null;
  }
  const days = daysSince(info.at, now);
  if (days === null || days <= REMIND_AFTER_DAYS) return null;
  const latest = latestRecordAt(state);
  if (latest === null || latest <= new Date(info.at).getTime()) return null;
  return { days, text: `該備份了（上次 ${days} 天前）` };
}

// 首頁提醒列點下去：先到家長區（沒解鎖就輸入操作碼），解鎖後回到備份卡片（parent.js returnTargetOf 認得這個目標）
export const BACKUP_TARGET = "#/parent?open=backup";
export const BACKUP_REMINDER_HREF = `#/parent?return=${encodeURIComponent(BACKUP_TARGET)}`;

// ---------- 主畫面 app 還是瀏覽器分頁 ----------
// env：{ standalone, displayModeStandalone, userAgent, platform, maxTouchPoints }
export function isStandaloneEnv(env) {
  return Boolean(env) && (env.standalone === true || env.displayModeStandalone === true);
}

export function isIosEnv(env) {
  if (!env) return false;
  return /iPhone|iPad|iPod/.test(String(env.userAgent || ""))
    || (env.platform === "MacIntel" && Number(env.maxTouchPoints) > 1);
}

// 只對 iOS／iPadOS：那裡主畫面 app 與 Safari 分頁各存各的。Android 的 Chrome 分頁與安裝的 app 共用資料，
// 講「不相通」反而是錯的；桌機瀏覽器不顯示。
export function needsTabWarning(env) {
  return isIosEnv(env) && !isStandaloneEnv(env);
}

export const TAB_WARNING_TEXT = "Safari 分頁和主畫面 app 的資料不相通。請先加到主畫面再開始：分享鈕 → 加入主畫面，之後從主畫面圖示打開。";
export const TAB_WARNING_DISMISS = "我知道了，仍要在這裡用";
export const TAB_LEDGER_NOTE = "你現在是在 Safari 分頁裡用：Safari 分頁和主畫面 app 的資料不相通，這份帳本只在這個分頁裡。";

export function currentEnv() {
  let displayModeStandalone = false;
  try { displayModeStandalone = Boolean(globalThis.matchMedia && globalThis.matchMedia("(display-mode: standalone)").matches); } catch (e) {}
  const nav = globalThis.navigator || {};
  return {
    standalone: nav.standalone,
    displayModeStandalone,
    userAgent: nav.userAgent || "",
    platform: nav.platform || "",
    maxTouchPoints: nav.maxTouchPoints || 0,
  };
}

const TAB_OK_KEY = "money-island.v1.tab-warning-ok";
export function tabWarningDismissed() {
  try { return globalThis.sessionStorage.getItem(TAB_OK_KEY) === "1"; } catch (e) { return false; }
}
export function dismissTabWarning() {
  try { globalThis.sessionStorage.setItem(TAB_OK_KEY, "1"); } catch (e) {}
}
export function showTabWarning(env = currentEnv()) {
  return needsTabWarning(env) && !tabWarningDismissed();
}

// ---------- 長期保存 ----------
// 結果："granted"｜"denied"｜"unsupported"；null＝還在問
export function persistText(result) {
  if (result === "granted") return "這台裝置已允許長期保存";
  if (result === "denied" || result === "unsupported") return "瀏覽器沒有答應長期保存，更要記得備份";
  return "";
}

let persistResult = null;
export function persistStatus() { return persistResult; }

function paintPersist() {
  if (typeof document === "undefined") return;
  const text = persistText(persistResult);
  document.querySelectorAll("[data-persist-line]").forEach((node) => {
    node.textContent = text;
    node.hidden = !text;
  });
}

// 開機呼叫一次：已經允許就不再要；要不到的話，第一次觸控再要一次（有些瀏覽器要使用者動過才會答應）
export async function requestPersist() {
  const storage = globalThis.navigator && globalThis.navigator.storage;
  if (!storage || typeof storage.persist !== "function") { persistResult = "unsupported"; paintPersist(); return persistResult; }
  try {
    const already = typeof storage.persisted === "function" ? await storage.persisted() : false;
    persistResult = already || await storage.persist() ? "granted" : "denied";
  } catch (e) {
    persistResult = "denied";
  }
  paintPersist();
  if (persistResult === "denied" && typeof addEventListener === "function") {
    addEventListener("pointerdown", () => {
      storage.persist().then((granted) => { if (granted) { persistResult = "granted"; paintPersist(); } }).catch(() => {});
    }, { once: true });
  }
  return persistResult;
}

// ---------- 私密瀏覽 ----------
export const PRIVATE_WARNING_TEXT = "私密瀏覽關掉就會清空，請改用一般模式";
// 一般模式的配額通常是好幾 GB；私密／無痕模式常常只有一百多 MB 以下。門檻是經驗值，不是規格。
// 配額這條判斷是盡力而為，真機未驗（各瀏覽器、各版本的私密模式配額不同；磁碟快滿的一般模式也可能被誤判）。
export const PRIVATE_QUOTA_BYTES = 120 * 1024 * 1024;

export function looksPrivate({ localStorageOk, indexedDbOk, quota } = {}) {
  if (localStorageOk === false || indexedDbOk === false) return true;
  return typeof quota === "number" && quota > 0 && quota < PRIVATE_QUOTA_BYTES;
}

function probeLocalStorage() {
  const key = "money-island.v1.probe";
  try {
    globalThis.localStorage.setItem(key, "1");
    globalThis.localStorage.removeItem(key);
    return true;
  } catch (e) {
    return false;
  }
}

function probeIndexedDb() {
  return new Promise((resolve) => {
    let done = false;
    let idb = null;
    // 批 3 驗收小項 5：測完把探測用的資料庫刪掉，不在使用者的瀏覽器裡留一個沒用的「money-island-probe」。
    // 連線要先關（成功路徑在 finish 之前就 close 了）；逾時那條路連線若之後才打開，刪除會等到它關掉，不會出錯。
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
      try { if (idb && typeof idb.deleteDatabase === "function") idb.deleteDatabase("money-island-probe"); } catch (e) {}
    };
    try {
      idb = globalThis.indexedDB;
      if (!idb) { finish(false); return; }
      const request = idb.open("money-island-probe", 1);
      request.onerror = () => finish(false);
      request.onblocked = () => finish(true);
      request.onupgradeneeded = () => {
        try { if (!request.result.objectStoreNames.contains("p")) request.result.createObjectStore("p"); } catch (e) { finish(false); }
      };
      request.onsuccess = () => {
        try {
          const db = request.result;
          const tx = db.transaction("p", "readwrite");
          tx.objectStore("p").put(1, "probe");
          tx.oncomplete = () => { try { db.close(); } catch (e) {} finish(true); };
          tx.onerror = () => { try { db.close(); } catch (e) {} finish(false); };
          tx.onabort = () => { try { db.close(); } catch (e) {} finish(false); };
        } catch (e) { finish(false); }
      };
      setTimeout(() => finish(true), 3000);   // 一直沒有回音的話不當成私密模式（寧可漏報，不要誤報）
    } catch (e) {
      finish(false);
    }
  });
}

let privateResult = null;   // null＝還沒測、true／false
export function privateModeStatus() { return privateResult; }

function paintPrivate() {
  if (typeof document === "undefined") return;
  document.querySelectorAll("[data-private-warning]").forEach((node) => { node.hidden = privateResult !== true; });
}

export async function detectPrivateMode() {
  const localStorageOk = probeLocalStorage();
  const indexedDbOk = await probeIndexedDb();
  let quota = null;
  try {
    const storage = globalThis.navigator && globalThis.navigator.storage;
    if (storage && typeof storage.estimate === "function") {
      const estimate = await storage.estimate();
      quota = estimate && typeof estimate.quota === "number" ? estimate.quota : null;
    }
  } catch (e) {}
  privateResult = looksPrivate({ localStorageOk, indexedDbOk, quota });
  paintPrivate();
  return privateResult;
}
