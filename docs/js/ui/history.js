// 小小理財島 PWA：所有紀錄（移植自 app/history/page.tsx）。
// DOM、class、aria、文案照原頁；資料改由 store.getActivitiesPage 同步取得，401 導向刪除。
// 手機版重新設計（notes/mobile-redesign/spec.md 第 2.3、9 節）：頂欄改用 common.miniTopbar，
// 家長解鎖收成情境式 icon-lock-btn，點擊開本檔原有的 lockPanel(pinStatus) 表單片段包進
// common.openModal()（規格 2.3 節「直接沿用」，不改標題／提示句／按鈕文字），套用 1.2 節給的
// lockModalOpen／lockPin／lockError／lockModalKind 存活骨架，篩選列沿用共用層修好的 650px 斷點，
// 列表改成 groupByMonth 純前端分組＋sticky 月份標頭，編輯／刪除鈕只在 unlocked 時才產出 DOM，
// PAGE_SIZE 40→16。
import { html, money, formatMonthLabel, errorMessage } from "../util.js";
import * as common from "./common.js";
import * as store from "../store.js";
import * as appState from "../state.js";
import * as pin from "../pin.js";

const PAGE_SIZE = 16; // 規格 2.3 第 7 項：40→16，「載入更多」更快出現
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1'])";
const DELETABLE_APP_KINDS = ["allowance", "spend", "reward", "dream", "savings-transfer"];

// 頁面自己的 UI 狀態：重繪後由 render 讀回（架構契約第 2 節）。
let query = "";
let kind = "all";
let pagesLoaded = 1;
let editingId = "";
let modalOpen = false;
let formError = "";
let listError = "";
let lastProfileId = "";
let searchTimer = 0;
let pageActivities = [];
let currentCtx = null;

// 情境式解鎖（規格 1.2／2.3／3.3／第 9 節「頂欄」列）：module-scope 存活骨架，重繪後
// mount() 裡的 mountCheck 邏輯會補開並回填欄位，不會被無聲清空。
let lockModalOpen = false;   // 是否「應該」開著（不是 DOM 目前開不開）
let lockPin = "";            // 已輸入但還沒送出的操作碼，重繪後要回填
let lockError = "";
let lockModalKind = "";      // "" | "lock"，跟 common.isModalOpen() 分開判斷，理由同 home.js

// ---------- 移植自原檔的三支純函式 ----------
// 原檔的 kindName 對照表已經搬到 state.js（KIND_NAMES／kindName），這裡直接用。
const kindName = appState.kindName;

function historyIcon(value) {
  if (value === "spend") return "−";
  if (value === "reward") return "★";
  if (value === "savings-transfer") return "🌱";
  if (["stock-buy", "etf", "market-update"].includes(value)) return "↗";
  if (value === "harvest") return "福";
  if (value === "dream") return "☁";
  return "+";
}

function deltaText(item) {
  const parts = [];
  if (item.spendDelta) parts.push(`撲滿 ${item.spendDelta > 0 ? "+" : ""}${item.spendDelta}`);
  if (item.bankDelta) parts.push(`爸媽銀行 ${item.bankDelta > 0 ? "+" : ""}${item.bankDelta}`);
  if (item.marketDelta) parts.push(`ETF 小森林 ${item.marketDelta > 0 ? "+" : ""}${item.marketDelta}`);
  return parts.join(" · ") || "沒有改變餘額";
}

// 規格 3.4：純前端依 entryDate 年月分組，不動 store.getActivitiesPage。
function groupByMonth(activities) {
  const groups = [];
  let currentKey = "";
  for (const item of activities) {
    const key = item.entryDate.slice(0, 7); // "2026-09"
    if (key !== currentKey) { groups.push({ key, items: [] }); currentKey = key; }
    groups[groups.length - 1].items.push(item);
  }
  return groups;
}

