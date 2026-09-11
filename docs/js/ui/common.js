// 小小理財島 PWA：共用 UI 元件。
// 這裡的每一支都只做「產生 HTML 字串」或「操作 #toast-root／#modal-root」，不碰業務規則。
// 結構與文案照原專案 app/primary-nav.tsx、status-toast.tsx、info-tip.tsx、profile-avatar.tsx、
// money-state-cache.tsx（MoneyStateGate）；modal 的 inert／focus／Esc 行為照 ../stamps/index.html 1984–2076 行。

import { html, raw, classNames, formatDateTime, errorMessage } from "../util.js";
import * as pin from "../pin.js";

// ---------- 雲端狀態的橋接 ----------
// common.js 不能 import gist.js（gist → store → db → common 會變成循環相依），
// 所以由 gist.js 在載入時把「現在雲端是什麼狀態」掛進來。沒掛＝沒開雲端備份。
let cloudStatusProvider = null;
export function setCloudStatusProvider(fn) { cloudStatusProvider = fn; }
function cloudStatus() {
  try { return cloudStatusProvider ? cloudStatusProvider() : null; } catch (e) { return null; }
}

// ---------- 主要頁面導覽 ----------
// 主線拍板（spec.md 第 9 節，題 1＋2a）：底部貼底列只放孩子每天會用的三個目的地；
// 「家長區」不放進拇指區，改成每頁迷你頂欄右上角的 lockIconButton（見下方）。
const primaryLinks = [
  { id: "home", href: "#/", label: "孩子首頁" },
  { id: "dreams", href: "#/dreams", label: "夢想與回顧" },
  { id: "history", href: "#/history", label: "所有紀錄" },
];

export function primaryNav(active) {
  return html`<nav class="primary-nav" aria-label="主要頁面">${primaryLinks.map((item) => html`<a
      class="${item.id === active ? "is-active" : ""}"
      href="${item.href}"
      ${item.id === active ? raw('aria-current="page"') : ""}
    >${item.label}</a>`)}</nav>`;
}

// ---------- 迷你頂欄 ----------
// miniTopbar({ active, ctx, right })：第 9 節「頂欄」列——四頁共用同一個函式，取代各頁原本
// 手刻的 .topbar／.parent-topbar。品牌小字（左）＋ profileChips()（中，可橫向捲動）＋
// 呼叫端自己組好的 right 插槽（右，例如 lockIconButton() 或加一個「🔍 所有紀錄」小連結）。
// active 只用來決定品牌連結是否標成目前頁（首頁時不需要再點一次自己）。
export function miniTopbar({ active, ctx, right } = {}) {
  const profiles = (ctx && (ctx.profiles || (ctx.state && ctx.state.profiles))) || [];
  const selectedId = ctx && ctx.profile ? ctx.profile.id : null;
  const isHome = active === "home";
  return html`<header class="mini-topbar">
    <a class="mini-topbar-brand" href="#/" aria-label="回到小小理財島首頁" ${isHome ? raw('aria-current="page"') : ""}>
      <span class="brand-mark" aria-hidden="true">¢</span>
      <strong>小小理財島</strong>
    </a>
    <div class="mini-topbar-profiles">${raw(String(profileChips(profiles, selectedId)))}</div>
    <div class="mini-topbar-right">${right ? raw(String(right)) : ""}</div>
  </header>`;
}

// ---------- 情境式解鎖圖示 ----------
// lockIconButton({ href, pinStatus })：規格 1.2／3.3／第 9 節 2b。
// href 有值 → 純連結（首頁用，直接導去 #/parent，不開 modal）；
// 沒有 href → 按鈕，帶 data-action="open-lock"，頁面模組自己接這個委派去呼叫
// createLockModal() 回傳的 open()（dreams／history 用，開情境式解鎖 modal）。
export function lockIconButton({ href, pinStatus } = {}) {
  const unlocked = pinStatus === "unlocked";
  const icon = unlocked ? "🔓" : "🔒";
  if (href) {
    return html`<a class="icon-lock-btn" href="${href}" aria-label="家長區">${icon}</a>`;
  }
  return html`<button
    type="button"
    class="icon-lock-btn"
    data-action="open-lock"
    aria-label="${unlocked ? "家長區（已解鎖）" : "家長區（未解鎖，點一下輸入操作碼）"}"
  >${icon}</button>`;
}

