// 小小理財島 PWA：這一份程式的版本，與跨版守衛（v18，驗收 45bce23 回報第 3 點）。
//
// BUILD 要跟 sw.js 的 VERSION 一起改（每次升 SW 版本就同步改這裡）。
//
// 為什麼要有這支：sw.js 安裝完就 skipWaiting＋clients.claim，開著的舊版分頁會被新版 SW 接手；
// 之後才延遲載入的頁面模組（home、growth、history、more、parent、parent-investments）是新版，
// 記憶體裡的殼（app.js、common.js、store.js、gist.js、backup.js…）卻是舊版。新版頁面呼叫舊版沒有的函式，
// 就會「…is not a function」畫不出來（例如 v14 分頁升級後解鎖家長區）。v18 起 app.js 自己會偵測新版接管、
// 換頁前整頁重新整理；但 v14 這種更舊的殼沒有那段，只能由新版頁面自己發現。
//
// 做法：app.js 開機時設 window.__APP_BUILD = BUILD（殼的版本）；每支頁面模組在 render／mount 最前面呼叫
// reloadIfShellIsOld()。兩邊不一樣＝舊殼載到新頁面，整頁重新整理一次。
// sessionStorage 記「已經為這個 BUILD 重新整理過」：第二次仍不一樣就照常畫，不再整理，不會無限迴圈。
// 這支不能依賴 common.js 的新匯出（舊殼的 common.js 沒有），所以檢查函式也放在這裡。
//
// 已知限制：瀏覽器的模組表以網址為準。這支一旦被某個殼載入過（v18 以後的 app.js 都會靜態載入它），
// 之後才載入的新版頁面 import 到的仍是記憶體裡那一份舊的 BUILD，兩邊相等，守衛不會觸發——
// v18 以後的升級靠 app.js 的「新版已接管」（controllerchange）整理；這支守衛主要救 v14 這類沒有那段的舊殼。

export const BUILD = "v20";

const RELOADED_KEY = "money-island.build-reloaded";
let reloading = false;

// 純判斷（selftest 用）："same"＝同一版；"reload"＝要整理；"draw"＝已經為這一版整理過一次仍不符，照常畫
export function buildDecision(shellBuild, pageBuild, reloadedFor) {
  if (shellBuild === pageBuild) return "same";
  if (reloadedFor === pageBuild) return "draw";
  return "reload";
}

function sessionStore() {
  try { return globalThis.sessionStorage || null; } catch (e) { return null; }
}

// 回傳 true＝已經在重新整理，呼叫端（render／mount）直接收手。
// options 只給 selftest 換掉 sessionStorage 與 location.reload。
export function reloadIfShellIsOld(options = {}) {
  if (reloading) return true;
  const shellBuild = globalThis.__APP_BUILD;
  const storage = options.storage || sessionStore();
  if (shellBuild === BUILD) return false;
  // 記不下「整理過了」就不整理：寧可畫一次可能出錯的頁面（有「再試一次」），也不要可能停不下來的重新整理
  if (!storage) return false;
  let reloadedFor = null;
  try { reloadedFor = storage.getItem(RELOADED_KEY); } catch (e) { return false; }
  if (buildDecision(shellBuild, BUILD, reloadedFor) !== "reload") return false;
  try {
    storage.setItem(RELOADED_KEY, BUILD);
    if (storage.getItem(RELOADED_KEY) !== BUILD) return false;
  } catch (e) { return false; }
  reloading = true;
  const reload = typeof options.reload === "function" ? options.reload : () => location.reload();
  reload();
  return true;
}

// 只給 selftest：測完把「正在重新整理」的旗標放回去，免得後面的頁面測試全部收手
export function resetBuildGuardForTest() {
  reloading = false;
}