// ---------- 讀資料 ----------
// 已載入的頁數放在 pagesLoaded；每次繪製都重新查，避免快取與 store 提交後不同步。
function readPage(profileId) {
  let activities = [];
  let total = 0;
  let nextOffset = null;
  let kinds = [];
  try {
    let offset = 0;
    for (let page = 0; page < pagesLoaded; page += 1) {
      const result = store.getActivitiesPage({ profileId, query, kind, offset, limit: PAGE_SIZE });
      activities = activities.concat(result.activities || []);
      total = Math.max(0, Number(result.total ?? activities.length));
      kinds = result.kinds || [];
      nextOffset = result.nextOffset ?? null;
      if (nextOffset === null) break;
      offset = nextOffset;
    }
    listError = "";
  } catch (caught) {
    activities = [];
    total = 0;
    nextOffset = null;
    kinds = [];
    listError = errorMessage(caught, "暫時無法讀取所有紀錄");
  }
  pageActivities = activities;
  return { activities, total, nextOffset, kinds };
}

function findActivity(id) {
  return pageActivities.find((item) => item.id === id) || null;
}

function isDeletable(item) {
  return (item.source === "app" && DELETABLE_APP_KINDS.includes(item.kind))
    || (item.source === "parent" && item.kind === "piggy-adjustment");
}

// ---------- 繪製 ----------
function profileButtons(profiles, profile, total) {
  return profiles.map((item) => {
    const active = item.id === profile.id;
    return html`<button aria-pressed="${active ? "true" : "false"}" class="${active ? "parent-profile is-active" : "parent-profile"}" data-choose-profile="${item.id}" style="--profile-color: ${item.accent}"><span>${common.profileAvatar(item.avatar)}</span><b>${item.name}</b><small>${active ? `${total} 筆紀錄` : "選擇查看"}</small></button>`;
  });
}

function controls(kinds) {
  const options = kinds.map((item) => html`<option value="${item}"${kind === item ? " selected" : ""}>${kindName(item)}</option>`);
  return html`<aside class="history-controls"><h2>篩選紀錄</h2><label>搜尋<input data-history-search value="${query}" placeholder="名稱、備註或日期" /></label><label>紀錄類型<select data-history-kind><option value="all"${kind === "all" ? " selected" : ""}>全部類型</option>${options}</select></label>${formError ? html`<p class="form-error" role="alert">${formError}</p>` : ""}</aside>`;
}

// 規格 2.3 第 6 項：編輯／刪除鈕只在 unlocked 時才產出這段 DOM（不是渲染出來再 disabled）。
function activityRow(item, pinStatus) {
  const unlocked = pinStatus === "unlocked";
  const deletable = isDeletable(item);
  const deleteHelp = deletable ? "刪除並撤銷餘額變化" : "請到對應家長功能調整";
  const actions = unlocked
    ? html`<div class="history-actions"><button title="編輯紀錄說明" data-action="edit" data-id="${item.id}">編輯</button><button class="delete-record"${deletable ? "" : " disabled"} title="${deleteHelp}" aria-label="${`刪除「${item.label}」：${deleteHelp}`}" data-action="delete" data-id="${item.id}">刪除</button></div>`
    : "";
  return html`<article class="history-row"><span class="timeline-dot kind-${item.kind}">${historyIcon(item.kind)}</span><div><b>${item.label}</b><small>${item.entryDate} · ${kindName(item.kind)} · ${item.note || "沒有備註"}</small><i>${deltaText(item)}</i></div><strong>${item.amount ? money(item.amount) : "—"}</strong>${actions}</article>`;
}

function listSection(page, pinStatus) {
  const groups = groupByMonth(page.activities);
  const rows = groups.map((group) => html`<h3 class="history-month-header">${formatMonthLabel(group.key)}</h3>${group.items.map((item) => activityRow(item, pinStatus))}`);
  const empty = page.activities.length ? "" : html`<p class="empty-history">沒有符合條件的紀錄。</p>`;
  const more = page.nextOffset !== null
    ? html`<button class="load-more-button" type="button" data-action="load-more">${`載入更多（已顯示 ${page.activities.length}／${page.total}）`}</button>`
    : "";
  return html`<div class="history-heading"><div><span class="parent-kicker">符合條件</span><h2>${page.total} 筆紀錄</h2></div>${common.infoTip("先解鎖家長編輯即可修改說明。只有能安全撤銷餘額變化的紀錄可在這裡刪除；持股、專案與匯入資料請到對應家長功能調整。", { label: "編輯與刪除說明" })}</div>${listError ? html`<p class="form-error" role="alert">${listError}</p>` : ""}${rows}${empty}${more}`;
}

