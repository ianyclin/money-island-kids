// 小小理財島 PWA：孩子首頁（v2 規格 5.1）。
// 版面重做：頁首＝孩子切換列（appShell 提供）、問候、三個錢包、兩顆記帳鈕、多存鈕、小森林、最近三筆。
// 折線圖搬到成長頁（growth.js）；totalAssets／assetTimeline 在 common.js，兩頁共用；
// 家庭小專案、我們家的約定、footer 搬到「更多」頁。
// store 呼叫、operationId、錯誤處理、busy 狀態、modal 的重繪存活機制全部原樣沿用，只換 markup 的 class。

import { html, raw, money, formatShortDate, taipeiMonth, uuid, errorMessage } from "../util.js";
import { kindName } from "../state.js";
import {
  appShell,
  btn,
  field,
  showStatus,
  openModal,
  closeModal,
  profileAvatar,
  stateGate,
  savedStatus,
} from "./common.js";
import * as store from "../store.js";
import { totalAssets, assetTimeline } from "./common.js";

// ---------- 頁面暫存（重繪後由 render 讀回） ----------
let action = null;              // null | "allowance" | "spend"
let amount = "";
let labelText = "";
let transactionOperationId = uuid();
let saving = false;
let error = "";
let gardenBusy = false;
let gardenPickerOpen = false;   // <details> 的展開狀態：整頁重繪後要還原
let saveMoreOpen = false;
let saveMoreAmount = "";
let saveMoreNote = "";
let saveMoreBusy = false;
let saveMoreError = "";
let savingsOperationId = uuid();

let openModalKind = "";         // "" | "transaction" | "saveMore"
let currentCtx = null;
const boundRoots = new WeakSet();

// ---------- 原檔的純函式（原樣移植） ----------
const gardenOptions = [
  { value: "tree", emoji: "🌳", label: "綠葉樹" },
  { value: "cherry", emoji: "🌸", label: "櫻花樹" },
  { value: "pine", emoji: "🌲", label: "松樹" },
  { value: "sunflower", emoji: "🌻", label: "向日葵" },
  { value: "tulip", emoji: "🌷", label: "鬱金香" },
  { value: "daisy", emoji: "🌼", label: "小雛菊" },
];

function gardenOption(value) {
  return gardenOptions.find((item) => item.value === value) ?? gardenOptions[0];
}

function recentActivities(list, limit) {
  const top = list.slice(0, limit);
  if (top.some((item) => item.kind === "reward")) return top;
  const month = taipeiMonth();
  const reward = list.find((item, index) => index >= limit && item.kind === "reward" && item.entryDate.slice(0, 7) === month);
  if (!reward) return top;
  return [...top.slice(0, limit - 1), reward];
}

function activityIcon(kind) {
  if (kind === "reward") return "★";
  if (kind === "etf" || kind === "stock-buy") return "↗";
  if (kind === "project") return "✓";
  if (kind === "savings-transfer") return "🌱";
  if (kind === "dream") return "☁";
  if (kind === "harvest") return "福";
  if (kind === "market-update") return "≈";
  if (kind === "spend") return "−";
  if (kind === "welcome") return "♡";
  return "+";
}

// ---------- 目前輸入值推出來的數字 ----------
function attr(condition, text) {
  return condition ? raw(text) : "";
}

function savingsRateOf(state) {
  return Math.min(100, Math.max(0, state.savingsRate ?? 30));
}

function allowanceValue() {
  return Math.max(0, Math.round(Number(amount) || 0));
}

function saveMoreValueOf() {
  return Math.max(0, Math.round(Number(saveMoreAmount) || 0));
}

function pendingSavingsAmountOf(ctx) {
  return ctx.state.savingsTransfers
    .filter((item) => item.profileId === ctx.profile.id && item.status === "pending")
    .reduce((sum, item) => sum + item.amount, 0);
}

function savingAvailableOf(ctx) {
  return Math.max(0, ctx.profile.spendingBalance - pendingSavingsAmountOf(ctx));
}

