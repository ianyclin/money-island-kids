// 小小理財島 PWA：孩子首頁。內容、class、aria 與文案全部照 app/page.tsx；只把資料來源換成本機 store。

import { html, raw, money, formatShortDate, taipeiMonth, uuid, errorMessage } from "../util.js";
import {
  primaryNav,
  showStatus,
  openModal,
  closeModal,
  profileAvatar,
  profileChips,
  stateGate,
  backupStatusText,
  savedStatus,
} from "./common.js";
import * as store from "../store.js";

// ---------- 頁面暫存（重繪後由 render 讀回） ----------
let action = null;              // null | "allowance" | "spend"
let amount = "";
let labelText = "";
let transactionOperationId = uuid();
let saving = false;
let notice = "";
let error = "";
let projectBusy = "";
let projectError = "";
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
function totalAssets(profile) {
  return profile.spendingBalance + profile.bankBalance + profile.marketValue;
}

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

function assetTimeline(profile, activities) {
  const monthly = new Map();
  let running = 0;
  const sorted = activities
    .filter((item) => item.profileId === profile.id)
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.createdAt.localeCompare(b.createdAt));

  for (const item of sorted) {
    running = Math.max(0, running + item.spendDelta + item.bankDelta + item.marketDelta);
    monthly.set(item.entryDate.slice(0, 7), running);
  }

  const currentMonth = taipeiMonth();
  monthly.set(currentMonth, totalAssets(profile));

  const all = Array.from(monthly, ([month, value]) => ({
    month,
    label: `${Number(month.slice(5, 7))}月`,
    value,
  })).sort((a, b) => a.month.localeCompare(b.month));
  if (all.length <= 10) return all;
  const sampled = Array.from({ length: 10 }, (_, index) => all[Math.round(index * (all.length - 1) / 9)]);
  return sampled.filter((item, index) => index === 0 || item.month !== sampled[index - 1].month);
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