// ---------- 情境式解鎖 modal ----------
// createLockModal({ getPinStatus, onUnlocked, parentHref })：規格 1.2（回應手機裁判擋下：
// 新 modal 沒有重繪存活機制）。回傳 { open(), mountCheck(ctx), reset() }，供 dreams.js／history.js
// 各自在自己的模組作用域建一份（狀態彼此獨立，不共用）：
//
//   const lockModal = common.createLockModal({
//     getPinStatus: () => currentCtx.pinStatus,
//     onUnlocked: () => currentCtx.refresh(),
//     parentHref: "#/parent",
//   });
//   // 點 .icon-lock-btn 的地方：lockModal.open();
//   // 自己的 mount(root, ctx) 裡：currentCtx = ctx; lockModal.mountCheck(ctx);
//
// 內部用 module-scope（其實是這個閉包的作用域，效果等同 1.2 節骨架裡的
// lockModalOpen／lockPin／lockError／lockModalKind）記住「該不該開」與「已輸入但還沒送出的值」，
// mount() 觸發的 mountCheck() 檢查「該開卻沒開」就重新叫 openModal 並回填欄位——
// 這是本次新增 modal 的硬性規定，不是這一份特例。
// submit 成功只呼叫 onUnlocked()（頁面模組裡就是 ctx.refresh()），不用另外呼叫 closeModal()：
// ctx.refresh() 會觸發 app.js 的 render()，裡面無條件的 closeModal() 已經涵蓋這一步。
export function createLockModal({ getPinStatus, onUnlocked, parentHref } = {}) {
  let wantOpen = false;   // 是否「應該」開著（不是 DOM 目前開不開）
  let value = "";         // 已輸入但還沒送出的操作碼，重繪後要回填
  let error = "";
  let kind = "";          // "" | "lock"，跟 isModalOpen() 分開判斷，理由同 home.js

  function panelMarkup() {
    const pinStatus = typeof getPinStatus === "function" ? getPinStatus() : "locked";
    const unlocked = pinStatus === "unlocked";
    const heading = pinStatus === "setup" ? "第一次設定家長操作碼" : unlocked ? "家長區已解鎖" : "輸入家長操作碼";
    const hint = pinStatus === "setup"
      ? "使用 4–8 位數字；操作碼不會顯示在孩子頁面。"
      : unlocked
        ? "現在可以使用家長功能。"
        : "解鎖後才能看到家長專屬的編輯與刪除。";
    return html`<div class="${classNames("parent-lock-card lock-modal-card", unlocked && "is-unlocked")}">
      <span class="lock-icon" aria-hidden="true">${unlocked ? "✓" : "🔒"}</span>
      <div><b id="lock-modal-title">${heading}</b><small>${hint}</small></div>
      ${!unlocked ? html`<form data-lock-form>
        <label class="sr-only" for="lock-modal-pin">家長操作碼</label>
        <input id="lock-modal-pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" value="${value}" placeholder="4–8 位數字" required />
        <button data-busy-label="驗證中…">${pinStatus === "setup" ? "設定並解鎖" : "解鎖"}</button>
      </form>` : ""}
      ${error ? html`<p class="form-error" role="alert">${error}</p>` : ""}
      ${parentHref ? html`<a class="lock-modal-parent-link" href="${parentHref}">前往家長區 →</a>` : ""}
    </div>`;
  }

  function setFieldError(form, message) {
    const existing = form.querySelector(".form-error");
    if (!message) { if (existing) existing.remove(); return; }
    if (existing) { existing.textContent = message; return; }
    const node = document.createElement("p");
    node.className = "form-error";
    node.setAttribute("role", "alert");
    node.textContent = message;
    form.insertAdjacentElement("afterend", node);
  }

  async function submit(form) {
    const pinStatus = typeof getPinStatus === "function" ? getPinStatus() : "locked";
    const button = form.querySelector("button");
    const busyLabel = button && button.dataset.busyLabel;
    const idleLabel = button ? button.textContent : "";
    if (button) { button.disabled = true; if (busyLabel) button.textContent = busyLabel; }
    try {
      if (pinStatus === "setup") await pin.setup(value); else await pin.assert(value);
      wantOpen = false;
      value = "";
      error = "";
      setFieldError(form, "");
      if (typeof onUnlocked === "function") onUnlocked();
      // 只呼叫 onUnlocked()：它觸發的 render() 裡的 closeModal() 已經會把這個 modal 收掉，
      // 這裡不用、也不該再手動呼叫 closeModal()（見 1.2 節明文規定）。
    } catch (caught) {
      error = errorMessage(caught, "操作碼不正確");
      setFieldError(form, error);
      if (button && button.isConnected) { button.disabled = false; button.textContent = idleLabel; }
    }
  }

  function openNow() {
    const dialog = openModal(panelMarkup(), {
      labelledBy: "lock-modal-title",
      onClose: (reason) => {
        if (kind !== "lock") return;
        kind = "";
        // 背景重繪（reason === "rerender"）不算使用者關閉：留著 wantOpen，mountCheck 會補開並回填。
        if (reason !== "rerender") wantOpen = false;
      },
    });
    if (!dialog) return;
    kind = "lock";
    dialog.addEventListener("input", (event) => {
      const target = event.target;
      if (!target || !target.matches || !target.matches("#lock-modal-pin")) return;
      // 照舊版 dreams.js：打字過程就只留數字
      const cleaned = target.value.replace(/\D/g, "");
      if (cleaned !== target.value) target.value = cleaned;
      value = cleaned;
    });
    const form = dialog.querySelector("[data-lock-form]");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void submit(form);
      });
      const input = form.querySelector("#lock-modal-pin");
      if (input) input.focus();
    }
  }

  return {
    // 點 .icon-lock-btn 時呼叫：標記「該開」並立刻開（除非已經開著）。
    open() {
      wantOpen = true;
      value = "";
      error = "";
      if (kind !== "lock") openNow();
    },
    // 頁面模組自己的 mount(root, ctx) 裡呼叫：重繪後如果「該開卻沒開」，補開並回填欄位值。
    // 接受 ctx 只是配合頁面模組 mount(root, ctx) 的呼叫慣例；實際讀取的 pinStatus／onUnlocked
    // 都是建立時傳進來的 getter/callback（它們自己會讀頁面模組當下最新的 ctx）。
    mountCheck(_ctx) {
      if (wantOpen && kind !== "lock") openNow();
    },
    // 離開情境（例如換小朋友、換頁）時可以呼叫，清空未送出的輸入與錯誤訊息。
    reset() {
      wantOpen = false;
      value = "";
      error = "";
      kind = "";
    },
  };
}