export function render(ctx) {
  currentCtx = ctx;
  const profile = ctx.profile;
  if (!ctx.state || !profile) return common.stateGate("", () => ctx.refresh());
  if (profile.id !== lastProfileId) {
    lastProfileId = profile.id;
    pagesLoaded = 1;
  }
  const pinStatus = ctx.pinStatus || pin.status();
  const profiles = ctx.profiles || ctx.state.profiles || [];
  const page = readPage(profile.id);
  return html`<main class="history-shell" data-kid="${profile.id}" style="--kid-accent: ${profile.accent}">${common.miniTopbar({ active: "history", ctx, right: common.lockIconButton({ pinStatus }) })}<section class="history-hero"><h1><span class="heading-avatar">${common.profileAvatar(profile.avatar)}</span>${profile.name}的錢，<em>每一步都有故事。</em></h1></section><section class="parent-profile-row history-profiles">${profileButtons(profiles, profile, page.total)}</section><section class="history-layout">${controls(page.kinds)}<section class="history-list">${listSection(page, pinStatus)}</section></section>${common.primaryNav("history")}</main>`;
}

// ---------- 局部更新（不整頁重繪，才不會把使用者踢出搜尋框） ----------
function syncList({ focusLoadMore = false } = {}) {
  const ctx = currentCtx;
  const section = document.querySelector(".history-list");
  if (!ctx || !ctx.profile || !section) return;
  const pinStatus = ctx.pinStatus || pin.status();
  const page = readPage(ctx.profile.id);
  section.innerHTML = String(listSection(page, pinStatus));
  const activeSubtitle = document.querySelector(".history-profiles .parent-profile.is-active small");
  if (activeSubtitle) activeSubtitle.textContent = `${page.total} 筆紀錄`;
  if (focusLoadMore) {
    const button = section.querySelector(".load-more-button");
    if (button) button.focus();
  }
}

function reloadList() {
  pagesLoaded = 1;
  syncList();
}

function syncErrorNode(host, message, before) {
  if (!host) return;
  const existing = host.querySelector(":scope > .form-error");
  if (!message) {
    if (existing) existing.remove();
    return;
  }
  const node = existing || document.createElement("p");
  node.className = "form-error";
  node.setAttribute("role", "alert");
  node.textContent = message;
  if (!existing) {
    if (before) host.insertBefore(node, before);
    else host.append(node);
  }
}

// 原頁的 error 同時出現在側欄與編輯視窗；這裡兩處一起更新。
function setFormError(message) {
  formError = message;
  syncErrorNode(document.querySelector(".history-controls"), message, null);
  const form = document.querySelector("#modal-root form");
  if (form) syncErrorNode(form, message, form.querySelector(".primary-button"));
}

// ---------- 情境式解鎖 modal ----------
// 規格 2.3 節：「history.js 已有 lockPanel(pinStatus) 函式，直接沿用其表單片段包進
// openModal()」——標題／提示句／按鈕文字整段照抄原檔（曾經內嵌在 .history-controls 側欄
// 裡的版本），只新增 id 供 aria-labelledby，以及第 9 節新規定的「前往家長區 →」連結
// （原本沒有的新內容，不是文案被改寫）。
function lockPanel(pinStatus) {
  const heading = pinStatus === "unlocked" ? "家長編輯已解鎖" : pinStatus === "setup" ? "第一次設定家長碼" : "家長編輯已上鎖";
  const form = pinStatus === "unlocked" ? "" : html`<form data-history-pin-form><label class="sr-only" for="history-parent-pin">家長操作碼</label><input id="history-parent-pin" aria-describedby="history-pin-help" type="password" inputmode="numeric" pattern="[0-9]{4,8}" value="${lockPin}" placeholder="4–8 位數字" required /><span class="sr-only" id="history-pin-help">輸入四到八位數字，解鎖編輯與可撤銷紀錄的刪除功能。</span><button>解鎖</button></form>`;
  return html`<div class="${pinStatus === "unlocked" ? "history-lock is-unlocked" : "history-lock"}"><div class="history-lock-heading"><span aria-hidden="true">${pinStatus === "unlocked" ? "✓" : "🔒"}</span><b id="history-lock-title">${heading}</b></div>${form}${lockError ? html`<p class="form-error" role="alert">${lockError}</p>` : ""}<a class="lock-modal-parent-link" href="#/parent">前往家長區 →</a></div>`;
}

