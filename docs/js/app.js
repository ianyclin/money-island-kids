// 小小理財島 PWA：路由、開機、每月獎勵、自動行情、Service Worker、安裝提示。
// SW 註冊、shell-updated 提示、visualViewport 鍵盤頂高、storage.persist 照 ../stamps/index.html
// 4006–4039、4088–4097 行搬過來，註解保留。

import * as db from "./db.js";
import * as store from "./store.js";
import * as pin from "./pin.js";
import { derive } from "./state.js";
import * as gist from "./gist.js";
import * as backup from "./backup.js";
import * as setup from "./ui/setup.js";
import { stateGate, showStatus, closeModal, confirmDialog, isModalOpen, syncModalBackdrop, timestampText, applyListHolds } from "./ui/common.js";
import { html, raw } from "./util.js";

// ---------- 路由表 ----------
// hash 路由：GitHub Pages 沒有伺服器可以改寫網址，所有頁面共用同一份 index.html。
// 路由表照 v2 規格第 2 節：#/growth、#/more 新增；#/dreams 保留為 #/growth 的別名（舊連結不斷）。
const ROUTES = {
  "#/": { id: "home", load: () => import("./ui/home.js") },
  "#/growth": { id: "growth", load: () => import("./ui/growth.js") },
  "#/history": { id: "history", load: () => import("./ui/history.js") },
  "#/more": { id: "more", load: () => import("./ui/more.js") },
  "#/parent": { id: "parent", load: () => import("./ui/parent.js") },
  "#/parent/investments": { id: "parent-investments", load: () => import("./ui/parent-investments.js") },
  "#/setup": { id: "setup", module: setup },
};
ROUTES["#/dreams"] = ROUTES["#/growth"];

function currentHash() {
  const hash = location.hash || "#/";
  const base = hash.split("?")[0];
  return ROUTES[base] ? base : "#/";
}

function root() { return document.getElementById("app"); }

// ---------- 目前的狀態與選中的孩子 ----------
function readState() {
  try { return store.getState(); } catch (e) { return null; }
}

const PROFILE_STORAGE_KEY = "money-island-profile";   // 照 app/money-state-cache.tsx

function storedProfileId(state) {
  let stored = "";
  try { stored = localStorage.getItem(PROFILE_STORAGE_KEY) || ""; } catch (e) {}
  return stored || (state.meta && state.meta.selectedProfileId) || "";
}

function selectedProfile(profiles, state) {
  const wanted = storedProfileId(state);
  return profiles.find((item) => item.id === wanted) || profiles[0] || null;
}

// 切換小朋友只是畫面狀態：寫 localStorage（照原本）與 state.meta，不走 commit——
// 不然每切一次都會存檔、排快照、排 Gist 同步，頂端還會寫「剛剛已儲存」。
export function chooseProfile(id) {
  const state = readState();
  if (!state || !(state.profiles || []).some((item) => item.id === id)) return;
  // 已經是選中的那一個就什麼都不做：v2 的殼每一頁都有孩子切換（側欄＋頁首），
  // 加上舊頁面自己也還接著 data-choose-profile，同一次點擊可能被處理兩次——
  // 第二次一定是「切到已經選中的人」，在這裡擋掉就不會多重繪一輪。
  if (storedProfileId(state) === id) return;
  if (!state.meta) state.meta = {};
  state.meta.selectedProfileId = id;
  try { localStorage.setItem(PROFILE_STORAGE_KEY, id); } catch (e) {}
  void render();
}

// 孩子切換的統一委派（規格 3.3）：appShell() 的側欄與頁首 chip 都帶 data-choose-profile，
// 不屬於任何一個頁面模組，所以接在 document 上。舊頁面自己綁的那一份先留著，
// chooseProfile() 上面的「已經選中就不做事」保證不會重覆重繪。
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("[data-choose-profile]");
  if (!button) return;
  chooseProfile(button.getAttribute("data-choose-profile"));
});

export function navigate(hash) {
  if (location.hash === hash) { void render(); return; }
  location.hash = hash;
}

