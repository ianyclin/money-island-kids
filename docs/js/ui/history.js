// 小小理財島 PWA：所有紀錄（規格 5.3）。
// 版面重寫成 v2 的殼：頁首下孩子切換、sticky 篩選列、sticky 月份標頭、.record 一列。
// 資料與家長功能的邏輯原樣搬：store.getActivitiesPage 分頁、groupByMonth 前端分組、搜尋 debounce、
// 編輯 modal（含 editDraft 的重繪存活）、刪除確認、可刪除判斷；解鎖改用 common.createLockModal。

import { html, raw, money, formatMonthLabel, errorMessage } from "../util.js";
import * as common from "./common.js";
import * as store from "../store.js";
import * as appState from "../state.js";
import * as pin from "../pin.js";

const PAGE_SIZE = 20; // 規格 5.3：「載入更多（已顯示 N / M）」每次 20 筆
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
let menuId = "";        // 手機「⋯」選單目前對著哪一筆（重繪後 mount() 補開）
let menuNode = null;

// ---------- 情境式解鎖 modal（規格 3.3：頁首右插槽的 32px 鎖鈕） ----------
const lockModal = common.createLockModal({
  getPinStatus: () => (currentCtx ? (currentCtx.pinStatus || pin.status()) : "locked"),
  onUnlocked: () => { if (currentCtx) currentCtx.refresh(); },
  parentHref: "#/parent",
});

function frag(value) {
  return raw(String(value));
}

// ---------- 移植自原檔的純函式 ----------
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

// 規格 5.3 的日期寫法「9/6」：entryDate 是 YYYY-MM-DD，直接取月日。
function shortDate(entryDate) {
  const parts = String(entryDate).slice(0, 10).split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : String(entryDate);
}

// 規格 5.3：正數綠。金額欄本身沒有正負號，用三個錢包的淨變化判斷這一筆是進來還是出去。
function netDelta(item) {
  return item.spendDelta + item.bankDelta + item.marketDelta;
}

// 純前端依 entryDate 年月分組，不動 store.getActivitiesPage。
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

// 孩子切換列的小字：各自的總筆數（不跟著搜尋條件變）。
function countOf(state, profileId) {
  return state.activities.filter((item) => item.profileId === profileId).length;
}

// ---------- 繪製 ----------
function filters(kinds) {
  const options = kinds.map((item) => html`<option value="${item}"${kind === item ? raw(" selected") : ""}>${kindName(item)}</option>`);
  return html`<div class="filters">
      <input class="input" type="search" data-history-search value="${query}" placeholder="名稱、備註或日期" aria-label="搜尋紀錄">
      <select class="select" data-history-kind aria-label="紀錄類型"><option value="all"${kind === "all" ? raw(" selected") : ""}>全部類型</option>${options}</select>
    </div>`;
}

// 編輯／刪除鈕只在 unlocked 時才產出 DOM（不是渲染出來再 disabled）。
// 手機一顆「⋯」開 modal 選；≥1100 由 history.css 換成直接顯示兩顆 ghost。
function rowActions(item) {
  const deletable = isDeletable(item);
  const deleteHelp = deletable ? "刪除並撤銷餘額變化" : "請到對應家長功能調整";
  return html`<button type="button" class="btn-icon record-menu" data-action="row-menu" data-id="${item.id}" aria-label="${`「${item.label}」的編輯與刪除`}">⋯</button>
        <div class="record-actions">
          <button type="button" class="btn btn-ghost" title="編輯紀錄說明" data-action="edit" data-id="${item.id}">編輯</button>
          <button type="button" class="btn btn-ghost"${deletable ? "" : raw(" disabled")} title="${deleteHelp}" aria-label="${`刪除「${item.label}」：${deleteHelp}`}" data-action="delete" data-id="${item.id}">刪除</button>
        </div>`;
}

// 這一行是 app 的核心教學（錢有不同任務）：每一筆錢分別進了哪個錢包。從舊版原樣搬回。
function deltaText(item) {
  const parts = [];
  if (item.spendDelta) parts.push(`撲滿 ${item.spendDelta > 0 ? "+" : ""}${item.spendDelta}`);
  if (item.bankDelta) parts.push(`爸媽銀行 ${item.bankDelta > 0 ? "+" : ""}${item.bankDelta}`);
  if (item.marketDelta) parts.push(`ETF 小森林 ${item.marketDelta > 0 ? "+" : ""}${item.marketDelta}`);
  return parts.join(" · ") || "沒有改變餘額";
}

function activityRow(item, pinStatus) {
  const unlocked = pinStatus === "unlocked";
  return html`<article class="record">
        <span class="timeline-dot kind-${item.kind}" aria-hidden="true">${historyIcon(item.kind)}</span>
        <div><b>${item.label}</b><small>${shortDate(item.entryDate)} · ${kindName(item.kind)} · ${item.note || "沒有備註"}</small><i class="record-delta">${deltaText(item)}</i></div>
        <strong class="${netDelta(item) > 0 ? "is-positive" : ""}">${item.amount ? money(item.amount) : "—"}</strong>
        ${unlocked ? rowActions(item) : ""}
      </article>`;
}