// common.openModal 已經處理 backdrop、Esc、inert 與焦點還原，這裡只綁 input／submit。
function openLockModal() {
  const pinStatus = currentCtx ? (currentCtx.pinStatus || pin.status()) : "locked";
  const dialog = common.openModal(String(lockPanel(pinStatus)), {
    labelledBy: "history-lock-title",
    onClose: (reason) => {
      if (lockModalKind !== "lock") return;
      lockModalKind = "";
      if (reason !== "rerender") lockModalOpen = false;   // 背景重繪留著，mount() 補開並回填
    },
  });
  if (!dialog) {
    lockModalOpen = false;
    return;
  }
  lockModalKind = "lock";
  dialog.addEventListener("input", (event) => {
    const target = event.target;
    if (!target || !target.matches || !target.matches("#history-parent-pin")) return;
    const cleaned = target.value.replace(/\D/g, "");
    if (cleaned !== target.value) target.value = cleaned;
    lockPin = cleaned;
  });
  const form = dialog.querySelector("[data-history-pin-form]");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitLock(form);
    });
    const input = form.querySelector("#history-parent-pin");
    if (input) input.focus();
  }
}

// 規格 1.2 明文規定：驗證成功只呼叫 ctx.refresh()，不要另外呼叫 closeModal()——
// render() 裡無條件的 closeModal() 已經涵蓋關閉這一步。
async function submitLock(form) {
  const button = form.querySelector("button");
  const input = form.querySelector("#history-parent-pin");
  const value = input ? input.value : lockPin;
  const pinStatus = currentCtx ? (currentCtx.pinStatus || pin.status()) : "locked";
  const panel = form.closest(".history-lock");
  const link = panel ? panel.querySelector(".lock-modal-parent-link") : null;
  lockError = "";
  syncErrorNode(panel, "", link);
  if (button) {
    button.disabled = true;
    button.textContent = "驗證中…";
  }
  try {
    if (pinStatus === "setup") await pin.setup(value);
    else await pin.assert(value);
    lockPin = value;
    lockModalOpen = false;
    lockError = "";
    if (currentCtx) currentCtx.refresh();
  } catch (caught) {
    lockError = errorMessage(caught, "操作碼驗證失敗");
    syncErrorNode(panel, lockError, link);
    if (button && button.isConnected) {
      button.disabled = false;
      button.textContent = "解鎖";
    }
  }
}

// ---------- 編輯視窗 ----------
// common.openModal 已經處理 backdrop、Esc、inert 與焦點還原，也自己畫關閉鈕；
// 這裡只補原頁有、common 沒有的 Tab 焦點圈與關閉鈕的 aria-label。
function trapTab(event) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const scope = event.currentTarget;
  const focusable = Array.from(scope.querySelectorAll(FOCUSABLE));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// 編輯到一半的值：背景重繪把 modal 關掉時留著，mount() 補開後回填。
let editDraft = null;   // { id, label, entryDate, note }

function startEdit(item) {
  setFormError("");
  editingId = item.id;
  modalOpen = true;
  const draft = editDraft && editDraft.id === item.id ? editDraft : null;
  const content = html`<div class="heading-help"><span class="parent-kicker">家長編輯紀錄</span>${common.infoTip("金額與分配不在這裡修改，避免帳務失去平衡。")}</div><h2 id="history-edit-title">${item.label}</h2><p class="sr-only" id="history-edit-help">可以修改紀錄名稱、日期與備註；不能修改金額與分配。</p><form><label class="input-label" for="history-edit-label">紀錄名稱</label><input id="history-edit-label" class="text-input" value="${draft ? draft.label : item.label}" maxlength="60" required /><label class="input-label" for="history-edit-date">日期</label><input id="history-edit-date" class="text-input" type="date" value="${draft ? draft.entryDate : item.entryDate}" required /><label class="input-label" for="history-edit-note">備註</label><textarea id="history-edit-note" class="text-input" maxlength="160">${draft ? draft.note : item.note}</textarea><button class="primary-button full-width">儲存修改</button></form>`;
  const node = common.openModal(String(content), {
    labelledBy: "history-edit-title",
    onClose: (reason) => {
      modalOpen = false;
      if (reason !== "rerender") { editingId = ""; editDraft = null; }   // 背景重繪留著 editingId 與草稿
    },
  });
  if (!node) {
    editingId = "";
    modalOpen = false;
    return;
  }
  const scope = node.classList && node.classList.contains("modal") ? node : node.querySelector(".modal") || node;
  scope.setAttribute("aria-describedby", "history-edit-help");
  scope.addEventListener("keydown", trapTab);
  const closeButton = scope.querySelector(".modal-close");
  if (closeButton) closeButton.setAttribute("aria-label", "關閉編輯紀錄視窗");
  const form = scope.querySelector("form");
  if (form) {
    form.addEventListener("submit", saveEdit);
    form.addEventListener("input", () => {
      editDraft = {
        id: item.id,
        label: form.querySelector("#history-edit-label").value,
        entryDate: form.querySelector("#history-edit-date").value,
        note: form.querySelector("#history-edit-note").value,
      };
    });
  }
}