// ---------- 整頁重繪 ----------
// 重繪的時機只有兩種：路由切換、store 提交後（store.subscribe → refresh）。
let rendering = false;
let pendingRender = false;
let lastRenderedRoute = "";   // 批 5：上一次畫出來的路由，用來分辨「換頁」與「同一頁重繪」

// ---------- 疑問-1：上一頁／下一頁回到離開時的捲動位置 ----------
// 分辨「上一頁／下一頁」與「點連結進新頁」的方法：每一筆畫過的瀏覽紀錄都在 history.state 蓋一個記號；
// 點連結、分頁列或程式改 location.hash 都會產生一筆沒有記號的新紀錄，回到有記號的紀錄就是上一頁／下一頁。
// 瀏覽器自己的捲動還原關掉，免得兩邊打架。
// 驗收 C3：捲動位置改記在每一筆瀏覽紀錄自己的 history.state 上（以前依頁面記，同一頁的兩筆紀錄會共用一個位置）。
// 捲動停下來 120ms 後寫一次；點擊（捕捉階段，在連結換網址之前）也先寫一次，免得剛捲完馬上點連結時沒記到。
const ENTRY_MARK = "moneyIslandEntry";
const ENTRY_SCROLL = "moneyIslandScrollY";
let scrollSaveTimer = 0;
let scrollTracking = false;    // 這一筆紀錄畫好、捲動位置定下來之後才開始記（換頁途中的捲動不算）
try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}

function currentEntryState() {
  try { return history.state && typeof history.state === "object" ? history.state : {}; } catch (e) { return {}; }
}

function saveEntryScroll() {
  clearTimeout(scrollSaveTimer);
  if (!scrollTracking || !entryVisited()) return;
  const current = currentEntryState();
  const y = Math.round(window.scrollY);
  if (current[ENTRY_SCROLL] === y) return;
  try { history.replaceState({ ...current, [ENTRY_SCROLL]: y }, ""); } catch (e) {}
}
window.addEventListener("scroll", () => {
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveEntryScroll, 120);
}, { passive: true });
document.addEventListener("click", saveEntryScroll, true);
window.addEventListener("pagehide", saveEntryScroll);

function entryVisited() {
  try { return Boolean(history.state && history.state[ENTRY_MARK]); } catch (e) { return false; }
}

function markEntry() {
  if (entryVisited()) return;
  try { history.replaceState({ ...currentEntryState(), [ENTRY_MARK]: true }, ""); } catch (e) {}
}

// 上一頁／下一頁回到這一筆紀錄離開時的位置；點連結、分頁列進新頁一律回頂端
export function scrollTargetFor(entryState, traversal) {
  if (!traversal || !entryState || typeof entryState !== "object") return 0;
  const y = Number(entryState[ENTRY_SCROLL]);
  return Number.isFinite(y) && y > 0 ? y : 0;
}

// 路由（# 後、? 前；#/dreams 是 #/growth 的別名）
function routeOf(hash) {
  const base = String(hash || "#/").split("?")[0] || "#/";
  const route = ROUTES[base];
  return route ? route.id : base;
}

// 批 5：點目前所在的分頁（分頁列、側欄、左上角品牌）不會觸發 hashchange，自己捲回頂端。
// 驗收 C3：比路由、不比完整網址（#/growth?… 時點「成長」也算同一頁）。
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest(".tabbar a[href], .sidenav a[href], .sidebar .brand[href]");
  if (!link || event.defaultPrevented) return;
  const href = link.getAttribute("href") || "";
  if (routeOf(href) !== routeOf(location.hash || "#/")) return;
  event.preventDefault();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

export async function refresh() { await render(); }

