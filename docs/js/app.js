// 小小理財島 PWA：路由、開機、每月獎勵、自動行情、Service Worker、安裝提示。
// SW 註冊、shell-updated 提示、visualViewport 鍵盤頂高、storage.persist 照 ../stamps/index.html
// 4006–4039、4088–4097 行搬過來，註解保留。

import * as db from "./db.js";
import * as store from "./store.js";
import * as pin from "./pin.js";
import { derive } from "./state.js";
import * as gist from "./gist.js";
import * as setup from "./ui/setup.js";
import { stateGate, showStatus, closeModal } from "./ui/common.js";

// ---------- 路由表 ----------
// hash 路由：GitHub Pages 沒有伺服器可以改寫網址，所有頁面共用同一份 index.html。
const ROUTES = {
  "#/": { id: "home", load: () => import("./ui/home.js") },
  "#/dreams": { id: "dreams", load: () => import("./ui/dreams.js") },
  "#/history": { id: "history", load: () => import("./ui/history.js") },
  "#/parent": { id: "parent", load: () => import("./ui/parent.js") },
  "#/setup": { id: "setup", module: setup },
};

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
  if (!state.meta) state.meta = {};
  state.meta.selectedProfileId = id;
  try { localStorage.setItem(PROFILE_STORAGE_KEY, id); } catch (e) {}
  void render();
}

export function navigate(hash) {
  if (location.hash === hash) { void render(); return; }
  location.hash = hash;
}

// ---------- 整頁重繪 ----------
// 重繪的時機只有兩種：路由切換、store 提交後（store.subscribe → refresh）。
let rendering = false;
let pendingRender = false;

export async function refresh() { await render(); }

async function render() {
  if (rendering) { pendingRender = true; return; }
  rendering = true;
  try {
    const mount = root();
    if (!mount) return;
    const hash = currentHash();
    const state = readState();

    // 還沒有帳本：一律先走第一次使用。
    if (!state || !Array.isArray(state.profiles)) {
      if (db.hasState()) {
        mount.innerHTML = String(stateGate("這台裝置上的帳本讀不出來，原始內容已另外保留。", () => { location.reload(); }));
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
    closeModal();
    /* 整頁重繪時換掉整個 #app 節點：頁面模組在 mount() 裡綁的事件委派會跟著舊節點一起消失，
       不會每重繪一次就疊一層監聽器（模組自己不用管解綁）。 */
    const next = document.createElement("div");
    next.id = "app";
    next.innerHTML = String(mod.render(ctx));
    mount.replaceWith(next);
    if (typeof mod.mount === "function") mod.mount(next, ctx);
    updateInstallHint();
  } finally {
    rendering = false;
    if (pendingRender) { pendingRender = false; void render(); }
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
      store.commit("關閉安裝提示");
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
async function boot() {
  // 先把 localStorage 的帳本放進 store（不回寫）；讀不到就維持 null，render 會導去第一次使用。
  store.hydrate(db.load());
  gist.loadGist();
  gist.setRefreshHandler(() => { void refresh(); });
  store.subscribe(() => { void refresh(); });
  window.addEventListener("hashchange", () => { void render(); });
  registerServiceWorker();
  setupInstallHint();
  setupKeyboardLift();
  askPersist();

  if (readState()) await runMonthlyRewards();
  await render();
  /* 開 app 也排一次，把上次沒傳成的補上；待決的回音先靜默比對 */
  if (gist.cloudOn()) { gist.retryEcho().catch(() => {}); gist.scheduleCloudSync(); }
  void refreshAutomaticMarketQuotes();
}

void boot();
