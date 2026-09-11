// 小小理財島 PWA：成長頁（規格 5.2，取代舊的 dreams.js）。
// 三段：📈 資產（總資產折線圖）、🎯 夢想罐、📝 每月回顧。
// 業務邏輯（store.updateDreamJar 的各 action、saveMonthlyReflection、月份切換、三個數字的計算、
// completedEditor 的存活機制、createLockModal 的用法）全部從 dreams.js 原樣搬過來，
// 只換 markup 的 class 與版面；文案除規格 5.2 明列者外一字不改。

import { html, raw, money, signedMoney, formatDate, formatDateTime, formatMonthLabel, taipeiMonth, errorMessage } from "../util.js";
import * as common from "./common.js";
import * as store from "../store.js";
import * as pin from "../pin.js";
import { totalAssets, assetTimeline } from "./common.js";   // 與首頁共用同一份

// ---------- 頁面暫存（重繪後由 render 讀回） ----------
let activeTab = "assets";       // "assets" | "jar" | "review"（規格 5.2：手機三段切換，預設「資產」）
let selectedMonth = "";
let editingId = "";
let draftTitle = "";
let draftKind = "short";
let draftTarget = "";
let draftProud = "";
let draftChange = "";
let draftPlan = "";
let reflectionKey = "";
let formErrorText = "";
let noticeText = "夢想與回顧都會自動備份";
let dreamFormOpen = false;      // 「＋ 新增夢想」／「編輯」modal：是否「應該」開著
let dreamFormNode = null;       // DOM 目前開著的那個節點（背景重繪會被關掉，mount 補開）
let dreamFormErrorText = "";
let completedEditorId = "";
let completedEditorErrorText = "";
let completedEditorNode = null;
let lastProfileId = "";
let completedJarsOpen = false;  // 已完成夢想 details 的收合狀態
let currentCtx = null;          // 供 createLockModal 的 getPinStatus／onUnlocked 讀最新 ctx

const RESET_ACTIONS = ["create", "update", "delete", "complete", "activate"];

// ---------- 情境式解鎖 modal（規格 3.3：頁首右插槽的 32px 鎖鈕開這一個） ----------
const lockModal = common.createLockModal({
  getPinStatus: () => (currentCtx ? pinStatusOf(currentCtx) : "locked"),
  onUnlocked: () => { if (currentCtx) currentCtx.refresh(); },
  parentHref: "#/parent",
});

// common.* 回傳的片段一律當 HTML 片段輸出（RawHtml 或字串都適用）。
function frag(value) {
  return raw(String(value));
}

// ---------- 折線圖（規格 1：整段原樣搬） ----------
// 建造者 B 重寫中的 home.js 還沒 export assetTimeline／assetGrowthChart，
// 這裡先照派工指示從 git HEAD 的 home.js 複製一份；主線整合時改成
//   import { assetTimeline, assetGrowthChart } from "./home.js";
// 去重。.asset-chart／.chart-y-axis／.chart-plot／.line-chart-stage／.chart-point／.chart-x-axis
// 這一段 markup 一個字都沒動；原函式外層的 .section-heading 與「查看夢想進度 →」連結屬於舊首頁版面，
// 由規格 5.2 的 .card-title「總資產」＋金額＋年數那一行取代。
// 「從 {year} 年開始 · 累積第 {n} 年」的兩個數字，算法照原 assetGrowthChart 裡的那兩行。
function chartYears(points) {
  const firstYear = Number(points[0]?.month.slice(0, 4) ?? new Date().getFullYear());
  const lastYear = Number(points[points.length - 1]?.month.slice(0, 4) ?? firstYear);
  return { firstYear, years: Math.max(1, lastYear - firstYear + 1) };
}

function assetGrowthChart({ points, current }) {
  const maximum = Math.max(100, ...points.map((item) => item.value));
  const ceiling = Math.max(1000, Math.ceil(maximum / 1000) * 1000);
  const chartPoints = points.map((point, index) => {
    const x = points.length === 1 ? 50 : 4 + (index / (points.length - 1)) * 92;
    const y = 4 + (1 - point.value / ceiling) * 88;
    return { ...point, x, y };
  });
  const polyline = chartPoints.map((point) => `${point.x},${point.y}`).join(" ");
  const area = chartPoints.length > 1
    ? `${chartPoints[0].x},92 ${polyline} ${chartPoints[chartPoints.length - 1].x},92`
    : "";
  return html`<div class="asset-chart" role="img" aria-label="橫軸為時間、縱軸為金額；目前總資產 ${money(current)}">
            <div class="chart-y-axis"><span>${money(ceiling)}</span><span>${money(Math.round(ceiling / 2))}</span><span>NT$0</span></div>
            <div class="chart-plot">
              <div class="line-chart-stage">
                <svg viewBox="0 0 100 96" preserveAspectRatio="none" aria-hidden="true">
                  <line x1="0" y1="4" x2="100" y2="4"></line>
                  <line x1="0" y1="48" x2="100" y2="48"></line>
                  <line x1="0" y1="92" x2="100" y2="92"></line>
                  ${area ? html`<polygon points="${area}"></polygon>` : ""}
                  ${polyline ? html`<polyline points="${polyline}"></polyline>` : ""}
                </svg>
                ${chartPoints.map((point) => html`<i class="chart-point" title="${point.month}：${money(point.value)}" style="left: ${point.x}%; top: ${point.y}%"></i>`)}
              </div>
              <div class="chart-x-axis">${chartPoints.map((point, index) => html`<span><b>${point.label}</b><small>${index === 0 || point.month.slice(0, 4) !== chartPoints[index - 1].month.slice(0, 4) ? point.month.slice(0, 4) : ""}</small></span>`)}</div>
            </div>
          </div>`;
}