// ---------- 畫面片段 ----------
// 規格 5.1 第 3 列：一列錢包＝左 36px icon、中 名稱＋caption（爸媽銀行多一行 pending badge）、右 金額。
function wallet({ tone, icon, name, value, caption, pending }) {
  return html`
        <div class="wallet wallet-${tone}">
          <span class="wallet-icon" aria-hidden="true">${icon}</span>
          <div>
            <span class="wallet-name">${name}</span>
            <p class="wallet-caption">${caption}</p>
            ${pending ? html`<span class="badge">⌛ ${pending}</span>` : ""}
          </div>
          <strong class="wallet-amount">${money(value)}</strong>
        </div>`;
}

function islandGarden({ avatar, name, value, futureValue, futurePrincipal, species, busy }) {
  const selected = gardenOption(species);
  const fullPlants = Math.floor(value / 1000);
  const remainder = value % 1000;
  const visualCount = value > 0 ? Math.min(12, Math.max(1, fullPlants + (remainder ? 1 : 0))) : 0;
  const forestMaturity = 1 + Math.min(.28, Math.floor(fullPlants / 12) * .07);
  const forestLayout = [
    { x: 50, bottom: 10, scale: 1.08, tilt: -2 },
    { x: 34, bottom: 53, scale: .9, tilt: 2 },
    { x: 66, bottom: 52, scale: .92, tilt: -1 },
    { x: 50, bottom: 96, scale: .72, tilt: 1 },
    { x: 23, bottom: 13, scale: 1.02, tilt: -3 },
    { x: 77, bottom: 13, scale: 1.04, tilt: 3 },
    { x: 29, bottom: 88, scale: .68, tilt: 2 },
    { x: 71, bottom: 87, scale: .7, tilt: -2 },
    { x: 14, bottom: 42, scale: .82, tilt: 3 },
    { x: 86, bottom: 41, scale: .8, tilt: -3 },
    { x: 41, bottom: 0, scale: 1.15, tilt: 2 },
    { x: 62, bottom: 1, scale: 1.18, tilt: -2 },
  ];

  const plants = Array.from({ length: visualCount }, (_, index) => {
    const growing = index === fullPlants && remainder > 0 && fullPlants < visualCount;
    const position = forestLayout[index];
    const growthScale = growing ? 0.5 + (remainder / 1000) * 0.5 : forestMaturity;
    return html`<span class="${growing ? "is-growing" : ""}" style="--plant-x: ${position.x}%; --plant-bottom: ${position.bottom}px; --plant-scale: ${position.scale * growthScale}; --plant-tilt: ${position.tilt}deg; --plant-depth: ${120 - position.bottom}">${selected.emoji}</span>`;
  });

  return html`
        <div class="island-scene" aria-label="ETF 小森林：${fullPlants} 株完整植物${remainder ? "，另有一株正在長大" : ""}；${name}已經存給未來 ${money(futurePrincipal)}，現在成長為 ${money(futureValue)}">
          <div class="sun"></div>
          <div class="island-ground"></div>
          <div class="island-garden species-${species}" aria-hidden="true">
            ${plants}
            ${!visualCount ? html`<span class="garden-seed">🌱</span>` : ""}
          </div>
          <details class="garden-picker"${attr(gardenPickerOpen, " open")}>
            <summary><span>選擇樹種</span><b>${selected.emoji} ${selected.label}</b></summary>
            <div>
              ${gardenOptions.map((item) => html`<button type="button" class="${item.value === species ? "is-active" : ""}" aria-label="${item.label}" aria-pressed="${item.value === species}" title="${item.label}"${attr(busy, " disabled")} data-garden="${item.value}">${item.emoji}</button>`)}
            </div>
          </details>
          <span class="scene-total">
            <span class="scene-total-avatar">${profileAvatar(avatar)}</span>
            <span class="scene-total-copy">
              <span>${name}已經存給未來 <b>${money(futurePrincipal)}</b></span>
              <span>現在成長為 <strong>${money(futureValue)}</strong></span>
            </span>
          </span>
        </div>`;
}