async function render() {
  if (rendering) { pendingRender = true; return; }
  rendering = true;
  try {
    const mount = root();
    if (!mount) return;
    const hash = currentHash();
    const state = readState();
    const recovering = (!state || !Array.isArray(state.profiles)) && db.hasState() && hash !== "#/setup";

    // 批 5：換了路由（上一頁、分頁列、彈窗裡的連結）＝使用者自己離開，用 "navigate" 關彈窗，
    // 各頁會清掉「該開」旗標，回原頁不會自己彈回；同一頁重繪才用 "rerender"（保留旗標，mount() 再補開）。
    // 只比路由本身（# 後、? 前）：?open= 這種同頁參數不算換頁。
    // 批 1 驗收 #12：移到所有提早 return 的分支之前——以前出路畫面、導去第一次使用這幾條路不經過這裡，
    // 開著的確認框換頁後還留著，在別頁按確定照樣執行。出路畫面本身算同一頁（不管網址是哪個），重繪不關確認框。
    const routeKey = recovering ? "recovery" : hash;
    const navigated = routeKey !== lastRenderedRoute;
    // 驗收 C3：開頭記下網址與這一筆紀錄的狀態；畫完要捲動、蓋記號之前比對網址沒變才做——
    // 排隊中的重繪畫完時網址可能已經是下一頁了，不能把這一頁的捲動與記號蓋到別筆紀錄上。
    const startHash = location.hash;
    const traversal = navigated && entryVisited();
    const entryState = currentEntryState();
    if (navigated) { scrollTracking = false; clearTimeout(scrollSaveTimer); }
    lastRenderedRoute = routeKey;
    const settleEntry = () => {
      if (!navigated) return;
      if (location.hash !== startHash) { lastRenderedRoute = ""; return; }   // 交給排隊的那次重繪當成換頁處理
      window.scrollTo(0, scrollTargetFor(entryState, traversal));
      markEntry();
      scrollTracking = true;
    };
    // 批 1 驗收 #11：同一頁重繪（例如另一個分頁存檔）會把開著的彈窗關掉再補開，補開時焦點固定跳到第一個欄位；
    // 先記下焦點在哪個欄位、游標在哪，畫完再還回去
    const focusMemo = navigated ? null : rememberModalFocus();
    closeModal(navigated ? "navigate" : "rerender");

    // 還沒有帳本：一律先走第一次使用。
    // 帳本讀不出來：給四條出路（批 1 #7、驗收 #1）；其中「從備份檔還原」與「另外建立」借用第一次使用那一頁，所以放行 #/setup。
    if (!state || !Array.isArray(state.profiles)) {
      if (recovering) {
        mount.innerHTML = String(recoveryGate());
        syncModalBackdrop();
        settleEntry();   // 驗收 C3：出路畫面這條提早 return 也一樣捲回頂端、蓋記號
        void loadRecoverySnapshots();
        void refreshBrokenCopyText();
        return;
      }
      if (hash !== "#/setup") { location.hash = "#/setup"; return; }
    }
    if (state && Array.isArray(state.profiles) && hash === "#/setup" && (state.profiles || []).length > 0) {
      location.hash = "#/";
      return;
    }

    const route = ROUTES[hash];
    let mod = route.module;
    if (!mod) {
      try {
        mod = await route.load();
      } catch (error) {
        mount.innerHTML = String(stateGate(`這一頁載不進來（${error && error.message ? error.message : "未知的錯誤"}）`, () => { void render(); }));
        return;
      }
    }

    const ctx = buildContext(state);
    /* 整頁重繪時換掉整個 #app 節點：頁面模組在 mount() 裡綁的事件委派會跟著舊節點一起消失，
       不會每重繪一次就疊一層監聽器（模組自己不用管解綁）。 */
    try {
      const next = document.createElement("div");
      next.id = "app";
      next.innerHTML = String(mod.render(ctx));
      mount.replaceWith(next);
      // v2 的殼不用 --dock：貼底補償由 app.css 的 .page-body 直接算（規格 3.1）。
      if (typeof mod.mount === "function") mod.mount(next, ctx);
      applyListHolds(next);   // 驗收中-1：清單停用期還沒過，新畫出來的按鈕照樣停用
    } catch (error) {
      /* 帳本裡有頁面畫不動的資料：不要卡在骨架或半張畫面，至少留一顆「再試一次」 */
      const current = root();
      if (current) current.innerHTML = String(stateGate(`這一頁畫不出來（${error && error.message ? error.message : "未知的錯誤"}）`, () => { void render(); }));
    }
    syncModalBackdrop();      // 確認框不跟著重繪關掉，新的 #app 要重新鎖住
    restoreModalFocus(focusMemo);
    // 批 5：換頁捲回頂端；同一頁重繪不動捲動位置（深連結 ?open= 自己會在下一拍捲到區塊）
    // 疑問-1：上一頁／下一頁回到這一筆紀錄離開時的位置；點連結、分頁列進新頁才回頂端
    settleEntry();
    updateInstallHint();
  } finally {
    rendering = false;
    if (pendingRender) { pendingRender = false; void render(); }
  }
}