// ---------- 移植自 dreams.js 的輔助函式 ----------
function currentMonth() {
  return taipeiMonth();
}

const formatMonth = formatMonthLabel;

function toDateTimeLocal(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function recentMonthKeys(count) {
  const [year, monthValue] = currentMonth().split("-").map(Number);
  return Array.from({ length: count }, (_, index) => new Date(Date.UTC(year, monthValue - 1 - index, 1)).toISOString().slice(0, 7));
}

function elapsedTime(startValue, endValue) {
  const milliseconds = Math.max(0, new Date(endValue).getTime() - new Date(startValue).getTime());
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "不到 1 分鐘";
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours} 小時 ${remainingMinutes} 分鐘` : `${hours} 小時`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days < 30) return remainingHours ? `${days} 天 ${remainingHours} 小時` : `${days} 天`;
  const months = Math.floor(days / 30);
  const remainingDays = days % 30;
  return remainingDays ? `${months} 個月 ${remainingDays} 天` : `${months} 個月`;
}

// ---------- 衍生資料 ----------
function jarsOf(state, profileId) {
  return state.dreamJars.filter((item) => item.profileId === profileId);
}

function availableMonthsOf(state, profileId) {
  const keys = new Set(recentMonthKeys(12));
  for (const item of state.activities) if (item.profileId === profileId) keys.add(item.entryDate.slice(0, 7));
  for (const item of state.reflections) if (item.profileId === profileId) keys.add(item.month);
  return [...keys].filter((item) => /^\d{4}-\d{2}$/.test(item)).sort((a, b) => b.localeCompare(a));
}

// 切換孩子時把頁面暫存重設（對應原本 chooseProfile 與 [profile?.id] 的 effect）。
function syncProfile(ctx) {
  const id = ctx.profile ? ctx.profile.id : "";
  if (id === lastProfileId) return;
  lastProfileId = id;
  selectedMonth = currentMonth();
  formErrorText = "";
  editingId = "";
  draftTitle = "";
  draftTarget = "";
  lockModal.reset();
  if (dreamFormOpen) {
    dreamFormOpen = false;
    dreamFormErrorText = "";
    dreamFormNode = null;
    common.closeModal();
  }
  if (completedEditorId) {
    completedEditorId = "";
    completedEditorErrorText = "";
    completedEditorNode = null;
    common.closeModal();
  }
}

// app.js 的 ctx 目前只給 unlocked；契約列的 ctx.pinStatus 有就用，沒有就直接問 pin.js。
function pinStatusOf(ctx) {
  return ctx.pinStatus || pin.status();
}

function createTipText(kind, editing, activeShort) {
  if (kind === "short") return activeShort && !editing ? "目前已有短期夢想；這個新目標會先加入短期夢想清單。" : "短期夢想直接顯示撲滿的金額。";
  return "長期夢想顯示爸媽銀行加上 ETF 小森林的合計，不會另外扣款。";
}

function createButtonLabel(kind, editing, activeShort) {
  if (editing) return "儲存家長修改";
  return kind === "short" && activeShort ? "加入短期夢想清單" : "建立目前夢想";
}

// ---------- 畫面片段 ----------
function assetsSection(ctx, hidden) {
  const profile = ctx.profile;
  const points = assetTimeline(profile, ctx.state.activities);
  const current = totalAssets(profile);
  const { firstYear, years } = chartYears(points);
  return html`<section class="growth-section" data-tab-panel="assets"${hidden ? raw(" hidden") : ""}>
        <div class="card">
          <div class="card-head"><h2 class="card-title">總資產</h2><strong class="growth-total">${money(current)}</strong></div>
          ${assetGrowthChart({ points, current })}
          <p class="growth-chart-note">從 ${firstYear} 年開始 · 累積第 ${years} 年</p>
        </div>
      </section>`;
}

function dreamCard(jar, current, unlocked) {
  const percent = Math.min(100, jar.targetAmount ? current / jar.targetAmount * 100 : 0);
  return html`<article class="card dream-card">
          <div class="card-head"><h2 class="card-title">${jar.title}</h2><b class="dream-percent">${Math.round(percent)}%</b></div>
          <span class="badge">${jar.kind === "short" ? "短期 · 撲滿" : "長期 · 爸媽銀行＋ETF"}</span>
          <p class="dream-amounts">${money(current)} / ${money(jar.targetAmount)}</p>
          <div class="progress"><i style="width:${percent}%"></i></div>
          ${unlocked ? html`<div class="btn-row dream-actions">
            <button type="button" class="btn btn-ghost" data-action="edit-dream" data-id="${jar.id}">編輯</button>
            <button type="button" class="btn btn-ghost" data-action="complete-dream" data-id="${jar.id}">完成夢想</button>
            <button type="button" class="btn btn-ghost" data-action="delete-dream" data-id="${jar.id}">刪除</button>
          </div>` : ""}
        </article>`;
}

function emptyDreamCard(slotKind, queuedCount) {
  return html`<article class="card dream-card is-empty">
          <p class="empty"><b>還沒有${slotKind === "short" ? "短期" : "長期"}夢想</b><br>${slotKind === "short" && queuedCount ? "可以從下方清單選一個開始。" : "可以從下方建立一個新目標。"}</p>
        </article>`;
}

function jarSection(ctx, hidden, { activeShort, activeLong, queuedShort, completedJars, unlocked }) {
  const profile = ctx.profile;
  const slots = [{ kind: "short", jar: activeShort }, { kind: "long", jar: activeLong }];
  return html`<section class="growth-section" data-tab-panel="jar"${hidden ? raw(" hidden") : ""}>
        ${slots.map(({ kind: slotKind, jar }) => {
          if (!jar) return emptyDreamCard(slotKind, queuedShort.length);
          const current = jar.kind === "short" ? profile.spendingBalance : profile.bankBalance + profile.marketValue;
          return dreamCard(jar, current, unlocked);
        })}
        <p class="dream-note">撲滿金額改變時，這裡會自動更新；夢想罐只是進度尺，不會另外扣款</p>
        <button type="button" class="btn btn-secondary btn-block" data-action="new-dream">＋ 新增夢想</button>
        ${queuedShort.length ? html`<div class="card">
          <h2 class="card-title">排隊中的短期夢想</h2>
          <div class="queued-list">${queuedShort.map((jar) => html`<article class="queued-row">
            <div><b>${jar.title}</b><small>目標 ${money(jar.targetAmount)} · 加入於 ${formatDate(jar.createdAt)}</small></div>
            ${unlocked ? html`<div class="btn-row">
              <button type="button" class="btn btn-ghost" data-action="activate-dream" data-id="${jar.id}"${activeShort ? raw(" disabled") : ""}>${activeShort ? "先完成目前夢想" : "開始這個夢想"}</button>
              <button type="button" class="btn btn-ghost" data-action="edit-dream" data-id="${jar.id}">編輯</button>
              <button type="button" class="btn btn-ghost" data-action="delete-dream" data-id="${jar.id}">刪除</button>
            </div>` : ""}
          </article>`)}</div>
        </div>` : ""}
        <details class="card completed-card"${completedJarsOpen ? raw(" open") : ""}>
          <summary>已完成的 ${completedJars.length} 個夢想</summary>
          <div class="completed-list">${completedJars.map((jar) => html`<article class="completed-row">
            <span class="completed-icon" aria-hidden="true">${jar.kind === "short" ? "🐷" : "🌳"}</span>
            <div>
              <b>${jar.title}</b>
              <strong>${money(jar.completedAmount ?? jar.targetAmount)}</strong>
              <small>${jar.kind === "short" ? "短期夢想" : "長期夢想"} · 完成 ${formatDateTime(jar.completedAt ?? jar.updatedAt)}<br>用了 ${elapsedTime(jar.createdAt, jar.completedAt ?? jar.updatedAt)} · 原目標 ${money(jar.targetAmount)}</small>
              ${unlocked ? html`<button type="button" class="btn btn-ghost" data-action="edit-completed" data-id="${jar.id}">✎ 編輯紀錄</button>` : ""}
            </div>
          </article>`)}</div>
          ${!completedJars.length ? html`<p class="empty">第一個完成的夢想，會連同日期、花費時間與金額留在這裡。</p>` : ""}
        </details>
      </section>`;
}

function reviewSection(ctx, hidden) {
  const profile = ctx.profile;
  const state = ctx.state;
  const reflection = state.reflections.find((item) => item.profileId === profile.id && item.month === selectedMonth);
  const monthActivities = state.activities.filter((item) => item.profileId === profile.id && item.entryDate.startsWith(selectedMonth));
  const monthSpend = monthActivities.filter((item) => item.kind === "spend").reduce((sum, item) => sum + item.amount, 0);
  const monthSpendCount = monthActivities.filter((item) => item.kind === "spend").length;
  const monthSaved = monthActivities.filter((item) => ["allowance", "project", "sheet-deposit", "savings-transfer"].includes(item.kind)).reduce((sum, item) => sum + Math.max(0, item.bankDelta), 0);
  const monthVoluntarySaved = monthActivities.filter((item) => item.kind === "savings-transfer").reduce((sum, item) => sum + item.amount, 0);
  const monthAssetChange = monthActivities.reduce((sum, item) => sum + item.spendDelta + item.bankDelta + item.marketDelta, 0);
  const availableMonths = availableMonthsOf(state, profile.id);
  const selectedMonthIndex = Math.max(0, availableMonths.indexOf(selectedMonth));

  return html`<section class="growth-section" data-tab-panel="review"${hidden ? raw(" hidden") : ""}>
        <div class="card review-card">
          <div class="card-head"><h2 class="card-title">這個月，錢教了我什麼？</h2></div>
          <div class="review-month" aria-label="切換回顧月份">
            <button type="button" aria-label="較新的月份" data-action="month-newer"${selectedMonthIndex <= 0 ? raw(" disabled") : ""}>‹</button>
            <select class="select" data-review-month aria-label="選擇月份">${availableMonths.map((item) => html`<option value="${item}"${item === selectedMonth ? raw(" selected") : ""}>${formatMonth(item)}</option>`)}</select>
            <button type="button" aria-label="較早的月份" data-action="month-older"${selectedMonthIndex >= availableMonths.length - 1 ? raw(" disabled") : ""}>›</button>
          </div>
          <div class="stats">
            <div class="stat"><b class="stat-value">${monthActivities.length ? money(monthSaved) : "—"}</b><span class="stat-label">這個月我存給未來</span><small class="stat-note">${monthVoluntarySaved > 0 ? `包含自主多存 ${money(monthVoluntarySaved)}` : "先存再花的累積"}</small></div>
            <div class="stat"><b class="${monthAssetChange < 0 ? "stat-value is-negative" : "stat-value"}">${monthActivities.length ? signedMoney(monthAssetChange) : "—"}</b><span class="stat-label">這個月全部的錢變化 ${frag(common.infoTip("這是撲滿、爸媽銀行與 ETF 小森林合計的增減；ETF 漲跌也會影響，因此不等於這個月的收入或存款。", { align: "right" }))}</span><small class="stat-note">月底和月初相比</small></div>
            <div class="stat"><b class="stat-value">${monthActivities.length ? money(monthSpend) : "—"}</b><span class="stat-label">這個月我做了什麼選擇</span><small class="stat-note">${monthSpendCount ? `${monthSpendCount} 筆實際支出` : "沒有支出紀錄"}</small></div>
          </div>
          <form class="review-form">
            ${frag(common.field({ label: "我最滿意的一個選擇", id: "growth-proud", input: html`<textarea id="growth-proud" class="textarea" placeholder="我做了什麼好選擇？" maxlength="160">${draftProud}</textarea>` }))}
            ${frag(common.field({ label: "下次我想換個做法", id: "growth-change", input: html`<textarea id="growth-change" class="textarea" placeholder="沒有對錯，只要說說看" maxlength="160">${draftChange}</textarea>` }))}
            ${frag(common.field({ label: "下個月想練習什麼？", id: "growth-plan", input: html`<textarea id="growth-plan" class="textarea" placeholder="例如：買東西前先等一天" maxlength="160">${draftPlan}</textarea>` }))}
            ${formErrorText ? html`<p class="form-error" role="alert">${formErrorText}</p>` : ""}
            <button type="submit" class="btn btn-primary btn-block review-save">${reflection ? "更新這個月的回顧" : "存下這個月的回顧"}</button>
            <small class="review-notice">${noticeText}</small>
          </form>
        </div>
      </section>`;
}

// ---------- render ----------
export function render(ctx) {
  currentCtx = ctx;
  if (!ctx.state || !ctx.profile) return common.stateGate(undefined, () => ctx.refresh());
  syncProfile(ctx);

  const state = ctx.state;
  const profile = ctx.profile;
  const pinStatus = pinStatusOf(ctx);
  const unlocked = pinStatus === "unlocked";

  const jars = jarsOf(state, profile.id);
  const activeShort = jars.find((item) => item.status === "active" && item.kind === "short");
  const activeLong = jars.find((item) => item.status === "active" && item.kind === "long");
  const queuedShort = jars.filter((item) => item.status === "queued" && item.kind === "short");
  const completedJars = jars.filter((item) => item.status === "completed");

  if (!selectedMonth) selectedMonth = currentMonth();
  const reflection = state.reflections.find((item) => item.profileId === profile.id && item.month === selectedMonth);

  // 對應原本 [profile?.id, reflection?.proudText, reflection?.changeText, reflection?.planText] 的 effect：
  // 這三個欄位只有在孩子、月份或已存回顧的內容變動時才被重設，其餘重繪保留正在打的字。
  const nextReflectionKey = JSON.stringify([profile.id, selectedMonth, reflection ? reflection.proudText : "", reflection ? reflection.changeText : "", reflection ? reflection.planText : ""]);
  if (nextReflectionKey !== reflectionKey) {
    reflectionKey = nextReflectionKey;
    draftProud = reflection ? reflection.proudText : "";
    draftChange = reflection ? reflection.changeText : "";
    draftPlan = reflection ? reflection.planText : "";
  }

  const body = html`<div class="segmented growth-tabs" role="group" aria-label="切換成長頁的區塊">
        <button type="button" data-action="dream-tab" data-tab="assets" aria-pressed="${activeTab === "assets" ? "true" : "false"}">📈 資產</button>
        <button type="button" data-action="dream-tab" data-tab="jar" aria-pressed="${activeTab === "jar" ? "true" : "false"}">🎯 夢想罐</button>
        <button type="button" data-action="dream-tab" data-tab="review" aria-pressed="${activeTab === "review" ? "true" : "false"}">📝 每月回顧</button>
      </div>
      <div class="growth-sections">
        ${assetsSection(ctx, activeTab !== "assets")}
        ${jarSection(ctx, activeTab !== "jar", { activeShort, activeLong, queuedShort, completedJars, unlocked })}
        ${reviewSection(ctx, activeTab !== "review")}
      </div>`;

  return common.appShell({
    page: "growth",
    title: "成長",
    ctx,
    right: common.lockIconButton({ pinStatus }),
    body,
  });
}

// ---------- mount ----------
export function mount(root, ctx) {
  currentCtx = ctx;
  if (!ctx.state || !ctx.profile) return;
  // 規格 4.3：重繪後如果 modal「該開卻沒開」，補開並回填欄位值。
  lockModal.mountCheck(ctx);
  if (dreamFormOpen && !dreamFormNode) openDreamForm(root, ctx);
  if (completedEditorId && !completedEditorNode) {
    const jar = ctx.state.dreamJars.find((item) => item.id === completedEditorId);
    if (jar) openCompletedEditor(root, ctx, jar); else completedEditorId = "";
  }

  // details 開闔狀態（toggle 不冒泡，用捕捉階段接；同既有寫法）。
  root.addEventListener("toggle", (event) => {
    const target = event.target;
    const details = target && target.closest ? target.closest(".completed-card") : null;
    if (details) completedJarsOpen = details.open;
  }, true);

  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.getAttribute("data-action");
    const id = button.getAttribute("data-id");
    if (action === "open-lock") { lockModal.open(); return; }
    if (action === "dream-tab") {
      const tab = button.getAttribute("data-tab");
      // 規格 5.2：切換不重繪整頁，只切 section 的 hidden。
      if (tab && tab !== activeTab) { activeTab = tab; applyTab(root); }
      return;
    }
    if (action === "month-newer" || action === "month-older") {
      const months = availableMonthsOf(ctx.state, ctx.profile.id);
      const index = Math.max(0, months.indexOf(selectedMonth));
      const next = months[action === "month-newer" ? index - 1 : index + 1];
      if (next) { selectedMonth = next; ctx.refresh(); }
      return;
    }
    if (action === "new-dream") {
      editingId = "";
      draftTitle = "";
      draftTarget = "";
      draftKind = "short";
      dreamFormErrorText = "";
      openDreamForm(root, ctx);
      return;
    }
    if (action === "edit-dream") {
      const jar = jarsOf(ctx.state, ctx.profile.id).find((item) => item.id === id);
      if (!jar) return;
      editingId = jar.id;
      draftTitle = jar.title;
      draftKind = jar.kind;
      draftTarget = String(jar.targetAmount);
      dreamFormErrorText = "";
      formErrorText = "";
      openDreamForm(root, ctx);
      return;
    }
    if (action === "cancel-edit") { closeDreamForm(); return; }
    if (action === "complete-dream") { void completeDream(root, ctx, id, button); return; }
    if (action === "delete-dream") { void removeDream(root, ctx, id, button); return; }
    if (action === "activate-dream") { void activateDream(root, ctx, id, button); return; }
    if (action === "edit-completed") {
      const jar = jarsOf(ctx.state, ctx.profile.id).find((item) => item.id === id);
      if (jar) openCompletedEditor(root, ctx, jar);
    }
  });

  root.addEventListener("change", (event) => {
    const select = event.target.closest("[data-review-month]");
    if (select) { selectedMonth = select.value; ctx.refresh(); }
  });

  root.addEventListener("input", (event) => {
    // 原本這些欄位是受控的：重繪（例如按下完成夢想）不能把正在打的字弄丟。
    const field = event.target.closest(".review-form textarea");
    if (!field) return;
    if (field.id === "growth-proud") draftProud = field.value;
    if (field.id === "growth-change") draftChange = field.value;
    if (field.id === "growth-plan") draftPlan = field.value;
  });

  root.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form.classList.contains("review-form")) return;
    event.preventDefault();
    void saveReflection(root, ctx, form);
  });
}

// 只切 hidden 與 aria-pressed，不重繪整頁（≥1100 由 growth.css 讓三段同時顯示）。
function applyTab(root) {
  for (const section of root.querySelectorAll("[data-tab-panel]")) {
    section.hidden = section.getAttribute("data-tab-panel") !== activeTab;
  }
  for (const button of root.querySelectorAll("[data-action='dream-tab']")) {
    button.setAttribute("aria-pressed", button.getAttribute("data-tab") === activeTab ? "true" : "false");
  }
}

// ---------- 新增／編輯夢想的 modal（欄位沿用舊的 .new-dream-card 表單） ----------
function dreamFormContent(ctx) {
  const jars = jarsOf(ctx.state, ctx.profile.id);
  const activeShort = jars.find((item) => item.status === "active" && item.kind === "short");
  const activeLong = jars.find((item) => item.status === "active" && item.kind === "long");
  const unlocked = pinStatusOf(ctx) === "unlocked";
  return html`<h2 id="dream-form-title">${editingId ? "✎ 家長編輯夢想罐" : "＋ 新增夢想"}</h2>
        <form data-dream-form>
          ${frag(common.field({ label: "夢想名稱", id: "dream-title", input: html`<input id="dream-title" class="input" value="${draftTitle}" placeholder="例如：一本想看的書" required maxlength="30">` }))}
          ${frag(common.field({ label: "多久以後使用？", id: "dream-kind", input: html`<select id="dream-kind" class="select"${editingId ? raw(" disabled") : ""}><option value="short"${draftKind === "short" ? raw(" selected") : ""}>短期：自動帶入撲滿</option><option value="long"${!editingId && activeLong ? raw(" disabled") : ""}${draftKind === "long" ? raw(" selected") : ""}>長期：自動帶入爸媽銀行＋ETF${activeLong && !editingId ? "（已有）" : ""}</option></select>` }))}
          ${frag(common.field({ label: "目標金額", id: "dream-target", input: html`<div class="money-input"><span>NT$</span><input id="dream-target" type="number" min="50" max="10000000" value="${draftTarget}" required></div>` }))}
          <p class="dream-form-tip">${createTipText(draftKind, editingId, activeShort)}</p>
          ${dreamFormErrorText ? html`<p class="form-error" role="alert">${dreamFormErrorText}</p>` : ""}
          <button type="submit" class="btn btn-primary btn-block dream-submit"${(editingId && !unlocked) || (!editingId && draftKind === "long" && activeLong) ? raw(" disabled") : ""}>${createButtonLabel(draftKind, editingId, activeShort)}</button>
        </form>`;
}

function openDreamForm(root, ctx) {
  dreamFormOpen = true;
  const node = common.openModal(dreamFormContent(ctx), {
    labelledBy: "dream-form-title",
    onClose: (reason) => {
      dreamFormNode = null;
      // 背景重繪（"rerender"）留著 dreamFormOpen 與草稿，mount() 補開並回填。
      if (reason !== "rerender") { dreamFormOpen = false; dreamFormErrorText = ""; editingId = ""; }
    },
  });
  if (!node) { dreamFormOpen = false; return; }
  dreamFormNode = node;
  const form = node.querySelector("[data-dream-form]");
  if (!form) return;
  form.addEventListener("input", (event) => {
    const target = event.target;
    if (target.id === "dream-title") draftTitle = target.value;
    if (target.id === "dream-target") draftTarget = target.value;
  });
  form.addEventListener("change", (event) => {
    if (event.target.id !== "dream-kind") return;
    draftKind = event.target.value === "long" ? "long" : "short";
    syncCreateForm(form, ctx);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void createDream(root, ctx, form);
  });
}

function closeDreamForm() {
  dreamFormOpen = false;
  dreamFormErrorText = "";
  dreamFormNode = null;
  editingId = "";
  common.closeModal();
}

// ---------- 局部更新 ----------
function syncCreateForm(form, ctx) {
  const jars = jarsOf(ctx.state, ctx.profile.id);
  const activeShort = jars.find((item) => item.status === "active" && item.kind === "short");
  const activeLong = jars.find((item) => item.status === "active" && item.kind === "long");
  const tip = form.querySelector(".dream-form-tip");
  if (tip) tip.textContent = createTipText(draftKind, editingId, activeShort);
  const submit = form.querySelector(".dream-submit");
  if (submit) {
    submit.textContent = createButtonLabel(draftKind, editingId, activeShort);
    submit.disabled = Boolean((editingId && pinStatusOf(ctx) !== "unlocked") || (!editingId && draftKind === "long" && activeLong));
  }
}

function paintError(container, message, anchor) {
  if (!container) return;
  let node = container.querySelector(".form-error");
  if (!message) { if (node) node.remove(); return; }
  if (!node) {
    node = document.createElement("p");
    node.className = "form-error";
    node.setAttribute("role", "alert");
    if (anchor) container.insertBefore(node, anchor); else container.append(node);
  }
  node.textContent = message;
}

function paintFormError(root, message) {
  formErrorText = message;
  const form = root.querySelector(".review-form");
  paintError(form, message, form ? form.querySelector(".review-save") : null);
}

function paintDreamFormError(message) {
  dreamFormErrorText = message;
  const form = dreamFormNode ? dreamFormNode.querySelector("[data-dream-form]") : null;
  if (form) paintError(form, message, form.querySelector(".dream-submit"));
}

function startBusy(button, label) {
  if (!button) return () => {};
  const previousLabel = button.textContent;
  const previousDisabled = button.disabled;
  button.disabled = true;
  if (label) button.textContent = label;
  return () => { button.disabled = previousDisabled; button.textContent = previousLabel; };
}

// ---------- 動作 ----------
// 對應原本的 postDream：先樂觀更新頁面暫存，store.commit 觸發重繪就會看到；失敗再還原。
async function postDream(root, ctx, payload, button, busyLabel, successNotice = "剛剛已自動備份") {
  paintFormError(root, "");
  const restoreBusy = startBusy(button, busyLabel);
  const previous = { notice: noticeText, editingId, title: draftTitle, target: draftTarget };
  noticeText = successNotice;
  if (RESET_ACTIONS.includes(String(payload.action))) { draftTitle = ""; draftTarget = ""; editingId = ""; }
  try {
    await store.updateDreamJar({ profileId: ctx.profile.id, ...payload });
    return true;
  } catch (caught) {
    noticeText = previous.notice;
    editingId = previous.editingId;
    draftTitle = previous.title;
    draftTarget = previous.target;
    const message = errorMessage(caught, "儲存失敗");
    paintFormError(root, message);
    if (payload.action === "update-completed") paintCompletedError(message);
    else if (dreamFormNode) paintDreamFormError(message);
    common.showStatus(message, "error");
    restoreBusy();
    return false;
  }
}

async function createDream(root, ctx, form) {
  const title = form.querySelector("#dream-title") ? form.querySelector("#dream-title").value : "";
  const targetAmount = form.querySelector("#dream-target") ? form.querySelector("#dream-target").value : "";
  const select = form.querySelector("#dream-kind");
  const kind = select && select.value === "long" ? "long" : "short";
  draftTitle = title;
  draftTarget = targetAmount;
  draftKind = kind;
  const wasEditing = editingId;
  const ok = await postDream(root, ctx, {
    action: wasEditing ? "update" : "create",
    dreamId: wasEditing || undefined,
    title,
    kind,
    targetAmount: Number(targetAmount),
    // 沒帶 parentPin：store.assertParentPin 沒收到值時會改用 pin.js 記住的本次解鎖操作碼再驗一次。
  }, form.querySelector(".dream-submit"), "儲存中…");
  if (ok) closeDreamForm();
}

async function completeDream(root, ctx, dreamId, button) {
  const jar = jarsOf(ctx.state, ctx.profile.id).find((item) => item.id === dreamId);
  if (!jar) return;
  const ok = await common.confirmDialog(`把「${jar.title}」記錄為已完成嗎？完成金額會記為 ${money(jar.targetAmount)}，帳戶餘額不會因此改變。`);
  if (!ok) return;
  await postDream(root, ctx, { action: "complete", dreamId: jar.id, completedAmount: jar.targetAmount }, button, "記錄中…");
}

async function removeDream(root, ctx, dreamId, button) {
  const jar = jarsOf(ctx.state, ctx.profile.id).find((item) => item.id === dreamId);
  if (!jar) return;
  const ok = await common.confirmDialog(`確定刪除「${jar.title}」嗎？這不會刪除任何錢或交易紀錄。`);
  if (!ok) return;
  // 進行中夢想的刪除鍵會換成「刪除中…」；清單列的刪除鍵原本只變灰、字不變。
  const busyLabel = button && button.closest(".dream-actions") ? "刪除中…" : null;
  await postDream(root, ctx, { action: "delete", dreamId: jar.id }, button, busyLabel);
}

async function activateDream(root, ctx, dreamId, button) {
  await postDream(root, ctx, { action: "activate", dreamId }, button, "開始中…");
}

async function saveReflection(root, ctx, form) {
  const proudText = form.querySelector("#growth-proud") ? form.querySelector("#growth-proud").value : "";
  const changeText = form.querySelector("#growth-change") ? form.querySelector("#growth-change").value : "";
  const planText = form.querySelector("#growth-plan") ? form.querySelector("#growth-plan").value : "";
  paintFormError(root, "");
  const restoreBusy = startBusy(form.querySelector(".review-save"), "儲存中…");
  const previousNotice = noticeText;
  const saved = common.savedStatus(ctx.state, `${formatMonth(selectedMonth)}回顧已存好`);
  noticeText = saved.message;
  try {
    await store.saveMonthlyReflection({ profileId: ctx.profile.id, month: selectedMonth, proudText, changeText, planText });
    common.showStatus(saved.message, saved.tone);
  } catch (caught) {
    noticeText = previousNotice;
    const message = errorMessage(caught, "回顧儲存失敗");
    paintFormError(root, message);
    common.showStatus(message, "error");
    restoreBusy();
  }
}

// ---------- 已完成夢想罐的家長編輯 modal ----------
function completedEditorContent(jar) {
  const startedAt = toDateTimeLocal(jar.createdAt);
  const finishedAt = toDateTimeLocal(jar.completedAt ?? jar.updatedAt);
  // 關閉鈕由 common.openModal 畫。
  return html`<span class="kicker">家長編輯</span>
        <h2 id="completed-dream-editor-title">已完成夢想罐</h2>
        <form>
          ${frag(common.field({ label: "夢想名稱", id: "completed-title", input: html`<input id="completed-title" class="input" value="${jar.title}" minlength="2" maxlength="30" required>` }))}
          ${frag(common.field({ label: "夢想類型", id: "completed-kind", input: html`<select id="completed-kind" class="select"><option value="short"${jar.kind === "short" ? raw(" selected") : ""}>短期夢想</option><option value="long"${jar.kind === "long" ? raw(" selected") : ""}>長期夢想</option></select>` }))}
          ${frag(common.field({ label: "原目標金額", id: "completed-target", input: html`<input id="completed-target" class="input" type="number" min="50" max="10000000" value="${jar.targetAmount}" required>` }))}
          ${frag(common.field({ label: "完成金額", id: "completed-amount", input: html`<input id="completed-amount" class="input" type="number" min="0" max="10000000" value="${jar.completedAmount ?? jar.targetAmount}" required>` }))}
          ${frag(common.field({ label: "開始日期與時間", id: "completed-start", input: html`<input id="completed-start" class="input" type="datetime-local" value="${startedAt}" required>` }))}
          ${frag(common.field({ label: "完成日期與時間", id: "completed-finish", input: html`<input id="completed-finish" class="input" type="datetime-local" value="${finishedAt}" required>` }))}
          ${startedAt && finishedAt ? html`<p class="completed-duration-preview">完成歷時：${elapsedTime(startedAt, finishedAt)}</p>` : ""}
          <button type="submit" class="btn btn-primary btn-block completed-submit">儲存完成紀錄</button>
        </form>`;
}

function openCompletedEditor(root, ctx, jar) {
  completedEditorId = jar.id;
  completedEditorErrorText = "";
  const node = common.openModal(completedEditorContent(jar), {
    labelledBy: "completed-dream-editor-title",
    className: "completed-dream-editor",
    onClose: (reason) => {
      completedEditorNode = null;
      if (reason !== "rerender") { completedEditorId = ""; completedEditorErrorText = ""; }   // 背景重繪留著 id，mount() 補開
    },
  });
  if (!node) return;
  completedEditorNode = node;
  const form = node.querySelector("form");
  if (!form) return;
  form.addEventListener("input", (event) => {
    if (event.target.closest("input[type=datetime-local]")) updateDurationPreview(form);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveCompletedDream(root, ctx, form, jar);
  });
}

function completedFields(form) {
  const value = (id) => (form.querySelector(`#${id}`) ? form.querySelector(`#${id}`).value : "");
  return {
    title: value("completed-title"),
    kind: value("completed-kind") === "long" ? "long" : "short",
    targetAmount: value("completed-target"),
    completedAmount: value("completed-amount"),
    startedAt: value("completed-start"),
    finishedAt: value("completed-finish"),
  };
}