function closeEdit() {
  if (!modalOpen) return;
  editingId = "";
  editDraft = null;
  modalOpen = false;
  common.closeModal();
}

// ---------- 呼叫 store ----------
async function activityRequest(payload, button, busyLabel) {
  setFormError("");
  const restoreLabel = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = busyLabel;
  }
  try {
    // pin.assertParentPin 沒收到 pin 時會退回本次開啟期間記住的 unlockedPin（見 pin.js assert()），
    // 解鎖成功過一次之後這裡傳空字串一樣過得了驗證，不用另外把 lockPin 傳過來。
    await store.updateActivityRecord({ ...payload, parentPin: "" });
    closeEdit();
    pagesLoaded = 1;
    syncList();
  } catch (caught) {
    setFormError(errorMessage(caught, "紀錄調整失敗"));
    if (button) {
      button.disabled = false;
      button.textContent = restoreLabel;
    }
  }
}

function saveEdit(event) {
  event.preventDefault();
  if (!editingId) return;
  const form = event.currentTarget;
  const label = form.querySelector("#history-edit-label");
  const date = form.querySelector("#history-edit-date");
  const note = form.querySelector("#history-edit-note");
  void activityRequest(
    { action: "edit", activityId: editingId, label: label ? label.value : "", note: note ? note.value : "", entryDate: date ? date.value : "" },
    form.querySelector(".primary-button"),
    "儲存中…",
  );
}

async function remove(item, button) {
  const confirmed = await common.confirmDialog(`確定要刪除「${item.label}」嗎？系統會撤銷這筆紀錄造成的餘額變化。`);
  if (!confirmed) return;
  await activityRequest({ action: "delete", activityId: item.id }, button, "刪除中…");
}

// ---------- 事件 ----------
function onInput(event) {
  const target = event.target;
  if (target.matches("[data-history-search]")) {
    query = target.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(reloadList, query ? 250 : 0);
  }
}

function onChange(event) {
  if (!event.target.matches("[data-history-kind]")) return;
  kind = event.target.value;
  reloadList();
}

function onClick(event) {
  const chooser = event.target.closest("[data-choose-profile]");
  if (chooser) {
    closeEdit();
    currentCtx.chooseProfile(chooser.dataset.chooseProfile);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "open-lock") {
    lockModalOpen = true;
    lockPin = "";
    lockError = "";
    if (lockModalKind !== "lock") openLockModal();
    return;
  }
  if (action === "load-more") {
    pagesLoaded += 1;
    syncList({ focusLoadMore: true });
    return;
  }
  const item = findActivity(button.dataset.id);
  if (!item) return;
  if (action === "edit") startEdit(item);
  else if (action === "delete") void remove(item, button);
}

export function mount(root, ctx) {
  currentCtx = ctx;
  root.removeEventListener("input", onInput);
  root.removeEventListener("change", onChange);
  root.removeEventListener("click", onClick);
  if (!ctx.state || !ctx.profile) return;
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("click", onClick);
  if (editingId && !modalOpen) {
    const item = findActivity(editingId);
    if (item) startEdit(item);
    else editingId = "";
  }
  // 規格 1.2：重繪後如果 lock modal「該開卻沒開」，補開並回填欄位值。
  if (lockModalOpen && lockModalKind !== "lock") openLockModal();
}