function rememberModalFocus() {
  const host = document.getElementById("modal-root");
  const active = document.activeElement;
  if (!host || !active || !active.id || !host.contains(active)) return null;
  let start = null;
  let end = null;
  try { start = active.selectionStart; end = active.selectionEnd; } catch (e) {}   // type=number 沒有游標位置可讀
  return { id: active.id, start, end };
}

function restoreModalFocus(memo) {
  if (!memo || !isModalOpen()) return;
  const host = document.getElementById("modal-root");
  const target = host ? host.querySelector(`#${CSS.escape(memo.id)}`) : null;
  if (!target || target.disabled) return;
  try { target.focus({ preventScroll: true }); } catch (e) {}
  if (typeof memo.start === "number" && typeof memo.end === "number") {
    try { target.setSelectionRange(memo.start, memo.end); } catch (e) {}
  }
}

function buildContext(state) {
  let view = null;
  if (state) {
    try { view = derive(state); } catch (e) { view = null; }
  }
  // 契約第 15 節：profile／profiles 一律拿 derive 過的（有 futurePrincipal、rewardClaimedThisMonth、
  // 只含 active 的常用標的）；derive 失敗才退回 raw。
  const profiles = view ? view.profiles : (state ? state.profiles || [] : []);
  const profile = state ? selectedProfile(profiles, state) : null;
  return {
    state,
    view,
    profile,
    profiles,
    unlocked: safeUnlocked(),
    pinStatus: safePinStatus(),
    navigate,
    refresh,
    chooseProfile,
  };
}

function safeUnlocked() {
  try { return pin.isUnlocked(); } catch (e) { return false; }
}

function safePinStatus() {
  try { return pin.status(); } catch (e) { return "locked"; }
}

// ---------- 帳本讀不出來（批 1 #7；驗收 #1、#3、#8） ----------
// 以前只有「再試一次」，而重新整理永遠讀到同一份壞資料：家長區進不去、連備份都下載不了。
// 這裡給四條出路（快照、備份檔、雲端、另外建立），外加一顆無論如何都在的「下載讀不出來的原始內容」。
// 換帳本之前一律：原始內容要先有安全的副本（另外留存成功，或家長已經下載），雲端同步要先凍結（gist.freezeForLedgerSwap）。
let recoverySnapshots = null;    // null＝讀取中、false＝讀不到快照（瀏覽器資料庫出錯）、[]＝沒有
let bootProblem = "";
let recoveryCloudNote = "";      // 「從雲端拿回」第一按之後的說明（雲端那份有幾筆）

function recoveryDetail() {
  return db.loadError() || bootProblem;
}

function recoverySnapshotList() {
  if (recoverySnapshots === null) return html`<p class="empty-history">正在找這台裝置上的快照…</p>`;
  if (recoverySnapshots === false) return html`<p class="empty-history">${db.SNAPSHOT_READ_ERROR}。</p>`;
  if (!recoverySnapshots.length) return html`<p class="empty-history">這台裝置上沒有快照。</p>`;
  return html`${recoverySnapshots.slice(0, 5).map((record) => html`<div class="parent-row">
      <div><b>${timestampText(record.ts)}</b><small>${[record.reason, typeof record.activities === "number" ? `${record.activities} 筆紀錄` : ""].filter(Boolean).join(" · ")}</small></div>
      <button type="button" data-recovery-snapshot="${record.ts}">還原</button>
    </div>`)}`;
}