// 規格 1：折線圖整段原樣搬（首頁不畫，成長頁 import 這一支）。
// ---------- render ----------
export function render(ctx) {
  const state = ctx.state;
  const profile = ctx.profile;
  if (!state || !profile) return stateGate("", () => ctx.refresh());

  // 複核 shouldFix：呼叫端不能先把候選池砍到 6 筆再找 reward，不然「當月有一筆 reward 就換進第3格」
  // 會在孩子當月記超過 6 筆之後找不到那筆 reward。這裡傳整份當事人的活動紀錄（已經依日期新到舊
  // 排序過，見 state.js），交給 recentActivities() 自己在裡面限定「當月」。
  const profileActivities = state.activities.filter((item) => item.profileId === profile.id);
  const recentThree = recentActivities(profileActivities, 3);
  const profileHoldings = state.holdings.filter((item) => item.profileId === profile.id);
  const pendingSavingsAmount = pendingSavingsAmountOf(ctx);
  const savingsRate = savingsRateOf(state);
  const spendingRate = 100 - savingsRate;
  const returnRate = profile.stockCost > 0
    ? ((profile.marketValue - profile.stockCost) / profile.stockCost) * 100
    : 0;

  const body = html`
      <div class="grid-2 grid-2-home">
        <section class="greeting" aria-label="${profile.name}的錢，正在慢慢長大">
          <h1>${profile.name}的錢，正在慢慢長大。</h1>
          <p>零用錢 ${savingsRate}% 先留給未來，${spendingRate}% 自己做選擇</p>
        </section>

        <section class="card" aria-label="錢包總覽">
          <div class="wallets">
            ${wallet({
              tone: "yellow",
              icon: "🐷",
              name: "可以自己決定（撲滿）",
              value: profile.spendingBalance,
              caption: profile.spendingBalance ? "用來買想要的東西" : "從下一筆零用錢開始記錄",
            })}
            ${wallet({
              tone: "pink",
              icon: "🏦",
              name: "爸媽銀行",
              value: profile.bankBalance,
              caption: profile.bankBalance >= 1000
                ? "有存錢獎勵；已經可以請爸媽協助種進小森林"
                : `有存錢獎勵；再存 ${money(1000 - profile.bankBalance)} 就能請爸媽協助種樹`,
              pending: pendingSavingsAmount ? `${money(pendingSavingsAmount)} 等待爸媽確認` : "",
            })}
            ${wallet({
              tone: "green",
              icon: "🌳",
              name: "ETF 小森林",
              value: profile.marketValue,
              // 「長期投資，會漲也會跌」是理念句，有持股時也要看得到（規格第 1 節）：放第二行。
              caption: profileHoldings.length === 1
                ? `${profileHoldings[0].symbol} · ${profileHoldings[0].units} 股 · ${returnRate >= 0 ? "+" : ""}${returnRate.toFixed(1)}%
長期投資，會漲也會跌`
                : profileHoldings.length > 1
                  ? `${profileHoldings.length} 個標的 · ${returnRate >= 0 ? "+" : ""}${returnRate.toFixed(1)}%
長期投資，會漲也會跌`
                  : "長期投資，會漲也會跌",
            })}
          </div>
        </section>

        <div class="btn-row">
          ${btn({ label: "＋ 記一筆零用錢", action: "open-allowance", kind: "primary" })}
          ${btn({ label: "記一筆花費", action: "open-spend", kind: "secondary" })}
        </div>

        <div class="wallet-action">
          ${btn({ label: "🌱 我想多存一點到爸媽銀行", action: "open-save-more", kind: "ghost", block: true })}
        </div>

        <section class="card island-card" aria-label="ETF 小森林">
          ${islandGarden({
            avatar: profile.avatar,
            name: profile.name,
            value: profile.marketValue,
            futureValue: profile.bankBalance + profile.marketValue,
            futurePrincipal: profile.futurePrincipal ?? 0,
            species: profile.gardenSpecies ?? "tree",
            busy: gardenBusy,
          })}
        </section>

        <section class="card recent">
          <div class="card-head">
            <h2 class="card-title">最近紀錄</h2>
            <a class="card-head-link" href="#/history">看全部 →</a>
          </div>
          ${recentThree.length === 0 ? html`<p class="empty">還沒有紀錄，記第一筆看看</p>` : html`<div class="record-list">
            ${recentThree.map((item) => html`
            <div class="record">
              <span class="timeline-dot kind-${item.kind}" aria-hidden="true">${activityIcon(item.kind)}</span>
              <div>
                <b>${item.label}</b>
                <small>${[formatShortDate(item.entryDate), kindName(item.kind), item.note].filter(Boolean).join(" · ")}</small>
              </div>
              <strong>${item.amount ? money(item.amount) : "開始"}</strong>
            </div>`)}
          </div>`}
        </section>
      </div>`;

  // 規格 3.1：首頁的 title 傳空字串，頁首自動變成孩子切換列；右插槽留空。
  return appShell({ page: "home", title: "", ctx, body });
}