function updateDurationPreview(form) {
  const { startedAt, finishedAt } = completedFields(form);
  let node = form.querySelector(".completed-duration-preview");
  if (!startedAt || !finishedAt) { if (node) node.remove(); return; }
  if (!node) {
    node = document.createElement("p");
    node.className = "completed-duration-preview";
    const anchor = form.querySelector(".form-error") || form.querySelector(".completed-submit");
    if (anchor) form.insertBefore(node, anchor); else form.append(node);
  }
  node.textContent = `完成歷時：${elapsedTime(startedAt, finishedAt)}`;
}

function paintCompletedError(message) {
  completedEditorErrorText = message;
  const form = completedEditorNode ? completedEditorNode.querySelector("form") : null;
  if (form) paintError(form, message, form.querySelector(".completed-submit"));
}

async function saveCompletedDream(root, ctx, form, jar) {
  const fields = completedFields(form);
  const startedAt = new Date(fields.startedAt);
  const finishedAt = new Date(fields.finishedAt);
  if (!fields.startedAt || !fields.finishedAt || Number.isNaN(startedAt.getTime()) || Number.isNaN(finishedAt.getTime())) {
    paintCompletedError("請輸入完整的開始與完成日期時間");
    return;
  }
  if (finishedAt < startedAt) {
    paintCompletedError("完成時間不能早於開始時間");
    return;
  }
  paintCompletedError("");
  const ok = await postDream(root, ctx, {
    action: "update-completed",
    dreamId: jar.id,
    title: fields.title,
    kind: fields.kind,
    targetAmount: Number(fields.targetAmount),
    completedAmount: Number(fields.completedAmount),
    createdAt: startedAt.toISOString(),
    completedAt: finishedAt.toISOString(),
  }, form.querySelector(".completed-submit"), "儲存中…", "已完成夢想的內容與日期時間已更新並備份");
  if (ok) {
    completedEditorId = "";
    completedEditorErrorText = "";
    completedEditorNode = null;
    common.closeModal();
  }
}