function brokenCopyText() {
  switch (db.brokenCopyStatus()) {
    case "preserved": return "讀不出來的原始內容已經另外留存在這台裝置（最多留最近 3 份），換帳本也不會被蓋掉。";
    case "downloaded": return "讀不出來的原始內容你已經下載了一份。";
    case "failed": return "讀不出來的原始內容沒辦法另外留存在這台裝置（瀏覽器資料庫有問題）。換帳本之前，請先按下面這顆鈕下載一份。";
    case "none": return "";
    default: return "正在把讀不出來的原始內容另外留存…";
  }
}

async function refreshBrokenCopyText() {
  await db.ensureBrokenPreserved();
  const node = document.querySelector("[data-recovery-copy]");
  if (node) node.textContent = brokenCopyText();
}

function recoveryCloudButton() {
  const arm = gist.armState("pull");
  const label = arm === "warming" ? "稍等…" : arm === "armed" ? "再按一次：從雲端還原" : "從雲端拿回備份";
  return html`<button type="button" data-recovery="cloud"${arm === "warming" ? raw(" disabled") : ""}>${label}</button>`;
}

function recoveryGate() {
  const detail = recoveryDetail();
  const cloud = gist.cloudOn();
  return stateGate(
    `這台裝置上的帳本讀不出來${detail ? `（${detail}）` : ""}。可以用下面其中一種方式繼續：`,
    () => { location.reload(); },
    html`<div class="recovery-routes">
      <h2>讀不出來的原始內容</h2>
      <p data-recovery-copy>${brokenCopyText()}</p>
      <button type="button" data-recovery="download-raw">下載讀不出來的原始內容</button>
      <h2>從本機快照還原</h2>
      <p>app 每次記帳後都會自動另存一份快照，選一份最近的，就能回到那時候的樣子。</p>
      <div class="device-list" data-recovery-snapshots>${recoverySnapshotList()}</div>
      <h2>從備份檔還原</h2>
      <p>用以前在家長區下載的帳本備份或完整可攜備份（.json）。</p>
      <button type="button" data-recovery="file">選擇備份檔</button>
      ${cloud ? html`<h2>從 GitHub 雲端拿回</h2>
      <p>用雲端那份備份取代讀不出來的帳本。按一下先讀雲端、告訴你有幾筆紀錄，5 秒內再按一次才會換。</p>
      ${recoveryCloudButton()}
      ${recoveryCloudNote && gist.armState("pull") !== "idle" ? html`<p role="status">${recoveryCloudNote}</p>` : ""}` : ""}
      <h2>另外建立新帳本</h2>
      <p>從頭開始記，新帳本不會有以前的紀錄。${cloud ? "雲端那份備份不會被動到，之後會問你要用哪一份。" : ""}</p>
      <button type="button" data-recovery="new">另外建立新帳本</button>
    </div>`,
  );
}

async function loadRecoverySnapshots() {
  try {
    const list = await db.listSnapshots();
    recoverySnapshots = Array.isArray(list) ? list : false;
  } catch (e) {
    recoverySnapshots = false;
  }
  const container = document.querySelector("[data-recovery-snapshots]");
  if (container) container.innerHTML = String(recoverySnapshotList());
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const route = target.closest("[data-recovery]");
  const snapshot = target.closest("[data-recovery-snapshot]");
  if (route) void runRecoveryRoute(route.getAttribute("data-recovery"), route);
  else if (snapshot) void restoreRecoverySnapshot(Number(snapshot.getAttribute("data-recovery-snapshot")), snapshot);
});

