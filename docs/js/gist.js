// 小小理財島 PWA：雲端自動備份（GitHub Gist）。
// 整段從 ../stamps/index.html 1084–1363 行搬過來，行為一模一樣，只換掉相依：
//   state → store.getState()／store.setState()、normalize → state.js、toast → ui/common.js 的 showStatus、
//   refreshSettings → 由 app.js 掛進來的重繪、resetRuntime → pin.lock() ＋ 關掉開著的 modal。
// 3547–3818 行那段設定頁 UI 的「行為」也在這裡（連線三向分支、拍板、拿回、刪除、中斷），
// 畫面由 ui/parent.js 的「資料與備份」面板呼叫。

import { normalize } from "./state.js";
import * as store from "./store.js";
import * as pin from "./pin.js";
import { setCloudBridge, KEY } from "./db.js";
import { showStatus, closeModal, setCloudStatusProvider } from "./ui/common.js";

/* ───────── 雲端自動備份（GitHub Gist） ─────────
   iPhone 上的網頁 app 進不了 iCloud，這是 Apple 不開放的；
   做得到「自動」的路是傳到使用者自己的 GitHub 私人 Gist：
   設定一次金鑰，之後每次改動 15 秒後自動上傳、切到背景時立刻上傳。
   金鑰與 Gist 編號存在 localStorage 的另一把鑰匙下（不放進 state），
   所以匯出的備份檔與上傳到雲端的內容都不會夾帶金鑰。 */
const GKEY = KEY + ".gist";
const FILE = "money-island-backup.json";
let gist = null;                    /* {token, gistId, lastSyncAt, lastError} */

export function loadGist() { try { gist = JSON.parse(localStorage.getItem(GKEY) || "null"); } catch (e) { gist = null; } }
function saveGist() { try { if (gist) localStorage.setItem(GKEY, JSON.stringify(gist)); else localStorage.removeItem(GKEY); } catch (e) {} }
export const cloudOn = () => !!(gist && gist.token);
let cloudTimer = 0, cloudBusy = false, cloudPending = false;
let pendingCloud = null;      /* 連線時發現兩邊都有資料：等使用者拍板前，凍結所有上傳 */
let pullFreeze = false;       /* 「從雲端拿回」按了第一下、還沒確認：這段期間不准任何上傳 */
let pullTimer = 0;            /* 武裝解除計時器放模組層級：重繪後的舊計時器要能被清掉 */
/* gist.pending＝「還沒決定要用雲端還是本機」的持久旗標：
   跟執行期的 pendingCloud 不同，關掉 app 再開它還在，凍結所有上傳直到使用者決定 */
export const cloudFrozen = () => pullFreeze || pendingCloud || (gist && gist.pending);

/* app.js 在開機時把「整頁重繪」掛進來（設定頁重繪在原本的 stamps 是 refreshSettings） */
let refreshHandler = null;
export function setRefreshHandler(fn) { refreshHandler = fn; }
/* 只在畫面還開著時重繪；正在打字（改名字、貼備份文字）就不動，重繪會把打到一半的東西清掉 */
function refreshSettings() {
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
  if (refreshHandler) try { refreshHandler(); } catch (e) {}
}
/* 換掉整份帳本之前先把執行期狀態收乾淨：家長解鎖不能跨帳本沿用，開著的 modal 也要關掉 */
function resetRuntime() {
  try { pin.lock(); } catch (e) {}
  try { closeModal(); } catch (e) {}
}
function toast(message, opt) {
  opt = opt || {};
  showStatus(message, opt.tone || "waiting", opt);
}
/* 吐司上的「去看」一律帶到家長區的資料與備份面板 */
const goToBackupPanel = () => { location.hash = "#/parent"; };

/* 所有打 GitHub 的請求都掛 20 秒逾時：行動網路卡住時，不能讓同步永遠懸著。
   計時器涵蓋整趟（含讀 body）：不在標頭到手就解除，網路半途斷掉才不會讓 cloudBusy 卡死 */
function gfetch(url, opts) {
  const ac = ("AbortController" in window) ? new AbortController() : null;
  if (ac) setTimeout(() => ac.abort(), 20000);      /* 全部讀完之後才開火的 abort 是無害的空包彈 */
  return fetch(url, Object.assign({}, opts, ac ? { signal: ac.signal } : {}));
}
/* 逾時／斷網的錯誤訊息統一講中文 */
const errMsg = (e, fallback) => (e && e.name === "AbortError") ? "連線逾時（可能網路不穩）"
  : (e && e.message) ? e.message : fallback;
/* 內容指紋：辨認「雲端那份其實是這支手機自己傳的」。
   iOS 切背景會凍結 app——上傳常常成功了，但「成功」的回條沒被記下來，
   下次開 app 比對版本戳就誤判成別台裝置動過，狂跳「要用哪一份」的假警報。 */
