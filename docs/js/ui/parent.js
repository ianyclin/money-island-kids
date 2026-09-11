// 家長區（移植自 app/parent/page.tsx ＋ app/parent/device-trust-panel.tsx 的備份段落）。
// 骨架換成 render/mount，內容、class 與文案照原專案；只有架構契約第 12 節列出的句子改寫成單機版。
//
// v2 重做（notes/redesign-v2/spec.md 第 3／5.5 節）：外殼換成 common.appShell()，
// markup 換成 v2 的 .card／.btn／.field 這組 class；store 呼叫、operationId、busy 狀態、
// 錯誤處理、校正撲滿 modal 的存活機制一律原樣沿用。
// 未解鎖：只有一張解鎖表單 .card ＋ 一行「解鎖後才能看到家長功能」，不顯示備份面板。
// 已解鎖（由上到下）：待辦 → 快速動作 → 預先儲蓄比例 → 孩子資料 → 投資入口 →
// 家庭小專案 → 資料與備份 → 理念與操作指南；≥1100px 依規格 5.5 切 3:2 兩欄。

import { html, raw, money, formatDate, formatDateTime, errorMessage, uuid } from "../util.js";
import * as common from "./common.js";
import * as store from "../store.js";
import * as pin from "../pin.js";
import * as backup from "../backup.js";
import * as db from "../db.js";
import * as gist from "../gist.js";

// ---------- 頁面暫存（重繪後還原） ----------
const ui = {
  parentPin: "",
  notice: "資料異動後會自動儲存",
  operationError: null,          // { scope, message }
  pinError: "",
  pinChangeOpen: false,          // 變更操作碼 modal：是否「應該」開著（規格 4.3 的存活機制）
  pinChangeModalKind: "",        // "" | "pin-change"
  pinChangeDrafts: { "current-pin": "", "new-pin": "", "confirm-new-pin": "" },
  addProfileOpen: false,
  projectId: "",
  savingsRate: null,
  savingsRateBase: null,
  profilePhoto: "",              // 新選的照片（已壓縮的 data URL）
  profilePreview: "",
  restoreSummary: null,
  restoreEnvelope: null,
  snapshots: null,               // null=尚未讀取、[]=沒有、false=不支援
  openDetails: new Set(),        // "guide" | "backup-file" | "snapshots" | "gist"（v2 只剩這四個抽屜）
  drafts: Object.create(null),
  piggyKey: "",
  identityKey: "",
  guideTouched: false,           // 使用者手動切換過指南 details 後，不再被 pinStatus==="setup" 蓋回
  correctionOpen: false,         // 校正撲滿 modal：是否「應該」開著（規格 1.2／3.2／2.4 第 3 項的存活模式）
  correctionModalKind: "",       // "" | "correction"
};

const ERROR_ANCHORS = {
  pin: { selector: ".parent-lock-card", position: "beforeend" },
  profile: { selector: ".profile-editor-forms", position: "beforeend" },
  accounts: { selector: ".profile-editor-forms", position: "beforeend" },
  inbox: { selector: ".parent-inbox", position: "beforeend" },
  projects: { selector: ".parent-project-panel", position: "beforeend" },
  backup: { selector: ".parent-device-panel", position: "beforeend" },
};