// 換帳本前的關卡：讀不出來的原始內容要先有安全的副本（另外留存成功，或家長已經下載）。
// store.prepareReplace 換的那一刻還會再驗一次；這裡先擋，家長才不會填完表單才被退回。
async function readyToReplace() {
  if (await db.ensureBrokenPreserved()) return true;
  void refreshBrokenCopyText();
  showStatus("讀不出來的原始內容還沒有安全的副本：請先按「下載讀不出來的原始內容」存一份，再換帳本", "error", { ms: 8000 });
  return false;
}

async function downloadBrokenRaw() {
  const text = db.brokenRaw();
  if (text === null) { showStatus("這台裝置上已經沒有讀不出來的內容了", "waiting"); return; }
  const filename = `小小理財島讀不出來的原始內容-${new Date().toISOString().slice(0, 10)}.txt`;
  try {
    const result = await backup.shareOrDownload(text, filename, { type: "text/plain", title: "小小理財島讀不出來的原始內容" });
    if (result === "share" || result === "download") {
      db.markBrokenDownloaded(text);
      showStatus("已經下載讀不出來的原始內容（.txt）", "success");
    } else if (result === "clipboard") {
      showStatus("下載不了，已經把原始內容複製到剪貼簿；請先貼到備忘錄存起來", "waiting", { ms: 8000 });
    }
  } catch (error) {
    showStatus("下載不了讀不出來的原始內容", "error");
  }
  void refreshBrokenCopyText();
}

// 第四條路（驗收 #1）：沿用家長區同一套「從雲端拿回」——第一按只讀、武裝 5 秒，600ms 內的第二按不算；
// 第二按換之前先存「還原前」（帳本讀不出來時就是先確認原始內容有副本），存不進去就取消。
async function pullRecoveryCloud(button) {
  if (gist.armState("pull") === "idle") {
    if (!(await readyToReplace())) return;
    if (button && button.isConnected) { button.disabled = true; button.textContent = "讀取中…"; }
  }
  const result = await gist.pullFromCloud();
  if (result && result.tooSoon) return;
  if (result && result.applied) {
    recoveryCloudNote = "";
    if (location.hash !== "#/") location.hash = "#/"; else void render();
    return;
  }
  recoveryCloudNote = result && result.armed ? `雲端那份有 ${result.activities} 筆紀錄；5 秒內再按一次就會換成雲端那份` : "";
  void render();
}

async function runRecoveryRoute(kind, button) {
  if (kind === "download-raw") { await downloadBrokenRaw(); return; }
  if (kind === "cloud") { await pullRecoveryCloud(button); return; }
  if (kind === "file") {
    if (!(await readyToReplace())) return;
    gist.freezeForLedgerSwap();
    setup.presetMode("restore");
    location.hash = "#/setup";
    return;
  }
  if (kind !== "new") return;
  const cloudNote = gist.cloudOn() ? "雲端那份備份不會被動到，之後會問你要用哪一份。" : "";
  const ok = await confirmDialog(`新帳本會從零開始，以前的紀錄不會出現在新帳本裡。讀不出來的那份會另外留存在這台裝置（或由你先下載一份），不會刪掉；之後如果找到備份檔，還是可以用「從備份檔還原」換回來。${cloudNote}確定要另外建立嗎？`, {
    title: "另外建立新帳本",
    confirmLabel: "另外建立",
  });
  if (!ok) return;
  if (!(await readyToReplace())) return;
  gist.freezeForLedgerSwap();
  if (button && button.isConnected) button.disabled = true;
  setup.presetMode("create");
  location.hash = "#/setup";
}

async function restoreRecoverySnapshot(ts, button) {
  const ok = await confirmDialog(`要用 ${timestampText(ts)} 的快照取代讀不出來的帳本嗎？讀不出來的那份會先另外留存。`, {
    title: "從本機快照還原",
    confirmLabel: "用這份快照還原",
    danger: true,
  });
  if (!ok) return;
  if (!(await readyToReplace())) return;
  if (button && button.isConnected) { button.disabled = true; button.textContent = "還原中…"; }
  try {
    const restored = await db.restoreSnapshot(ts);
    gist.freezeForLedgerSwap();
    await store.replaceState(restored, "還原本機快照");
    showStatus(`已還原到 ${timestampText(ts)} 的樣子`, "success");
    if (location.hash !== "#/") location.hash = "#/"; else void render();
  } catch (error) {
    showStatus(error && error.message ? error.message : "這份快照讀不出來", "error");
    if (button && button.isConnected) { button.disabled = false; button.textContent = "還原"; }
  }
}