// ---------- 頭像 ----------
// emoji 直接輸出；data:image/、https:// 是照片；舊站的 /api/profile-photo 在單機版沒有照片可拿，改用 🙂。
export function profileAvatar(avatar, name) {
  const value = String(avatar || "");
  if (value.startsWith("data:image/") || value.startsWith("https://")) {
    return html`<img class="profile-avatar-image" src="${value}" alt="${name ? `${name}的照片` : ""}" width="96" height="96" loading="lazy" decoding="async">`;
  }
  if (value.startsWith("/api/profile-photo")) return html`🙂`;
  return html`${value}`;
}

// ---------- InfoTip ----------
export function infoTip(content, options = {}) {
  const label = options.label || "查看說明";
  const align = options.align === "right" ? "right" : "left";
  return html`<details class="info-tip info-tip-${align}"><summary aria-label="${label}" title="${label}">❔</summary><div class="info-tip-popover" role="note">${content}</div></details>`;
}

// ---------- 狀態吐司 ----------
const toneIcons = { success: "✓", waiting: "⌛", error: "!" };
let toastTimer = 0;
let toastAction = null;

function toastRoot() {
  return document.getElementById("toast-root");
}

// showStatus(message, tone, { ms, action, onAction })
// action／onAction 是搬 stamps 的雲端提示（「去看」「更新」）時必要的，原 StatusToast 沒有這一顆。
export function showStatus(message, tone = "success", options = {}) {
  const root = toastRoot();
  if (!root) return;
  const clean = String(message == null ? "" : message).trim();
  if (!clean) return;
  const kind = toneIcons[tone] ? tone : "success";
  toastAction = typeof options.onAction === "function" ? options.onAction : null;
  root.innerHTML = String(html`<div class="status-toast is-${kind}" role="${kind === "error" ? "alert" : "status"}" aria-live="${kind === "error" ? "assertive" : "polite"}" aria-atomic="true">
    <span class="status-toast-icon" aria-hidden="true">${toneIcons[kind]}</span>
    <strong>${clean}</strong>
    ${options.action ? html`<button type="button" class="status-toast-action" data-toast-action>${options.action}</button>` : ""}
    <button type="button" class="status-toast-close" aria-label="關閉提示" data-toast-close>×</button>
  </div>`);
  clearTimeout(toastTimer);
  const ms = Number(options.ms) || (kind === "error" ? 7000 : 4500);
  toastTimer = setTimeout(dismissStatus, ms);
}