function projectStatus(status, name) {
  if (status === "claimed") return `${name ?? "小朋友"}進行中`;
  if (status === "waiting") return "等待家長確認";
  if (status === "completed") return "已完成";
  return "可以認領";
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
function moneyCard({ icon, tone, title, value, caption, pending, actionLabel, actionName }) {
  return html`
      <article class="money-card ${tone}">
        <span class="money-card-icon" aria-hidden="true">${icon}</span>
        <div>
          <small>${title}</small>
          <div class="money-card-value-row">
            <strong>${money(value)}</strong>
            ${actionLabel && actionName ? html`<button class="money-card-action" type="button" data-action="${actionName}">${actionLabel}</button>` : ""}
          </div>
          <p>${caption}</p>
          ${pending ? html`<span class="money-card-pending">⌛ ${pending}</span>` : ""}
        </div>
      </article>`;
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

function assetGrowthChart({ points, current, profile, dreams }) {
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
  const firstYear = Number(chartPoints[0]?.month.slice(0, 4) ?? new Date().getFullYear());
  const lastYear = Number(chartPoints[chartPoints.length - 1]?.month.slice(0, 4) ?? firstYear);
  const yearsAccumulating = Math.max(1, lastYear - firstYear + 1);
  return html`
        <article class="growth-card">
          <div class="section-heading">
            <div><span class="section-kicker">資產成長</span><h2>總資產折線圖</h2><small class="chart-year-count">從 ${firstYear} 年開始 · 累積第 ${yearsAccumulating} 年</small></div>
            <strong>${money(current)}</strong>
          </div>
          <div class="asset-chart" role="img" aria-label="橫軸為時間、縱軸為金額；目前總資產 ${money(current)}">
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
              <div class="chart-x-axis">${chartPoints.map((point) => html`<span><b>${point.label}</b><small>${point.month.slice(0, 4)}</small></span>`)}</div>
            </div>
          </div>
          ${dreams.length ? html`
          <div class="growth-dreams">
            <div><span>夢想罐進度</span><a href="#/dreams">查看夢想 →</a></div>
            ${dreams.map((dream) => {
              const saved = dream.kind === "short" ? profile.spendingBalance : profile.bankBalance + profile.marketValue;
              const percent = Math.min(100, dream.targetAmount ? saved / dream.targetAmount * 100 : 0);
              return html`
            <a href="#/dreams" class="growth-dream kind-${dream.kind}">
              <span><b>${dream.title}</b><small>${dream.kind === "short" ? "短期 · 撲滿" : "長期 · 爸媽銀行＋ETF"}</small></span>
              <i><em style="width: ${percent}%"></em></i>
              <strong>${Math.round(percent)}%</strong>
            </a>`;
            })}
          </div>` : html`
          <a class="growth-dream-empty" href="#/dreams"><span>☁</span><b>放進一個想完成的夢想</b><small>建立夢想罐 →</small></a>`}
        </article>`;
}

function rule(number, title, text) {
  return html`<article class="rule"><span>${number}</span><div><h3>${title}</h3><p>${text}</p></div></article>`;
}

// ---------- render ----------
export function render(ctx) {
  const state = ctx.state;
  const profile = ctx.profile;
  if (!state || !profile) return stateGate("", () => ctx.refresh());

  const activities = state.activities.filter((item) => item.profileId === profile.id).slice(0, 6);
  const profileHoldings = state.holdings.filter((item) => item.profileId === profile.id);
  const assetPoints = assetTimeline(profile, state.activities);
  const activeDreams = state.dreamJars
    .filter((item) => item.profileId === profile.id && item.status === "active")
    .slice(0, 2);
  const pendingSavingsAmount = pendingSavingsAmountOf(ctx);
  const savingsRate = savingsRateOf(state);
  const spendingRate = 100 - savingsRate;
  const returnRate = profile.stockCost > 0
    ? ((profile.marketValue - profile.stockCost) / profile.stockCost) * 100
    : 0;

  return html`
    <main class="site-shell" data-kid="${profile.id}" style="--kid-accent: ${profile.accent}">
      <header class="topbar">
        <a class="brand" href="#top" aria-label="回到小小理財島首頁">
          <span class="brand-mark" aria-hidden="true">¢</span>
          <span>
            <strong>小小理財島</strong>
            <small>先存一點，夢想長大</small>
          </span>
        </a>
        ${profileChips(ctx.profiles, profile.id)}
        <div class="top-actions">
          <span class="backup-status"><i aria-hidden="true"></i>${notice || backupStatusText(state)}</span>
          ${primaryNav("home")}
        </div>
      </header>

      <section class="hero" id="top">
        <div class="hero-copy">
          <span class="eyebrow">${profile.name}的理財小基地</span>
          <h1>${profile.name}的錢，<br /><em>正在慢慢長大。</em></h1>
          <div class="hero-practice" aria-label="零用錢分成 ${savingsRate}% 留給未來與 ${spendingRate}% 自己決定">
            <div><b>${savingsRate}%</b><small>先留給未來</small></div>
            <div><b>${spendingRate}%</b><small>自己做選擇</small></div>
          </div>
          <div class="hero-actions">
            <button class="primary-button" data-action="open-allowance">
              <span aria-hidden="true">＋</span> 記一筆零用錢
            </button>
            <button class="secondary-button" data-action="open-spend">
              記一筆花費
            </button>
          </div>
        </div>
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

      <section class="wallet-grid" aria-label="錢包總覽">
        ${moneyCard({
          icon: "🐷",
          tone: "yellow",
          title: "可以自己決定（撲滿）",
          value: profile.spendingBalance,
          caption: profile.spendingBalance ? "用來買想要的東西" : "從下一筆零用錢開始記錄",
        })}
        ${moneyCard({
          icon: "🏦",
          tone: "pink",
          title: "爸媽銀行",
          value: profile.bankBalance,
          caption: profile.bankBalance >= 1000
            ? "有存錢獎勵；已經可以請爸媽協助種進小森林"
            : `有存錢獎勵；再存 ${money(1000 - profile.bankBalance)} 就能請爸媽協助種樹`,
          pending: pendingSavingsAmount ? `${money(pendingSavingsAmount)} 等待爸媽確認` : undefined,
          actionLabel: "🌱 我想多存一點",
          actionName: "open-save-more",
        })}
        ${moneyCard({
          icon: "🌳",
          tone: "green",
          title: "ETF 小森林",
          value: profile.marketValue,
          caption: profileHoldings.length === 1
            ? `${profileHoldings[0].symbol} · ${profileHoldings[0].units} 股 · ${returnRate >= 0 ? "+" : ""}${returnRate.toFixed(1)}%`
            : profileHoldings.length > 1
              ? `${profileHoldings.length} 個標的 · ${returnRate >= 0 ? "+" : ""}${returnRate.toFixed(1)}%`
              : "長期投資，會漲也會跌",
        })}
      </section>

      <section class="content-grid">
        ${assetGrowthChart({ points: assetPoints, current: totalAssets(profile), profile, dreams: activeDreams })}

        <article class="activity-card">
          <div class="section-heading">
            <div>
              <span class="section-kicker">最近紀錄</span>
              <h2>錢的成長足跡</h2>
            </div>
            <a class="record-count" href="#/history">查看全部 →</a>
          </div>
          <div class="timeline">
            ${activities.map((item) => html`
            <div class="timeline-item">
              <span class="timeline-dot kind-${item.kind}" aria-hidden="true">
                ${activityIcon(item.kind)}
              </span>
              <div>
                <strong>${item.label}</strong>
                <small>${formatShortDate(item.entryDate)} · ${item.note}</small>
              </div>
              <b>${item.amount ? money(item.amount) : "開始"}</b>
            </div>`)}
          </div>
        </article>
      </section>

      <section class="projects-section" aria-labelledby="projects-title">
        <div class="projects-heading">
          <div>
            <span class="section-kicker">偶爾才開放</span>
            <h2 id="projects-title">家庭小專案</h2>
            <p>只有家長事前約定、超出日常責任的完整任務才會出現在這裡。</p>
          </div>
          <span class="project-principle"><b>完成後才發放</b>報酬一樣先存 ${savingsRate}%</span>
        </div>
        <div class="project-grid">
          ${state.projects.map((item) => {
            const assigned = state.profiles.find((kid) => kid.id === item.assignedProfileId);
            const isMine = item.assignedProfileId === profile.id;
            return html`
          <article class="project-card status-${item.status}">
            <div class="project-card-top">
              <span class="project-status">${projectStatus(item.status, assigned?.name)}</span>
              <strong>${money(item.reward)}</strong>
            </div>
            <h3>${item.title}</h3>
            <p>${item.description}</p>
            ${item.status === "open" ? html`<button${attr(projectBusy === item.id, " disabled")} data-action="claim-project" data-id="${item.id}">${projectBusy === item.id ? "正在登記…" : `${profile.name}想接這個專案`}</button>` : ""}
            ${item.status === "claimed" && isMine ? html`<button${attr(projectBusy === item.id, " disabled")} data-action="submit-project" data-id="${item.id}">${projectBusy === item.id ? "正在送出…" : "我完成了，請家長確認"}</button>` : ""}
            ${item.status === "claimed" && !isMine ? html`<small>${assigned?.name}正在進行中</small>` : ""}
            ${item.status === "waiting" ? html`<small class="waiting-note">⌛ 等待家長在家長專區確認</small>` : ""}
            ${item.status === "completed" ? html`<small class="completed-note">✓ 已完成並分配報酬</small>` : ""}
          </article>`;
          })}
        </div>
        ${projectError ? html`<p class="form-error project-error">${projectError}</p>` : ""}
      </section>

      <section class="rules-section" id="rules">
        <div class="rules-copy">
          <span class="section-kicker">我們家的約定</span>
          <h2>錢是用來練習選擇，<br />不是拿來考試。</h2>
          <p>記不清楚時，我們一起補帳；花錯一次，也能變成下次更好的選擇。</p>
        </div>
        <div class="rule-list">
          ${rule("01", "先存再花", `每次收到零用錢，先留下 ${savingsRate}% 給未來。`)}
          ${rule("02", "想要自己買", "飲料、小玩具和非必要文具，用自己的零用錢選擇。")}
          ${rule("03", "需要由爸媽負責", "餐點、衣服、學校用品、書籍與教育需要，由爸媽準備。")}
          ${rule("04", "一起記、一起想", "漏記就一起回想，不會因為忘記記帳而取消零用錢。")}
        </div>
      </section>

      <footer>
        <strong>小小理財島 · 讓好習慣慢慢長大</strong>
        <span class="footer-credit">著作注記 · <a href="https://www.facebook.com/profile.php?id=100084000897269" target="_blank" rel="noreferrer">fb/指數三寶飯</a></span>
      </footer>
    </main>`;
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
      <button class="modal-close" aria-label="關閉" data-action="close-modal">×</button>
      <span class="modal-avatar">${profileAvatar(profile.avatar, profile.name)}</span>
      <p class="section-kicker">${profile.name}的紀錄</p>
      <h2 id="money-dialog-title">${action === "allowance" ? "收到多少零用錢？" : "這次花了多少錢？"}</h2>
      <form>
        ${action === "allowance" ? html`<div class="quick-amounts quick-amounts-three" aria-label="快速增加零用錢金額">
          ${[10, 100, 1000].map((value) => html`<button type="button"${attr(allowance >= 100000, " disabled")} data-quick-amount="${value}">＋${value.toLocaleString("zh-TW")}</button>`)}
        </div>` : ""}
        <label class="input-label" for="money-amount">金額</label>
        <div class="money-input"><span>NT$</span><input id="money-amount" inputmode="numeric" min="1" max="100000" type="number" value="${amount}" required></div>
        <label class="input-label" for="money-label">${action === "allowance" ? "這筆錢從哪裡來？" : "買了什麼？"}</label>
        <input class="text-input" id="money-label" value="${labelText}" placeholder="${action === "allowance" ? "例如：本週零用錢" : "例如：貼紙"}">
        ${action === "allowance" ? html`
        <div class="preview-split">
          <span><b>${money(investPreview)}</b>先存 ${savingsRate}%</span>
          <span><b>${money(spendPreview)}</b>自己安排 ${spendingRate}%</span>
        </div>` : ""}
        ${error ? html`<p class="form-error">${error}</p>` : ""}
        <button class="primary-button full-width"${attr(saving || allowance <= 0, " disabled")}>
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
      <button class="modal-close" aria-label="關閉" data-action="close-modal">×</button>
      <span class="modal-avatar">${profileAvatar(profile.avatar, profile.name)}</span>
      <p class="section-kicker">把現在的一點自由留給未來</p>
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
        <label class="input-label" for="save-more-amount">自主存入金額</label>
        <div class="money-input"><span>NT$</span><input id="save-more-amount" inputmode="numeric" min="1" max="${savingAvailable}" type="number" value="${saveMoreAmount}"${attr(savingAvailable <= 0, " disabled")} required></div>
        <label class="input-label" for="save-more-note">想留給未來做什麼？（選填）</label>
        <input class="text-input" id="save-more-note" value="${saveMoreNote}" placeholder="例如：想讓長期夢想快一點長大" maxlength="80">
        <div class="transfer-preview">
          <span><small>撲滿</small><b>${money(profile.spendingBalance)} → ${money(profile.spendingBalance - saveMorePreview)}</b></span>
          <i aria-hidden="true">→</i>
          <span><small>爸媽銀行</small><b>${money(profile.bankBalance)} → ${money(profile.bankBalance + saveMorePreview)}</b></span>
        </div>
        ${pendingSavingsAmount > 0 ? html`<small class="pending-transfer-note">另有 ${money(pendingSavingsAmount)} 正在等待爸媽確認</small>` : ""}
        ${saveMoreError ? html`<p class="form-error">${saveMoreError}</p>` : ""}
        <button class="primary-button full-width"${attr(saveMoreBusy || saveMoreValue <= 0 || saveMoreValue > savingAvailable, " disabled")}>${saveMoreBusy ? "正在送出…" : "請爸媽確認"}</button>
      </form>`;
}

// common.openModal 可能自己包 .modal 外框，也可能只放內容；兩種都撐住，並補上原本的附加 class。
function openDialog(body, { labelledBy, extraClass, onClose }) {
  const node = openModal(String(body), { labelledBy, onClose });
  const host = node && node.nodeType === 1 ? node : document.getElementById("modal-root");
  let dialog = host.classList.contains("modal") ? host : host.querySelector(".modal");
  if (!dialog) {
    dialog = document.createElement("div");
    dialog.className = "modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    if (labelledBy) dialog.setAttribute("aria-labelledby", labelledBy);
    while (host.firstChild) dialog.append(host.firstChild);
    host.append(dialog);
  }
  if (extraClass) dialog.classList.add(extraClass);
  return dialog;
}

// ---------- 提示與錯誤 ----------
function announce(message, tone = "success") {
  notice = message;
  showStatus(message, tone);
  const status = document.querySelector(".backup-status");
  if (status) {
    const icon = status.querySelector("i");
    status.textContent = message;
    if (icon) status.prepend(icon);
  }
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
  form.querySelector("button.primary-button")?.before(node);
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
  const submit = dialog.querySelector("button.primary-button");
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
  const dialog = openDialog(transactionModalBody(ctx), {
    labelledBy: "money-dialog-title",
    onClose: () => {
      if (openModalKind !== "transaction") return;
      openModalKind = "";
      action = null;
    },
  });
  openModalKind = "transaction";

  dialog.addEventListener("input", () => syncTransactionPreview(dialog));
  dialog.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-action='close-modal']");
    if (closeButton) {
      action = null;
      openModalKind = "";
      closeModal();
      return;
    }
    const quick = event.target.closest("[data-quick-amount]");
    if (quick) {
      const input = dialog.querySelector("#money-amount");
      input.value = String(Math.min(100000, allowanceValue() + Number(quick.dataset.quickAmount)));
      syncTransactionPreview(dialog);
    }
  });
  dialog.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
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
  const button = form.querySelector("button.primary-button");
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
  const submit = dialog.querySelector("button.primary-button");
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
  const dialog = openDialog(saveMoreModalBody(ctx), {
    labelledBy: "save-more-dialog-title",
    extraClass: "savings-transfer-modal",
    onClose: () => {
      if (openModalKind !== "saveMore") return;
      openModalKind = "";
      saveMoreOpen = false;
    },
  });
  openModalKind = "saveMore";

  dialog.addEventListener("input", () => syncSaveMorePreview(dialog));
  dialog.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-action='close-modal']");
    if (closeButton) {
      saveMoreOpen = false;
      openModalKind = "";
      closeModal();
      return;
    }
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
  const button = form.querySelector("button.primary-button");
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

// ---------- 專案與花園 ----------
async function runProject(ctx, projectAction, projectId, button) {
  projectBusy = projectId;
  projectError = "";
  if (button) {
    button.disabled = true;
    button.textContent = projectAction === "submit" ? "正在送出…" : "正在登記…";
  }
  try {
    await store.updateFamilyProject({ action: projectAction, projectId, profileId: ctx.profile.id });
    projectBusy = "";
    announce(
      projectAction === "submit" ? "已經送給爸媽確認" : "已經接下這個家庭小專案",
      projectAction === "submit" ? "waiting" : "success",
    );
  } catch (caught) {
    const message = errorMessage(caught, "儲存失敗");
    projectBusy = "";
    projectError = message;
    showStatus(message, "error");
    ctx.refresh();
  }
}

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
      const details = event.target.closest?.(".garden-picker");
      if (details) gardenPickerOpen = details.open;
    }, true);
  }

  // 重繪之後把原本開著的 modal 補回來（正在送出時不重開，避免搶走焦點）。
  if (action && openModalKind !== "transaction") openTransactionModal(ctx);
  else if (saveMoreOpen && openModalKind !== "saveMore") openSaveMoreModal(ctx);
}

function onRootClick(event) {
  const ctx = currentCtx;
  if (!ctx) return;

  const chooser = event.target.closest("[data-choose-profile]");
  if (chooser) {
    ctx.chooseProfile(chooser.dataset.chooseProfile);
    return;
  }

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
  else if (name === "claim-project") void runProject(ctx, "claim", button.dataset.id, button);
  else if (name === "submit-project") void runProject(ctx, "submit", button.dataset.id, button);
}