// ---------- modal 內容 ----------
function transactionModalBody(ctx) {
  const profile = ctx.profile;
  const savingsRate = savingsRateOf(ctx.state);
  const spendingRate = 100 - savingsRate;
  const allowance = allowanceValue();
  const investPreview = allowance ? Math.round(allowance * savingsRate / 100) : 0;
  const spendPreview = allowance - investPreview;
  return html`
      <span class="modal-avatar">${profileAvatar(profile.avatar, profile.name)}</span>
      <p class="kicker">${profile.name}的紀錄</p>
      <h2 id="money-dialog-title">${action === "allowance" ? "收到多少零用錢？" : "這次花了多少錢？"}</h2>
      <form>
        ${action === "allowance" ? html`<div class="quick-amounts" aria-label="快速增加零用錢金額">
          ${[10, 100, 1000].map((value) => html`<button type="button"${attr(allowance >= 100000, " disabled")} data-quick-amount="${value}">＋${value.toLocaleString("zh-TW")}</button>`)}
        </div>` : ""}
        ${field({
          label: "金額",
          id: "money-amount",
          input: html`<div class="money-input"><span>NT$</span><input id="money-amount" inputmode="numeric" min="1" max="100000" type="number" value="${amount}" required></div>`,
        })}
        ${field({
          label: action === "allowance" ? "這筆錢從哪裡來？" : "買了什麼？",
          id: "money-label",
          input: html`<input class="input" id="money-label" value="${labelText}" placeholder="${action === "allowance" ? "例如：本週零用錢" : "例如：貼紙"}">`,
        })}
        ${action === "allowance" ? html`
        <div class="preview-split">
          <span><b>${money(investPreview)}</b>先存 ${savingsRate}%</span>
          <span><b>${money(spendPreview)}</b>自己安排 ${spendingRate}%</span>
        </div>` : ""}
        ${error ? html`<p class="form-error">${error}</p>` : ""}
        <button type="submit" class="btn btn-primary btn-block" data-submit${attr(saving || allowance <= 0, " disabled")}>
          ${saving ? "正在儲存…" : "存好這一筆"}
        </button>
        <small class="auto-save-note">儲存後會自動備份在這台裝置；開啟雲端備份後也會同步到你的 GitHub</small>
      </form>`;
}

