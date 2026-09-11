// 小小理財島 PWA：家長專區的投資子頁（真實買入、持股、買入紀錄、過年收成）。
// 內容整段搬自 docs/js/ui/parent.js 原本的 `.investment-layout`（規格 2.4.1）；
// 文案、store 呼叫、operationId、錯誤處理、busy 狀態、事件委派模式一律照抄。
//
// v2 重做（notes/redesign-v2/spec.md 5.5）：外殼換成 common.appShell()（title「投資管理」、
// body 第一個元素是「‹ 家長區」），四段各一張 .card，markup 換成 v2 的 .card／.btn／.field；
// 收成的 1、2 月自動展開與 ?open=purchase|harvest 深連結原樣沿用。電腦單欄 max-width 760（.narrow）。
//
// 這頁自己的模組作用域已經在「已解鎖」的家長區裡（見下方 render() 開頭的解鎖保護），
// 所以不需要、也沒有 parent.js 那個 ui.parentPin：所有 store 呼叫都不帶 parentPin，
// pin.assertParentPin() 會退回使用 pin.js 記在記憶體裡的 unlockedPin（規格 1.2 的技術基礎第 2 條）。

import { html, raw, money, taipeiDate, formatDate, formatDateTime, errorMessage, uuid } from "../util.js";
import * as common from "./common.js";
import * as store from "../store.js";

// 原本 readInvestmentPresets 只回 active = 1（money-store.ts L1398–1402）
function activePresets(state) {
  return (state.investmentPresets || []).filter((item) => item.active !== false);
}

// ---------- 頁面暫存（重繪後還原；規格第 5 節：從 parent.js 搬來的投資子集合＋新增 harvestManuallyToggled） ----------
const ui = {
  notice: "資料異動後會自動儲存",
  operationError: null,
  editingPurchaseId: "",
  editingHarvestId: "",
  harvestHoldingId: "",
  destinationDreamId: "",
  purchaseOperationId: "",
  presetId: "",
  quoteMeta: null,
  openDetails: new Set(),   // "preset-admin" | "harvest" | "harvest-history"
  drafts: Object.create(null),
  profileKey: "",
  harvestManuallyToggled: false,   // 使用者手動切換過收成 details 後，不再被月份判斷蓋回（規格 2.4.1 第 5 項）
};

