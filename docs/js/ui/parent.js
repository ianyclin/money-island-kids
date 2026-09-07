// 家長區（移植自 app/parent/page.tsx ＋ app/parent/device-trust-panel.tsx 的備份段落）。
// 骨架換成 render/mount，內容、class 與文案照原專案；只有架構契約第 12 節列出的句子改寫成單機版。

import { html, raw, money, taipeiDate, formatDate, formatDateTime, errorMessage, uuid } from "../util.js";
import * as common from "./common.js";
import * as store from "../store.js";
import * as pin from "../pin.js";
import * as backup from "../backup.js";
import * as db from "../db.js";
import * as gist from "../gist.js";

// 原本 readInvestmentPresets 只回 active = 1（money-store.ts L1398–1402）
function activePresets(state) {
  return (state.investmentPresets || []).filter((item) => item.active !== false);
}

// ---------- 頁面暫存（重繪後還原） ----------
const ui = {
  parentPin: "",
  notice: "資料異動後會自動儲存",
  operationError: null,          // { scope, message }
  pinError: "",
  pinChangeOpen: false,
  profileEditorOpen: false,
  addProfileOpen: false,
  projectEditorOpen: false,
  projectId: "",
  presetId: "",
  editingPurchaseId: "",
  editingHarvestId: "",
  harvestHoldingId: "",
  destinationDreamId: "",
  purchaseOperationId: "",
  savingsRate: null,
  savingsRateBase: null,
  quoteMeta: null,               // { updatedAt, source }
  profilePhoto: "",              // 新選的照片（已壓縮的 data URL）
  profilePreview: "",
  restoreSummary: null,
  restoreEnvelope: null,
  snapshots: null,               // null=尚未讀取、[]=沒有、false=不支援
  openDetails: new Set(),
  drafts: Object.create(null),
  profileKey: "",
  piggyKey: "",
  identityKey: "",
};

const ERROR_ANCHORS = {
  pin: { selector: ".parent-lock-card", position: "beforeend" },
  profile: { selector: ".profile-editor-forms", position: "beforeend" },
  accounts: { selector: ".profile-editor-forms", position: "beforeend" },
  projects: { selector: ".parent-project-panel", position: "beforeend" },
  purchase: { selector: "[data-purchase-submit]", position: "beforebegin" },
  holdings: { selector: ".holding-panel", position: "beforeend" },
  harvest: { selector: ".harvest-content", position: "beforeend" },
  backup: { selector: ".parent-device-panel", position: "beforeend" },
};

function draft(key, fallback = "") {
  return Object.prototype.hasOwnProperty.call(ui.drafts, key) ? ui.drafts[key] : fallback;
}

function draftChecked(key) {
  return ui.drafts[key] === true;
}

function clearDrafts(...keys) {
  for (const key of keys) delete ui.drafts[key];
}

function isOpen(key) {
  return ui.openDetails.has(key);
}

function fieldValue(scope, key) {
  const field = scope && scope.querySelector(`[data-draft="${key}"]`);
  return field ? field.value : "";
}

function fieldChecked(scope, key) {
  const field = scope && scope.querySelector(`[data-draft="${key}"]`);
  return Boolean(field && field.checked);
}

// ---------- 衍生資料 ----------
function scopeOf(state, profile) {
  const holdings = state.holdings.filter((item) => item.profileId === profile.id);
  const purchases = state.purchases.filter((item) => item.profileId === profile.id).slice(0, 8);
  const shortDreams = state.dreamJars.filter((item) => item.profileId === profile.id && item.kind === "short" && item.status === "active");
  const harvestHistory = state.harvests
    .filter((item) => item.profileId === profile.id)
    .slice()
    .sort((a, b) => b.saleDate.localeCompare(a.saleDate) || b.createdAt.localeCompare(a.createdAt));
  return { holdings, purchases, shortDreams, harvestHistory };
}

// 原本用 useEffect 在 profile／餘額變動時重設表單；這裡在 render 時比對 key 做同一件事。
function syncKeys(state, profile, holdings, shortDreams) {
  if (ui.profileKey !== profile.id) {
    ui.profileKey = profile.id;
    clearDrafts("harvest-sold-units", "harvest-net-proceeds", "harvest-note", "harvest-confirm");
    ui.editingPurchaseId = "";
    ui.editingHarvestId = "";
  }
  const piggyKey = `${profile.id}:${profile.spendingBalance}`;
  if (ui.piggyKey !== piggyKey) {
    ui.piggyKey = piggyKey;
    clearDrafts("piggy-balance", "piggy-note");
  }
  const identityKey = `${profile.id}:${profile.name}:${profile.avatar}`;
  if (ui.identityKey !== identityKey) {
    ui.identityKey = identityKey;
    clearDrafts("profile-name");
    ui.profilePhoto = "";
    ui.profilePreview = "";
  }
  if (ui.savingsRateBase !== state.savingsRate) {
    ui.savingsRateBase = state.savingsRate;
    ui.savingsRate = state.savingsRate;
  }
  if (!ui.purchaseOperationId) ui.purchaseOperationId = uuid();

  const validHoldingIds = new Set(holdings.map((item) => item.id));
  if (!ui.harvestHoldingId || !validHoldingIds.has(ui.harvestHoldingId)) ui.harvestHoldingId = holdings[0]?.id ?? "";
  const validDreamIds = new Set(shortDreams.map((item) => item.id));
  if (ui.destinationDreamId && !validDreamIds.has(ui.destinationDreamId)) ui.destinationDreamId = shortDreams[0]?.id ?? "";
}