// ---------- 每月獎勵 ----------
// 原本每次 GET /api/state 都會跑一次；單機版改成開機與回到前景時各跑一次。
async function runMonthlyRewards() {
  if (!readState()) return;
  try { await store.ensureMonthlySavingsRewards(); } catch (e) {}
}

// ---------- 自動行情 ----------
// 規則照 app/money-state-cache.tsx 的 refreshAutomaticMarketQuotes：
// 有 TWD、四到六位數字代號的持股才問；30 分鐘內最多一次；旗標存 localStorage，換分頁也算數。
const AUTO_QUOTE_RETRY_AFTER_MS = 30 * 60_000;
const AUTO_QUOTE_STORAGE_KEY_PREFIX = "money-island-auto-quote";
let automaticQuoteInFlight = null;
let lastAutomaticQuoteAttemptAt = 0;

async function refreshAutomaticMarketQuotes() {
  const state = readState();
  if (!state) return;
  const hasSupportedHolding = (state.holdings || []).some((holding) =>
    String(holding.currency || "").toUpperCase() === "TWD" && /^\d{4,6}$/.test(String(holding.symbol || "").trim()),
  );
  const storageKey = `${AUTO_QUOTE_STORAGE_KEY_PREFIX}:${(state.family && state.family.id) || "current"}`;
  let storedAttemptAt = 0;
  try {
    storedAttemptAt = Number(window.localStorage.getItem(storageKey)) || 0;
  } catch {
    // Some privacy modes disable local storage; the in-memory guard still applies.
  }
  const mostRecentAttemptAt = Math.max(lastAutomaticQuoteAttemptAt, storedAttemptAt);
  if (!hasSupportedHolding || automaticQuoteInFlight || Date.now() - mostRecentAttemptAt < AUTO_QUOTE_RETRY_AFTER_MS) return;

  lastAutomaticQuoteAttemptAt = Date.now();
  try {
    window.localStorage.setItem(storageKey, String(lastAutomaticQuoteAttemptAt));
  } catch {
    // The quote refresh can safely continue without local storage.
  }
  const request = store.refreshTwseClosingPrices({ mode: "auto" })
    .catch(() => undefined)
    .finally(() => {
      if (automaticQuoteInFlight === request) automaticQuoteInFlight = null;
    });
  automaticQuoteInFlight = request;
  await request;
}

// ---------- 回到前景 ----------
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  void (async () => {
    await runMonthlyRewards();
    await refreshAutomaticMarketQuotes();
  })();
});

// ---------- Service Worker：離線 + 新版提示 ----------
function registerServiceWorker() {
  if ("serviceWorker" in navigator && /^https?:/.test(location.protocol)) {
    addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
      navigator.serviceWorker.addEventListener("message", e => {
        if (e.data && e.data.type === "shell-updated") {
          showStatus("有新版本", "waiting", { ms: 8000, action: "更新", onAction: () => location.reload() });
        }
      });
    });
  }
}

// ---------- 非主畫面模式的提示 ----------
const isStandalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function updateInstallHint() {
  const el = document.getElementById("install-hint");
  if (!el) return;
  const state = readState();
  const dismissed = !!(state && state.meta && state.meta.installHintDismissed);
  el.hidden = !(isIos && !isStandalone && !dismissed);
}

function setupInstallHint() {
  const close = document.getElementById("install-hint-close");
  if (!close) return;
  close.addEventListener("click", () => {
    const el = document.getElementById("install-hint");
    if (el) el.hidden = true;
    const state = readState();
    if (state) {
      if (!state.meta) state.meta = {};
      state.meta.installHintDismissed = true;
      try { store.commit("關閉安裝提示"); } catch (e) {}   // 存不進去時 db.save 自己會提示，頁首也有常駐標記
    }
  });
}