function draft(key, fallback = "") {
  return Object.prototype.hasOwnProperty.call(ui.drafts, key) ? ui.drafts[key] : fallback;
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

// ---------- 衍生資料 ----------
function scopeOf(state, profile) {
  return { holdings: state.holdings.filter((item) => item.profileId === profile.id) };
}

// 原本用 useEffect 在 profile／餘額變動時重設表單；這裡在 render 時比對 key 做同一件事。
function syncKeys(state, profile) {
  const piggyKey = `${profile.id}:${profile.spendingBalance}`;
  if (ui.piggyKey !== piggyKey) {
    // 只有「換了孩子」才把校正 modal 收掉；同一個孩子的餘額被背景異動（Gist 同步、每月獎勵）
    // 改變時，modal 與輸入到一半的金額都要留著（規格 1.2／3.2 存活機制）。
    const previousId = ui.piggyKey ? ui.piggyKey.split(":")[0] : "";
    ui.piggyKey = piggyKey;
    if (previousId !== profile.id) {
      clearDrafts("piggy-balance", "piggy-note");
      ui.correctionOpen = false;
    }
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
}

// ---------- 校正撲滿：共用欄位（同一段 markup／邏輯同時被孩子資料編輯的撲滿表單與快速動作 modal 呼叫） ----------
function piggyCorrectionFields(profile) {
  return html`${common.field({
      label: "撲滿目前金額",
      input: html`<input class="input" type="number" min="0" max="1000000" inputmode="numeric" data-draft="piggy-balance" value="${draft("piggy-balance", String(profile.spendingBalance))}" required />`,
    })}
      ${common.field({
      label: "校正原因（選填）",
      input: html`<input class="input" data-draft="piggy-note" value="${draft("piggy-note")}" placeholder="例如：和實體撲滿核對" maxlength="100" />`,
    })}`;
}

function piggyCorrectionModalBody(profile) {
  return html`<div class="piggy-correction-modal">
    <h2 id="piggy-correction-title">校正撲滿金額</h2>
    <p class="piggy-correction-context"><span>${raw(common.profileAvatar(profile.avatar))}</span><b>${profile.name}的撲滿</b></p>
    <form data-form="piggy-correction">
      ${piggyCorrectionFields(profile)}
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-action="cancel-correction">取消</button>
        <button class="btn btn-primary" data-busy-label="儲存中…">儲存撲滿金額</button>
      </div>
    </form>
  </div>`;
}

// ---------- 變更操作碼 modal（規格 5.5：頁首右插槽的小連結打開；存活機制照 common.createLockModal 的寫法） ----------
function pinChangeField(label, key) {
  return common.field({
    label,
    input: html`<input class="input" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" data-digits data-field="${key}" value="${ui.pinChangeDrafts[key] || ""}" required />`,
  });
}

function pinChangeModalBody() {
  return html`<div class="parent-pin-modal">
    <h2 id="pin-change-title">變更操作碼</h2>
    <form data-form="pin-change">
      ${pinChangeField("目前操作碼", "current-pin")}
      ${pinChangeField("新操作碼", "new-pin")}
      ${pinChangeField("再輸入一次", "confirm-new-pin")}
      <div class="form-actions">
        <button class="btn btn-primary btn-block" data-busy-label="更新中…">確認變更</button>
      </div>
    </form>
  </div>`;
}

// ---------- render ----------
export function render(ctx) {
  const state = ctx.state;
  const profile = ctx.profile;
  if (!state || !profile) return raw(common.stateGate(null, () => ctx.refresh()));

  const pinStatus = ctx.pinStatus;
  const unlocked = pinStatus === "unlocked";
  const { holdings } = scopeOf(state, profile);
  syncKeys(state, profile);

  // 規格 2.4 第 9 項：pinStatus==="setup" 時指南預設展開，使用者手動切換過後不再被蓋回。
  if (!ui.guideTouched && pinStatus === "setup") ui.openDetails.add("guide");

  // 規格 5.5：已解鎖時頁首右插槽放「🔓 已解鎖 · 變更操作碼」小連結（點了開 modal）。
  const right = unlocked
    ? html`<button type="button" class="parent-unlocked-link" data-action="toggle-pin-change">🔓 已解鎖 · 變更操作碼</button>`
    : "";

  return common.appShell({
    page: "parent",
    title: "家長區",
    ctx,
    right,
    body: unlocked ? unlockedBody(state, profile, holdings) : lockedBody(pinStatus),
  });
}

// ---------- 未解鎖（規格 5.5：只有一張解鎖表單，不顯示備份面板） ----------
function lockedBody(pinStatus) {
  const setupMode = pinStatus === "setup";
  return html`<section class="card parent-lock-card">
      <h2 class="card-title">${setupMode ? "第一次使用：設定家長操作碼" : "輸入家長操作碼"}</h2>
      <p class="parent-lock-copy">${setupMode ? "使用 4–8 位數字；操作碼不會顯示在孩子頁面。" : "編輯帳本、專案、投資與資料備份都需要驗證。"}</p>
      <form data-form="pin">
        ${common.field({
          label: "家長操作碼",
          id: "parent-pin",
          input: html`<input id="parent-pin" class="input" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" data-digits placeholder="4–8 位數字" required />`,
        })}
        <div class="form-actions">
          <button class="btn btn-primary btn-block" data-busy-label="驗證中…">${setupMode ? "設定並解鎖" : "解鎖"}</button>
        </div>
      </form>
    </section>
    <p class="parent-lock-note">解鎖後才能看到家長功能</p>`;
}

// ---------- 已解鎖（規格 5.5：手機單欄，≥1100px 左 3 右 2 兩欄） ----------
function unlockedBody(state, profile, holdings) {
  return html`<div class="parent-grid grid-2">
      <div class="grid-2-col">
        ${inboxCard(state)}
        ${quickActionsCard()}
        ${savingsRateCard(state)}
        ${profileCard(state, profile)}
        ${projectsCard(state)}
      </div>
      <div class="grid-2-col">
        ${investmentEntryCard(holdings)}
        ${dataPanelMarkup(state, true)}
        ${guideMarkup()}
      </div>
    </div>`;
}

function inboxCard(state) {
  const waitingProjects = state.projects.filter((item) => item.status === "waiting");
  const pendingSavingsTransfers = state.savingsTransfers.filter((item) => item.status === "pending");
  const hasInboxItems = waitingProjects.length > 0 || pendingSavingsTransfers.length > 0;
  return html`<section class="card parent-inbox parent-card-inbox">
      <h2 class="card-title">待辦</h2>
      <p class="card-sub">今天要處理的事</p>
      ${hasInboxItems ? html`<div class="inbox-list">${pendingSavingsTransfers.map((transfer) => {
          const kid = state.profiles.find((item) => item.id === transfer.profileId);
          return html`<div class="inbox-item">
            <div><b>${kid?.name ?? "小朋友"}想多存 ${money(transfer.amount)}</b><small>${transfer.note} · 批准後才會從撲滿轉入爸媽銀行</small></div>
            <div class="btn-row">
              <button type="button" class="btn btn-primary" data-action="approve-transfer" data-id="${transfer.id}" data-busy-label="處理中…">確認存入</button>
              <button type="button" class="btn btn-secondary" data-action="reject-transfer" data-id="${transfer.id}" data-busy-label="處理中…">不執行</button>
            </div>
          </div>`;
        })}${waitingProjects.map((project) => {
          const kid = state.profiles.find((item) => item.id === project.assignedProfileId);
          return html`<div class="inbox-item">
            <div><b>${kid?.name} · ${project.title}</b><small>${money(project.reward)}，確認後依 ${state.savingsRate}% / ${100 - state.savingsRate}% 分配</small></div>
            <div class="btn-row">
              <button type="button" class="btn btn-primary" data-action="approve-project" data-id="${project.id}" data-busy-label="發放中…">確認完成</button>
            </div>
          </div>`;
        })}</div>` : html`<p class="empty">這個月都核對過了 ✓</p>`}
    </section>`;
}

function quickActionsCard() {
  return html`<section class="card parent-card-quick">
      <h2 class="card-title">快速動作</h2>
      <div class="btn-row parent-quick-row">
        <a class="btn btn-secondary" href="#/parent/investments?open=purchase"><span aria-hidden="true">🌱</span>記買入</a>
        <a class="btn btn-secondary" href="#/parent/investments?open=harvest"><span aria-hidden="true">🧧</span>記收成</a>
        <button type="button" class="btn btn-secondary" data-action="open-correction"><span aria-hidden="true">🐷</span>校正撲滿</button>
      </div>
    </section>`;
}

function savingsRateCard(state) {
  return html`<section class="card parent-card-rate">
      <form data-form="savings-rate">
        <span class="kicker">全家共用設定</span>
        <h2 class="card-title">預先儲蓄比例</h2>
        <div class="stepper" aria-label="調整預先儲蓄比例">
          <button type="button" class="stepper-btn" aria-label="減少 5%" data-action="savings-down" ${ui.savingsRate <= 0 ? raw("disabled") : ""}>−</button>
          <output aria-live="polite">${ui.savingsRate}%</output>
          <button type="button" class="stepper-btn" aria-label="增加 5%" data-action="savings-up" ${ui.savingsRate >= 100 ? raw("disabled") : ""}>＋</button>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary btn-block savings-rate-save" data-busy-label="儲存中…" ${ui.savingsRate === state.savingsRate ? raw("disabled") : ""}>${ui.savingsRate === state.savingsRate ? "已儲存" : "儲存"}</button>
        </div>
      </form>
    </section>`;
}

function profileCard(state, profile) {
  return html`<section class="card parent-card-kids" id="profile-editor">
      <h2 class="card-title">孩子資料</h2>
      ${profileEditorMarkup(state, profile)}
    </section>`;
}

function investmentEntryCard(holdings) {
  const latestHolding = holdings.find((item) => item.priceUpdatedAt) ?? holdings[0] ?? null;
  const investmentUpdatedAt = latestHolding ? (latestHolding.priceUpdatedAt ?? latestHolding.updatedAt) : "";
  return html`<section class="card parent-card-invest">
      <h2 class="card-title"><span aria-hidden="true">📈</span> 投資</h2>
      <p class="card-sub">${holdings.length ? `${holdings.length} 檔持股 · 上次更新${investmentUpdatedAt ? formatDate(investmentUpdatedAt) : "尚未更新"}` : "尚未記錄任何持股"}</p>
      <div class="form-actions">
        <a class="btn btn-secondary btn-block" href="#/parent/investments">前往投資管理 →</a>
      </div>
    </section>`;
}

function projectStatusText(status) {
  return status === "open" ? "尚未接下" : status === "claimed" ? "進行中" : status === "waiting" ? "等待確認" : "已完成";
}

function projectsCard(state) {
  return html`<section class="card parent-project-panel parent-card-projects" id="projects">
      <div class="card-head">
        <div><span class="kicker">家庭小專案</span><h2 class="card-title">專案與確認</h2></div>
        ${raw(common.infoTip("只替額外、完整且事前約定的任務設定報酬；日常責任不標價。", { align: "right" }))}
      </div>
      <form class="parent-project-form" id="project-editor" data-form="project">
        <h3 class="parent-subtitle">${ui.projectId ? "編輯尚未被接下的專案" : "新增一個小專案"}</h3>
        ${common.field({
          label: "專案名稱",
          input: html`<input class="input" data-draft="project-title" value="${draft("project-title")}" placeholder="例如：整理一箱舊玩具" required minlength="2" maxlength="40" />`,
        })}
        ${common.field({
          label: "完成條件",
          input: html`<textarea class="textarea" data-draft="project-description" placeholder="清楚寫出範圍與成果" required minlength="4" maxlength="180">${draft("project-description")}</textarea>`,
        })}
        ${common.field({
          label: "完成報酬",
          input: html`<input class="input" type="number" inputmode="numeric" min="10" max="500" step="10" data-draft="project-reward" value="${draft("project-reward", ui.projectId ? "" : "50")}" required />`,
        })}
        <div class="form-actions">
          <button class="btn btn-primary btn-block" data-busy-label="儲存中…">${ui.projectId ? "儲存修改" : "發布小專案"}</button>
          ${ui.projectId ? html`<button class="btn btn-ghost btn-block" type="button" data-action="cancel-project-edit">取消編輯</button>` : ""}
        </div>
      </form>
      <div class="parent-project-list">
        <h3 class="parent-subtitle">目前專案</h3>
        ${state.projects.length ? state.projects.map((project) => html`<div class="parent-row">
            <div><b>${project.title}</b><small>${projectStatusText(project.status)} · ${money(project.reward)}</small></div>
            ${project.status === "open" ? html`<button type="button" class="btn btn-secondary" data-action="edit-project" data-id="${project.id}">編輯</button>` : ""}
          </div>`) : html`<p class="empty">目前沒有家庭小專案，需要時再新增即可。</p>`}
      </div>
    </section>`;
}

// ---------- 指南（只改契約第 12 節列出的句子） ----------
function guideMarkup() {
  return html`<details class="card parent-guide" data-open-key="guide" ${isOpen("guide") ? raw("open") : ""}>
        <summary>
          <span class="guide-mark" aria-hidden="true">🧭</span>
          <div><small>第一次使用可以從這裡開始</small><b>小小理財島：理念與操作指南</b></div>
          <span class="summary-hint"><i class="summary-closed-label">查看指南</i><i class="summary-open-label">收起指南</i></span>
        </summary>
        <div class="guide-body">
          <section class="guide-block guide-principle">
            <span class="kicker">我們想教的不是「賺最多」</span>
            <h3>錢有限，所以每一次安排，都是在練習自己做選擇。</h3>
            <p>先照顧未來的自己，再安排現在想做的事；記帳與回顧是用來觀察和調整，不是考試，也不因為選錯就處罰。</p>
          </section>

          <section class="guide-block">
            <span class="kicker">五個核心理財觀念</span>
            <div class="guide-grid">
              <article><b>1</b><h4>錢有限</h4><p>選擇一件想要的東西，也代表其他東西需要等待。</p></article>
              <article><b>2</b><h4>先存再花</h4><p>每次收到錢，先依家庭比例留一部分給未來的自己。</p></article>
              <article><b>3</b><h4>錢有不同任務</h4><p>撲滿、爸媽銀行與 ETF 是不同用途；互相搬動不是又賺一筆。</p></article>
              <article><b>4</b><h4>投資會波動</h4><p>資產成長可能來自投入，也可能來自 ETF 漲跌，沒有保證。</p></article>
              <article><b>5</b><h4>回顧再調整</h4><p>每月看看選擇的結果，找到下次想保留或換個做法的地方。</p></article>
            </div>
          </section>

          <section class="guide-block">
            <span class="kicker">第一次設定</span>
            <div class="guide-grid">
              <article><b>1</b><h4>建立家庭</h4><p>設定家長操作碼與孩子名字，並在「資料與備份」開啟雲端備份。</p></article>
              <article><b>2</b><h4>設定孩子資料</h4><p>編輯孩子的名字、照片與撲滿金額，並調整預先儲蓄比例；預設是 30%。</p></article>
              <article><b>3</b><h4>從第一筆錢開始</h4><p>孩子記錄收到的零用錢，系統會依比例分到「留給未來」與「可以自己決定」。</p></article>
              <article><b>4</b><h4>一起核對</h4><p>家長定期確認實體金額、爸媽銀行與真實投資；需要修正時再解鎖家長功能。</p></article>
            </div>
          </section>

          <section class="guide-block">
            <span class="kicker">四個頁面怎麼用</span>
            <div class="guide-grid">
              <article><h4>孩子首頁</h4><p>記錄收到的錢與花費，查看撲滿、爸媽銀行、ETF 小森林和最近紀錄。</p></article>
              <article><h4>夢想與回顧</h4><p>先看看每月存錢、資產與支出，再保留一個短期夢想和一個長期夢想。</p></article>
              <article><h4>所有紀錄</h4><p>依名稱、日期或類型搜尋。家長解鎖後可以編輯或撤銷可調整的紀錄。</p></article>
              <article><h4>家長區</h4><p>管理比例、照片、撲滿、家庭小專案、真實投資與資料備份。</p></article>
            </div>
          </section>

          <section class="guide-block">
            <span class="kicker">三個帳戶的意思</span>
            <div class="guide-accounts">
              <article><span aria-hidden="true">🐷</span><div><b>撲滿</b><p>孩子可以自己決定的錢，也是短期夢想的進度來源。</p></div></article>
              <article><span aria-hidden="true">🏦</span><div><b>爸媽銀行</b><p>先存下的錢、自主多存與每月自動加入的爸媽存錢獎勵，準備留給較久以後。</p></div></article>
              <article><span aria-hidden="true">🌳</span><div><b>ETF 小森林</b><p>爸媽實際買入後再記錄，市值會隨家長更新的真實金額變化。</p></div></article>
            </div>
            <p class="guide-note">總資產＝撲滿＋爸媽銀行＋ETF 小森林；帳戶之間搬錢不代表又賺到一筆錢。</p>
          </section>

          <section class="guide-block">
            <span class="kicker">建議的家庭節奏</span>
            <ul class="guide-list"><li>收到或花錢時：當下簡單記一筆。</li><li>每週：花 5 分鐘一起核對帳本。</li><li>每月：完成一次回顧，聊聊最滿意的選擇。</li><li>每年過年：可以選擇不提領，或最多收成投資的 5%。</li></ul>
          </section>

          <section class="guide-block">
            <span class="kicker">資料與救援</span>
            <ul class="guide-list"><li>每次異動會自動存在這台裝置並保留快照。</li><li>家長可下載備份檔，或開啟 GitHub 雲端備份。</li><li>換手機時用備份檔或雲端備份拿回來。</li><li>實體「好棒印章」不換現金，繼續保留生活鼓勵的味道。</li></ul>
          </section>
        </div>
      </details>`;
}

// ---------- 孩子資料編輯（規格 5.5：外層改成一張 .card，切換列改用共用的 profileChips） ----------
function profileEditorMarkup(state, profile) {
  const canAddProfile = state.profiles.length < 5;
  const removable = state.profiles.length > 1
    && !state.activities.some((item) => item.profileId === profile.id)
    && !state.holdings.some((item) => item.profileId === profile.id)
    && !state.dreamJars.some((item) => item.profileId === profile.id);
  return html`${raw(common.profileChips(state.profiles, profile.id))}
        ${canAddProfile ? html`<div class="form-actions">
            <button class="btn btn-ghost" type="button" data-action="toggle-add-profile" aria-expanded="${ui.addProfileOpen ? "true" : "false"}">${ui.addProfileOpen ? "再按一次收起" : "＋ 新增小朋友（最多 5 位，只要填名字）"}</button>
          </div>` : ""}
        <div class="profile-editor-forms">
          <form class="profile-identity-form" data-form="profile-identity">
            <h3 class="parent-subtitle">編輯${profile.name}</h3>
            <div class="profile-photo-row">
              <span class="profile-photo-preview">${raw(common.profileAvatar(ui.profilePreview || profile.avatar, draft("profile-name", profile.name) || profile.name))}</span>
              <div class="profile-photo-fields">
                ${common.field({
                  label: "顯示名字",
                  input: html`<input class="input" data-draft="profile-name" value="${draft("profile-name", profile.name)}" minlength="1" maxlength="12" required />`,
                })}
                ${common.field({
                  label: "選擇照片",
                  input: html`<input class="input file-input" type="file" accept="image/jpeg,image/png,image/webp" data-input="profile-photo" />`,
                })}
              </div>
            </div>
            <div class="form-actions">
              <button class="btn btn-primary" data-busy-label="儲存中…">儲存照片與名字</button>
              ${removable ? html`<button class="btn btn-danger" type="button" data-action="remove-profile" data-busy-label="移除中…">移除這位小朋友</button>` : ""}
            </div>
          </form>
          <form class="profile-piggy-form" data-form="piggy">
            <h3 class="parent-subtitle">校正撲滿金額</h3>
            ${piggyCorrectionFields(profile)}
            <div class="form-actions">
              <button class="btn btn-primary" data-busy-label="儲存中…">儲存撲滿金額</button>
            </div>
          </form>
          ${ui.addProfileOpen && canAddProfile ? html`<form class="profile-add-form" data-form="add-profile">
            ${common.field({
              label: "新的小朋友名字",
              input: html`<input class="input" data-draft="new-profile-name" value="${draft("new-profile-name")}" minlength="1" maxlength="12" placeholder="例如：小寶" required />`,
            })}
            <div class="form-actions">
              <button class="btn btn-primary" data-busy-label="新增中…">新增小朋友</button>
              <button class="btn btn-ghost" type="button" data-action="cancel-add-profile">取消</button>
            </div>
          </form>` : ""}
        </div>`;
}

// ---------- 資料與備份（取代 DeviceTrustPanel） ----------
function dataPanelMarkup(state, unlocked) {
  const healthy = state.backupHealth?.status !== "failed";
  return html`<section class="card parent-device-panel" id="devices">
      <div class="card-head">
        <div><span class="kicker">裝置與資料</span><h2 class="card-title">資料與備份</h2></div>
        <span class="${healthy ? "backup-status" : "backup-status is-failed"}"><i aria-hidden="true"></i>${common.backupStatusText(state)}</span>
      </div>
      <details class="subpanel" data-open-key="backup-file" ${isOpen("backup-file") ? raw("open") : ""}>
        <summary>下載或上傳資料副本</summary>
        <div class="subpanel-body">
          <p>平時可下載帳本；換手機或搬到別的地方時，請下載包含孩子照片的完整可攜備份。兩種備份都不含家長操作碼。</p>
          <div class="backup-download-actions">
            <button type="button" class="btn btn-secondary" data-action="download-backup" data-kind="account" data-busy-label="準備中…" ${!unlocked ? raw("disabled") : ""}>下載帳本備份</button>
            <button type="button" class="btn btn-secondary" data-action="download-backup" data-kind="portable" data-busy-label="準備中…" ${!unlocked ? raw("disabled") : ""}>下載完整可攜備份</button>
          </div>
          <label class="backup-file-label">選擇備份檔<input class="input file-input" type="file" accept="application/json,.json" data-input="backup-file" ${!unlocked ? raw("disabled") : ""} /></label>
          ${ui.restoreSummary ? restoreSummaryMarkup(ui.restoreSummary, unlocked) : ""}
        </div>
      </details>
      <details class="subpanel" data-open-key="snapshots" ${isOpen("snapshots") ? raw("open") : ""}>
        <summary>本機快照</summary>
        <div class="subpanel-body">
          <p>每次記帳或修改，app 都會自動另外存一份完整快照，保留最近 20 份與每天最後一份（60 天）。誤刪、誤扣、資料出問題都可以從這裡救回來。</p>
          <div class="device-list" data-snapshot-list>${snapshotListMarkup(unlocked)}</div>
        </div>
      </details>
      <details class="subpanel" data-open-key="gist" ${isOpen("gist") ? raw("open") : ""}>
        <summary>GitHub 雲端備份</summary>
        <div class="subpanel-body" data-gist-root>${raw(gist.renderGistPanel())}</div>
      </details>
    </section>`;
}

function restoreSummaryMarkup(summary, unlocked) {
  return html`<div class="restore-summary"><b>${summary.family.name} · ${formatDateTime(summary.exportedAt)}</b><small>${summary.portable ? `完整可攜備份${summary.photoCount ? `，包含 ${summary.photoCount} 張照片` : ""}` : "帳本備份"}</small><small>${summary.counts.profiles} 位孩子、${summary.counts.activities} 筆紀錄、${summary.counts.dreams} 個夢想、${summary.counts.holdings} 個投資標的</small><button type="button" class="btn btn-primary restore-button" data-action="restore-backup" data-busy-label="還原中…" ${!unlocked ? raw("disabled") : ""}>確認覆蓋並還原</button><small>確認後會先自動保存目前帳本，再以備份內容取代。</small></div>`;
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
  return html`${shown.map((record) => html`<div class="parent-row">
      <div><b>${formatDateTime(record.ts)}</b><small>${snapshotSubtitle(record)}</small></div>
      <button type="button" class="btn btn-secondary" data-action="restore-snapshot" data-ts="${record.ts}" data-busy-label="還原中…" ${!unlocked ? raw("disabled") : ""}>還原</button>
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

// ---------- 校正撲滿 modal（規格 1.2／3.2 的存活模式：module-scope 旗標＋mount() 重開檢查） ----------
function setDialogError(form, message) {
  let node = form.querySelector(".form-error");
  if (!message) { if (node) node.remove(); return; }
  if (!node) {
    node = document.createElement("p");
    node.className = "form-error";
    node.setAttribute("role", "alert");
    form.appendChild(node);
  }
  node.textContent = message;
}

async function submitCorrectionModal(ctx, form) {
  const button = submitButtonOf(form);
  const idleLabel = button ? button.textContent : "";
  if (button) { button.disabled = true; if (button.dataset.busyLabel) button.textContent = button.dataset.busyLabel; }
  setDialogError(form, "");
  try {
    await store.setPiggyBankBalance({
      profileId: ctx.profile.id,
      balance: Number(fieldValue(form, "piggy-balance")),
      note: fieldValue(form, "piggy-note"),
      parentPin: ui.parentPin,
    });
    clearDrafts("piggy-note");
    ui.correctionOpen = false;
    // 只呼叫 ctx.refresh()：它觸發的 render() 裡的 closeModal() 已經會收掉這個 modal（規格 1.2 明文規定）。
    const saved = common.savedStatus(store.getState(), "撲滿金額已經校正");
    common.showStatus(saved.message, saved.tone);
    ctx.refresh();
  } catch (caught) {
    const message = errorMessage(caught, "撲滿金額校正失敗");
    setDialogError(form, message);
    common.showStatus(message, "error");
    if (button && button.isConnected) { button.disabled = false; button.textContent = idleLabel; }
  }
}

function openCorrectionModal(ctx) {
  const dialog = common.openModal(piggyCorrectionModalBody(ctx.profile), {
    labelledBy: "piggy-correction-title",
    // 只清 correctionModalKind：會不會「重開」只交給 correctionOpen，而 correctionOpen 只在使用者
    // 明確送出成功或按下「取消」時才會變 false。這裡刻意不在 onClose 裡把它一併設回 false——
    // app.js 的 render() 每次重繪都會無條件呼叫一次 closeModal()（跟使用者按 Esc／點背景是同一個函式，
    // 無法從這裡分辨誰觸發的），若在這裡也把 correctionOpen 設回 false，
    // 下面 mount() 的重開檢查就永遠等不到「該開」的訊號，背景重繪會直接把使用者輸入到一半的內容關掉，
    // 正是規格 1.2／3.2 要修的那個洞。
    onClose: (reason) => {
      if (ui.correctionModalKind !== "correction") return;
      ui.correctionModalKind = "";
      // 裁判 9/11：使用者按 ×／背景／Esc 也要清「該開」旗標，否則下次重繪會自己彈回來；
      // 只有背景重繪（reason === "rerender"）才保留，讓 mount() 補開並回填。
      if (reason !== "rerender") ui.correctionOpen = false;
    },
  });
  if (!dialog) return;
  ui.correctionModalKind = "correction";
  dialog.addEventListener("input", (event) => {
    const field = event.target;
    if (!(field instanceof HTMLElement) || !field.dataset.draft) return;
    ui.drafts[field.dataset.draft] = field.value;
  });
  const cancelButton = dialog.querySelector('[data-action="cancel-correction"]');
  if (cancelButton) {
    cancelButton.addEventListener("click", () => {
      ui.correctionOpen = false;
      common.closeModal();
    });
  }
  const form = dialog.querySelector("form");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitCorrectionModal(ctxRef, form);
    });
    const input = form.querySelector('[data-draft="piggy-balance"]');
    if (input) input.focus();
  }
}

// ---------- 變更操作碼 modal（存活機制照 common.createLockModal：reason === "rerender" 不清「該開」旗標） ----------
async function submitPinChangeModal(ctx, form) {
  const button = submitButtonOf(form);
  const idleLabel = button ? button.textContent : "";
  const currentPin = form.querySelector('[data-field="current-pin"]').value;
  const newPin = form.querySelector('[data-field="new-pin"]').value;
  const confirmNewPin = form.querySelector('[data-field="confirm-new-pin"]').value;
  setDialogError(form, "");
  if (newPin !== confirmNewPin) {
    setDialogError(form, "兩次輸入的新操作碼不一致");
    common.showStatus("兩次輸入的新操作碼不一致", "error");
    return;
  }
  if (button) { button.disabled = true; if (button.dataset.busyLabel) button.textContent = button.dataset.busyLabel; }
  try {
    await pin.change(currentPin, newPin);
    ui.parentPin = newPin;
    ui.pinChangeOpen = false;
    ui.pinChangeDrafts = { "current-pin": "", "new-pin": "", "confirm-new-pin": "" };
    // 只呼叫 ctx.refresh()：它觸發的 render() 裡的 closeModal() 會收掉這個 modal（規格 4.3）。
    common.showStatus("家長操作碼已更新；下次請使用新操作碼解鎖", "success");
    ui.notice = "家長操作碼已更新；下次請使用新操作碼解鎖";
    ctx.refresh();
  } catch (caught) {
    const message = errorMessage(caught, "無法變更操作碼");
    setDialogError(form, message);
    common.showStatus(message, "error");
    if (button && button.isConnected) { button.disabled = false; button.textContent = idleLabel; }
  }
}

function openPinChangeModal(ctx) {
  const dialog = common.openModal(pinChangeModalBody(), {
    labelledBy: "pin-change-title",
    onClose: (reason) => {
      if (ui.pinChangeModalKind !== "pin-change") return;
      ui.pinChangeModalKind = "";
      // 背景重繪不算使用者關閉：留著「該開」旗標，mount() 會補開並回填欄位。
      if (reason !== "rerender") ui.pinChangeOpen = false;
    },
  });
  if (!dialog) return;
  ui.pinChangeModalKind = "pin-change";
  dialog.addEventListener("input", (event) => {
    const field = event.target;
    if (!(field instanceof HTMLElement) || !field.dataset.field) return;
    if (field.dataset.digits !== undefined) field.value = field.value.replace(/\D/g, "");
    ui.pinChangeDrafts[field.dataset.field] = field.value;
  });
  const form = dialog.querySelector("form");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitPinChangeModal(ctxRef, form);
    });
    const input = form.querySelector('[data-field="current-pin"]');
    if (input) input.focus();
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
function syncSavingsRate(root, ctx) {
  const panel = root.querySelector('[data-form="savings-rate"]');
  if (!panel) return;
  const output = panel.querySelector("output");
  if (output) output.textContent = `${ui.savingsRate}%`;
  const down = panel.querySelector('[data-action="savings-down"]');
  const up = panel.querySelector('[data-action="savings-up"]');
  if (down) down.disabled = ui.savingsRate <= 0;
  if (up) up.disabled = ui.savingsRate >= 100;
  const save = panel.querySelector(".savings-rate-save");
  if (save) {
    const same = ui.savingsRate === ctx.state.savingsRate;
    save.disabled = same;
    save.textContent = same ? "已儲存" : "儲存";
  }
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

export function mount(root, ctx) {
  ctxRef = ctx;
  if (!ctx.state || !ctx.profile) return;

  paintOperationError(root);

  const gistRoot = root.querySelector("[data-gist-root]");
  if (gistRoot) gist.mountGistPanel(gistRoot);

  if (isOpen("snapshots") && ui.snapshots === null) void loadSnapshots(root, ctx);

  // 重繪之後把原本開著的校正撲滿 modal 補回來（規格 1.2／3.2）。
  if (ui.correctionOpen && ui.correctionModalKind !== "correction") openCorrectionModal(ctx);
  // 變更操作碼 modal 同一套存活機制（規格 4.3）。
  if (ctx.pinStatus === "unlocked" && ui.pinChangeOpen && ui.pinChangeModalKind !== "pin-change") openPinChangeModal(ctx);

  if (boundRoots.has(root)) return;
  boundRoots.add(root);

  // details 開闔狀態（toggle 不冒泡，用捕捉階段接）
  root.addEventListener("toggle", (event) => {
    const element = event.target;
    if (!(element instanceof HTMLElement) || element.tagName !== "DETAILS" || !element.dataset.openKey) return;
    const key = element.dataset.openKey;
    if (element.open) ui.openDetails.add(key); else ui.openDetails.delete(key);
    if (key === "snapshots" && element.open && ui.snapshots === null) void loadSnapshots(root, ctxRef);
    if (key === "guide") ui.guideTouched = true;
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
    recordDraft(field);
  });

  root.addEventListener("change", async (event) => {
    const field = event.target;
    if (!(field instanceof HTMLElement)) return;
    recordDraft(field);
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

  // 變更操作碼的表單已經搬進 modal（規格 5.5），由 submitPinChangeModal() 直接接手，
  // 不再走 #app 的 submit 委派。

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
  }
}

function resetProjectForm() {
  ui.projectId = "";
  ui.openDetails.delete("project-editor");
  clearDrafts("project-title", "project-description", "project-reward");
}

// ---------- 按鈕 ----------
async function handleClick(root, ctx, button) {
  const state = ctx.state;
  const profile = ctx.profile;
  const action = button.dataset.action;
  const id = button.dataset.id;

  switch (action) {
    case "toggle-pin-change": {
      ui.pinError = "";
      ui.pinChangeOpen = true;
      if (ui.pinChangeModalKind !== "pin-change") openPinChangeModal(ctx);
      return;
    }
    case "savings-up":
    case "savings-down": {
      ui.savingsRate = action === "savings-up" ? Math.min(100, ui.savingsRate + 5) : Math.max(0, ui.savingsRate - 5);
      syncSavingsRate(root, ctx);
      return;
    }
    // 孩子切換改用共用的 profileChips（data-choose-profile，委派在 app.js），
    // 孩子資料卡不再是收合面板，所以 open-profile-editor 這個動作在 v2 沒有對應的按鈕了。
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
      const ok = await runParentAction(root, ctx, { button, scope: "inbox" }, () => store.updateSavingsTransfer({
        action: transferAction,
        transferId: id,
        operationId: uuid(),
        parentPin: ui.parentPin,
      }));
      if (ok) announce(root, transferAction === "approve" ? "已確認存入爸媽銀行" : "這次自主多存沒有執行");
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
      ui.openDetails.add("project-editor");
      ui.drafts["project-title"] = project.title;
      ui.drafts["project-description"] = project.description;
      ui.drafts["project-reward"] = String(project.reward);
      ctx.refresh();
      window.setTimeout(() => document.getElementById("project-editor")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
      return;
    }
    case "approve-project": {
      await runParentAction(root, ctx, { button, scope: "inbox" }, () => store.updateFamilyProject({
        action: "approve",
        projectId: id,
        profileId: profile.id,
        parentPin: ui.parentPin,
      }));
      return;
    }
    case "open-correction": {
      ui.correctionOpen = true;
      openCorrectionModal(ctx);
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