export function dismissStatus() {
  clearTimeout(toastTimer);
  toastAction = null;
  const root = toastRoot();
  if (root) root.innerHTML = "";
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-toast-close]")) { dismissStatus(); return; }
  /* 先把 toast 收掉再執行動作：不然動作裡新跳的提示會被這一行立刻關掉 */
  if (target.closest("[data-toast-action]")) {
    const fn = toastAction;
    dismissStatus();
    if (fn) fn();
  }
});

// ---------- Modal ----------
// 收起的面板只是被移除，但開著的時候背景要真的關起來：不設 inert 的話，外接鍵盤 Shift+Tab
// 可以走到被蓋住的按鈕上（stamps 第四輪列為未修的那一條）。#toast-root 在 #app 外面，吐司上的
// 「去看／更新」不會被鎖住。
let modalSession = null;   // { onClose, opener }

function backdropInert(on) {
  for (const id of ["app", "install-hint"]) {
    const el = document.getElementById(id);
    if (el) try { el.inert = !!on; } catch (e) {}
  }
}

// openModal(htmlString, { labelledBy, onClose, className })
// 回傳 .modal 節點，呼叫端自己綁事件。關閉鈕由這裡畫，內容不用再放一顆。
export function openModal(content, options = {}) {
  const root = document.getElementById("modal-root");
  if (!root) return null;
  if (modalSession) closeModal();
  const opener = document.activeElement;
  root.innerHTML = String(html`<div class="modal-backdrop" role="presentation" data-modal-backdrop>
    <div class="${classNames("modal", options.className)}" role="dialog" aria-modal="true" ${options.labelledBy ? raw(`aria-labelledby="${options.labelledBy}"`) : ""}>
      <button type="button" class="modal-close" data-modal-close aria-label="關閉">×</button>
      ${raw(String(content))}
    </div>
  </div>`);
  modalSession = { onClose: typeof options.onClose === "function" ? options.onClose : null, opener };
  backdropInert(true);
  const dialog = root.querySelector(".modal");
  /* 焦點帶進對話框，輔助科技才不會還停在被遮住的按鈕上 */
  const first = dialog && (dialog.querySelector("[autofocus]") || dialog.querySelector("input, select, textarea, button:not(.modal-close)"));
  try { (first || dialog).focus({ preventScroll: true }); } catch (e) {}
  return dialog;
}

// closeModal(reason)：reason 會原樣傳給 onClose。app.js 每次整頁重繪前會用 "rerender" 關掉
// 開著的 modal；頁面模組的 onClose 看到 "rerender" 時只清「DOM 目前開著」的旗標，
// 不清「應該開著」的旗標，mount() 才能把 modal 補開並回填輸入（規格 1.2／3.2 的存活機制）。
// 使用者主動關（關閉鈕、背景、Esc）reason 為 undefined，兩個旗標都清。
export function closeModal(reason) {
  const root = document.getElementById("modal-root");
  const session = modalSession;
  modalSession = null;
  if (root) root.innerHTML = "";
  backdropInert(false);
  if (session) {
    const back = session.opener;
    /* 開啟後畫面可能重繪過，原節點已失連：只在還連著的時候把焦點還回去，
       不然焦點會掉到 body */
    if (back && back.isConnected) { try { back.focus({ preventScroll: true }); } catch (e) {} }
    if (session.onClose) session.onClose(reason);
  }
}