// ---------- 鍵盤 ----------
/* iOS 的鍵盤不會把版面推上去，只會縮小可視範圍，
   所以貼在底部的面板與 sheet 會躲到鍵盤後面。用 visualViewport 自己把它們頂起來。 */
function setupKeyboardLift() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    const lift = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--kb", (lift > 60 ? lift : 0) + "px");
    // 驗收 C5：彈窗開著時吐司貼在畫面上方；鍵盤把可視區往下推（offsetTop）時跟著往下，不被推出可視區
    document.documentElement.style.setProperty("--vv-top", Math.max(0, Math.round(vv.offsetTop || 0)) + "px");
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();
}

/* 第一次互動後跟系統要「持久儲存」：讓 iOS/瀏覽器少一個自動清掉資料的理由。
   要不到也沒關係（Safari 常常自己決定），備份三層還在 */
function askPersist() {
  addEventListener("pointerdown", function askPersistOnce() {
    removeEventListener("pointerdown", askPersistOnce);
    try {
      if (navigator.storage && navigator.storage.persisted) {
        navigator.storage.persisted().then(p => { if (!p && navigator.storage.persist) navigator.storage.persist().catch(() => {}); }).catch(() => {});
      }
    } catch (e) {}
  }, { once: true });
}

// ---------- 開機 ----------
// 讀帳本進 store：讀不出來、或放進去時排序就炸，都當成「讀不出來」（批 1 #7），由 render 顯示出路畫面。
function hydrateFromStorage() {
  bootProblem = "";
  try {
    store.hydrate(db.load());
  } catch (error) {
    bootProblem = error && error.message ? error.message : "內容不是帳本";
    db.markBroken(bootProblem);
    store.hydrate(null);
  }
}

// 另一個分頁改了帳本（批 1 #4）：重讀、重繪；正開著彈窗的話說一聲，免得家長以為自己填的東西被吃掉。
// 驗收 B1：雲端設定（凍結、中斷連線）也一起重讀，不拿記憶體裡的舊設定繼續上傳。
// 驗收 B2：兩個分頁同時存檔、這個分頁那一筆被另一個分頁蓋掉（db 判斷 lostWrite）：明確講出來，不靜默消失。
function reloadFromOtherTab(event, info = {}) {
  const hadModal = isModalOpen();
  gist.reloadGistFromStorage();
  hydrateFromStorage();          // hydrate 會通知 subscribe → refresh 整頁重繪
  if (info.lostWrite) showStatus(db.LOST_WRITE_ERROR, "error", { ms: 9000 });
  else if (hadModal) showStatus("另一個分頁更新了帳本，畫面已重新整理", "waiting", { ms: 6000 });
}

async function boot() {
  // 先把 localStorage 的帳本放進 store（不回寫）；讀不到就維持 null，render 會導去第一次使用。
  hydrateFromStorage();
  // 批 2 B：舊版留在 localStorage 的 .broken 搬進 IndexedDB；確定存進去才移除，存不進去就留著
  void db.migrateLegacyBroken().catch(() => {});
  gist.loadGist();
  gist.setRefreshHandler(() => { void refresh(); });
  store.subscribe(() => { void refresh(); });
  db.watchExternalChanges(reloadFromOtherTab);
  window.addEventListener("hashchange", () => { void render(); });
  registerServiceWorker();
  setupInstallHint();
  setupKeyboardLift();
  askPersist();

  if (readState()) await runMonthlyRewards();
  await render();
  /* 開 app 也排一次，把上次沒傳成的補上；待決的回音先靜默比對。
     帳本讀不出來時不排：沒有東西可以傳，傳了只會蓋掉雲端那份（批 1 #1；syncCloud 自己也會再擋一次） */
  if (gist.cloudOn() && readState()) { gist.retryEcho().catch(() => {}); gist.scheduleCloudSync(); }
  void refreshAutomaticMarketQuotes();
}

void boot();