function saveMoreModalBody(ctx) {
  const profile = ctx.profile;
  const pendingSavingsAmount = pendingSavingsAmountOf(ctx);
  const savingAvailable = savingAvailableOf(ctx);
  const saveMoreValue = saveMoreValueOf();
  const saveMorePreview = Math.min(saveMoreValue, savingAvailable);
  return html`
      <span class="modal-avatar">${profileAvatar(profile.avatar, profile.name)}</span>
      <p class="kicker">把現在的一點自由留給未來</p>
      <h2 id="save-more-dialog-title">想多存多少到爸媽銀行？</h2>
      <p class="transfer-dialog-copy">送出後先等待爸媽確認；確認完成才會真的從撲滿搬到爸媽銀行。</p>
      ${savingAvailable <= 0 ? html`
      <p class="no-transfer-balance" role="status">
        ${pendingSavingsAmount > 0
          ? "撲滿裡的錢目前都在等待爸媽確認；處理完成後再來看看。"
          : "撲滿目前沒有可以移動的錢；下次收到零用錢後，就可以自主多存。"}
      </p>` : ""}
      <form>
        <div class="quick-amounts" aria-label="快速選擇金額">
          ${[10, 100, 1000].map((value) => html`<button type="button"${attr(savingAvailable <= 0 || saveMoreValue >= savingAvailable, " disabled")} data-quick-save="${value}">＋${value.toLocaleString("zh-TW")}</button>`)}
          <button type="button"${attr(savingAvailable <= 0, " disabled")} data-save-all="1">全部</button>
        </div>
        ${field({
          label: "自主存入金額",
          id: "save-more-amount",
          input: html`<div class="money-input"><span>NT$</span><input id="save-more-amount" inputmode="numeric" min="1" max="${savingAvailable}" type="number" value="${saveMoreAmount}"${attr(savingAvailable <= 0, " disabled")} required></div>`,
        })}
        ${field({
          label: "想留給未來做什麼？（選填）",
          id: "save-more-note",
          input: html`<input class="input" id="save-more-note" value="${saveMoreNote}" placeholder="例如：想讓長期夢想快一點長大" maxlength="80">`,
        })}
        <div class="transfer-preview">
          <span><small>撲滿</small><b>${money(profile.spendingBalance)} → ${money(profile.spendingBalance - saveMorePreview)}</b></span>
          <i aria-hidden="true">→</i>
          <span><small>爸媽銀行</small><b>${money(profile.bankBalance)} → ${money(profile.bankBalance + saveMorePreview)}</b></span>
        </div>
        ${pendingSavingsAmount > 0 ? html`<small class="pending-transfer-note">另有 ${money(pendingSavingsAmount)} 正在等待爸媽確認</small>` : ""}
        ${saveMoreError ? html`<p class="form-error">${saveMoreError}</p>` : ""}
        <button type="submit" class="btn btn-primary btn-block" data-submit${attr(saveMoreBusy || saveMoreValue <= 0 || saveMoreValue > savingAvailable, " disabled")}>${saveMoreBusy ? "正在送出…" : "請爸媽確認"}</button>
      </form>`;
}

// ---------- 提示與錯誤 ----------
function announce(message, tone = "success") {
  showStatus(message, tone);
}

function setFormError(form, message) {
  const existing = form.querySelector(".form-error");
  if (!message) {
    if (existing) existing.remove();
    return;
  }
  if (existing) {
    existing.textContent = message;
    return;
  }
  const node = document.createElement("p");
  node.className = "form-error";
  node.textContent = message;
  form.querySelector("[data-submit]")?.before(node);
}

// ---------- 記帳 modal ----------
function syncTransactionPreview(dialog) {
  const ctx = currentCtx;
  const input = dialog.querySelector("#money-amount");
  if (input) amount = input.value;
  const labelInput = dialog.querySelector("#money-label");
  if (labelInput) labelText = labelInput.value;
  const allowance = allowanceValue();
  const savingsRate = savingsRateOf(ctx.state);
  const investPreview = allowance ? Math.round(allowance * savingsRate / 100) : 0;
  const spendPreview = allowance - investPreview;
  dialog.querySelectorAll("[data-quick-amount]").forEach((button) => { button.disabled = allowance >= 100000; });
  const previews = dialog.querySelectorAll(".preview-split b");
  if (previews[0]) previews[0].textContent = money(investPreview);
  if (previews[1]) previews[1].textContent = money(spendPreview);
  const submit = dialog.querySelector("[data-submit]");
  if (submit) submit.disabled = saving || allowance <= 0;
}

function openAction(ctx, kind) {
  action = kind;
  amount = "";
  labelText = "";
  error = "";
  transactionOperationId = uuid();
  openTransactionModal(ctx);
}