const ERROR_ANCHORS = {
  purchase: { selector: "[data-purchase-submit]", position: "beforebegin" },
  holdings: { selector: ".holding-panel", position: "beforeend" },
  harvest: { selector: ".harvest-content", position: "beforeend" },
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

// 照 parent.js 原本的模式：在 render 時比對 key 做「profile 換人就清草稿」。
function syncKeys(state, profile, holdings, shortDreams) {
  if (ui.profileKey !== profile.id) {
    ui.profileKey = profile.id;
    clearDrafts("harvest-sold-units", "harvest-net-proceeds", "harvest-note", "harvest-confirm");
    ui.editingPurchaseId = "";
    ui.editingHarvestId = "";
  }
  if (!ui.purchaseOperationId) ui.purchaseOperationId = uuid();

  const validHoldingIds = new Set(holdings.map((item) => item.id));
  if (!ui.harvestHoldingId || !validHoldingIds.has(ui.harvestHoldingId)) ui.harvestHoldingId = holdings[0]?.id ?? "";
  const validDreamIds = new Set(shortDreams.map((item) => item.id));
  if (ui.destinationDreamId && !validDreamIds.has(ui.destinationDreamId)) ui.destinationDreamId = shortDreams[0]?.id ?? "";
}

function soleHoldingUpdatedLabel(holding) {
  const iso = holding.priceUpdatedAt ?? holding.updatedAt;
  if (!iso) return "尚未更新市值";
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  return days === 0 ? "上次更新：今天" : `上次更新：${days} 天前`;
}

// ---------- render ----------
export function render(ctx) {
  // 規格 1.2／2.4.1：新路由的解鎖保護。
  if (!ctx.unlocked) return html`${common.stateGate("請先從家長區解鎖", () => ctx.navigate("#/parent"))}`;

  const state = ctx.state;
  const profile = ctx.profile;
  if (!state || !profile) return raw(common.stateGate(null, () => ctx.refresh()));

  const { holdings, purchases, shortDreams, harvestHistory } = scopeOf(state, profile);
  syncKeys(state, profile, holdings, shortDreams);
  const soleHolding = holdings.length === 1 ? holdings[0] : null;

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

  // 規格 2.4.1 第 5 項／第 9 節拍板題 5：陽曆 1、2 月自動展開；使用者手動切換過後不再被月份蓋回。
  const currentMonthIndex = Number(taipeiDate().slice(5, 7)) - 1;
  const seasonalHarvestOpen = currentMonthIndex === 0 || currentMonthIndex === 1;
  const harvestOpen = ui.harvestManuallyToggled ? isOpen("harvest") : seasonalHarvestOpen;
  const lastHarvest = harvestHistory[0];

  const body = html`<a class="btn btn-ghost parent-back" href="#/parent">‹ 家長區</a>
      <div class="narrow" id="investments">
        <section class="card investment-form-card">
          <span class="kicker">新增一筆真實買入</span>
          <div class="card-head">
            <h2 class="card-title"><span aria-hidden="true">🌱</span> 爸媽已經買好了嗎？</h2>
            ${raw(common.infoTip("請依照券商成交結果填寫；總成本包含手續費，會最容易和真實帳戶對得上。", { align: "right" }))}
          </div>
          <p class="card-sub">請依實際券商成交結果填寫</p>

          <div class="preset-row" aria-label="常用標的">
            ${activePresets(state).map((preset) => html`<button type="button" class="preset-chip" data-action="choose-preset" data-symbol="${preset.symbol}" data-name="${preset.name}" data-category="${preset.category}">${preset.symbol}</button>`)}
            <span>也可以輸入其他標的</span>
          </div>

          <details class="subpanel preset-admin" data-open-key="preset-admin" ${isOpen("preset-admin") ? raw("open") : ""}>
            <summary>調整常用標的</summary>
            <div class="subpanel-body">
              <div class="preset-list">${activePresets(state).map((preset) => html`<div class="parent-row">
                <div><b>${preset.symbol}</b><small>${preset.name} · ${preset.category}</small></div>
                <div class="btn-row">
                  <button type="button" class="btn btn-secondary" data-action="edit-preset" data-id="${preset.id}">編輯</button>
                  <button type="button" class="btn btn-ghost" data-action="delete-preset" data-id="${preset.id}" data-busy-label="停用中…">停用</button>
                </div>
              </div>`)}</div>
              <form data-form="preset">
                <div class="field-row">
                  ${common.field({ label: "標的代號", input: html`<input class="input" data-draft="preset-symbol" data-uppercase value="${draft("preset-symbol")}" placeholder="例如 VT" required maxlength="12" />` })}
                  ${common.field({ label: "類型", input: html`<select class="select" data-draft="preset-category"><option ${draft("preset-category", "ETF") === "ETF" ? raw("selected") : ""}>ETF</option><option ${draft("preset-category", "ETF") === "股票" ? raw("selected") : ""}>股票</option></select>` })}
                </div>
                ${common.field({ label: "顯示名稱", input: html`<input class="input" data-draft="preset-name" value="${draft("preset-name")}" placeholder="例如 Vanguard Total World" required maxlength="40" />` })}
                ${common.field({ label: "排序", input: html`<input class="input" type="number" min="0" max="100" data-draft="preset-sort" value="${draft("preset-sort")}" placeholder="數字越小越前面" />` })}
                <div class="form-actions">
                  <button class="btn btn-primary btn-block" data-busy-label="儲存中…">${ui.presetId ? "儲存常用標的修改" : "新增常用標的"}</button>
                  ${ui.presetId ? html`<button class="btn btn-ghost btn-block" type="button" data-action="cancel-preset-edit">取消編輯</button>` : ""}
                </div>
              </form>
            </div>
          </details>

          <form data-form="purchase">
            <div class="field-row">
              ${common.field({ label: "股票代號", input: html`<input class="input" data-draft="purchase-symbol" data-uppercase value="${draft("purchase-symbol", soleHolding ? soleHolding.symbol : "")}" placeholder="例如 00646" required maxlength="12" />` })}
              ${common.field({ label: "類型", input: html`<select class="select" data-draft="purchase-category"><option ${draft("purchase-category", soleHolding ? soleHolding.category : "ETF") === "ETF" ? raw("selected") : ""}>ETF</option><option ${draft("purchase-category", soleHolding ? soleHolding.category : "ETF") === "股票" ? raw("selected") : ""}>股票</option></select>` })}
            </div>
            ${common.field({ label: "標的名稱", input: html`<input class="input" data-draft="purchase-name" value="${draft("purchase-name", soleHolding ? soleHolding.name : "")}" placeholder="例如 元大 S&P 500" required maxlength="40" />` })}
            <div class="field-row">
              ${common.field({ label: "實際買入股數", input: html`<input class="input" type="number" inputmode="decimal" min="0.0001" step="0.0001" data-draft="purchase-units" value="${draft("purchase-units")}" placeholder="例如 10" required />` })}
              ${common.field({ label: "總成本（含費用）", input: html`<input class="input" type="number" inputmode="numeric" min="1" max="${profile.bankBalance}" data-draft="purchase-total-cost" value="${draft("purchase-total-cost")}" placeholder="NT$" required />` })}
            </div>
            ${common.field({ label: "買入日期", input: html`<input class="input" type="date" data-draft="purchase-date" value="${draft("purchase-date", taipeiDate())}" required />` })}
            ${common.field({ label: "備註（選填）", input: html`<input class="input" data-draft="purchase-note" value="${draft("purchase-note")}" placeholder="例如：用 8 月累積的存款買入" maxlength="100" />` })}

            <div class="purchase-preview">
              <span>${raw(common.profileAvatar(profile.avatar))}</span>
              <div><b>這筆記錄完成後</b><small>爸媽銀行會扣除 <span data-planned-cost>${money(plannedCost)}</span>，同額移到 ETF 小森林；總資產不會憑空增加。</small></div>
            </div>
            <label class="confirm-check">
              <input type="checkbox" data-draft="purchase-confirm" ${draftChecked("purchase-confirm") ? raw("checked") : ""} />
              <span>我確認這筆交易已經在真實券商完成</span>
            </label>
            <div class="form-actions">
              <button class="btn btn-primary btn-block" data-purchase-submit data-busy-label="正在記錄與備份…" ${!purchaseReady ? raw("disabled") : ""}>確認記錄 ${profile.name}的買入</button>
            </div>
            <small class="parent-save-note">${ui.notice}</small>
          </form>
        </section>

        <section class="${soleHolding ? "card holding-panel is-single" : "card holding-panel"}">
          <div class="card-head">
            <div><span class="kicker">目前持有</span><h2 class="card-title">${profile.name}的 ETF 小森林</h2></div>
            <span class="badge">${holdings.length} 個標的</span>
          </div>
          <div class="market-quote-actions">
            <div class="market-auto-label"><b>自動更新</b>${raw(common.infoTip("打開 app 或回到前景時，系統會在背景檢查證交所最新可用收盤價；同一家庭 30 分鐘內不會重複請求。這不是盤中即時報價。", { align: "right" }))}</div>
            <button type="button" class="btn btn-secondary" data-action="refresh-quotes" data-busy-label="檢查中…" ${!holdings.length ? raw("disabled") : ""}>重新檢查收盤價</button>
            ${ui.quoteMeta || latestPriceUpdatedAt ? html`<small>${ui.quoteMeta?.source ?? "最近行情"} · ${formatDateTime(ui.quoteMeta?.updatedAt ?? latestPriceUpdatedAt)}</small>` : ""}
          </div>
          ${soleHolding ? html`<small class="holding-sole-updated">${soleHoldingUpdatedLabel(soleHolding)}</small>` : ""}
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
                <div class="market-editor">
                  <input class="input" type="number" min="0" inputmode="numeric" data-draft="market-${holding.id}" value="${marketDraft}" placeholder="更新市值，目前 ${holding.marketValue}" />
                  <button type="button" class="btn btn-secondary" data-action="update-market-value" data-id="${holding.id}" data-busy-label="更新中…" ${marketDraft === "" ? raw("disabled") : ""}>記錄今日市值</button>
                </div>
              </div>
            `;
          }) : html`<div class="empty-holding"><span>${raw(common.profileAvatar(profile.avatar))}</span><b>第一棵投資小樹還在等你</b><small>等爸媽完成第一次真實買入後，就會出現在這裡。</small></div>`}
          <p class="panel-help">${raw(common.infoTip("按下更新會取得最新可用收盤價；也可以依券商畫面手動記錄今日市值。", { align: "right" }))}</p>
        </section>

        <section class="card purchase-history">
          <span class="kicker">最近記錄</span>
          <h2 class="card-title">爸媽協助買入</h2>
          ${purchases.length ? purchases.map((item) => html`
            <div class="${ui.editingPurchaseId === item.id ? "purchase-entry is-editing" : "purchase-entry"}">
              <div class="parent-row purchase-row">
                <div><b>${item.symbol} · ${item.name}</b><small>${item.purchaseDate} · ${item.units} 股${item.note ? ` · ${item.note}` : ""}</small></div>
                <div class="purchase-row-tail">
                  <strong>${money(item.totalCost)}</strong>
                  <div class="btn-row">
                    <button type="button" class="btn btn-secondary" data-action="${ui.editingPurchaseId === item.id ? "close-purchase-editor" : "edit-purchase"}" data-id="${item.id}" data-busy-lock>${ui.editingPurchaseId === item.id ? "收起" : "編輯"}</button>
                    <button type="button" class="btn btn-danger" data-action="void-purchase" data-id="${item.id}" data-busy-label="撤銷中…" data-busy-lock>撤銷</button>
                  </div>
                </div>
              </div>
              ${ui.editingPurchaseId === item.id ? html`<form class="purchase-correction-form" data-form="purchase-correct" data-id="${item.id}">
                <div class="field-row">
                  ${common.field({ label: "股數", input: html`<input class="input" type="number" inputmode="decimal" min="0.0001" step="0.0001" data-draft="edit-purchase-units" value="${draft("edit-purchase-units")}" required />` })}
                  ${common.field({ label: "總成本", input: html`<input class="input" type="number" inputmode="numeric" min="1" step="1" data-draft="edit-purchase-cost" value="${draft("edit-purchase-cost")}" required />` })}
                  ${common.field({ label: "買入日期", input: html`<input class="input" type="date" data-draft="edit-purchase-date" value="${draft("edit-purchase-date")}" required />` })}
                  ${common.field({ label: "備註", input: html`<input class="input" data-draft="edit-purchase-note" value="${draft("edit-purchase-note")}" maxlength="100" placeholder="選填" />` })}
                </div>
                <div class="form-actions">
                  <button type="button" class="btn btn-ghost" data-action="close-purchase-editor">取消</button>
                  <button type="submit" class="btn btn-primary" data-busy-label="校正中…">儲存更正</button>
                </div>
              </form>` : ""}
            </div>
          `) : html`<p class="empty-history">新記錄會自動留在這裡。</p>`}
        </section>

        <details class="card harvest-panel" id="harvest" data-open-key="harvest" ${harvestOpen ? raw("open") : ""}>
          <summary class="harvest-summary">
            <div>
              <span class="kicker">一年一次的選擇</span>
              <b><span aria-hidden="true">🧧</span> 過年投資收成日</b>
              <small>${currentYear} 年最多 ${money(maxHarvest)} · ${harvestedThisYear ? "今年已使用" : "今年尚未使用"} · ${lastHarvest ? `上次收成：${lastHarvest.saleDate}` : "今年還沒收成"}</small>
            </div>
            <span class="harvest-summary-action">
              <span class="badge">最多 5%</span>
              <small class="harvest-closed-label">查看或操作 ＋</small>
              <small class="harvest-open-label">收起細節 −</small>
            </span>
          </summary>
          <div class="harvest-content">
            <p class="panel-help">${raw(common.infoTip("可以選擇完全不提領。若要使用，爸媽先在券商實際賣出，再把淨入帳金額放回撲滿；短期夢想罐的進度會自動更新。"))}</p>
            <div class="harvest-limit"><span>${raw(common.profileAvatar(profile.avatar))}</span><div><small>${currentYear} 年最高收成額度</small><strong>${money(maxHarvest)}</strong></div><b>${harvestedThisYear ? "今年已使用" : "今年尚未使用"}</b></div>
            <form data-form="harvest">
              ${soleHolding
                ? html`<div class="harvest-sole-holding"><span>實際賣出的標的</span><b>${soleHolding.symbol} · ${soleHolding.name}（${soleHolding.units} 股）</b><input type="hidden" data-draft="harvest-holding" value="${soleHolding.id}" /></div>`
                : common.field({ label: "實際賣出的標的", input: html`<select class="select" data-draft="harvest-holding" required>${holdings.map((holding) => html`<option value="${holding.id}" ${holding.id === ui.harvestHoldingId ? raw("selected") : ""}>${holding.symbol} · ${holding.name}（${holding.units} 股）</option>`)}</select>` })}
              <div class="field-row">
                ${common.field({ label: "實際賣出股數", input: html`<input class="input" type="number" min="0.0001" step="0.0001" data-draft="harvest-sold-units" value="${draft("harvest-sold-units")}" required />` })}
                ${common.field({ label: "券商淨入帳", input: html`<input class="input" type="number" min="1" max="${maxHarvest}" data-draft="harvest-net-proceeds" value="${draft("harvest-net-proceeds")}" required />` })}
              </div>
              ${common.field({ label: "這次收成要對應哪個短期夢想？", input: html`<select class="select" data-draft="harvest-dream"><option value="" ${ui.destinationDreamId === "" ? raw("selected") : ""}>不指定（仍放回撲滿）</option>${shortDreams.map((jar) => html`<option value="${jar.id}" ${jar.id === ui.destinationDreamId ? raw("selected") : ""}>短期夢想罐：${jar.title}</option>`)}</select>` })}
              ${common.field({ label: "實際賣出日期", input: html`<input class="input" type="date" data-draft="harvest-sale-date" value="${draft("harvest-sale-date", taipeiDate())}" required />` })}
              ${common.field({ label: "備註（選填）", input: html`<input class="input" data-draft="harvest-note" value="${draft("harvest-note")}" placeholder="例如：今年選擇收成 3%" maxlength="100" />` })}
              <label class="confirm-check"><input type="checkbox" data-draft="harvest-confirm" ${draftChecked("harvest-confirm") ? raw("checked") : ""} /><span>我確認這筆股票已在真實券商賣出</span></label>
              <div class="form-actions">
                <button class="btn btn-primary btn-block" data-harvest-submit data-busy-label="記錄收成中…" ${harvestedThisYear || !holdings.length || !harvestReady ? raw("disabled") : ""}>${harvestedThisYear ? "今年已完成收成" : "確認過年收成"}</button>
              </div>
            </form>
            <details class="subpanel harvest-history-panel" data-open-key="harvest-history" ${isOpen("harvest-history") ? raw("open") : ""}>
              <summary><span>過年收成歷史</span><b>${harvestHistory.length} 筆</b></summary>
              <div class="subpanel-body harvest-history-list">
                ${harvestHistory.length ? harvestHistory.map((item) => {
                  const holding = state.holdings.find((candidate) => candidate.id === item.holdingId);
                  const destination = state.dreamJars.find((candidate) => candidate.id === item.destinationDreamId);
                  const destinationOptions = destination && !shortDreams.some((candidate) => candidate.id === destination.id)
                    ? [destination, ...shortDreams]
                    : shortDreams;
                  const isEditing = ui.editingHarvestId === item.id;
                  return html`<article class="${isEditing ? "harvest-history-entry is-editing" : "harvest-history-entry"}">
                    <div class="parent-row">
                      <div><b>${item.year} 年 · ${money(item.netProceeds)}</b><small>${item.saleDate} · ${holding?.symbol ?? "歷史標的"} · ${item.soldUnits} 股${destination ? ` · ${destination.title}` : ""}</small></div>
                      <div class="btn-row">
                        <button type="button" class="btn btn-secondary" data-action="${isEditing ? "close-harvest-editor" : "edit-harvest"}" data-id="${item.id}" data-busy-lock>${isEditing ? "收起" : "編輯"}</button>
                        <button type="button" class="btn btn-danger" data-action="void-harvest" data-id="${item.id}" data-busy-label="撤銷中…" data-busy-lock>撤銷</button>
                      </div>
                    </div>
                    ${isEditing ? html`<form class="harvest-correction-form" data-form="harvest-correct" data-id="${item.id}">
                      <div class="field-row">
                        ${common.field({ label: "實際賣出股數", input: html`<input class="input" type="number" inputmode="decimal" min="0.0001" step="0.0001" data-draft="edit-harvest-sold-units" value="${draft("edit-harvest-sold-units")}" required />` })}
                        ${common.field({ label: "券商淨入帳", input: html`<input class="input" type="number" inputmode="numeric" min="1" step="1" data-draft="edit-harvest-net-proceeds" value="${draft("edit-harvest-net-proceeds")}" required />` })}
                        ${common.field({ label: "短期夢想罐", input: html`<select class="select" data-draft="edit-harvest-dream"><option value="" ${draft("edit-harvest-dream") === "" ? raw("selected") : ""}>不指定（仍放回撲滿）</option>${destinationOptions.map((jar) => html`<option value="${jar.id}" ${draft("edit-harvest-dream") === jar.id ? raw("selected") : ""}>${jar.title}${jar.status !== "active" ? "（已完成或排隊中）" : ""}</option>`)}</select>` })}
                        ${common.field({ label: "實際賣出日期", input: html`<input class="input" type="date" data-draft="edit-harvest-sale-date" value="${draft("edit-harvest-sale-date")}" required />` })}
                        ${common.field({ label: "備註", input: html`<input class="input" data-draft="edit-harvest-note" value="${draft("edit-harvest-note")}" maxlength="100" placeholder="選填" />` })}
                      </div>
                      <div class="form-actions">
                        <button type="button" class="btn btn-ghost" data-action="close-harvest-editor">取消</button>
                        <button type="submit" class="btn btn-primary" data-busy-label="校正中…">儲存更正</button>
                      </div>
                    </form>` : ""}
                  </article>`;
                }) : html`<p class="empty-history">尚未有過年收成紀錄。</p>`}
              </div>
            </details>
          </div>
        </details>
      </div>`;

  return common.appShell({ page: "parent", title: "投資管理", ctx, right: "", body });
}

// ---------- 忙碌狀態與錯誤（照 parent.js 原本的模式） ----------
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
  if (!ui.operationError) return;
  const anchor = ERROR_ANCHORS[ui.operationError.scope];
  if (!anchor) return;
  const target = root.querySelector(anchor.selector);
  if (!target) return;
  const paragraph = document.createElement("p");
  paragraph.className = "form-error";
  paragraph.dataset.errorScope = ui.operationError.scope;
  paragraph.textContent = ui.operationError.message;
  target.insertAdjacentElement(anchor.position, paragraph);
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

async function runParentAction(root, ctx, { button, scope, fallback, message }, work) {
  startBusy(root, button);
  clearOperationError(root, scope);
  try {
    await work();
    busyRestore = null;
    const saved = common.savedStatus(store.getState(), message ?? "投資紀錄已完成，帳本已更新");
    announce(root, saved.message, saved.tone);
    return true;
  } catch (caught) {
    endBusy();
    reportOperationError(root, scope, caught, fallback ?? "投資操作儲存失敗");
    return false;
  }
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
    submit.disabled = !fieldChecked(form, "purchase-confirm")
      || plannedCost <= 0
      || plannedCost > profile.bankBalance
      || Number(fieldValue(form, "purchase-units")) <= 0;
  }
}

function harvestLimits(ctx) {
  const state = ctx.state;
  const profile = ctx.profile;
  const currentYear = Number(taipeiDate().slice(0, 4));
  return {
    maxHarvest: Math.floor((profile.marketValue ?? 0) * 0.05),
    harvestedThisYear: state.harvests.some((item) => item.profileId === profile.id && item.year === currentYear),
    holdingCount: state.holdings.filter((item) => item.profileId === profile.id).length,
  };
}

function syncHarvestForm(root, maxHarvest, harvestedThisYear, holdingCount) {
  const form = root.querySelector('[data-form="harvest"]');
  if (!form) return;
  const submit = form.querySelector("[data-harvest-submit]");
  if (!submit) return;
  const netProceeds = Number(fieldValue(form, "harvest-net-proceeds"));
  submit.disabled = harvestedThisYear
    || !holdingCount
    || !fieldChecked(form, "harvest-confirm")
    || netProceeds <= 0
    || netProceeds > maxHarvest
    || Number(fieldValue(form, "harvest-sold-units")) <= 0;
}

function syncHarvestSubmit(root, ctx) {
  const limits = harvestLimits(ctx);
  syncHarvestForm(root, limits.maxHarvest, limits.harvestedThisYear, limits.holdingCount);
}

function syncMarketEditor(root, holdingId) {
  const input = root.querySelector(`[data-draft="market-${holdingId}"]`);
  const button = root.querySelector(`[data-action="update-market-value"][data-id="${holdingId}"]`);
  if (!input || !button) return;
  button.disabled = input.value === "";
}

// ---------- 深連結（規格 2.4.1 第 6 項） ----------
let lastDeepLinkHash = "";

function applyDeepLink(root) {
  const query = (location.hash.split("?")[1]) || "";
  const params = new URLSearchParams(query);
  const open = params.get("open");
  if (open === "purchase") {
    window.setTimeout(() => {
      const form = root.querySelector('[data-form="purchase"]');
      form?.scrollIntoView({ behavior: "smooth", block: "start" });
      form?.querySelector('[data-draft="purchase-symbol"]')?.focus();
    }, 0);
  } else if (open === "harvest") {
    ui.harvestManuallyToggled = true;
    ui.openDetails.add("harvest");
    const details = root.querySelector(".harvest-panel");
    if (details) details.open = true;
    window.setTimeout(() => details?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }
}

function maybeApplyDeepLink(root) {
  if (location.hash === lastDeepLinkHash) return;
  lastDeepLinkHash = location.hash;
  applyDeepLink(root);
}

// ---------- mount ----------
const boundRoots = new WeakSet();
let ctxRef = null;

export function mount(root, ctx) {
  ctxRef = ctx;
  if (!ctx.unlocked || !ctx.state || !ctx.profile) return;

  paintOperationError(root);
  maybeApplyDeepLink(root);

  if (boundRoots.has(root)) return;
  boundRoots.add(root);

  root.addEventListener("toggle", (event) => {
    const element = event.target;
    if (!(element instanceof HTMLElement) || element.tagName !== "DETAILS" || !element.dataset.openKey) return;
    const key = element.dataset.openKey;
    if (key === "harvest") ui.harvestManuallyToggled = true;
    if (element.open) ui.openDetails.add(key); else ui.openDetails.delete(key);
  }, true);

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
    if (field.dataset.draft === "harvest-net-proceeds" || field.dataset.draft === "harvest-sold-units") syncHarvestSubmit(root, ctxRef);
    if (field.dataset.draft?.startsWith("market-")) syncMarketEditor(root, field.dataset.draft.slice(7));
  });

  root.addEventListener("change", (event) => {
    const field = event.target;
    if (!(field instanceof HTMLElement)) return;
    recordDraft(field);
    if (field.dataset.draft === "purchase-confirm") syncPurchaseForm(root, ctxRef);
    if (field.dataset.draft === "harvest-confirm") syncHarvestSubmit(root, ctxRef);
    if (field.dataset.draft === "harvest-holding") ui.harvestHoldingId = field.value;
    if (field.dataset.draft === "harvest-dream") ui.destinationDreamId = field.value;
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

  if (kind === "preset") {
    const sort = fieldValue(form, "preset-sort");
    const ok = await runParentAction(root, ctx, { button, scope: "holdings" }, () => store.updateInvestmentPreset({
      action: ui.presetId ? "update" : "create",
      presetId: ui.presetId || undefined,
      symbol: fieldValue(form, "preset-symbol"),
      name: fieldValue(form, "preset-name"),
      category: fieldValue(form, "preset-category"),
      sortOrder: Number(sort || activePresets(ctx.state).length + 1),
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
    }));
    if (ok) {
      closeHarvestEditor();
      announce(root, "過年收成已更正，撲滿、持股與投入成本也已一起校正");
    }
  }
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
      await runParentAction(root, ctx, { button, scope: "holdings" }, () => store.updateInvestmentPreset({ action: "delete", presetId: id }));
      return;
    }
    case "update-market-value": {
      const input = root.querySelector(`[data-draft="market-${id}"]`);
      const next = Math.round(Number(input?.value));
      const ok = await runParentAction(root, ctx, { button, scope: "holdings" }, () => store.updateHoldingMarketValue({ holdingId: id, marketValue: next }));
      if (ok) clearDrafts(`market-${id}`);
      return;
    }
    case "refresh-quotes": {
      startBusy(root, button);
      clearOperationError(root, "holdings");
      try {
        const result = await store.refreshTwseClosingPrices({ mode: "parent", profileId: profile.id });
        ui.quoteMeta = {
          updatedAt: result?.fetchedAt ?? new Date().toISOString(),
          source: result?.source ?? "市場行情",
        };
        announce(root, "最新可用收盤價已更新");
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
      const ok = await runParentAction(root, ctx, { button, scope: "holdings" }, () => store.voidInvestmentPurchase({ purchaseId: item.id }));
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
      const ok = await runParentAction(root, ctx, { button, scope: "harvest" }, () => store.voidAnnualHarvest({ harvestId: item.id }));
      if (ok) {
        if (ui.editingHarvestId === item.id) closeHarvestEditor();
        announce(root, "過年收成已撤銷，撲滿、持股與投入成本也已還原");
      }
      return;
    }
    default:
  }
}