const hashStr = s => { let h2 = 5381; for (let i = 0; i < s.length; i++) h2 = ((h2 << 5) + h2 + s.charCodeAt(i)) >>> 0; return s.length + "." + h2.toString(36); };
function sameState(raw) {
  /* 「全等」指的是孩子的紀錄一樣：選到哪個孩子、這台裝置何時存過、提示關掉了沒，
     都是單機才會動的畫面狀態，不該讓紀錄相同的兩份被判成不同 */
  const strip = o => {
    const n = normalize(o);
    if (n.meta) { n.meta.selectedProfileId = ""; n.meta.installHintDismissed = false; n.meta.updatedAt = null; }
    n.latestBackup = null; n.backupHealth = null;
    return JSON.stringify(n);
  };
  try { return strip(JSON.parse(raw)) === strip(JSON.parse(JSON.stringify(store.getState()))); }
  catch (e) { return false; }
}
/* 雲端內容＝自己上傳過的那份（或跟本機一模一樣）→ 默默把帳記對、解凍、照常同步。
   回傳 true 表示已靜默解決，不用出卡片。 */
function adoptIfEcho(r) {
  if (!gist || !r || !r.raw) return false;
  const hh = hashStr(r.raw);
  const byHash = hh === gist.pendingPush || hh === gist.lastPush;
  if (!byHash && !sameState(r.raw)) return false;
  /* 命中之後把 lastPush 對齊成這份內容的指紋：同一份回音若被自動路與手動鈕各比一次，
     第二次才不會因為 pendingPush 已清、lastPush 是更早那份而誤判成別台寫入 */
  gist.remoteStamp = r.stamp || null; gist.pending = false; gist.pendingPush = null; gist.lastPush = hh;
  pendingCloud = null; saveGist(); scheduleCloudSync();
  return byHash ? "push" : "same";   /* 呼叫端靠這個分辨該講哪句話：指紋命中≠內容一模一樣 */
}
/* 發現雲端被別台裝置動過（或舊設定沒有指紋可比）：凍結上傳、把雲端那份讀回來，
   讓家長區的「要用哪一份」拍板卡接手。這裡絕不自動覆蓋任何一邊。 */
async function freezeForConflict(g, pre) {
  g.pending = true;
  if (gist === g) saveGist();
  let r = null;
  try {
    /* pre＝syncCloud 第一支 GET 已經拿回來的檔案內容：直接用，不再打第二支請求——
       第二支請求在飛的那幾百毫秒若 app 被 iOS 回收，pending 已落地卻沒人再比對，
       雲端備份會無聲停擺到使用者自己進家長區為止 */
    r = pre || await fetchCloudContent();
    if (r && r.gone && gist === g) { await freezeForGone(g); return "gone"; }   /* 讀的瞬間被刪掉了：轉「不見了」流程 */
    /* 先驗是不是「自己的回音」：是的話不吵人，把帳記對就走 */
    if (gist === g && adoptIfEcho(r)) {
      refreshSettings();
      return "echo";
    }
    if (gist === g && r && r.raw) pendingCloud = { cloud: normalize(JSON.parse(r.raw)), stamp: r.stamp };
  } catch (e) { r = null; }   /* 讀不到也沒關係：pending 已落地，開 app／回前景會再比對一次，家長區也有「讀取雲端備份來比對」 */
  if (gist !== g) return "aborted";                /* 讀取途中被中斷連線：不留殘骸、不誤導吐司 */
  refreshSettings();
  if (pendingCloud) {
    toast("雲端備份跟這台裝置不同步了——到家長區選要用哪一份", { ms: 5000, action: "去看", onAction: goToBackupPanel });
    return "conflict";
  }
  /* 讀取失敗：只是還沒比對成，不是「不同步」，更沒有要選的——別把家長叫去拍板一張不存在的卡 */
  toast("雲端備份還沒比對完（讀不到雲端內容），稍後會再試一次", { ms: 5000, action: "去看", onAction: goToBackupPanel });
  return "failed";
}
/* pending 已落地、但指紋還在（自己傳過的內容）：開 app／回前景／網路回來時靜默再比對一次。
   是回音就解凍繼續同步，零打擾；不是回音就把雲端那份放進拍板卡，不吐司（每次開 app 吐一次會變嘮叨）；
   讀不到就下次再試。連線流程留下的待決沒有指紋可比，不在這裡處理，交給拍板卡 */
export async function retryEcho() {
  if (!cloudOn() || !gist.pending || !gist.gistId || pendingCloud) return;
  if (!gist.pendingPush && !gist.lastPush) return;
  const g = gist;
  try {
    const r = await fetchCloudContent();
    if (gist !== g || !r || r.gone) return;
    if (adoptIfEcho(r)) { refreshSettings(); return; }
    if (r.raw) { pendingCloud = { cloud: normalize(JSON.parse(r.raw)), stamp: r.stamp }; refreshSettings(); }
  } catch (e) {}
}
/* 雲端那份 gist 不見了（被刪掉或搬走），而這台裝置以前明明同步過：
   不准自動重建——先找找是不是別台裝置剛重建了一份（撿回來比對），
   真的沒有就凍結、讓使用者決定要重傳一份還是中斷。
   自動重建會把「我已經刪掉雲端備份了」的隱私預期打破，多裝置還會各建各的永久分岔 */