function openTransactionModal(ctx) {
  const dialog = openModal(String(transactionModalBody(ctx)), {
    labelledBy: "money-dialog-title",
    className: "money-modal",
    onClose: (reason) => {
      if (openModalKind !== "transaction") return;
      openModalKind = "";
      if (reason !== "rerender") action = null;   // 背景重繪留著 action，mount() 會補開並回填
    },
  });
  if (!dialog) return;
  openModalKind = "transaction";

  dialog.addEventListener("input", () => syncTransactionPreview(dialog));
  dialog.addEventListener("click", (event) => {
    const quick = event.target.closest("[data-quick-amount]");
    if (quick) {
      const input = dialog.querySelector("#money-amount");
      input.value = String(Math.min(100000, allowanceValue() + Number(quick.dataset.quickAmount)));
      syncTransactionPreview(dialog);
    }
  });
  dialog.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    // 送出前再從表單讀一次：自動填入或貼上不一定會觸發 input 事件。
    syncTransactionPreview(dialog);
    void submitTransaction(currentCtx, event.currentTarget);
  });

  const input = dialog.querySelector("#money-amount");
  if (input && !input.disabled) input.focus();
}

async function submitTransaction(ctx, form) {
  if (!action) return;
  const kind = action;
  saving = true;
  error = "";
  setFormError(form, "");
  const button = form.querySelector("[data-submit]");
  if (button) {
    button.disabled = true;
    button.textContent = "正在儲存…";
  }
  try {
    await store.addTransaction({
      profileId: ctx.profile.id,
      kind,
      amount: Number(amount),
      label: labelText,
      operationId: transactionOperationId,
    });
    const saved = savedStatus(store.getState(), kind === "allowance" ? "零用錢已經記在帳本裡" : "花費已經記在帳本裡");
    saving = false;
    announce(saved.message, saved.tone);
    action = null;
    openModalKind = "";
    closeModal();
  } catch (caught) {
    const message = errorMessage(caught, "儲存失敗");
    saving = false;
    error = message;
    setFormError(form, message);
    showStatus(message, "error");
    if (button && button.isConnected) {
      button.textContent = "存好這一筆";
      button.disabled = allowanceValue() <= 0;
    }
  }
}

// ---------- 自主多存 modal ----------
function syncSaveMorePreview(dialog) {
  const ctx = currentCtx;
  const input = dialog.querySelector("#save-more-amount");
  if (input) saveMoreAmount = input.value;
  const noteInput = dialog.querySelector("#save-more-note");
  if (noteInput) saveMoreNote = noteInput.value;
  const savingAvailable = savingAvailableOf(ctx);
  const saveMoreValue = saveMoreValueOf();
  const saveMorePreview = Math.min(saveMoreValue, savingAvailable);
  dialog.querySelectorAll("[data-quick-save]").forEach((button) => {
    button.disabled = savingAvailable <= 0 || saveMoreValue >= savingAvailable;
  });
  const all = dialog.querySelector("[data-save-all]");
  if (all) all.disabled = savingAvailable <= 0;
  const previews = dialog.querySelectorAll(".transfer-preview b");
  if (previews[0]) previews[0].textContent = `${money(ctx.profile.spendingBalance)} → ${money(ctx.profile.spendingBalance - saveMorePreview)}`;
  if (previews[1]) previews[1].textContent = `${money(ctx.profile.bankBalance)} → ${money(ctx.profile.bankBalance + saveMorePreview)}`;
  const submit = dialog.querySelector("[data-submit]");
  if (submit) submit.disabled = saveMoreBusy || saveMoreValue <= 0 || saveMoreValue > savingAvailable;
}

function openSaveMore(ctx) {
  saveMoreAmount = "";
  saveMoreNote = "";
  saveMoreError = "";
  savingsOperationId = uuid();
  saveMoreOpen = true;
  openSaveMoreModal(ctx);
}