function listSection(page, pinStatus) {
  const groups = groupByMonth(page.activities);
  const rows = groups.map((group) => html`<h2 class="month-head">${formatMonthLabel(group.key)}</h2>${group.items.map((item) => activityRow(item, pinStatus))}`);
  const empty = page.activities.length ? "" : html`<p class="empty">沒有符合條件的紀錄。</p>`;
  const more = page.nextOffset !== null
    ? html`<button type="button" class="btn btn-secondary btn-block load-more-button" data-action="load-more">${`載入更多（已顯示 ${page.activities.length} / ${page.total}）`}</button>`
    : "";
  return html`<div class="history-list">${listError ? html`<p class="form-error" role="alert">${listError}</p>` : ""}<div class="record-list">${rows}</div>${empty}${more}</div>`;
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
  const body = html`${frag(common.profileChips(profiles, profile.id, (item) => `${countOf(ctx.state, item.id)} 筆`))}
      ${filters(page.kinds)}
      ${listSection(page, pinStatus)}`;
  return common.appShell({
    page: "history",
    title: `${profile.name}的紀錄`,
    ctx,
    right: common.lockIconButton({ pinStatus }),
    body,
  });
}

// ---------- 局部更新（不整頁重繪，才不會把使用者踢出搜尋框） ----------
function syncList({ focusLoadMore = false } = {}) {
  const ctx = currentCtx;
  const section = document.querySelector(".history-list");
  if (!ctx || !ctx.profile || !section) return;
  const pinStatus = ctx.pinStatus || pin.status();
  const page = readPage(ctx.profile.id);
  section.outerHTML = String(listSection(page, pinStatus));
  if (focusLoadMore) {
    const button = document.querySelector(".history-list .load-more-button");
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

// 錯誤畫在開著的編輯視窗裡；沒有視窗（例如列上直接刪除）時走吐司。
function setFormError(message) {
  formError = message;
  const form = document.querySelector("#modal-root form");
  if (form) {
    syncErrorNode(form, message, form.querySelector(".history-save"));
    return;
  }
  if (message) common.showStatus(message, "error");
}

// ---------- 手機的「⋯」選單（規格 5.3：列右側 32px 鈕開 modal 選編輯／刪除） ----------
function openRowMenu(item) {
  menuId = item.id;
  const deletable = isDeletable(item);
  const node = common.openModal(html`<h2 id="record-menu-title">${item.label}</h2>
      <p class="confirm-dialog-copy">${shortDate(item.entryDate)} · ${kindName(item.kind)}</p>
      <div class="record-menu-actions">
        <button type="button" class="btn btn-secondary btn-block" data-menu-edit>編輯</button>
        <button type="button" class="btn btn-danger btn-block"${deletable ? "" : raw(" disabled")} title="${deletable ? "刪除並撤銷餘額變化" : "請到對應家長功能調整"}" data-menu-delete>刪除</button>
      </div>`, {
    labelledBy: "record-menu-title",
    onClose: (reason) => {
      menuNode = null;
      if (reason !== "rerender") menuId = "";   // 背景重繪留著 menuId，mount() 補開
    },
  });
  if (!node) { menuId = ""; return; }
  menuNode = node;
  node.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-menu-edit]")) {
      menuId = "";
      menuNode = null;
      startEdit(item);
      return;
    }
    if (target.closest("[data-menu-delete]")) {
      const button = target.closest("[data-menu-delete]");
      if (button.disabled) return;
      menuId = "";
      menuNode = null;
      void remove(item, null);
    }
  });
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
  const content = html`<span class="kicker">家長編輯紀錄</span>
      <h2 id="history-edit-title">${item.label}</h2>
      <p class="sr-only" id="history-edit-help">可以修改紀錄名稱、日期與備註；不能修改金額與分配。</p>
      <p class="confirm-dialog-copy">金額與分配不在這裡修改，避免帳務失去平衡。</p>
      <form>
        ${frag(common.field({ label: "紀錄名稱", id: "history-edit-label", input: html`<input id="history-edit-label" class="input" value="${draft ? draft.label : item.label}" maxlength="60" required>` }))}
        ${frag(common.field({ label: "日期", id: "history-edit-date", input: html`<input id="history-edit-date" class="input" type="date" value="${draft ? draft.entryDate : item.entryDate}" required>` }))}
        ${frag(common.field({ label: "備註", id: "history-edit-note", input: html`<textarea id="history-edit-note" class="textarea" maxlength="160">${draft ? draft.note : item.note}</textarea>` }))}
        <button type="submit" class="btn btn-primary btn-block history-save">儲存修改</button>
      </form>`;
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
    // 解鎖成功過一次之後這裡傳空字串一樣過得了驗證。
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
    form.querySelector(".history-save"),
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
    // 換小朋友時把開著的編輯視窗收掉（實際的切換由 app.js 的統一委派處理）。
    closeEdit();
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === "open-lock") { lockModal.open(); return; }
  if (action === "load-more") {
    pagesLoaded += 1;
    syncList({ focusLoadMore: true });
    return;
  }
  const item = findActivity(button.dataset.id);
  if (!item) return;
  if (action === "row-menu") openRowMenu(item);
  else if (action === "edit") startEdit(item);
  else if (action === "delete") void remove(item, button);
}

export function mount(root, ctx) {
  currentCtx = ctx;
  if (!ctx.state || !ctx.profile) return;
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("click", onClick);
  // 規格 4.3：重繪後如果 modal「該開卻沒開」，補開並回填欄位值。
  if (editingId && !modalOpen) {
    const item = findActivity(editingId);
    if (item) startEdit(item);
    else editingId = "";
  } else if (menuId && !menuNode) {
    const item = findActivity(menuId);
    if (item) openRowMenu(item);
    else menuId = "";
  }
  lockModal.mountCheck(ctx);
}