async function freezeForGone(g) {
  /* 進場第一件事就凍結：搜尋要翻好幾頁可能很久，這段期間不能讓第二個同步鑽進來
     並行搜尋、或把剛採用好的指紋洗掉 */
  g.pending = true; g.remoteStamp = null;
  if (gist === g) saveGist();
  try {
    const hit = await findCloudBackup(g.token);
    if (hit && gist === g) {
      g.gistId = hit.id; saveGist();
      return freezeForConflict(g);
    }
  } catch (e) {}
  if (gist !== g) return;                          /* 搜尋途中被中斷連線：別留殘骸 */
  g.gistId = null; saveGist();
  refreshSettings();
  toast("雲端那份備份不見了——到家長區決定要重傳一份還是中斷", { ms: 6000, action: "去看", onAction: goToBackupPanel });
}
export function scheduleCloudSync() {
  if (!cloudOn() || cloudFrozen()) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => { syncCloud().catch(() => {}); }, 15000);
}
let lastSyncOutcome = "";     /* 'ok'／'busy'／'frozen'／'error'：「立刻同步」鈕靠它講對話，不再把排隊或回音說成失敗 */
export async function syncCloud(force, _retried) {
  lastSyncOutcome = "frozen";
  if (!cloudOn() || cloudFrozen()) return false;
  if (cloudBusy) { cloudPending = true; lastSyncOutcome = "busy"; return false; }
  cloudBusy = true; lastSyncOutcome = "error";
  const g = gist;          /* 上傳途中被「中斷連線」清掉時，用這個別名安全收尾 */
  let ok = false, retry404 = false, conflict = false, gone = false, pre = null;
  try {
    /* 上次 POST 建檔可能成功了但回條被逾時吞掉（pendingPush 還掛著、gistId 卻是空的）：
       再 POST 會生出第二份孤兒 gist。先找一次帳號裡有沒有那份，找到就掛回去，
       讓下面的指紋比對＋回音判定接手。
       搜尋「連不上」跟「確定沒有」不是同一回事：連不上就讓這趟同步以失敗收場、下次再搜，
       不能照樣 POST——那會多出一份 app 不再認得的 gist，帶著孩子的名字與照片，「刪除雲端備份」刪不到它 */
    if (!g.gistId && g.pendingPush && !force) {
      const orphan = await findCloudBackup(g.token);
      if (orphan) { g.gistId = orphan.id; g.remoteStamp = null; if (gist === g) saveGist(); }
    }
    /* 上傳前先核對雲端指紋：跟上一次寫上去的版本戳（remoteStamp）不一樣，
       表示有另一台裝置動過——一律擋下、進「要用哪一份」拍板流程，連手動按「立刻同步」
       也不例外（覆蓋只走拍板卡上的那顆兩段確認鈕）。舊設定沒有指紋可比的，同樣先比對再說。
       force 只有拍板卡的「用這台裝置的（覆蓋雲端）」與連線時雲端全空的第一次上傳在用。 */
    if (g.gistId && !force) {
      const chk = await gfetch("https://api.github.com/gists/" + g.gistId, {
        headers: { Authorization: "Bearer " + g.token, Accept: "application/vnd.github+json" },
      });
      if (chk.status === 404) {
        /* 以前同步過（有指紋）表示雲端那份確實存在過、現在不見了：不准自動重建，
           交給 freezeForGone 撿回別台重建的那份或讓使用者拍板 */
        if (g.remoteStamp) { gone = true; }
        else { g.gistId = null; g.remoteStamp = null; }
      }
      else if (!chk.ok) throw new Error("GitHub 回應 " + chk.status);
      else {
        const meta = await chk.json();
        if (!g.remoteStamp || (meta.updated_at && meta.updated_at !== g.remoteStamp)) {
          conflict = true;
          /* 這支 GET 已經把檔案內容帶回來了（1 MB 以下不會 truncated）：交給 freezeForConflict 直接比對，
             省掉第二支請求和它的時間窗 */
          const f = meta.files && meta.files[FILE];
          if (f && f.content && !f.truncated) pre = { raw: f.content, stamp: meta.updated_at || null };
        }
      }
    }
    if (conflict || gone) throw { conflict: true };  /* 走 catch 收尾，凍結流程在鎖放掉之後跑 */
    const body = JSON.stringify(store.getState(), null, 1);
    const files = { [FILE]: { content: body } };
    /* 上傳「前」先把要傳的內容指紋落地：iOS 切背景常把成功回條吞掉，
       之後在雲端看到這個指紋，就知道那是自己傳成功的，不是別台裝置 */
    g.pendingPush = hashStr(body);
    if (gist === g) saveGist();
    const url = g.gistId ? "https://api.github.com/gists/" + g.gistId : "https://api.github.com/gists";
    const res = await gfetch(url, {
      method: g.gistId ? "PATCH" : "POST",
      headers: { Authorization: "Bearer " + g.token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(g.gistId ? { files } : { description: "小小理財島備份（自動同步）", public: false, files }),
    });
    if (res.status === 404 && g.gistId) {
      if (g.remoteStamp && !force) {
        gone = true;                               /* 同上：曾經有過的雲端份不見了，不自動重建 */
      } else {
        /* 使用者親手拍板覆蓋（force）或本來就沒同步過：忘掉編號，讓控制流走出 try、
           等 finally 放完鎖，函式最後一行才重試建新的 */
        g.gistId = null; g.remoteStamp = null;
        if (gist === g) saveGist();
        retry404 = true;
      }
    } else {
      if (res.status === 401 || res.status === 403) throw new Error("金鑰失效或被撤銷，請重新連線");
      if (!res.ok) throw new Error("GitHub 回應 " + res.status);
      const j = await res.json();
      g.gistId = j.id; g.remoteStamp = j.updated_at || null;
      g.lastPush = g.pendingPush; g.pendingPush = null;   /* 回條到手：這份內容確定在雲端了 */
      g.lastSyncAt = new Date().toISOString(); g.lastError = null;
      if (gist === g) { saveGist(); ok = true; lastSyncOutcome = "ok"; }     /* 途中被中斷連線就不落地也不宣稱成功 */
    }
  } catch (e) {
    if (!(e && e.conflict)) {
      g.lastError = (e && e.name === "AbortError") ? "連線逾時（可能網路不穩）"
        : (e && e.message) ? e.message : "連不上（可能沒網路）";
      if (gist === g) saveGist();
    }
  } finally {
    cloudBusy = false;                              /* 任何路徑都要放手，不能讓同步永久卡死 */
  }
  if (gone && gist === g) { await freezeForGone(g); return false; }
  if (conflict && gist === g) {
    const how = await freezeForConflict(g, pre);
    /* 是自己的回音：帳已記對，立刻把這台裝置較新的改動傳上去，
       「立刻同步」按下去才真的是立刻同步，不用等 15 秒；只補跑一次，不會迴圈 */
    if (how === "echo" && !_retried && gist === g) { clearTimeout(cloudTimer); return syncCloud(force, true); }
    return false;
  }
  if (retry404) return syncCloud(force);            /* 鎖已放乾淨，重試會自己重新上鎖 */
  if (cloudPending) { cloudPending = false; scheduleCloudSync(); }
  refreshSettings();
  return ok;
}
/* 沒網路時上傳會失敗，等網路回來自動補一次；切到背景是最好的上傳時機；
   回前景與網路回來也順便把「待決但有指紋」的回音再比對一次 */
addEventListener("online", () => { retryEcho().catch(() => {}); scheduleCloudSync(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden && cloudOn()) { clearTimeout(cloudTimer); syncCloud().catch(() => {}); }
  else if (!document.hidden && cloudOn()) retryEcho().catch(() => {});
});
/* 用金鑰在帳號裡找有沒有既有的備份 Gist（換手機時用）。
   一頁 100 筆、最多翻 10 頁：帳號裡 gist 很多的人，備份不在第一頁也要找得到，
   不然會誤以為雲端沒備份、又建一份新的 */
async function findCloudBackup(token) {
  for (let page = 1; page <= 10; page++) {
    const res = await gfetch(`https://api.github.com/gists?per_page=100&page=${page}`, {
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
    });
    if (res.status === 401 || res.status === 403) throw new Error("金鑰不對或沒有 gist 權限");
    if (!res.ok) throw new Error("GitHub 回應 " + res.status);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return null;
    const hit = list.find(g => g.files && g.files[FILE]);
    if (hit) return hit;
    if (list.length < 100) return null;
  }
  return null;
}
/* 讀雲端備份，回傳 {raw, stamp}。
   重要：這裡「絕不」自己更新 gist.remoteStamp——指紋的安全語意是
   「本機已經反映過（或拍板放棄過）的雲端版本」，光是「讀過、看一眼筆數」不算數。
   偷看一眼就更新指紋，會讓下一次自動同步以為雲端沒被別人動過，無聲蓋掉別台的新資料。
   要採用時由呼叫端自己把回傳的 stamp 寫進 gist.remoteStamp。 */
async function fetchCloudContent() {
  if (!gist || !gist.gistId) return null;
  const res = await gfetch("https://api.github.com/gists/" + gist.gistId, {
    headers: { Authorization: "Bearer " + gist.token, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return { gone: true };   /* 那份 gist 不在了：讓呼叫端走「不見了」流程，別謊稱是網路問題 */
  if (!res.ok) throw new Error("GitHub 回應 " + res.status);
  const j = await res.json();
  const stamp = j.updated_at || null;
  const f = j.files && j.files[FILE];
  if (!f) return null;
  if (f.truncated && f.raw_url) {
    const r = await gfetch(f.raw_url);
    return r.ok ? { raw: await r.text(), stamp } : null;
  }
  return f.content ? { raw: f.content, stamp } : null;
}

/* ───────── 給畫面用的狀態 ───────── */
// 家長區的「資料與備份」面板照這個物件畫（原本 stamps 3732–3737 行那段狀態文字）。
export function cloudInfo() {
  const summary = st => ({
    activities: (st.activities || []).length,
    lastEntryDate: (st.activities || []).map(a => a.entryDate).sort().pop() || "—",
    profiles: (st.profiles || []).map(p => ({ name: p.name, avatar: p.avatar, activities: (st.activities || []).filter(a => a.profileId === p.id).length })),
  });
  const local = store.getState();
  return {
    on: cloudOn(),
    gistId: gist ? gist.gistId || null : null,
    lastSyncAt: gist ? gist.lastSyncAt || null : null,
    lastError: gist ? gist.lastError || null : null,
    pending: !!(gist && gist.pending),
    frozen: !!cloudFrozen(),
    pullFreeze,
    pullArmed: !!pullCache,
    // 三張卡：拍板卡（decide）、備份不見了（gone）、還沒比對完（stale）
    card: pendingCloud ? "decide" : (gist && gist.pending && !gist.gistId) ? "gone" : (gist && gist.pending) ? "stale" : "",
    cloudSummary: pendingCloud ? summary(pendingCloud.cloud) : null,
    localSummary: local ? summary(local) : null,
  };
}
// db.save 靠這個決定 latestBackup.copyStatus；common.js 的儲存狀態文字也靠它
function bridgeStatus() {
  if (!cloudOn()) return null;
  if (gist.lastError || (gist.pending && !pendingCloud && !gist.gistId)) return "failed";
  if (cloudFrozen()) return "pending";
  return gist.lastSyncAt ? "synced" : "pending";
}
setCloudBridge({ schedule: scheduleCloudSync, status: bridgeStatus });
setCloudStatusProvider(bridgeStatus);

/* ───────── 設定頁的行為（stamps 3547–3818 行） ───────── */

/* 連線：三向分支——雲端全空就直接上傳；雲端有一份而本機空白就直接拿回；兩邊都有就凍結等拍板 */
export async function connect(token) {
  token = String(token || "").trim();
  if (!token) { toast("先貼上金鑰", { ms: 2000 }); return { ok: false }; }
  pendingCloud = null;      /* 上一次連線留下的待決狀態全部作廢，不能拿舊快照誤導這一次 */
  try {
    const existing = await findCloudBackup(token);
    /* 指紋先留空：要等「真的採用了哪個版本」才寫。連線當下就抄雲端的版本戳，
       等於還沒拍板就宣稱同步過，之後的自動上傳會直接放行 */
    gist = { token, gistId: existing ? existing.id : null, lastSyncAt: null, lastError: null, remoteStamp: null };
    saveGist();
    if (!existing) {
      const ok = await syncCloud(true);
      toast(ok ? "已連線，之後每次改動都會自動備份" : "已連線，但第一次上傳失敗：" + (gist.lastError || ""), { ms: 5000, tone: ok ? "success" : "waiting" });
      refreshSettings(); return { ok: true, mode: "created" };
    }
    /* 雲端已經有一份備份：先讀回來看清楚，拍板之前絕不上傳
       （讀不到也不上傳——用本機資料蓋掉一份「還救得回來」的雲端備份是最糟的結果） */
    let cloud = null, cloudStamp = null;
    try {
      const r = await fetchCloudContent();
      if (r && r.raw) { cloud = normalize(JSON.parse(r.raw)); cloudStamp = r.stamp; }
    } catch (e) {}
    if (!cloud) {
      /* 讀失敗（可能只是網路抖一下）：凍結上傳，等讀得到、使用者決定了才動雲端 */
      gist.pending = true; gist.lastError = "讀不到雲端備份的內容"; saveGist();
      toast("已連線，但雲端那份備份還讀不出來——先不動它，稍後到家長區再比對一次。", { ms: 6000 });
      refreshSettings(); return { ok: true, mode: "unreadable" };
    }
    const local = store.getState();
    if (!local || (local.activities || []).length === 0) {
      resetRuntime();
      gist.remoteStamp = cloudStamp; saveGist();  /* 採用了雲端這個版本，指紋才算數 */
      store.setState(cloud, "從雲端備份還原");
      toast("已連線，並從雲端拿回 " + (cloud.activities || []).length + " 筆紀錄", { ms: 5000, tone: "success" });
      refreshSettings(); return { ok: true, mode: "pulled" };
    }
    /* 兩邊都有資料：讓使用者決定（選項畫在家長區）。
       pending 旗標要落地——關掉 app 再開，凍結也不能失效 */
    gist.pending = true; saveGist();
    pendingCloud = { cloud, stamp: cloudStamp };
    /* 慢網路下家長可能已經離開家長區：不自己彈回來蓋掉他正在做的事，改用吐司帶路 */
    if (location.hash.startsWith("#/parent")) refreshSettings();
    else toast("雲端已經有一份備份——到家長區選要用哪一份", { ms: 6000, action: "去看", onAction: goToBackupPanel });
    return { ok: true, mode: "conflict" };
  } catch (e) {
    toast(errMsg(e, "連線失敗"), { ms: 4000, tone: "error" });
    return { ok: false, error: errMsg(e, "連線失敗") };
  }
}

/* 拍板卡：用雲端的（覆蓋這台裝置）。雙擊確認由畫面負責，按到這裡就是真的要換 */
export function adoptCloud() {
  if (!pendingCloud || !gist) return false;
  resetRuntime();
  const next = pendingCloud.cloud;
  gist.remoteStamp = pendingCloud.stamp || null;  /* 採用了這個版本，指紋跟著它 */
  gist.lastPush = null; gist.pendingPush = null;   /* 舊指紋代表的不再是雲端內容：留著會把別台還原回舊版時誤認成回音 */
  pendingCloud = null;
  gist.pending = false; saveGist();
  store.setState(next, "改用雲端備份");
  toast("已改用雲端那份備份", { ms: 3000, tone: "success" });
  refreshSettings();
  return true;
}

/* 拍板卡：用這台裝置的（覆蓋雲端）。
   覆蓋前再看一眼雲端：這張卡是出卡那一秒的快照，掛著的期間別台可能又寫入了——
   版本戳變了就重抓、重畫卡片、請家長再確認一次，不能拿舊筆數蓋掉一份沒看過的新內容 */
export async function adoptLocal() {
  if (!pendingCloud || !gist) return { ok: false };
  try {
    const chk = await gfetch("https://api.github.com/gists/" + gist.gistId, {
      headers: { Authorization: "Bearer " + gist.token, Accept: "application/vnd.github+json" },
    });
    if (chk.status === 404) { pendingCloud = null; await freezeForGone(gist); refreshSettings(); return { ok: false, mode: "gone" }; }
    if (chk.ok) {
      const meta = await chk.json();
      if (meta.updated_at && pendingCloud && meta.updated_at !== pendingCloud.stamp) {
        const r = await fetchCloudContent();
        if (r && r.raw) pendingCloud = { cloud: normalize(JSON.parse(r.raw)), stamp: r.stamp };
        refreshSettings();
        toast("雲端那份剛剛又被改過了，卡片上的筆數已更新，請再確認一次", { ms: 5000 });
        return { ok: false, mode: "changed" };
      }
    }
  } catch (e) {
    toast(errMsg(e, "連不上，稍後再試"), { ms: 3500, tone: "error" });
    return { ok: false, mode: "offline" };
  }
  pendingCloud = null;
  gist.pending = false; saveGist();
  /* 使用者按了兩段確認的最強決定，要能送出去：先解除拿回鈕的凍結，不然 force 上傳會在入口被擋下、誤報「上傳失敗」 */
  clearTimeout(pullTimer); pullFreeze = false;
  const ok = await syncCloud(true);
  toast(ok ? "已用這台裝置的資料覆蓋雲端" : "上傳失敗：" + (gist.lastError || "請稍後再試"), { ms: 4000, tone: ok ? "success" : "error" });
  refreshSettings();
  return { ok };
}

/* 備份消失卡：重新上傳一份。
   這張卡可能掛了好幾天：按下時先重找一次——別台裝置若已經重建了一份，
   要撿那份來比對，不能各建各的、從此永久分岔 */
export async function reuploadCloud() {
  if (!gist) return { ok: false };
  try {
    const hit = await findCloudBackup(gist.token);
    if (hit) {
      gist.gistId = hit.id; gist.remoteStamp = null; saveGist();
      await freezeForConflict(gist);
      refreshSettings(); return { ok: false, mode: "conflict" };
    }
  } catch (e2) {
    toast(errMsg(e2, "連不上，稍後再試"), { ms: 3500, tone: "error" });
    return { ok: false, mode: "offline" };
  }
  gist.pending = false; saveGist();
  const ok3 = await syncCloud(true);
  toast(ok3 ? "重新上傳好了，之後照常自動備份" : "上傳失敗：" + (gist.lastError || "請稍後再試"), { ms: 4000, tone: ok3 ? "success" : "error" });
  refreshSettings();
  return { ok: ok3 };
}

/* 「還沒比對完」卡：重新讀一次來比對，期間上傳持續凍結 */
export async function compareCloud() {
  try {
    const r = await fetchCloudContent();
    if (r && r.gone) {
      /* 那份已經不在雲端：轉成「備份不見了」卡，別再叫人重試網路 */
      if (gist) { gist.gistId = null; saveGist(); }
      refreshSettings(); return { ok: false, mode: "gone" };
    }
    if (!r || !r.raw) throw new Error("讀不到內容");
    const how = adoptIfEcho(r);
    if (how) {
      /* 指紋命中只證明「雲端那份是這台裝置傳的」，本機多半已經又改過了——不能說一模一樣 */
      toast(how === "same" ? "比對過了：內容跟這台裝置一模一樣，已恢復自動同步"
        : "比對過了：雲端那份是這台裝置自己傳的，不是別台改的——已恢復自動同步，較新的改動會接著傳上去", { ms: 5000, tone: "success" });
      refreshSettings(); return { ok: true, mode: how };
    }
    pendingCloud = { cloud: normalize(JSON.parse(r.raw)), stamp: r.stamp };
    refreshSettings();
    return { ok: true, mode: "conflict" };
  } catch (err) {
    toast("還是讀不到，晚點再試（可能沒網路）", { ms: 4000, tone: "error" });
    return { ok: false, mode: "offline" };
  }
}

/* 立刻同步：就算是親手按的也照樣比對指紋，雲端被別台動過會進「要用哪一份」拍板卡，
   覆蓋只走卡上那顆兩段確認鈕，不再有一鍵無警告覆蓋 */
export async function syncNow() {
  const ok = await syncCloud();
  if (ok) toast("已同步到雲端", { ms: 3000, tone: "success" });
  else if (lastSyncOutcome === "busy") toast("正在同步中，稍後會再傳一次", { ms: 3000 });
  else if (!cloudFrozen()) toast("同步失敗：" + ((gist && gist.lastError) || "請稍後再試"), { ms: 3500, tone: "error" });
  refreshSettings();
  return ok;
}

/* 從雲端拿回備份：第一按只讀、武裝 5 秒；第二按才套用「第一按當時看到的那一份」。
   重抓可能拿到別的版本，跟你剛剛看到的筆數對不上，卻被直接套用 */
let pullCache = null;
export async function pullFromCloud() {
  if (pullCache) {
    /* 第二按：套用第一按讀到的那一份，不重抓 */
    clearTimeout(pullTimer);
    resetRuntime();
    const next = pullCache.s;
    pendingCloud = null; pullFreeze = false;
    if (gist) { gist.pending = false; gist.remoteStamp = pullCache.stamp || null; gist.lastPush = null; gist.pendingPush = null; saveGist(); }
    pullCache = null;
    store.setState(next, "從雲端拿回備份");
    toast("已從雲端還原", { ms: 3000, tone: "success" });
    refreshSettings();
    return { applied: true };
  }
  /* 第一按：讀「之前」就先凍結、先清掉舊的解除計時器——
     讀的那一秒也不准有上傳在背後跑，舊計時器也不准在讀取途中把凍結放掉。
     只是看一眼，不動 remoteStamp（偷看不算同步過） */
  clearTimeout(pullTimer);
  pullFreeze = true;
  try {
    const r = await fetchCloudContent();
    if (r && r.gone) {
      pullFreeze = false;
      /* 拍板卡若正掛著，它的快照已經沒意義：一起清掉，家長區才會落到「備份不見了」卡，
         不會吐司說不見了、卡片卻還在問要用哪一份 */
      pendingCloud = null;
      if (gist) { gist.gistId = null; gist.pending = true; saveGist(); }
      toast("雲端那份備份不見了——到家長區決定要重傳還是中斷", { ms: 4000 });
      refreshSettings(); return { gone: true };
    }
    if (!r || !r.raw) { pullFreeze = false; toast("雲端沒有讀到備份", { ms: 3000 }); return { empty: true }; }
    const s = normalize(JSON.parse(r.raw));
    pullCache = { s, stamp: r.stamp };
    pullFreeze = true;                   /* 重申一次：中途若被別的路徑動過，武裝期一定是凍的 */
    clearTimeout(pullTimer);
    pullTimer = setTimeout(() => {
      pullCache = null; pullFreeze = false;
      /* 武裝期內若家長區重繪過，狀態列還寫著暫停、「立刻同步」也還藏著：到期補畫一次 */
      refreshSettings();
    }, 5000);
    refreshSettings();
    return { armed: true, activities: (s.activities || []).length };
  } catch (e) {
    pullFreeze = false;
    toast(errMsg(e, "讀取失敗"), { ms: 3500, tone: "error" });
    return { error: errMsg(e, "讀取失敗") };
  }
}

/* 真的想把雲端那份刪掉（例如決定不用雲端了）：刪完金鑰也一起斷。兩段確認由畫面負責 */
export async function deleteCloudBackup() {
  if (!gist || !gist.gistId) { toast("雲端目前沒有備份", { ms: 2500 }); return { ok: false }; }
  try {
    const res = await gfetch("https://api.github.com/gists/" + gist.gistId, {
      method: "DELETE", headers: { Authorization: "Bearer " + gist.token, Accept: "application/vnd.github+json" },
    });
    if (res.status === 204 || res.status === 404) {
      gist = null; pendingCloud = null; pullCache = null; pullFreeze = false; saveGist();
      toast("雲端備份已刪除、連線已中斷。要更保險的話，可以到 GitHub 把金鑰也撤銷。", { ms: 6000, tone: "success" });
      refreshSettings();
      return { ok: true };
    }
    throw new Error("GitHub 回應 " + res.status);
  } catch (e) {
    toast("刪除失敗：" + errMsg(e, "請稍後再試"), { ms: 3500, tone: "error" });
    refreshSettings();
    return { ok: false };
  }
}

/* 中斷連線：雲端從來沒建成的話，別謊稱那裡還有一份 */
export function disconnect() {
  const had = !!(gist && gist.gistId);
  gist = null; pendingCloud = null; pullCache = null; pullFreeze = false; saveGist();
  toast(had ? "已中斷，雲端那份備份還在你的 GitHub 裡" : "已中斷連線", { ms: 4000 });
  refreshSettings();
  return { had };
}

/* ───────── 家長區「GitHub 雲端備份」面板（stamps 3547–3818 行的畫面） ─────────
   render 只產生字串；mount 綁一次事件委派。危險動作用「按兩次」武裝，幾秒沒按第二下就解除。 */
const armed = new Map();        /* key → timer；武裝中的按鈕會把文案換成「再按一次…」 */
function arm(key, ms, root) {
  if (armed.has(key)) return true;                 /* 第二按 */
  armed.set(key, setTimeout(() => { armed.delete(key); paintArmed(root); }, ms));
  paintArmed(root);
  return false;
}
function disarm(key) { clearTimeout(armed.get(key)); armed.delete(key); }
function paintArmed(root) {
  if (!root || !root.isConnected) return;
  root.querySelectorAll("[data-arm-label]").forEach((button) => {
    const key = button.getAttribute("data-gist");
    button.textContent = armed.has(key) ? button.getAttribute("data-arm-label") : button.getAttribute("data-idle-label");
  });
}
const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function whenText(iso) {
  if (!iso) return "還沒同步過";
  try { return new Date(iso).toLocaleString("zh-TW", { hour12: false }); } catch (e) { return iso; }
}
function summaryHtml(label, s) {
  if (!s) return "";
  return `<small><b>${escapeHtml(label)}</b>：${s.activities} 筆紀錄，最後一筆 ${escapeHtml(s.lastEntryDate)}；${s.profiles.map((p) => `${escapeHtml(p.name)} ${p.activities} 筆`).join("、")}</small>`;
}

export function renderGistPanel() {
  const info = cloudInfo();
  if (!info.on) {
    return `<p>雲端備份會把整份帳本（含孩子的名字與照片）傳到<b>你自己 GitHub 帳號的祕密 Gist</b>。祕密 Gist 不會被搜尋到，但知道網址的人看得到，而且 GitHub 會保留每次修改前的舊版本；自己用風險很低但不是零，別把備份網址分享出去。</p>
      <p>做法：到 GitHub 的 Settings → Developer settings → Personal access tokens（classic）建一把<b>只勾 gist 權限</b>的金鑰，貼在下面。金鑰只存在這台裝置，不會進備份檔。</p>
      <label>GitHub 金鑰<input type="password" data-gist-token autocomplete="off" placeholder="ghp_…" spellcheck="false"></label>
      <div class="backup-download-actions"><button type="button" data-gist="connect">連線並開始自動備份</button></div>
      <p data-gist-status role="status"></p>`;
  }
  const statusLine = info.pullFreeze ? "拿回備份確認中，自動上傳暫停"
    : info.card === "decide" ? "等你決定要用哪一份，自動上傳暫停"
    : info.card === "gone" ? "雲端那份備份不見了，自動上傳暫停"
    : info.card === "stale" ? "還沒跟雲端比對完，自動上傳暫停"
    : info.lastError ? `上次同步失敗：${info.lastError}`
    : `上次同步 ${whenText(info.lastSyncAt)}`;
  let card = "";
  if (info.card === "decide") {
    card = `<div class="restore-summary"><b>雲端跟這台裝置都有資料，要用哪一份？</b>
      ${summaryHtml("雲端那份", info.cloudSummary)}${summaryHtml("這台裝置", info.localSummary)}
      <div class="backup-download-actions">
        <button type="button" class="restore-button" data-gist="adopt-cloud" data-arm-label="再按一次：用雲端的" data-idle-label="用雲端的（覆蓋這台裝置）">用雲端的（覆蓋這台裝置）</button>
        <button type="button" data-gist="adopt-local" data-arm-label="再按一次：用這台裝置的" data-idle-label="用這台裝置的（覆蓋雲端）">用這台裝置的（覆蓋雲端）</button>
      </div><small>按一下後 4 秒內再按一次才會執行。</small></div>`;
  } else if (info.card === "gone") {
    card = `<div class="restore-summary"><b>雲端那份備份不見了</b><small>可能在 GitHub 被刪掉，或另一台裝置改用了別份。</small>
      <div class="backup-download-actions"><button type="button" data-gist="reupload">重新上傳這台裝置的資料</button><button type="button" data-gist="disconnect">中斷連線</button></div></div>`;
  } else if (info.card === "stale") {
    card = `<div class="restore-summary"><b>還沒跟雲端比對完</b><small>上次讀不到雲端內容；比對完成前不會上傳。</small>
      <div class="backup-download-actions"><button type="button" data-gist="compare">讀取雲端備份來比對</button></div></div>`;
  }
  return `<p>已連線到你的 GitHub。每次改動 15 秒後、以及 app 切到背景時會自動上傳。</p>
    <p data-gist-status role="status">${escapeHtml(statusLine)}</p>
    ${card}
    <div class="backup-download-actions">
      ${info.frozen ? "" : `<button type="button" data-gist="sync">立刻同步</button>`}
      <button type="button" data-gist="pull" data-arm-label="再按一次：從雲端還原" data-idle-label="從雲端拿回備份">${info.pullArmed ? "再按一次：從雲端還原" : "從雲端拿回備份"}</button>
    </div>
    <details><summary>進階</summary>
      <p>刪除雲端備份會把 GitHub 上那份 Gist 整個刪掉並中斷連線；中斷連線只是這台裝置不再上傳，雲端那份會留著。</p>
      <div class="backup-download-actions">
        <button type="button" class="is-danger" data-gist="delete" data-arm-label="再按一次：真的刪除雲端備份" data-idle-label="刪除雲端備份">刪除雲端備份</button>
        <button type="button" data-gist="disconnect">中斷連線</button>
      </div>
    </details>`;
}

export function mountGistPanel(root) {
  if (!root || root.dataset.gistMounted) return;
  root.dataset.gistMounted = "1";
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-gist]");
    if (!button) return;
    const action = button.getAttribute("data-gist");
    const status = root.querySelector("[data-gist-status]");
    const say = (text) => { if (status) status.textContent = text; };
    button.disabled = true;
    try {
      if (action === "connect") {
        const input = root.querySelector("[data-gist-token]");
        say("正在連線…");
        const result = await connect(input ? input.value : "");
        if (!result.ok) { say(result.error || "連線失敗"); button.disabled = false; }
        return;
      }
      if (action === "sync") { say("同步中…"); await syncNow(); return; }
      if (action === "compare") { say("讀取中…"); await compareCloud(); return; }
      if (action === "reupload") { say("上傳中…"); await reuploadCloud(); return; }
      if (action === "disconnect") { disconnect(); return; }
      if (action === "pull") {
        const r = await pullFromCloud();
        if (r && r.armed) say(`雲端那份有 ${r.activities} 筆紀錄；5 秒內再按一次就會覆蓋這台裝置`);
        button.disabled = false;
        return;
      }
      if (action === "adopt-cloud") { if (!arm("adopt-cloud", 4000, root)) { button.disabled = false; return; } disarm("adopt-cloud"); adoptCloud(); return; }
      if (action === "adopt-local") { if (!arm("adopt-local", 4000, root)) { button.disabled = false; return; } disarm("adopt-local"); say("上傳中…"); await adoptLocal(); return; }
      if (action === "delete") { if (!arm("delete", 5000, root)) { button.disabled = false; return; } disarm("delete"); say("刪除中…"); await deleteCloudBackup(); return; }
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
}