export function isModalOpen() { return !!modalSession; }

document.addEventListener("mousedown", (event) => {
  if (!modalSession) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.hasAttribute("data-modal-backdrop")) closeModal();
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-modal-close]")) closeModal();
});

/* Esc（外接鍵盤／switch control）也能關 */
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (modalSession) closeModal();
});

/* 保險絲：面板若在關閉前拋例外，inert 可能留著把整個主畫面鎖死——回到前景時沒有 modal 就放行 */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !modalSession) backdropInert(false);
});

// 用 modal 做的確認框（不用 window.confirm：iOS 的 PWA 會把它畫成瀏覽器對話框，很嚇人）
export function confirmDialog(message, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const dialog = openModal(html`<h2 id="confirm-dialog-title">${options.title || "請確認"}</h2>
      <p class="confirm-dialog-copy">${message}</p>
      <div class="confirm-dialog-actions">
        <button type="button" class="secondary-button" data-confirm-cancel>${options.cancelLabel || "取消"}</button>
        <button type="button" class="primary-button" data-confirm-ok autofocus>${options.confirmLabel || "確定"}</button>
      </div>`, {
      labelledBy: "confirm-dialog-title",
      className: "confirm-dialog",
      onClose: () => finish(false),
    });
    if (!dialog) { finish(false); return; }
    dialog.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-confirm-ok]")) { finish(true); closeModal(); }
      else if (target.closest("[data-confirm-cancel]")) { finish(false); closeModal(); }
    });
  });
}

// ---------- 小朋友切換列 ----------
// render 產生字串、mount 才綁事件的模型下沒辦法直接把 onChoose 掛上去，
// 所以按鈕帶 data-picker 編號，這裡用事件委派派回對應的 callback。
let pickerSerial = 0;
const pickerHandlers = new Map();

function prunePickers() {
  for (const key of Array.from(pickerHandlers.keys())) {
    if (!document.querySelector(`[data-picker="${key}"]`)) pickerHandlers.delete(key);
  }
}

// profilePicker(profiles, selectedId, onChoose, { variant: "chip" | "parent", label, caption })
// variant "chip"＝首頁 topbar 那一排；variant "parent"＝家長區 parent-profile 那一排。
// 每顆按鈕都帶 data-choose-profile="<id>"：頁面模組要自己接（像 dreams／history 那樣）也可以，
// 不傳 onChoose 就不會走這裡的委派。
export function profilePicker(profiles, selectedId, onChoose, options = {}) {
  prunePickers();
  pickerSerial += 1;
  const key = `p${pickerSerial}`;
  if (typeof onChoose === "function") pickerHandlers.set(key, onChoose);
  const list = Array.isArray(profiles) ? profiles : [];
  const caption = typeof options.caption === "function" ? options.caption : null;

  if (options.variant === "parent") {
    return html`<div class="${classNames("parent-profile-row", options.className)}" aria-label="${options.label || "選擇要編輯的小朋友"}">${list.map((item) => {
      const active = item.id === selectedId;
      const text = caption ? caption(item, active) : "";
      return html`<div class="parent-profile-shell" style="--profile-color: ${item.accent}"><button
        type="button"
        class="${active ? "parent-profile is-active" : "parent-profile"}"
        data-picker="${key}"
        data-profile-id="${item.id}"
        aria-pressed="${active ? "true" : "false"}"
      ><span>${profileAvatar(item.avatar, item.name)}</span><b>${item.name}</b>${text ? html`<small>${text}</small>` : ""}</button></div>`;
    })}</div>`;
  }

  return html`<div class="top-profile-picker" aria-label="${options.label || "切換小朋友"}">
    <span class="profile-label">${options.title || "今天是誰？"}</span>
    <div class="profile-switcher">${list.map((item) => {
      const active = item.id === selectedId;
      return html`<button
        type="button"
        class="${active ? "profile-chip is-active" : "profile-chip"}"
        data-picker="${key}"
        data-profile-id="${item.id}"
        aria-pressed="${active ? "true" : "false"}"
        aria-label="切換到${item.name}"
        style="--profile-color: ${item.accent}"
      ><span>${profileAvatar(item.avatar, item.name)}</span><b>${item.name}</b></button>`;
    })}</div>
  </div>`;
}