function openSaveMoreModal(ctx) {
  const dialog = openModal(String(saveMoreModalBody(ctx)), {
    labelledBy: "save-more-dialog-title",
    className: "money-modal",
    onClose: (reason) => {
      if (openModalKind !== "saveMore") return;
      openModalKind = "";
      if (reason !== "rerender") saveMoreOpen = false;
    },
  });
  if (!dialog) return;
  openModalKind = "saveMore";

  dialog.addEventListener("input", () => syncSaveMorePreview(dialog));
  dialog.addEventListener("click", (event) => {
    const input = dialog.querySelector("#save-more-amount");
    const quick = event.target.closest("[data-quick-save]");
    if (quick) {
      input.value = String(Math.min(savingAvailableOf(currentCtx), saveMoreValueOf() + Number(quick.dataset.quickSave)));
      syncSaveMorePreview(dialog);
      return;
    }
    if (event.target.closest("[data-save-all]")) {
      input.value = String(savingAvailableOf(currentCtx));
      syncSaveMorePreview(dialog);
    }
  });
  dialog.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    void requestSavingsTransfer(currentCtx, event.currentTarget);
  });

  const input = dialog.querySelector("#save-more-amount");
  if (input && !input.disabled) input.focus();
}

async function requestSavingsTransfer(ctx, form) {
  saveMoreBusy = true;
  saveMoreError = "";
  setFormError(form, "");
  const button = form.querySelector("[data-submit]");
  if (button) {
    button.disabled = true;
    button.textContent = "正在送出…";
  }
  try {
    await store.updateSavingsTransfer({
      action: "request",
      profileId: ctx.profile.id,
      amount: saveMoreValueOf(),
      note: saveMoreNote,
      operationId: savingsOperationId,
    });
    saveMoreBusy = false;
    announce("自主多存已送給爸媽確認", "waiting");
    saveMoreOpen = false;
    openModalKind = "";
    closeModal();
  } catch (caught) {
    const message = errorMessage(caught, "自主存錢申請失敗");
    saveMoreBusy = false;
    saveMoreError = message;
    setFormError(form, message);
    showStatus(message, "error");
    if (button && button.isConnected) {
      button.textContent = "請爸媽確認";
      syncSaveMorePreview(form.closest(".modal") ?? form);
    }
  }
}

// ---------- 花園 ----------
async function chooseGarden(ctx, next, buttons) {
  gardenBusy = true;
  error = "";
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await store.updateGardenSpecies({ profileId: ctx.profile.id, gardenSpecies: next });
    gardenBusy = false;
    showStatus("小森林的植物已經換好了", "success");
  } catch (caught) {
    const message = errorMessage(caught, "花園設定失敗");
    gardenBusy = false;
    error = message;
    showStatus(message, "error");
    buttons.forEach((button) => { if (button.isConnected) button.disabled = false; });
  }
}

// ---------- mount ----------
export function mount(root, ctx) {
  currentCtx = ctx;
  if (!ctx.profile) return;

  if (!boundRoots.has(root)) {
    boundRoots.add(root);
    root.addEventListener("click", onRootClick);
    root.addEventListener("toggle", (event) => {
      const target = event.target;
      if (!target || typeof target.matches !== "function") return;
      if (target.matches(".garden-picker")) gardenPickerOpen = target.open;
    }, true);
  }

  // 重繪之後把原本開著的 modal 補回來（正在送出時不重開，避免搶走焦點）。
  if (action && openModalKind !== "transaction") openTransactionModal(ctx);
  else if (saveMoreOpen && openModalKind !== "saveMore") openSaveMoreModal(ctx);
}

function onRootClick(event) {
  const ctx = currentCtx;
  if (!ctx) return;

  // 孩子切換（data-choose-profile）由 app.js 統一委派，這裡不再接。

  const garden = event.target.closest("[data-garden]");
  if (garden) {
    const buttons = Array.from(garden.parentElement.querySelectorAll("[data-garden]"));
    void chooseGarden(ctx, garden.dataset.garden, buttons);
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button) return;
  const name = button.dataset.action;
  if (name === "open-allowance") openAction(ctx, "allowance");
  else if (name === "open-spend") openAction(ctx, "spend");
  else if (name === "open-save-more") openSaveMore(ctx);
}