// ---------- render ----------
export function render(ctx) {
  const state = ctx.state;
  const profile = ctx.profile;
  if (!state || !profile) return raw(common.stateGate(null, () => ctx.refresh()));

  const pinStatus = ctx.pinStatus;
  const unlocked = pinStatus === "unlocked";
  const { holdings, purchases, shortDreams, harvestHistory } = scopeOf(state, profile);
  syncKeys(state, profile, holdings, shortDreams);

  const waitingProjects = state.projects.filter((item) => item.status === "waiting");
  const pendingSavingsTransfers = state.savingsTransfers.filter((item) => item.status === "pending");
  const currentYear = Number(taipeiDate().slice(0, 4));
  const harvestedThisYear = state.harvests.some((item) => item.profileId === profile.id && item.year === currentYear);
  const maxHarvest = Math.floor((profile.marketValue ?? 0) * 0.05);
  const plannedCost = Math.max(0, Math.round(Number(draft("purchase-total-cost")) || 0));
  const purchaseReady = draftChecked("purchase-confirm")
    && plannedCost > 0 && plannedCost <= profile.bankBalance && Number(draft("purchase-units")) > 0;
  const harvestNetProceeds = Number(draft("harvest-net-proceeds"));
  const harvestReady = draftChecked("harvest-confirm")
    && harvestNetProceeds > 0 && harvestNetProceeds <= maxHarvest && Number(draft("harvest-sold-units")) > 0;
  const latestPriceUpdatedAt = holdings.find((holding) => holding.priceUpdatedAt)?.priceUpdatedAt ?? "";

  return html`<main class="parent-shell" data-kid="${profile.id}" style="--kid-accent: ${profile.accent}">
      <header class="parent-topbar">
        <a class="brand" href="#/" aria-label="回到小小理財島">
          <span class="brand-mark" aria-hidden="true">¢</span>
          <span><strong>小小理財島</strong><small>家長專區</small></span>
        </a>
        ${raw(common.primaryNav("parent"))}
      </header>

      <section class="parent-hero">
        <div>
          <div class="heading-help"><span class="parent-kicker">所有家長功能集中在這裡</span>${raw(common.infoTip("先解鎖一次，再依序處理撲滿、家庭小專案、真實投資與資料備份。"))}</div>
          <h1>管理帳本、專案與投資，<br /><em>孩子頁面保持簡單。</em></h1>
        </div>
      </section>

      <section class="${unlocked ? "parent-lock-card is-unlocked" : "parent-lock-card"}">
        <span class="lock-icon" aria-hidden="true">${unlocked ? "✓" : "🔒"}</span>
        <div><b>${pinStatus === "setup" ? "第一次使用：設定家長操作碼" : unlocked ? "家長區已解鎖" : "輸入家長操作碼"}</b><small>${pinStatus === "setup" ? "使用 4–8 位數字；操作碼不會顯示在孩子頁面。" : unlocked ? "現在可以使用本頁所有家長功能。" : "編輯帳本、專案、投資與資料備份都需要驗證。"}</small></div>
        ${!unlocked ? html`<form data-form="pin"><input type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" data-digits placeholder="4–8 位數字" required /><button data-busy-label="驗證中…">${pinStatus === "setup" ? "設定並解鎖" : "解鎖"}</button></form>` : ""}
        ${unlocked ? html`<button class="pin-change-trigger" type="button" aria-expanded="${ui.pinChangeOpen ? "true" : "false"}" data-action="toggle-pin-change">變更操作碼 ${ui.pinChangeOpen ? "−" : "＋"}</button>` : ""}
        ${unlocked && ui.pinChangeOpen ? html`<form class="pin-change-form" data-form="pin-change">
          <label>目前操作碼<input type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" data-digits data-field="current-pin" required /></label>
          <label>新操作碼<input type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" data-digits data-field="new-pin" required /></label>
          <label>再輸入一次<input type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" data-digits data-field="confirm-new-pin" required /></label>
          <button data-busy-label="更新中…">確認變更</button>
        </form>` : ""}
      </section>

      <div class="parent-settings-row">
      ${guideMarkup()}

      <form class="family-settings-panel savings-inline-panel" data-form="savings-rate">
        <span class="settings-panel-copy"><small>全家共用設定</small><b>預先儲蓄比例</b></span>
        <div class="savings-stepper" aria-label="調整預先儲蓄比例">
          <button type="button" aria-label="減少 5%" data-action="savings-down" ${!unlocked || ui.savingsRate <= 0 ? raw("disabled") : ""}>−</button>
          <output aria-live="polite">${ui.savingsRate}%</output>
          <button type="button" aria-label="增加 5%" data-action="savings-up" ${!unlocked || ui.savingsRate >= 100 ? raw("disabled") : ""}>＋</button>
        </div>
        <button class="savings-rate-save" data-busy-label="儲存中…" ${!unlocked || ui.savingsRate === state.savingsRate ? raw("disabled") : ""}>${ui.savingsRate === state.savingsRate ? "已儲存" : "儲存"}</button>
      </form>

      <button class="${ui.profileEditorOpen ? "profile-settings-trigger is-open" : "profile-settings-trigger"}" type="button" aria-expanded="${ui.profileEditorOpen ? "true" : "false"}" data-action="open-profile-editor" data-id="${profile.id}">
        <span>${raw(common.profileAvatar(profile.avatar))}</span>
        <span><small>孩子資料</small><b>編輯${profile.name}</b></span>
        <strong>${ui.profileEditorOpen ? "收起 −" : "編輯 ＋"}</strong>
      </button>
      </div>

      ${ui.profileEditorOpen ? profileEditorMarkup(state, profile, unlocked) : ""}

      ${pendingSavingsTransfers.length > 0 ? html`<section class="parent-approval-strip savings-approval-strip">
        <span class="parent-kicker">等待家長確認</span>
        <h2>🌱 自主多存申請</h2>
        ${pendingSavingsTransfers.map((transfer) => {
          const kid = state.profiles.find((item) => item.id === transfer.profileId);
          return html`<article>
            <span>${kid ? raw(common.profileAvatar(kid.avatar)) : "🌱"}</span>
            <div><b>${kid?.name ?? "小朋友"}想多存 ${money(transfer.amount)}</b><small>${transfer.note} · 批准後才會從撲滿轉入爸媽銀行</small></div>
            <div class="savings-approval-actions"><button type="button" data-action="approve-transfer" data-id="${transfer.id}" data-busy-label="處理中…" ${!unlocked ? raw("disabled") : ""}>確認存入</button><button class="reject-transfer" type="button" data-action="reject-transfer" data-id="${transfer.id}" data-busy-label="處理中…" ${!unlocked ? raw("disabled") : ""}>不執行</button></div>
          </article>`;
        })}
      </section>` : ""}

      <section class="parent-project-panel" id="projects">
        <div class="parent-project-heading">
          <div class="parent-project-copy"><div class="heading-help"><span class="parent-kicker">家庭小專案</span>${raw(common.infoTip("只替額外、完整且事前約定的任務設定報酬；日常責任不標價。"))}</div><h2>專案與確認</h2></div>
          <button
            class="project-editor-trigger"
            type="button"
            aria-expanded="${ui.projectEditorOpen ? "true" : "false"}"
            data-action="toggle-project-editor"
            ${!unlocked ? raw("disabled") : ""}
          >${!unlocked ? "解鎖後新增" : ui.projectEditorOpen ? "收起編輯 −" : "新增專案 ＋"}</button>
        </div>
        <div class="${ui.projectEditorOpen ? "parent-project-layout is-editor-open" : "parent-project-layout"}">
          ${ui.projectEditorOpen ? html`<form class="parent-project-form" id="project-editor" data-form="project">
            <h3>${ui.projectId ? "編輯尚未被接下的專案" : "新增一個小專案"}</h3>
            <label>專案名稱<input data-draft="project-title" value="${draft("project-title")}" placeholder="例如：整理一箱舊玩具" required minlength="2" maxlength="40" /></label>
            <label>完成條件<textarea data-draft="project-description" placeholder="清楚寫出範圍與成果" required minlength="4" maxlength="180">${draft("project-description")}</textarea></label>
            <label>完成報酬<input type="number" inputmode="numeric" min="10" max="500" step="10" data-draft="project-reward" value="${draft("project-reward")}" required /></label>
            <button class="primary-button full-width" data-busy-label="儲存中…" ${!unlocked ? raw("disabled") : ""}>${ui.projectId ? "儲存修改" : "發布小專案"}</button>
            ${ui.projectId ? html`<button class="cancel-preset" type="button" data-action="cancel-project-edit">取消編輯</button>` : ""}
          </form>` : ""}
          <div class="parent-project-list">
            ${waitingProjects.length > 0 ? html`<div class="project-waiting-group"><b>等待家長確認</b>${waitingProjects.map((project) => {
              const kid = state.profiles.find((item) => item.id === project.assignedProfileId);
              return html`<article><span>${kid ? raw(common.profileAvatar(kid.avatar)) : ""}</span><div><strong>${kid?.name} · ${project.title}</strong><small>${money(project.reward)}，確認後依 ${state.savingsRate}% / ${100 - state.savingsRate}% 分配</small></div><button data-action="approve-project" data-id="${project.id}" data-busy-label="發放中…" ${!unlocked ? raw("disabled") : ""}>確認完成</button></article>`;
            })}</div>` : ""}
            <div class="project-manage-group"><b>目前專案</b>${state.projects.length ? state.projects.map((project) => html`<article><div><strong>${project.title}</strong><small>${project.status === "open" ? "尚未接下" : project.status === "claimed" ? "進行中" : project.status === "waiting" ? "等待確認" : "已完成"} · ${money(project.reward)}</small></div>${project.status === "open" ? html`<button data-action="edit-project" data-id="${project.id}" ${!unlocked ? raw("disabled") : ""}>編輯</button>` : ""}</article>`) : html`<p class="project-empty-state">目前沒有家庭小專案，需要時再新增即可。</p>`}</div>
          </div>
        </div>
      </section>

      <section class="investment-layout" id="investments">
        <details class="investment-form-card" data-open-key="investment" ${isOpen("investment") ? raw("open") : ""}>
          <summary class="investment-summary">
            <div><span class="parent-kicker">新增一筆真實買入</span><h2>🌱 爸媽已經買好了嗎？</h2><small>需要記錄券商買入時再展開</small></div>
            <span class="investment-summary-action"><b>記錄買入</b><small class="investment-closed-label">查看或操作 ＋</small><small class="investment-open-label">收起細節 −</small></span>
          </summary>
          <div class="investment-form-content">
          <div class="panel-help">${raw(common.infoTip("請依照券商成交結果填寫；總成本包含手續費，會最容易和真實帳戶對得上。", { align: "right" }))}</div>

          <div class="preset-row" aria-label="常用標的">
            ${activePresets(state).map((preset) => html`<button type="button" data-action="choose-preset" data-symbol="${preset.symbol}" data-name="${preset.name}" data-category="${preset.category}">${preset.symbol}</button>`)}
            <span>也可以輸入其他標的</span>
          </div>

          <details class="preset-admin" data-open-key="preset-admin" ${isOpen("preset-admin") ? raw("open") : ""}>
            <summary>調整常用標的</summary>
            <div class="preset-list">${activePresets(state).map((preset) => html`<div><span><b>${preset.symbol}</b><small>${preset.name} · ${preset.category}</small></span><button type="button" data-action="edit-preset" data-id="${preset.id}" ${!unlocked ? raw("disabled") : ""}>編輯</button><button type="button" data-action="delete-preset" data-id="${preset.id}" data-busy-label="停用中…" ${!unlocked ? raw("disabled") : ""}>停用</button></div>`)}</div>
            <form data-form="preset"><div class="form-two-columns"><label><span>標的代號</span><input data-draft="preset-symbol" data-uppercase value="${draft("preset-symbol")}" placeholder="例如 VT" required maxlength="12" /></label><label><span>類型</span><select data-draft="preset-category"><option ${draft("preset-category", "ETF") === "ETF" ? raw("selected") : ""}>ETF</option><option ${draft("preset-category", "ETF") === "股票" ? raw("selected") : ""}>股票</option></select></label></div><label><span>顯示名稱</span><input data-draft="preset-name" value="${draft("preset-name")}" placeholder="例如 Vanguard Total World" required maxlength="40" /></label><label><span>排序</span><input type="number" min="0" max="100" data-draft="preset-sort" value="${draft("preset-sort")}" placeholder="數字越小越前面" /></label><button class="primary-button full-width" data-busy-label="儲存中…" ${!unlocked ? raw("disabled") : ""}>${ui.presetId ? "儲存常用標的修改" : "新增常用標的"}</button>${ui.presetId ? html`<button class="cancel-preset" type="button" data-action="cancel-preset-edit">取消編輯</button>` : ""}</form>
          </details>

          <form data-form="purchase">
            <div class="form-two-columns">
              <label><span>股票代號</span><input data-draft="purchase-symbol" data-uppercase value="${draft("purchase-symbol")}" placeholder="例如 00646" required maxlength="12" /></label>
              <label><span>類型</span><select data-draft="purchase-category"><option ${draft("purchase-category", "ETF") === "ETF" ? raw("selected") : ""}>ETF</option><option ${draft("purchase-category", "ETF") === "股票" ? raw("selected") : ""}>股票</option></select></label>
            </div>
            <label><span>標的名稱</span><input data-draft="purchase-name" value="${draft("purchase-name")}" placeholder="例如 元大 S&P 500" required maxlength="40" /></label>
            <div class="form-two-columns">
              <label><span>實際買入股數</span><input type="number" inputmode="decimal" min="0.0001" step="0.0001" data-draft="purchase-units" value="${draft("purchase-units")}" placeholder="例如 10" required /></label>
              <label><span>總成本（含費用）</span><input type="number" inputmode="numeric" min="1" max="${profile.bankBalance}" data-draft="purchase-total-cost" value="${draft("purchase-total-cost")}" placeholder="NT$" required /></label>
            </div>
            <label><span>買入日期</span><input type="date" data-draft="purchase-date" value="${draft("purchase-date", taipeiDate())}" required /></label>
            <label><span>備註（選填）</span><input data-draft="purchase-note" value="${draft("purchase-note")}" placeholder="例如：用 8 月累積的存款買入" maxlength="100" /></label>

            <div class="purchase-preview">
              <span>${raw(common.profileAvatar(profile.avatar))}</span>
              <div><b>這筆記錄完成後</b><small>爸媽銀行會扣除 <span data-planned-cost>${money(plannedCost)}</span>，同額移到 ETF 小森林；總資產不會憑空增加。</small></div>
            </div>
            <label class="confirm-check">
              <input type="checkbox" data-draft="purchase-confirm" ${draftChecked("purchase-confirm") ? raw("checked") : ""} />
              <span>我確認這筆交易已經在真實券商完成</span>
            </label>
            <button class="primary-button full-width" data-purchase-submit data-busy-label="正在記錄與備份…" ${!unlocked || !purchaseReady ? raw("disabled") : ""}>
              確認記錄 ${profile.name}的買入
            </button>
            <small class="parent-save-note">${ui.notice}</small>
          </form>
          </div>
        </details>

        <div class="holding-column">
          <section class="holding-panel">
            <div class="holding-heading"><div><span class="parent-kicker">目前持有</span><h2>${profile.name}的 ETF 小森林</h2></div><b>${holdings.length} 個標的</b></div>
            <div class="market-quote-actions">
              <div class="market-auto-label"><b>自動更新</b>${raw(common.infoTip("打開 app 或回到前景時，系統會在背景檢查證交所最新可用收盤價；同一家庭 30 分鐘內不會重複請求。這不是盤中即時報價。", { align: "right" }))}</div>
              <button type="button" data-action="refresh-quotes" data-busy-label="檢查中…" ${!unlocked || !holdings.length ? raw("disabled") : ""}>
                重新檢查收盤價
              </button>
              ${ui.quoteMeta || latestPriceUpdatedAt ? html`<small>
                ${ui.quoteMeta?.source ?? "最近行情"} · ${formatDateTime(ui.quoteMeta?.updatedAt ?? latestPriceUpdatedAt)}
              </small>` : ""}
            </div>
            ${holdings.length ? holdings.map((holding) => {
              const gain = holding.marketValue - holding.costBasis;
              const rate = holding.costBasis ? gain / holding.costBasis * 100 : 0;
              const marketDraft = draft(`market-${holding.id}`);
              return html`
                <div class="holding-record">
                  <article class="holding-card">
                    <span class="holding-symbol">${holding.symbol}</span>
                    <div><b>${holding.name}</b><small>${holding.category} · ${holding.units} 股 · ${holding.quoteAsOf ? `${holding.quoteAsOf} 收盤價` : holding.priceUpdatedAt ? `家長更新於 ${formatDate(holding.priceUpdatedAt)}` : "尚未更新市值"}</small></div>
                    <div class="holding-value"><b>${money(holding.marketValue)}</b><small class="${gain >= 0 ? "is-up" : "is-down"}">${gain >= 0 ? "+" : ""}${rate.toFixed(1)}%</small></div>
                  </article>
                  <div class="market-editor"><input type="number" min="0" inputmode="numeric" data-draft="market-${holding.id}" value="${marketDraft}" placeholder="更新市值，目前 ${holding.marketValue}" /><button data-action="update-market-value" data-id="${holding.id}" data-busy-label="更新中…" ${!unlocked || marketDraft === "" ? raw("disabled") : ""}>記錄今日市值</button></div>
                </div>
              `;
            }) : html`<div class="empty-holding"><span>${raw(common.profileAvatar(profile.avatar))}</span><b>第一棵投資小樹還在等你</b><small>等爸媽完成第一次真實買入後，就會出現在這裡。</small></div>`}
            <div class="panel-help">${raw(common.infoTip("按下更新會取得最新可用收盤價；也可以依券商畫面手動記錄今日市值。", { align: "right" }))}</div>
          </section>

          <section class="purchase-history">
            <div class="holding-heading"><div><span class="parent-kicker">最近記錄</span><h2>爸媽協助買入</h2></div></div>
            ${purchases.length ? purchases.map((item) => html`
              <div class="${ui.editingPurchaseId === item.id ? "purchase-entry is-editing" : "purchase-entry"}">
                <div class="purchase-row">
                  <span>↗</span>
                  <div><b>${item.symbol} · ${item.name}</b><small>${item.purchaseDate} · ${item.units} 股${item.note ? ` · ${item.note}` : ""}</small></div>
                  <div class="purchase-row-tail">
                    <strong>${money(item.totalCost)}</strong>
                    ${unlocked ? html`<div class="purchase-history-actions">
                      <button type="button" data-action="${ui.editingPurchaseId === item.id ? "close-purchase-editor" : "edit-purchase"}" data-id="${item.id}" data-busy-lock>${ui.editingPurchaseId === item.id ? "收起" : "編輯"}</button>
                      <button type="button" class="is-danger" data-action="void-purchase" data-id="${item.id}" data-busy-label="撤銷中…" data-busy-lock>撤銷</button>
                    </div>` : ""}
                  </div>
                </div>
                ${unlocked && ui.editingPurchaseId === item.id ? html`<form class="purchase-correction-form" data-form="purchase-correct" data-id="${item.id}">
                  <div class="purchase-correction-grid">
                    <label><span>股數</span><input type="number" inputmode="decimal" min="0.0001" step="0.0001" data-draft="edit-purchase-units" value="${draft("edit-purchase-units")}" required /></label>
                    <label><span>總成本</span><input type="number" inputmode="numeric" min="1" step="1" data-draft="edit-purchase-cost" value="${draft("edit-purchase-cost")}" required /></label>
                    <label><span>買入日期</span><input type="date" data-draft="edit-purchase-date" value="${draft("edit-purchase-date")}" required /></label>
                    <label><span>備註</span><input data-draft="edit-purchase-note" value="${draft("edit-purchase-note")}" maxlength="100" placeholder="選填" /></label>
                  </div>
                  <div class="purchase-correction-actions">
                    <button type="button" data-action="close-purchase-editor">取消</button>
                    <button type="submit" class="is-primary" data-busy-label="校正中…">儲存更正</button>
                  </div>
                </form>` : ""}
              </div>
            `) : html`<p class="empty-history">新記錄會自動留在這裡。</p>`}
          </section>

          <details class="harvest-panel" id="harvest" data-open-key="harvest" ${isOpen("harvest") ? raw("open") : ""}>
            <summary class="harvest-summary">
              <div>
                <span class="parent-kicker">一年一次的選擇</span>
                <h2>🧧 過年投資收成日</h2>
                <small>${currentYear} 年最多 ${money(maxHarvest)} · ${harvestedThisYear ? "今年已使用" : "今年尚未使用"}</small>
              </div>
              <span class="harvest-summary-action">
                <b>最多 5%</b>
                <small class="harvest-closed-label">查看或操作 ＋</small>
                <small class="harvest-open-label">收起細節 −</small>
              </span>
            </summary>
            <div class="harvest-content">
              <div class="panel-help">${raw(common.infoTip("可以選擇完全不提領。若要使用，爸媽先在券商實際賣出，再把淨入帳金額放回撲滿；短期夢想罐的進度會自動更新。"))}</div>
              <div class="harvest-limit"><span>${raw(common.profileAvatar(profile.avatar))}</span><div><small>${currentYear} 年最高收成額度</small><strong>${money(maxHarvest)}</strong></div><b>${harvestedThisYear ? "今年已使用" : "今年尚未使用"}</b></div>
              <form data-form="harvest">
                <label>實際賣出的標的<select data-draft="harvest-holding" required>${holdings.map((holding) => html`<option value="${holding.id}" ${holding.id === ui.harvestHoldingId ? raw("selected") : ""}>${holding.symbol} · ${holding.name}（${holding.units} 股）</option>`)}</select></label>
                <div class="form-two-columns"><label>實際賣出股數<input type="number" min="0.0001" step="0.0001" data-draft="harvest-sold-units" value="${draft("harvest-sold-units")}" required /></label><label>券商淨入帳<input type="number" min="1" max="${maxHarvest}" data-draft="harvest-net-proceeds" value="${draft("harvest-net-proceeds")}" required /></label></div>
                <label>這次收成要對應哪個短期夢想？<select data-draft="harvest-dream"><option value="" ${ui.destinationDreamId === "" ? raw("selected") : ""}>不指定（仍放回撲滿）</option>${shortDreams.map((jar) => html`<option value="${jar.id}" ${jar.id === ui.destinationDreamId ? raw("selected") : ""}>短期夢想罐：${jar.title}</option>`)}</select></label>
                <label>實際賣出日期<input type="date" data-draft="harvest-sale-date" value="${draft("harvest-sale-date", taipeiDate())}" required /></label>
                <label>備註（選填）<input data-draft="harvest-note" value="${draft("harvest-note")}" placeholder="例如：今年選擇收成 3%" maxlength="100" /></label>
                <label class="confirm-check"><input type="checkbox" data-draft="harvest-confirm" ${draftChecked("harvest-confirm") ? raw("checked") : ""} /><span>我確認這筆股票已在真實券商賣出</span></label>
                <button class="primary-button full-width" data-harvest-submit data-busy-label="記錄收成中…" ${!unlocked || harvestedThisYear || !holdings.length || !harvestReady ? raw("disabled") : ""}>${harvestedThisYear ? "今年已完成收成" : "確認過年收成"}</button>
              </form>
              <details class="harvest-history-panel" data-open-key="harvest-history" ${isOpen("harvest-history") ? raw("open") : ""}>
                <summary><span>過年收成歷史</span><b>${harvestHistory.length} 筆 ＋</b></summary>
                <div class="harvest-history-list">
                  ${harvestHistory.length ? harvestHistory.map((item) => {
                    const holding = state.holdings.find((candidate) => candidate.id === item.holdingId);
                    const destination = state.dreamJars.find((candidate) => candidate.id === item.destinationDreamId);
                    const destinationOptions = destination && !shortDreams.some((candidate) => candidate.id === destination.id)
                      ? [destination, ...shortDreams]
                      : shortDreams;
                    const isEditing = ui.editingHarvestId === item.id;
                    return html`<article class="${isEditing ? "harvest-history-entry is-editing" : "harvest-history-entry"}">
                      <div class="harvest-history-row">
                        <span aria-hidden="true">福</span>
                        <div><strong>${item.year} 年 · ${money(item.netProceeds)}</strong><small>${item.saleDate} · ${holding?.symbol ?? "歷史標的"} · ${item.soldUnits} 股${destination ? ` · ${destination.title}` : ""}</small></div>
                        ${unlocked ? html`<div class="harvest-history-actions">
                          <button type="button" data-action="${isEditing ? "close-harvest-editor" : "edit-harvest"}" data-id="${item.id}" data-busy-lock>${isEditing ? "收起" : "編輯"}</button>
                          <button type="button" class="is-danger" data-action="void-harvest" data-id="${item.id}" data-busy-label="撤銷中…" data-busy-lock>撤銷</button>
                        </div>` : ""}
                      </div>
                      ${unlocked && isEditing ? html`<form class="harvest-correction-form" data-form="harvest-correct" data-id="${item.id}">
                        <div class="harvest-correction-grid">
                          <label><span>實際賣出股數</span><input type="number" inputmode="decimal" min="0.0001" step="0.0001" data-draft="edit-harvest-sold-units" value="${draft("edit-harvest-sold-units")}" required /></label>
                          <label><span>券商淨入帳</span><input type="number" inputmode="numeric" min="1" step="1" data-draft="edit-harvest-net-proceeds" value="${draft("edit-harvest-net-proceeds")}" required /></label>
                          <label><span>短期夢想罐</span><select data-draft="edit-harvest-dream"><option value="" ${draft("edit-harvest-dream") === "" ? raw("selected") : ""}>不指定（仍放回撲滿）</option>${destinationOptions.map((jar) => html`<option value="${jar.id}" ${draft("edit-harvest-dream") === jar.id ? raw("selected") : ""}>${jar.title}${jar.status !== "active" ? "（已完成或排隊中）" : ""}</option>`)}</select></label>
                          <label><span>實際賣出日期</span><input type="date" data-draft="edit-harvest-sale-date" value="${draft("edit-harvest-sale-date")}" required /></label>
                          <label class="harvest-note-field"><span>備註</span><input data-draft="edit-harvest-note" value="${draft("edit-harvest-note")}" maxlength="100" placeholder="選填" /></label>
                        </div>
                        <div class="harvest-correction-actions"><button type="button" data-action="close-harvest-editor">取消</button><button type="submit" class="is-primary" data-busy-label="校正中…">儲存更正</button></div>
                      </form>` : ""}
                    </article>`;
                  }) : html`<p class="empty-history">尚未有過年收成紀錄。</p>`}
                </div>
              </details>
            </div>
          </details>
        </div>
      </section>
      ${dataPanelMarkup(state, unlocked)}
    </main>`;
}

// ---------- 指南（只改契約第 12 節列出的句子） ----------
function guideMarkup() {
  return html`<details class="parent-guide" data-open-key="guide" ${isOpen("guide") ? raw("open") : ""}>
        <summary>
          <span aria-hidden="true">🧭</span>
          <div><small>第一次使用可以從這裡開始</small><b>小小理財島：理念與操作指南</b></div>
          <strong><i>查看指南</i><i>收起指南</i></strong>
        </summary>
        <div class="parent-guide-content">
          <section class="guide-principle">
            <span>我們想教的不是「賺最多」</span>
            <h2>錢有限，所以每一次安排，都是在練習自己做選擇。</h2>
            <p>先照顧未來的自己，再安排現在想做的事；記帳與回顧是用來觀察和調整，不是考試，也不因為選錯就處罰。</p>
          </section>

          <section class="guide-section guide-finance-section">
            <span class="parent-kicker">五個核心理財觀念</span>
            <div class="guide-finance-grid">
              <article><b>1</b><h3>錢有限</h3><p>選擇一件想要的東西，也代表其他東西需要等待。</p></article>
              <article><b>2</b><h3>先存再花</h3><p>每次收到錢，先依家庭比例留一部分給未來的自己。</p></article>
              <article><b>3</b><h3>錢有不同任務</h3><p>撲滿、爸媽銀行與 ETF 是不同用途；互相搬動不是又賺一筆。</p></article>
              <article><b>4</b><h3>投資會波動</h3><p>資產成長可能來自投入，也可能來自 ETF 漲跌，沒有保證。</p></article>
              <article><b>5</b><h3>回顧再調整</h3><p>每月看看選擇的結果，找到下次想保留或換個做法的地方。</p></article>
            </div>
          </section>

          <section class="guide-section">
            <span class="parent-kicker">第一次設定</span>
            <div class="guide-step-grid">
              <article><b>1</b><h3>建立家庭</h3><p>設定家長操作碼與孩子名字，並在「資料與備份」開啟雲端備份。</p></article>
              <article><b>2</b><h3>設定孩子資料</h3><p>編輯孩子的名字、照片與撲滿金額，並調整預先儲蓄比例；預設是 30%。</p></article>
              <article><b>3</b><h3>從第一筆錢開始</h3><p>孩子記錄收到的零用錢，系統會依比例分到「留給未來」與「可以自己決定」。</p></article>
              <article><b>4</b><h3>一起核對</h3><p>家長定期確認實體金額、爸媽銀行與真實投資；需要修正時再解鎖家長功能。</p></article>
            </div>
          </section>

          <section class="guide-section">
            <span class="parent-kicker">四個頁面怎麼用</span>
            <div class="guide-page-grid">
              <article><b>孩子首頁</b><p>記錄收到的錢與花費，查看撲滿、爸媽銀行、ETF 小森林和最近紀錄。</p></article>
              <article><b>夢想與回顧</b><p>先看看每月存錢、資產與支出，再保留一個短期夢想和一個長期夢想。</p></article>
              <article><b>所有紀錄</b><p>依名稱、日期或類型搜尋。家長解鎖後可以編輯或撤銷可調整的紀錄。</p></article>
              <article><b>家長區</b><p>管理比例、照片、撲滿、家庭小專案、真實投資與資料備份。</p></article>
            </div>
          </section>

          <section class="guide-section guide-account-section">
            <span class="parent-kicker">三個帳戶的意思</span>
            <div class="guide-account-grid">
              <article><span>🐷</span><div><b>撲滿</b><p>孩子可以自己決定的錢，也是短期夢想的進度來源。</p></div></article>
              <article><span>🏦</span><div><b>爸媽銀行</b><p>先存下的錢、自主多存與每月自動加入的爸媽存錢獎勵，準備留給較久以後。</p></div></article>
              <article><span>🌳</span><div><b>ETF 小森林</b><p>爸媽實際買入後再記錄，市值會隨家長更新的真實金額變化。</p></div></article>
            </div>
            <p class="guide-balance-note">總資產＝撲滿＋爸媽銀行＋ETF 小森林；帳戶之間搬錢不代表又賺到一筆錢。</p>
          </section>

          <section class="guide-section guide-rhythm">
            <div><span class="parent-kicker">建議的家庭節奏</span><ul><li>收到或花錢時：當下簡單記一筆。</li><li>每週：花 5 分鐘一起核對帳本。</li><li>每月：完成一次回顧，聊聊最滿意的選擇。</li><li>每年過年：可以選擇不提領，或最多收成投資的 5%。</li></ul></div>
            <div><span class="parent-kicker">資料與救援</span><ul><li>每次異動會自動存在這台裝置並保留快照。</li><li>家長可下載備份檔，或開啟 GitHub 雲端備份。</li><li>換手機時用備份檔或雲端備份拿回來。</li><li>實體「好棒印章」不換現金，繼續保留生活鼓勵的味道。</li></ul></div>
          </section>
        </div>
      </details>`;
}

// ---------- 孩子資料編輯 ----------
function profileEditorMarkup(state, profile, unlocked) {
  const canAddProfile = state.profiles.length < 5;
  const removable = state.profiles.length > 1
    && !state.activities.some((item) => item.profileId === profile.id)
    && !state.holdings.some((item) => item.profileId === profile.id)
    && !state.dreamJars.some((item) => item.profileId === profile.id);
  return html`<section class="profile-editor-panel" id="profile-editor">
        <div class="parent-profile-row profile-editor-switcher" aria-label="選擇要編輯的小朋友">
          ${state.profiles.map((item) => html`<div class="parent-profile-shell" style="--profile-color: ${item.accent}">
              <button
                class="${item.id === profile.id ? "parent-profile is-active" : "parent-profile"}"
                type="button"
                data-action="open-profile-editor"
                data-id="${item.id}"
                aria-pressed="${item.id === profile.id ? "true" : "false"}"
                aria-expanded="${item.id === profile.id ? "true" : "false"}"
              >
                <span>${raw(common.profileAvatar(item.avatar))}</span><b>${item.name}</b><small>${item.id === profile.id ? "再按一次收起編輯" : "切換並編輯這位小朋友"}</small>
              </button>
            </div>`)}
          ${canAddProfile ? html`<div class="parent-profile-shell" style="--profile-color: var(--line)">
              <button class="parent-profile" type="button" data-action="toggle-add-profile" aria-expanded="${ui.addProfileOpen ? "true" : "false"}">
                <span aria-hidden="true">＋</span><b>新增小朋友</b><small>${ui.addProfileOpen ? "再按一次收起" : "最多 5 位，只要填名字"}</small>
              </button>
            </div>` : ""}
        </div>
        <div class="profile-editor-forms">
          <form class="profile-identity-form" data-form="profile-identity">
            <span class="profile-photo-preview">${raw(common.profileAvatar(ui.profilePreview || profile.avatar, draft("profile-name", profile.name) || profile.name))}</span>
            <label>顯示名字<input data-draft="profile-name" value="${draft("profile-name", profile.name)}" minlength="1" maxlength="12" required /></label>
            <label class="profile-photo-input">選擇照片<input type="file" accept="image/jpeg,image/png,image/webp" data-input="profile-photo" /></label>
            <button data-busy-label="儲存中…" ${!unlocked ? raw("disabled") : ""}>儲存照片與名字</button>
            ${removable ? html`<button class="cancel-preset" type="button" data-action="remove-profile" data-busy-label="移除中…" ${!unlocked ? raw("disabled") : ""}>移除這位小朋友</button>` : ""}
          </form>
          <form class="profile-piggy-form" data-form="piggy">
            <label>撲滿目前金額<input type="number" min="0" max="1000000" inputmode="numeric" data-draft="piggy-balance" value="${draft("piggy-balance", String(profile.spendingBalance))}" required /></label>
            <label>校正原因（選填）<input data-draft="piggy-note" value="${draft("piggy-note")}" placeholder="例如：和實體撲滿核對" maxlength="100" /></label>
            <button data-busy-label="儲存中…" ${!unlocked ? raw("disabled") : ""}>儲存撲滿金額</button>
          </form>
          ${ui.addProfileOpen && canAddProfile ? html`<form class="profile-add-form" data-form="add-profile">
            <label>新的小朋友名字<input data-draft="new-profile-name" value="${draft("new-profile-name")}" minlength="1" maxlength="12" placeholder="例如：小寶" required /></label>
            <button data-busy-label="新增中…" ${!unlocked ? raw("disabled") : ""}>新增小朋友</button>
            <button class="cancel-preset" type="button" data-action="cancel-add-profile">取消</button>
          </form>` : ""}
        </div>
      </section>`;
}

// ---------- 資料與備份（取代 DeviceTrustPanel） ----------
function dataPanelMarkup(state, unlocked) {
  const healthy = state.backupHealth?.status !== "failed";
  return html`<section class="parent-device-panel" id="devices">
      <div class="parent-device-heading"><div><span class="parent-kicker">裝置與資料</span><h2>資料與備份</h2></div><span class="${healthy ? "device-status is-trusted" : "device-status"}">${common.backupStatusText(state)}</span></div>
      <div class="parent-device-grid">
        <details data-open-key="backup-file" ${isOpen("backup-file") ? raw("open") : ""}><summary>下載或上傳資料副本</summary><p>平時可下載帳本；換手機或搬到別的地方時，請下載包含孩子照片的完整可攜備份。兩種備份都不含家長操作碼。</p><div class="backup-download-actions"><button data-action="download-backup" data-kind="account" data-busy-label="準備中…" ${!unlocked ? raw("disabled") : ""}>下載帳本備份</button><button data-action="download-backup" data-kind="portable" data-busy-label="準備中…" ${!unlocked ? raw("disabled") : ""}>下載完整可攜備份</button></div><label class="backup-file-label">選擇備份檔<input type="file" accept="application/json,.json" data-input="backup-file" ${!unlocked ? raw("disabled") : ""} /></label>${ui.restoreSummary ? restoreSummaryMarkup(ui.restoreSummary, unlocked) : ""}</details>
        <details data-open-key="snapshots" ${isOpen("snapshots") ? raw("open") : ""}><summary>本機快照</summary><p>每次記帳或修改，app 都會自動另外存一份完整快照，保留最近 20 份與每天最後一份（60 天）。誤刪、誤扣、資料出問題都可以從這裡救回來。</p><div class="device-list" data-snapshot-list>${snapshotListMarkup(unlocked)}</div></details>
        <details data-open-key="gist" ${isOpen("gist") ? raw("open") : ""}><summary>GitHub 雲端備份</summary><div data-gist-root>${raw(gist.renderGistPanel())}</div></details>
      </div>
    </section>`;
}

function restoreSummaryMarkup(summary, unlocked) {
  return html`<div class="restore-summary"><b>${summary.family.name} · ${formatDateTime(summary.exportedAt)}</b><small>${summary.portable ? `完整可攜備份${summary.photoCount ? `，包含 ${summary.photoCount} 張照片` : ""}` : "帳本備份"}</small><small>${summary.counts.profiles} 位孩子、${summary.counts.activities} 筆紀錄、${summary.counts.dreams} 個夢想、${summary.counts.holdings} 個投資標的</small><button class="restore-button" data-action="restore-backup" data-busy-label="還原中…" ${!unlocked ? raw("disabled") : ""}>確認覆蓋並還原</button><small>確認後會先自動保存目前帳本，再以備份內容取代。</small></div>`;
}

function snapshotSubtitle(record) {
  const parts = [];
  if (record.reason) parts.push(String(record.reason));
  if (typeof record.profiles === "number") parts.push(`${record.profiles} 位孩子`);
  if (typeof record.activities === "number") parts.push(`${record.activities} 筆紀錄`);
  if (!parts.length && typeof record.raw === "string") parts.push(`${Math.max(1, Math.round(record.raw.length / 1024))} KB`);
  return parts.join(" · ");
}

function snapshotListMarkup(unlocked) {
  if (ui.snapshots === null) return html`<p class="empty-history">讀取中…</p>`;
  if (ui.snapshots === false) return html`<p class="empty-history">這台裝置不支援自動快照，請多用上面的手動備份。</p>`;
  if (!ui.snapshots.length) return html`<p class="empty-history">還沒有快照（第一次改動後幾秒就會出現）。</p>`;
  const shown = ui.snapshots.slice(0, 12);
  return html`${shown.map((record) => html`<div>
      <span><b>${formatDateTime(record.ts)}</b><small>${snapshotSubtitle(record)}</small></span>
      <button type="button" data-action="restore-snapshot" data-ts="${record.ts}" data-busy-label="還原中…" ${!unlocked ? raw("disabled") : ""}>還原</button>
    </div>`)}${ui.snapshots.length > 12 ? html`<p class="empty-history">還有 ${ui.snapshots.length - 12} 份較早的快照。</p>` : ""}`;
}

// ---------- 忙碌狀態與錯誤 ----------
let busyRestore = null;

function startBusy(root, button) {
  busyRestore = [];
  if (button) {
    busyRestore.push({ element: button, html: button.innerHTML, disabled: button.disabled });
    if (button.dataset.busyLabel) button.textContent = button.dataset.busyLabel;
    button.disabled = true;
  }
  root.querySelectorAll("[data-busy-lock]").forEach((element) => {
    if (element === button) return;
    busyRestore.push({ element, html: element.innerHTML, disabled: element.disabled });
    element.disabled = true;
  });
}

function endBusy() {
  for (const entry of busyRestore ?? []) {
    entry.element.innerHTML = entry.html;
    entry.element.disabled = entry.disabled;
  }
  busyRestore = null;
}

function submitButtonOf(form) {
  return form.querySelector("button[type=submit], button:not([type])");
}

function paintOperationError(root) {
  root.querySelectorAll("p.form-error[data-error-scope]").forEach((node) => node.remove());
  const entries = [];
  if (ui.pinError) entries.push({ scope: "pin", message: ui.pinError });
  if (ui.operationError) entries.push(ui.operationError);
  for (const entry of entries) {
    const anchor = ERROR_ANCHORS[entry.scope];
    if (!anchor) continue;
    const target = root.querySelector(anchor.selector);
    if (!target) continue;
    const paragraph = document.createElement("p");
    paragraph.className = "form-error";
    paragraph.dataset.errorScope = entry.scope;
    paragraph.textContent = entry.message;
    target.insertAdjacentElement(anchor.position, paragraph);
  }
}

function announce(root, message, tone = "success") {
  ui.notice = message;
  const note = root.querySelector(".parent-save-note");
  if (note) note.textContent = message;
  common.showStatus(message, tone);
}

function clearOperationError(root, scope) {
  if (!scope || ui.operationError?.scope === scope) ui.operationError = null;
  paintOperationError(root);
}

function reportOperationError(root, scope, caught, fallback) {
  const message = errorMessage(caught, fallback);
  ui.operationError = { scope, message };
  paintOperationError(root);
  common.showStatus(message, "error");
}

// 送出到 store 的共同流程：忙碌 → 呼叫 → 成功報告／失敗顯示在該區塊。
async function runParentAction(root, ctx, { button, scope, fallback, message }, work) {
  startBusy(root, button);
  clearOperationError(root, scope);
  try {
    await work();
    busyRestore = null;   // commit 後 app.js 會整頁重繪，舊節點不需要還原
    const saved = common.savedStatus(store.getState(), message ?? "家長操作已完成，帳本已更新");
    announce(root, saved.message, saved.tone);
    return true;
  } catch (caught) {
    endBusy();
    reportOperationError(root, scope, caught, fallback ?? "家長操作儲存失敗");
    return false;
  }
}

// ---------- 照片壓縮 ----------
async function compressPhoto(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("照片讀取失敗，請換一張再試"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("照片讀取失敗，請換一張再試"));
    element.src = dataUrl;
  });
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const longest = Math.max(width, height) || 1;
  const scale = Math.min(1, 256 / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  let output = canvas.toDataURL("image/jpeg", 0.82);
  if (output.length > 60000) output = canvas.toDataURL("image/jpeg", 0.5);
  return output;
}

// ---------- 局部更新 ----------
function syncPurchaseForm(root, ctx) {
  const form = root.querySelector('[data-form="purchase"]');
  if (!form) return;
  const profile = ctx.profile;
  const plannedCost = Math.max(0, Math.round(Number(fieldValue(form, "purchase-total-cost")) || 0));
  const preview = form.querySelector("[data-planned-cost]");
  if (preview) preview.textContent = money(plannedCost);
  const submit = form.querySelector("[data-purchase-submit]");
  if (submit) {
    submit.disabled = ctx.pinStatus !== "unlocked"
      || !fieldChecked(form, "purchase-confirm")
      || plannedCost <= 0
      || plannedCost > profile.bankBalance
      || Number(fieldValue(form, "purchase-units")) <= 0;
  }
}

function syncHarvestForm(root, ctx, maxHarvest, harvestedThisYear, holdingCount) {
  const form = root.querySelector('[data-form="harvest"]');
  if (!form) return;
  const submit = form.querySelector("[data-harvest-submit]");
  if (!submit) return;
  const netProceeds = Number(fieldValue(form, "harvest-net-proceeds"));
  submit.disabled = ctx.pinStatus !== "unlocked"
    || harvestedThisYear
    || !holdingCount
    || !fieldChecked(form, "harvest-confirm")
    || netProceeds <= 0
    || netProceeds > maxHarvest
    || Number(fieldValue(form, "harvest-sold-units")) <= 0;
}

function syncMarketEditor(root, ctx, holdingId) {
  const input = root.querySelector(`[data-draft="market-${holdingId}"]`);
  const button = root.querySelector(`[data-action="update-market-value"][data-id="${holdingId}"]`);
  if (!input || !button) return;
  button.disabled = ctx.pinStatus !== "unlocked" || input.value === "";
}

function syncSavingsRate(root, ctx) {
  const panel = root.querySelector('[data-form="savings-rate"]');
  if (!panel) return;
  const unlocked = ctx.pinStatus === "unlocked";
  const output = panel.querySelector("output");
  if (output) output.textContent = `${ui.savingsRate}%`;
  const down = panel.querySelector('[data-action="savings-down"]');
  const up = panel.querySelector('[data-action="savings-up"]');
  if (down) down.disabled = !unlocked || ui.savingsRate <= 0;
  if (up) up.disabled = !unlocked || ui.savingsRate >= 100;
  const save = panel.querySelector(".savings-rate-save");
  if (save) {
    const same = ui.savingsRate === ctx.state.savingsRate;
    save.disabled = !unlocked || same;
    save.textContent = same ? "已儲存" : "儲存";
  }
}

function scrollTo(selector) {
  window.setTimeout(() => document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
}

async function loadSnapshots(root, ctx) {
  try {
    const list = await db.listSnapshots();
    ui.snapshots = Array.isArray(list) ? list : [];
  } catch {
    ui.snapshots = false;
  }
  const container = root.querySelector("[data-snapshot-list]");
  if (container) container.innerHTML = String(snapshotListMarkup(ctx.pinStatus === "unlocked"));
}

// ---------- mount ----------
// #app 這個節點在重繪之間是同一個，事件只綁一次；ctx 每次 mount 更新，處理器一律讀最新的。
const boundRoots = new WeakSet();
let ctxRef = null;

function harvestLimits() {
  const state = ctxRef.state;
  const profile = ctxRef.profile;
  const currentYear = Number(taipeiDate().slice(0, 4));
  return {
    maxHarvest: Math.floor((profile.marketValue ?? 0) * 0.05),
    harvestedThisYear: state.harvests.some((item) => item.profileId === profile.id && item.year === currentYear),
    holdingCount: state.holdings.filter((item) => item.profileId === profile.id).length,
  };
}

function syncHarvestSubmit(root) {
  const limits = harvestLimits();
  syncHarvestForm(root, ctxRef, limits.maxHarvest, limits.harvestedThisYear, limits.holdingCount);
}

export function mount(root, ctx) {
  ctxRef = ctx;
  if (!ctx.state || !ctx.profile) return;

  paintOperationError(root);

  const gistRoot = root.querySelector("[data-gist-root]");
  if (gistRoot) gist.mountGistPanel(gistRoot);

  if (isOpen("snapshots") && ui.snapshots === null) void loadSnapshots(root, ctx);

  if (boundRoots.has(root)) return;
  boundRoots.add(root);

  // details 開闔狀態（toggle 不冒泡，用捕捉階段接）
  root.addEventListener("toggle", (event) => {
    const element = event.target;
    if (!(element instanceof HTMLElement) || element.tagName !== "DETAILS" || !element.dataset.openKey) return;
    const key = element.dataset.openKey;
    if (element.open) ui.openDetails.add(key); else ui.openDetails.delete(key);
    if (key === "snapshots" && element.open && ui.snapshots === null) void loadSnapshots(root, ctxRef);
  }, true);

  // 草稿：所有帶 data-draft 的欄位都記在模組頂層，重繪後由 render 讀回。
  const recordDraft = (field) => {
    if (!(field instanceof HTMLElement) || !field.dataset.draft) return;
    ui.drafts[field.dataset.draft] = field.type === "checkbox" ? field.checked : field.value;
  };

  root.addEventListener("input", (event) => {
    const field = event.target;
    if (!(field instanceof HTMLElement)) return;
    if (field.dataset.digits !== undefined) field.value = field.value.replace(/\D/g, "");
    if (field.dataset.uppercase !== undefined) field.value = field.value.toUpperCase();
    recordDraft(field);
    if (field.dataset.draft === "purchase-total-cost" || field.dataset.draft === "purchase-units") syncPurchaseForm(root, ctxRef);
    if (field.dataset.draft === "harvest-net-proceeds" || field.dataset.draft === "harvest-sold-units") syncHarvestSubmit(root);
    if (field.dataset.draft?.startsWith("market-")) syncMarketEditor(root, ctxRef, field.dataset.draft.slice(7));
  });

  root.addEventListener("change", async (event) => {
    const field = event.target;
    if (!(field instanceof HTMLElement)) return;
    recordDraft(field);
    if (field.dataset.draft === "purchase-confirm") syncPurchaseForm(root, ctxRef);
    if (field.dataset.draft === "harvest-confirm") syncHarvestSubmit(root);
    if (field.dataset.draft === "harvest-holding") ui.harvestHoldingId = field.value;
    if (field.dataset.draft === "harvest-dream") ui.destinationDreamId = field.value;
    if (field.dataset.input === "profile-photo") {
      const file = field.files?.[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) {
        reportOperationError(root, "profile", new Error("照片請小於 4 MB"), "照片請小於 4 MB");
        field.value = "";
        return;
      }
      clearOperationError(root, "profile");
      try {
        const dataUrl = await compressPhoto(file);
        ui.profilePhoto = dataUrl;
        ui.profilePreview = dataUrl;
        const preview = root.querySelector(".profile-photo-preview");
        if (preview) preview.innerHTML = String(common.profileAvatar(dataUrl, fieldValue(root, "profile-name") || ctxRef.profile.name));
      } catch (caught) {
        reportOperationError(root, "profile", caught, "照片讀取失敗，請換一張再試");
      }
    }
    if (field.dataset.input === "backup-file") {
      const file = field.files?.[0];
      if (!file) return;
      await inspectBackupFile(root, ctxRef, field, file);
    }
  });

  root.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
    event.preventDefault();
    void handleSubmit(root, ctxRef, form);
  });

  root.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-action]");
    if (!button || !root.contains(button)) return;
    void handleClick(root, ctxRef, button);
  });
}

// ---------- 表單 ----------
async function handleSubmit(root, ctx, form) {
  const profile = ctx.profile;
  const button = submitButtonOf(form);
  const kind = form.dataset.form;

  if (kind === "pin") {
    const input = form.querySelector('input[type="password"]');
    const value = input ? input.value : "";
    ui.pinError = "";
    paintOperationError(root);
    startBusy(root, button);
    try {
      if (ctx.pinStatus === "setup") {
        await pin.setup(value);
        if (!pin.isUnlocked()) await pin.assert(value);
      } else {
        await pin.assert(value);
      }
      ui.parentPin = value;
      const message = ctx.pinStatus === "setup" ? "家長操作碼已設定" : "家長區已解鎖；關閉頁面後會再次上鎖";
      announce(root, message);
      ctx.refresh();
    } catch (caught) {
      endBusy();
      ui.pinError = errorMessage(caught, "操作碼驗證失敗");
      paintOperationError(root);
      common.showStatus(ui.pinError, "error");
    }
    return;
  }

  if (kind === "pin-change") {
    const currentPin = form.querySelector('[data-field="current-pin"]').value;
    const newPin = form.querySelector('[data-field="new-pin"]').value;
    const confirmNewPin = form.querySelector('[data-field="confirm-new-pin"]').value;
    ui.pinError = "";
    paintOperationError(root);
    if (newPin !== confirmNewPin) {
      ui.pinError = "兩次輸入的新操作碼不一致";
      paintOperationError(root);
      common.showStatus("兩次輸入的新操作碼不一致", "error");
      return;
    }
    startBusy(root, button);
    try {
      await pin.change(currentPin, newPin);
      ui.parentPin = newPin;
      ui.pinChangeOpen = false;
      announce(root, "家長操作碼已更新；下次請使用新操作碼解鎖");
      ctx.refresh();
    } catch (caught) {
      endBusy();
      ui.pinError = errorMessage(caught, "無法變更操作碼");
      paintOperationError(root);
      common.showStatus(ui.pinError, "error");
    }
    return;
  }

  if (kind === "savings-rate") {
    const ok = await runParentAction(root, ctx, { button, scope: "accounts" }, () => store.updateSavingsRate({ savingsRate: ui.savingsRate, parentPin: ui.parentPin }));
    if (ok) announce(root, `預先儲蓄比例已調整為 ${ui.savingsRate}%`);
    return;
  }

  if (kind === "profile-identity") {
    const name = fieldValue(form, "profile-name");
    const ok = await runParentAction(root, ctx, { button, scope: "profile", fallback: "名字或照片儲存失敗", message: `${name}的名字與照片已經存好了` }, () => store.updateProfile({
      profileId: profile.id,
      name,
      avatar: ui.profilePhoto || undefined,
      parentPin: ui.parentPin,
    }));
    if (ok) {
      ui.profilePhoto = "";
      ui.profilePreview = "";
    }
    return;
  }

  if (kind === "piggy") {
    const ok = await runParentAction(root, ctx, { button, scope: "accounts" }, () => store.setPiggyBankBalance({
      profileId: profile.id,
      balance: Number(fieldValue(form, "piggy-balance")),
      note: fieldValue(form, "piggy-note"),
      parentPin: ui.parentPin,
    }));
    if (ok) {
      clearDrafts("piggy-note");
      announce(root, "撲滿金額已經校正");
    }
    return;
  }

  if (kind === "add-profile") {
    const name = fieldValue(form, "new-profile-name");
    const ok = await runParentAction(root, ctx, { button, scope: "profile", fallback: "新增小朋友失敗", message: `${name}已經加入這座島了` }, () => store.addProfile({ name, parentPin: ui.parentPin }));
    if (ok) {
      clearDrafts("new-profile-name");
      ui.addProfileOpen = false;
    }
    return;
  }

  if (kind === "project") {
    const ok = await runParentAction(root, ctx, { button, scope: "projects" }, () => store.updateFamilyProject({
      action: ui.projectId ? "update" : "create",
      projectId: ui.projectId || undefined,
      title: fieldValue(form, "project-title"),
      description: fieldValue(form, "project-description"),
      reward: Number(fieldValue(form, "project-reward")),
      parentPin: ui.parentPin,
    }));
    if (ok) resetProjectForm();
    return;
  }

  if (kind === "preset") {
    const sort = fieldValue(form, "preset-sort");
    const ok = await runParentAction(root, ctx, { button, scope: "holdings" }, () => store.updateInvestmentPreset({
      action: ui.presetId ? "update" : "create",
      presetId: ui.presetId || undefined,
      symbol: fieldValue(form, "preset-symbol"),
      name: fieldValue(form, "preset-name"),
      category: fieldValue(form, "preset-category"),
      sortOrder: Number(sort || activePresets(ctx.state).length + 1),
      parentPin: ui.parentPin,
    }));
    if (ok) {
      ui.presetId = "";
      clearDrafts("preset-symbol", "preset-name", "preset-category", "preset-sort");
    }
    return;
  }

  if (kind === "purchase") {
    const plannedCost = Math.max(0, Math.round(Number(fieldValue(form, "purchase-total-cost")) || 0));
    const ok = await runParentAction(root, ctx, { button, scope: "purchase", fallback: "儲存失敗", message: `${profile.name}的買入紀錄已經存好了` }, () => store.addInvestmentPurchase({
      profileId: profile.id,
      symbol: fieldValue(form, "purchase-symbol"),
      name: fieldValue(form, "purchase-name"),
      category: fieldValue(form, "purchase-category"),
      units: Number(fieldValue(form, "purchase-units")),
      totalCost: plannedCost,
      purchaseDate: fieldValue(form, "purchase-date"),
      note: fieldValue(form, "purchase-note"),
      operationId: ui.purchaseOperationId,
      parentPin: ui.parentPin,
    }));
    if (ok) {
      clearDrafts("purchase-units", "purchase-total-cost", "purchase-note", "purchase-confirm");
      ui.purchaseOperationId = uuid();
    }
    return;
  }

  if (kind === "purchase-correct") {
    const purchaseId = form.dataset.id;
    const ok = await runParentAction(root, ctx, { button, scope: "holdings" }, () => store.correctInvestmentPurchase({
      purchaseId,
      units: Number(fieldValue(form, "edit-purchase-units")),
      totalCost: Number(fieldValue(form, "edit-purchase-cost")),
      purchaseDate: fieldValue(form, "edit-purchase-date"),
      note: fieldValue(form, "edit-purchase-note"),
      parentPin: ui.parentPin,
    }));
    if (ok) {
      closePurchaseEditor();
      announce(root, "買入紀錄已更正，相關餘額與持股也已一起校正");
    }
    return;
  }

  if (kind === "harvest") {
    const ok = await runParentAction(root, ctx, { button, scope: "harvest" }, () => store.recordAnnualHarvest({
      profileId: profile.id,
      holdingId: fieldValue(form, "harvest-holding"),
      soldUnits: Number(fieldValue(form, "harvest-sold-units")),
      netProceeds: Number(fieldValue(form, "harvest-net-proceeds")),
      destinationDreamId: fieldValue(form, "harvest-dream") || null,
      saleDate: fieldValue(form, "harvest-sale-date"),
      note: fieldValue(form, "harvest-note"),
      parentPin: ui.parentPin,
    }));
    if (ok) {
      clearDrafts("harvest-sold-units", "harvest-net-proceeds", "harvest-note", "harvest-confirm");
      announce(root, "過年投資收成已經記在帳本裡");
    }
    return;
  }

  if (kind === "harvest-correct") {
    const harvestId = form.dataset.id;
    const ok = await runParentAction(root, ctx, { button, scope: "harvest" }, () => store.correctAnnualHarvest({
      harvestId,
      soldUnits: Number(fieldValue(form, "edit-harvest-sold-units")),
      netProceeds: Number(fieldValue(form, "edit-harvest-net-proceeds")),
      destinationDreamId: fieldValue(form, "edit-harvest-dream") || null,
      saleDate: fieldValue(form, "edit-harvest-sale-date"),
      note: fieldValue(form, "edit-harvest-note"),
      parentPin: ui.parentPin,
    }));
    if (ok) {
      closeHarvestEditor();
      announce(root, "過年收成已更正，撲滿、持股與投入成本也已一起校正");
    }
  }
}

function resetProjectForm() {
  ui.projectId = "";
  ui.projectEditorOpen = false;
  clearDrafts("project-title", "project-description", "project-reward");
}

function closePurchaseEditor() {
  ui.editingPurchaseId = "";
  clearDrafts("edit-purchase-units", "edit-purchase-cost", "edit-purchase-date", "edit-purchase-note");
}

function closeHarvestEditor() {
  ui.editingHarvestId = "";
  clearDrafts("edit-harvest-sold-units", "edit-harvest-net-proceeds", "edit-harvest-dream", "edit-harvest-sale-date", "edit-harvest-note");
}

// ---------- 按鈕 ----------
async function handleClick(root, ctx, button) {
  const state = ctx.state;
  const profile = ctx.profile;
  const action = button.dataset.action;
  const id = button.dataset.id;

  switch (action) {
    case "toggle-pin-change": {
      ui.pinChangeOpen = !ui.pinChangeOpen;
      ui.pinError = "";
      ctx.refresh();
      return;
    }
    case "savings-up":
    case "savings-down": {
      ui.savingsRate = action === "savings-up" ? Math.min(100, ui.savingsRate + 5) : Math.max(0, ui.savingsRate - 5);
      syncSavingsRate(root, ctx);
      return;
    }
    case "open-profile-editor": {
      if (id === profile.id) {
        ui.profileEditorOpen = !ui.profileEditorOpen;
        ctx.refresh();
        if (ui.profileEditorOpen) scrollTo("#profile-editor");
        return;
      }
      ui.profileEditorOpen = true;
      ui.addProfileOpen = false;
      ui.editingPurchaseId = "";
      ui.editingHarvestId = "";
      ui.operationError = null;
      clearDrafts("purchase-confirm", "harvest-confirm");
      ctx.chooseProfile(id);
      scrollTo("#profile-editor");
      return;
    }
    case "toggle-add-profile": {
      ui.addProfileOpen = !ui.addProfileOpen;
      ctx.refresh();
      return;
    }
    case "cancel-add-profile": {
      ui.addProfileOpen = false;
      clearDrafts("new-profile-name");
      ctx.refresh();
      return;
    }
    case "remove-profile": {
      const confirmed = await common.confirmDialog(`確定要移除「${profile.name}」嗎？\n\n這位小朋友還沒有任何紀錄、持股與夢想，移除後就不會再出現在島上。`);
      if (!confirmed) return;
      await runParentAction(root, ctx, { button, scope: "profile", fallback: "移除小朋友失敗", message: `${profile.name}已經從島上移除` }, () => store.removeProfile({ profileId: profile.id, parentPin: ui.parentPin }));
      return;
    }
    case "approve-transfer":
    case "reject-transfer": {
      const transferAction = action === "approve-transfer" ? "approve" : "reject";
      const ok = await runParentAction(root, ctx, { button, scope: "accounts" }, () => store.updateSavingsTransfer({
        action: transferAction,
        transferId: id,
        operationId: uuid(),
        parentPin: ui.parentPin,
      }));
      if (ok) announce(root, transferAction === "approve" ? "已確認存入爸媽銀行" : "這次自主多存沒有執行");
      return;
    }
    case "toggle-project-editor": {
      if (ui.projectEditorOpen) resetProjectForm(); else ui.projectEditorOpen = true;
      ctx.refresh();
      return;
    }
    case "cancel-project-edit": {
      resetProjectForm();
      ctx.refresh();
      return;
    }
    case "edit-project": {
      const project = state.projects.find((item) => item.id === id);
      if (!project || project.status !== "open") return;
      ui.projectId = project.id;
      ui.projectEditorOpen = true;
      ui.drafts["project-title"] = project.title;
      ui.drafts["project-description"] = project.description;
      ui.drafts["project-reward"] = String(project.reward);
      ctx.refresh();
      window.setTimeout(() => document.getElementById("project-editor")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
      return;
    }
    case "approve-project": {
      await runParentAction(root, ctx, { button, scope: "projects" }, () => store.updateFamilyProject({
        action: "approve",
        projectId: id,
        profileId: profile.id,
        parentPin: ui.parentPin,
      }));
      return;
    }
    case "choose-preset": {
      const form = root.querySelector('[data-form="purchase"]');
      if (!form) return;
      const symbolField = form.querySelector('[data-draft="purchase-symbol"]');
      const nameField = form.querySelector('[data-draft="purchase-name"]');
      const categoryField = form.querySelector('[data-draft="purchase-category"]');
      symbolField.value = button.dataset.symbol;
      nameField.value = button.dataset.name;
      categoryField.value = button.dataset.category;
      ui.drafts["purchase-symbol"] = symbolField.value;
      ui.drafts["purchase-name"] = nameField.value;
      ui.drafts["purchase-category"] = categoryField.value;
      return;
    }
    case "edit-preset": {
      const preset = state.investmentPresets.find((item) => item.id === id);
      if (!preset) return;
      ui.presetId = preset.id;
      ui.drafts["preset-symbol"] = preset.symbol;
      ui.drafts["preset-name"] = preset.name;
      ui.drafts["preset-category"] = preset.category;
      ui.drafts["preset-sort"] = String(preset.sortOrder);
      ctx.refresh();
      return;
    }
    case "cancel-preset-edit": {
      ui.presetId = "";
      clearDrafts("preset-symbol", "preset-name", "preset-sort");
      ctx.refresh();
      return;
    }
    case "delete-preset": {
      await runParentAction(root, ctx, { button, scope: "holdings" }, () => store.updateInvestmentPreset({ action: "delete", presetId: id, parentPin: ui.parentPin }));
      return;
    }
    case "update-market-value": {
      const input = root.querySelector(`[data-draft="market-${id}"]`);
      const next = Math.round(Number(input?.value));
      const ok = await runParentAction(root, ctx, { button, scope: "holdings" }, () => store.updateHoldingMarketValue({ holdingId: id, marketValue: next, parentPin: ui.parentPin }));
      if (ok) clearDrafts(`market-${id}`);
      return;
    }
    case "refresh-quotes": {
      startBusy(root, button);
      clearOperationError(root, "holdings");
      try {
        const result = await store.refreshTwseClosingPrices({ mode: "parent", profileId: profile.id, parentPin: ui.parentPin });
        ui.quoteMeta = {
          updatedAt: result?.fetchedAt ?? new Date().toISOString(),
          source: result?.source ?? "市場行情",
        };
        const updated = result?.updatedSymbols ?? [];
        const unavailable = result?.unavailableSymbols ?? [];
        // 文案照 app/parent/page.tsx L401；哪些標的沒更新到，留在持有清單的小字裡。
        announce(root, "最新可用收盤價已更新");
        void updated; void unavailable;
        ctx.refresh();
      } catch (caught) {
        endBusy();
        reportOperationError(root, "holdings", caught, "無法更新最新收盤價");
      }
      return;
    }
    case "edit-purchase": {
      const item = state.purchases.find((purchase) => purchase.id === id);
      if (!item) return;
      ui.editingPurchaseId = item.id;
      ui.drafts["edit-purchase-units"] = String(item.units);
      ui.drafts["edit-purchase-cost"] = String(item.totalCost);
      ui.drafts["edit-purchase-date"] = item.purchaseDate;
      ui.drafts["edit-purchase-note"] = item.note;
      ui.operationError = ui.operationError?.scope === "holdings" ? null : ui.operationError;
      ctx.refresh();
      return;
    }
    case "close-purchase-editor": {
      closePurchaseEditor();
      ctx.refresh();
      return;
    }
    case "void-purchase": {
      const item = state.purchases.find((purchase) => purchase.id === id);
      if (!item) return;
      const confirmed = await common.confirmDialog(`確定要撤銷 ${item.purchaseDate} 的 ${item.symbol} 買入嗎？\n\n系統會一併還原爸媽銀行、持股與成本；若後續已有賣出紀錄，系統會為了帳本安全而拒絕撤銷。`);
      if (!confirmed) return;
      const ok = await runParentAction(root, ctx, { button, scope: "holdings" }, () => store.voidInvestmentPurchase({ purchaseId: item.id, parentPin: ui.parentPin }));
      if (ok) {
        if (ui.editingPurchaseId === item.id) closePurchaseEditor();
        announce(root, "買入紀錄已撤銷，相關餘額與持股也已還原");
      }
      return;
    }
    case "edit-harvest": {
      const item = state.harvests.find((harvest) => harvest.id === id);
      if (!item) return;
      ui.editingHarvestId = item.id;
      ui.drafts["edit-harvest-sold-units"] = String(item.soldUnits);
      ui.drafts["edit-harvest-net-proceeds"] = String(item.netProceeds);
      ui.drafts["edit-harvest-dream"] = item.destinationDreamId ?? "";
      ui.drafts["edit-harvest-sale-date"] = item.saleDate;
      ui.drafts["edit-harvest-note"] = item.note;
      ui.operationError = ui.operationError?.scope === "harvest" ? null : ui.operationError;
      ctx.refresh();
      return;
    }
    case "close-harvest-editor": {
      closeHarvestEditor();
      ctx.refresh();
      return;
    }
    case "void-harvest": {
      const item = state.harvests.find((harvest) => harvest.id === id);
      if (!item) return;
      const confirmed = await common.confirmDialog(`確定要撤銷 ${item.year} 年的過年投資收成嗎？\n\n系統會退回撲滿裡的 ${money(item.netProceeds)}，並恢復對應持股與投入成本。若後續餘額不足，系統會為了帳本安全而拒絕撤銷。`);
      if (!confirmed) return;
      const ok = await runParentAction(root, ctx, { button, scope: "harvest" }, () => store.voidAnnualHarvest({ harvestId: item.id, parentPin: ui.parentPin }));
      if (ok) {
        if (ui.editingHarvestId === item.id) closeHarvestEditor();
        announce(root, "過年收成已撤銷，撲滿、持股與投入成本也已還原");
      }
      return;
    }
    case "download-backup": {
      const portable = button.dataset.kind === "portable";
      startBusy(root, button);
      clearOperationError(root, "backup");
      try {
        const envelope = portable ? await backup.exportPortableEnvelope(state) : backup.exportEnvelope(state);
        const filename = `${portable ? "小小理財島完整可攜備份" : "小小理財島帳本備份"}-${new Date().toISOString().slice(0, 10)}.json`;
        await backup.shareOrDownload(JSON.stringify(envelope, null, 2), filename);
        endBusy();
        common.showStatus(portable ? "完整可攜備份已經下載" : "帳本備份已經下載", "success");
      } catch (caught) {
        endBusy();
        reportOperationError(root, "backup", caught, "備份下載失敗");
      }
      return;
    }
    case "restore-backup": {
      if (!ui.restoreEnvelope || !ui.restoreSummary) return;
      const warning = ui.restoreSummary.portable
        ? "完整可攜備份會取代目前家庭的帳本與孩子照片。系統會先保存目前帳本版本，確定繼續嗎？"
        : "這份備份會取代目前帳本。系統會先保存目前版本，確定繼續嗎？";
      const confirmed = await common.confirmDialog(warning);
      if (!confirmed) return;
      startBusy(root, button);
      clearOperationError(root, "backup");
      try {
        // backup.restore 內部已經 setState 並存檔，這裡不再寫第二次。
        await backup.restore(ui.restoreEnvelope);
        ui.restoreEnvelope = null;
        ui.restoreSummary = null;
        ui.snapshots = null;
        announce(root, "備份已還原，畫面已更新");
        ctx.refresh();
      } catch (caught) {
        endBusy();
        reportOperationError(root, "backup", caught, "還原失敗");
      }
      return;
    }
    case "restore-snapshot": {
      const ts = Number(button.dataset.ts);
      const confirmed = await common.confirmDialog(`確定要還原 ${formatDateTime(ts)} 的本機快照嗎？\n\n目前的帳本會被這份快照取代。`);
      if (!confirmed) return;
      startBusy(root, button);
      clearOperationError(root, "backup");
      try {
        const restored = await db.restoreSnapshot(ts);
        if (restored && Array.isArray(restored.profiles)) store.setState(restored, "還原本機快照");
        announce(root, `已還原到 ${formatDateTime(ts)} 的樣子`);
        ctx.refresh();
      } catch (caught) {
        endBusy();
        reportOperationError(root, "backup", caught, "這份快照讀不出來");
      }
      return;
    }
    default:
  }
}

// ---------- 備份檔檢查 ----------
async function inspectBackupFile(root, ctx, field, file) {
  ui.restoreSummary = null;
  ui.restoreEnvelope = null;
  clearOperationError(root, "backup");
  const label = field.closest(".backup-file-label");
  root.querySelectorAll(".restore-summary, [data-inspect-note]").forEach((node) => node.remove());
  const note = document.createElement("p");
  note.dataset.inspectNote = "";
  note.textContent = "正在檢查備份內容…";
  label?.insertAdjacentElement("afterend", note);
  try {
    const parsed = JSON.parse(await file.text());
    const summary = backup.inspect(parsed);
    ui.restoreEnvelope = parsed;
    ui.restoreSummary = summary;
    note.remove();
    label?.insertAdjacentHTML("afterend", String(restoreSummaryMarkup(summary, ctx.pinStatus === "unlocked")));
  } catch (caught) {
    note.remove();
    reportOperationError(root, "backup", caught, "無法讀取備份檔");
  }
}