// 契約第 15 節的兩個名字：頁面模組自己接 data-choose-profile 委派，不經過 pickerHandlers。
export function profileChips(profiles, selectedId) {
  return html`<div class="top-profile-picker" aria-label="切換小朋友">
    <span class="profile-label">今天是誰？</span>
    <div class="profile-switcher">${(profiles || []).map((item) => {
      const active = item.id === selectedId;
      return html`<button type="button" class="${active ? "profile-chip is-active" : "profile-chip"}" data-choose-profile="${item.id}" aria-pressed="${active ? "true" : "false"}" aria-label="切換到${item.name}" style="--profile-color: ${item.accent}"><span>${profileAvatar(item.avatar)}</span><b>${item.name}</b></button>`;
    })}</div>
  </div>`;
}

export function profileRow(profiles, selectedId, subtitleOf, className) {
  return html`<section class="${classNames("parent-profile-row", className)}">${(profiles || []).map((item) => {
    const active = item.id === selectedId;
    const text = typeof subtitleOf === "function" ? subtitleOf(item, active) : "";
    return html`<button type="button" class="${active ? "parent-profile is-active" : "parent-profile"}" data-choose-profile="${item.id}" aria-pressed="${active ? "true" : "false"}" style="--profile-color: ${item.accent}"><span>${profileAvatar(item.avatar)}</span><b>${item.name}</b>${text ? html`<small>${text}</small>` : ""}</button>`;
  })}</section>`;
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("[data-picker][data-profile-id]");
  if (!button) return;
  const handler = pickerHandlers.get(button.getAttribute("data-picker"));
  if (handler) handler(button.getAttribute("data-profile-id"));
});

// ---------- 開機／錯誤畫面 ----------
let retryHandler = null;

// stateGate(error, onRetry)：error 為空＝載入骨架；有 error＝錯誤卡加「再試一次」。
export function stateGate(error, onRetry) {
  retryHandler = typeof onRetry === "function" ? onRetry : null;
  return html`<main class="money-state-gate" aria-live="polite">
    <div class="money-state-gate-card">
      <span class="brand-mark" aria-hidden="true">¢</span>
      ${error
        ? html`<h1>暫時讀不到家庭帳本</h1><p>${error}</p>${onRetry ? html`<button type="button" data-state-retry>再試一次</button>` : ""}`
        : html`<div class="state-skeleton state-skeleton-title"></div>
          <div class="state-skeleton"></div>
          <div class="state-skeleton state-skeleton-short"></div>
          <span class="sr-only">正在讀取家庭帳本</span>`}
    </div>
  </main>`;
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!target.closest("[data-state-retry]")) return;
  const fn = retryHandler;
  if (fn) fn();
});

// ---------- 儲存狀態文案 ----------
// 原本的「等待第一次備份／剛剛已備份／…已備份」在單機版改講「儲存」；
// 開了 Gist 才在後面加雲端狀態。
export function backupStatusText(state) {
  const health = state && state.backupHealth;
  if (health && health.status === "failed" && health.message) return health.message;
  const value = state && state.latestBackup ? state.latestBackup.createdAt : "";
  let base;
  if (!value) base = "等待第一次儲存";
  else if (Date.now() - new Date(value).getTime() < 60000) base = "剛剛已儲存";
  else base = `${new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Taipei" }).format(new Date(value))} 已儲存`;
  const cloud = cloudStatus();
  if (!cloud) return base;
  return `${base} · ${cloud === "synced" ? "雲端已同步" : "雲端待同步"}`;
}

// savedStatus(state, message)：Gist 開啟且同步失敗時才加後綴。
export function savedStatus(state, message) {
  if (cloudStatus() === "failed") return { message: `${message}；雲端備份稍後重試`, tone: "waiting" };
  return { message, tone: "success" };
}

// 備份檔／快照卡片上的時間，統一走 util 的台北時區格式
export function timestampText(value) {
  try { return formatDateTime(value); } catch (e) { return String(value || ""); }
}
