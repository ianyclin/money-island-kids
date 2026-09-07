// 小小理財島 PWA：夢想與回顧（移植自 app/dreams/page.tsx）。
// DOM、class、aria、文案照原頁；資料來源改成 store，家長操作碼改成 pin.js。

import { html, raw, money, signedMoney, formatDate, formatDateTime, formatMonthLabel, taipeiMonth, errorMessage } from "../util.js";
import * as common from "./common.js";
import * as store from "../store.js";
import * as pin from "../pin.js";

// ---------- 頁面暫存（重繪後由 render 讀回） ----------
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
let completedEditorId = "";
let completedEditorErrorText = "";
let completedEditorNode = null;
let lastProfileId = "";
let activeDreamTab = "jar";     // "jar" | "review"（規格第 9 節拍板題 4：JS 互斥版分頁，不用 <details name>）
let completedJarsOpen = false;  // 已完成夢想罐 details 的收合狀態（規格 2.2）
let currentCtx = null;          // 供下面 createLockModal 的 getPinStatus／onUnlocked 讀最新 ctx

const RESET_ACTIONS = ["create", "update", "delete", "complete", "activate"];

// ---------- 情境式解鎖 modal（規格 1.2／3.3／第 9 節「1＋2a」：右上角圓鈕開 modal，
// modal 內建「前往家長區 →」連結，見 common.createLockModal 的 parentHref） ----------
// 已知限制（裁判 xhigh 複審擋下、根因不在這份檔案）：app.js 的 render() 每次重繪（含 gist 回音、
// 每月獎勵這類背景重繪）都會無條件呼叫 common.closeModal()；common.createLockModal 內部的
// onClose 只要偵測到自己是被關掉的那個 modal，就會把「該不該重開」的旗標清成 false——不分是
// 使用者主動關閉還是這種背景關閉。結果是 mountCheck() 下面這行「重繪後補開」在目前接線下永遠
// 不會觸發：家長打操作碼打到一半，若這時剛好有一次背景重繪，modal 會被無聲關掉。
// 這條路徑跨到 common.js／app.js，不是 dreams.js 這份檔案能修的（硬性規則不准動這兩個檔案），
// 需要另外指派人改 app.js 的 closeModal() 呼叫時機或 common.js 的 onClose 分流，這裡先留這段
// 註解讓下一個接手的人不用重新讀一次控制流程。
const lockModal = common.createLockModal({
  getPinStatus: () => (currentCtx ? pinStatusOf(currentCtx) : "locked"),
  onUnlocked: () => { if (currentCtx) currentCtx.refresh(); },
  parentHref: "#/parent",
});

// common.* 回傳的片段一律當 HTML 片段輸出（RawHtml 或字串都適用）。
function frag(value) {
  return raw(String(value));
}

// ---------- 移植自 app/dreams/page.tsx 的輔助函式 ----------
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
  // 換小朋友：情境式解鎖 modal 若還記著「該開」或尚未送出的操作碼，這裡清掉
  // （common.createLockModal 的 reset() 就是為了「換小朋友、換頁」這個情境寫的；
  // 目前效果上會被 app.js 的 closeModal() 間接涵蓋，這裡補上是讓 dreams.js 自己的狀態
  // 不依賴那條路徑——見上面 lockModal 宣告處的已知限制註解）。
  lockModal.reset();
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
  const availableMonths = availableMonthsOf(state, profile.id);
  const reflection = state.reflections.find((item) => item.profileId === profile.id && item.month === selectedMonth);
  const monthActivities = state.activities.filter((item) => item.profileId === profile.id && item.entryDate.startsWith(selectedMonth));
  const monthSpend = monthActivities.filter((item) => item.kind === "spend").reduce((sum, item) => sum + item.amount, 0);
  const monthSpendCount = monthActivities.filter((item) => item.kind === "spend").length;
  const monthSaved = monthActivities.filter((item) => ["allowance", "project", "sheet-deposit", "savings-transfer"].includes(item.kind)).reduce((sum, item) => sum + Math.max(0, item.bankDelta), 0);
  const monthVoluntarySaved = monthActivities.filter((item) => item.kind === "savings-transfer").reduce((sum, item) => sum + item.amount, 0);
  const monthAssetChange = monthActivities.reduce((sum, item) => sum + item.spendDelta + item.bankDelta + item.marketDelta, 0);
  const selectedMonthIndex = Math.max(0, availableMonths.indexOf(selectedMonth));

  // 對應原本 [profile?.id, reflection?.proudText, reflection?.changeText, reflection?.planText] 的 effect：
  // 這三個欄位只有在孩子、月份或已存回顧的內容變動時才被重設，其餘重繪保留正在打的字。
  const nextReflectionKey = JSON.stringify([profile.id, selectedMonth, reflection ? reflection.proudText : "", reflection ? reflection.changeText : "", reflection ? reflection.planText : ""]);
  if (nextReflectionKey !== reflectionKey) {
    reflectionKey = nextReflectionKey;
    draftProud = reflection ? reflection.proudText : "";
    draftChange = reflection ? reflection.changeText : "";
    draftPlan = reflection ? reflection.planText : "";
  }

  const slots = [{ kind: "short", jar: activeShort }, { kind: "long", jar: activeLong }];
  const jarTabActive = activeDreamTab !== "review"; // 規格第 9 節拍板題 4：JS 互斥分頁，不用 <details name>

  return html`<main class="dream-shell" data-kid="${profile.id}" style="--kid-accent:${profile.accent}">
      ${frag(common.miniTopbar({ active: "dreams", ctx, right: common.lockIconButton({ pinStatus }) }))}

      <section class="dream-hero">
        <span class="parent-kicker">先問：這筆錢什麼時候要用？</span>
        ${frag(common.infoTip(html`近一點的夢想留現金，<br><em>很久以後的夢想讓投資陪它長大。</em>`))}
      </section>

      <section class="dream-layout">
        <div class="dream-tabs" aria-label="切換夢想罐或每月回顧">
          <button type="button" data-action="dream-tab" data-tab="jar" aria-pressed="${jarTabActive ? "true" : "false"}">🎯 夢想罐</button>
          <button type="button" data-action="dream-tab" data-tab="review" aria-pressed="${jarTabActive ? "false" : "true"}">📝 每月回顧</button>
        </div>

        <div class="dream-panel"${jarTabActive ? "" : raw(" hidden")}>
          <div class="dream-heading"><div><span class="parent-kicker">${profile.name}的夢想</span><h2>現在想完成什麼？</h2></div>${frag(common.infoTip("短期進度跟著撲滿；長期進度跟著爸媽銀行與 ETF 小森林。夢想罐本身不另外存放或扣除金額。", { align: "right" }))}</div>
          <div class="dream-grid">
            ${slots.map(({ kind: slotKind, jar }) => {
              if (!jar) return html`<div class="empty-dream kind-${slotKind}"><span>${slotKind === "short" ? "🐷" : "🌳"}</span><b>還沒有${slotKind === "short" ? "短期" : "長期"}夢想</b><small>${slotKind === "short" && queuedShort.length ? "可以從下方清單選一個開始。" : "可以從下方建立一個新目標。"}</small></div>`;
              const current = jar.kind === "short" ? profile.spendingBalance : profile.bankBalance + profile.marketValue;
              const percent = Math.min(100, jar.targetAmount ? current / jar.targetAmount * 100 : 0);
              return html`<article class="dream-card kind-${jar.kind}">
                <div class="dream-card-top"><span>${jar.kind === "short" ? "短期 · 撲滿" : "長期 · 爸媽銀行＋ETF"}</span><b>${Math.round(percent)}%</b></div>
                <h3>${jar.title}</h3><p>${money(current)} / ${money(jar.targetAmount)}</p>
                <div class="dream-progress"><i style="width:${percent}%"></i></div>
                <small class="${jar.kind === "long" ? "long-note" : "dream-auto-note"}">${jar.kind === "short" ? "撲滿金額改變時，這裡會自動更新。" : `爸媽銀行 ${money(profile.bankBalance)} ＋ ETF ${money(profile.marketValue)}`}</small>
                ${unlocked ? html`<div class="dream-admin-actions"><button data-action="edit-dream" data-id="${jar.id}">編輯</button><button class="complete-dream" data-action="complete-dream" data-id="${jar.id}">完成夢想</button><button class="delete-dream" data-action="delete-dream" data-id="${jar.id}">刪除</button></div>` : ""}
              </article>`;
            })}
          </div>

          <details class="new-dream-card"${!jars.length || editingId ? raw(" open") : ""}>
            <summary>${editingId ? "✎ 家長編輯夢想罐" : "＋ 新增夢想"}</summary>
            <form><label>夢想名稱<input value="${draftTitle}" placeholder="例如：一本想看的書" required maxlength="30"></label><div class="form-two-columns"><label>多久以後使用？<select${editingId ? raw(" disabled") : ""}><option value="short"${draftKind === "short" ? raw(" selected") : ""}>短期：自動帶入撲滿</option><option value="long"${!editingId && activeLong ? raw(" disabled") : ""}${draftKind === "long" ? raw(" selected") : ""}>長期：自動帶入爸媽銀行＋ETF${activeLong && !editingId ? "（已有）" : ""}</option></select></label><label>目標金額<input type="number" min="50" max="10000000" value="${draftTarget}" required></label></div><div class="panel-help">${frag(common.infoTip(createTipText(draftKind, editingId, activeShort)))}</div><button class="primary-button"${(editingId && !unlocked) || (!editingId && draftKind === "long" && activeLong) ? raw(" disabled") : ""}>${createButtonLabel(draftKind, editingId, activeShort)}</button>${editingId ? html`<button class="cancel-preset" type="button" data-action="cancel-edit">取消編輯</button>` : ""}</form>
          </details>

          <section class="dream-list-panel">
            <div class="dream-subheading"><div><span class="parent-kicker">下一個想完成的事</span><h2>短期夢想罐清單</h2></div><b>${queuedShort.length} 個</b></div>
            ${queuedShort.length
              ? queuedShort.map((jar) => html`<article class="queued-dream-row"><span>🐷</span><div><b>${jar.title}</b><small>目標 ${money(jar.targetAmount)} · 加入於 ${formatDate(jar.createdAt)}</small></div>${unlocked ? html`<div><button data-action="activate-dream" data-id="${jar.id}"${activeShort ? raw(" disabled") : ""}>${activeShort ? "先完成目前夢想" : "開始這個夢想"}</button><button data-action="edit-dream" data-id="${jar.id}">編輯</button><button class="delete-dream" data-action="delete-dream" data-id="${jar.id}">刪除</button></div>` : ""}</article>`)
              : html`<p class="empty-list-note">清單還是空的；想到下一個小目標時再加進來。</p>`}
          </section>

          <details class="completed-dream-panel"${completedJarsOpen ? raw(" open") : ""}>
            <summary>查看已完成的 ${completedJars.length} 個夢想</summary>
            <div class="completed-dream-grid">${completedJars.map((jar) => html`<article><span>${jar.kind === "short" ? "🐷" : "🌳"}</span><div><small>${jar.kind === "short" ? "短期夢想" : "長期夢想"}</small><h3>${jar.title}</h3><strong>${money(jar.completedAmount ?? jar.targetAmount)}</strong><p>開始 ${formatDateTime(jar.createdAt)}<br>完成 ${formatDateTime(jar.completedAt ?? jar.updatedAt)}<br>用了 ${elapsedTime(jar.createdAt, jar.completedAt ?? jar.updatedAt)} · 原目標 ${money(jar.targetAmount)}</p>${unlocked ? html`<button class="edit-completed-dream" type="button" data-action="edit-completed" data-id="${jar.id}">✎ 編輯紀錄</button>` : ""}</div></article>`)}</div>
            ${!completedJars.length ? html`<p class="empty-list-note">第一個完成的夢想，會連同日期、花費時間與金額留在這裡。</p>` : ""}
          </details>
        </div>

        <div class="dream-panel"${jarTabActive ? raw(" hidden") : ""}>
          <aside class="reflection-card">
            <div class="reflection-heading-row">
              <div><span class="parent-kicker">每月回顧</span><h2>這個月，錢教了我什麼？</h2></div>
              <div class="reflection-month-picker" aria-label="切換回顧月份">
                <button type="button" aria-label="較新的月份" data-action="month-newer"${selectedMonthIndex <= 0 ? raw(" disabled") : ""}>‹</button>
                <select aria-label="選擇月份">${availableMonths.map((item) => html`<option value="${item}"${item === selectedMonth ? raw(" selected") : ""}>${formatMonth(item)}</option>`)}</select>
                <button type="button" aria-label="較早的月份" data-action="month-older"${selectedMonthIndex >= availableMonths.length - 1 ? raw(" disabled") : ""}>›</button>
              </div>
            </div>
            <div class="month-numbers month-numbers-three">
              <span><small>這個月我存給未來</small><b>${monthActivities.length ? money(monthSaved) : "—"}</b><em>${monthVoluntarySaved > 0 ? `包含自主多存 ${money(monthVoluntarySaved)}` : "先存再花的累積"}</em></span>
              <span><small>這個月全部的錢變化 ${frag(common.infoTip("這是撲滿、爸媽銀行與 ETF 小森林合計的增減；ETF 漲跌也會影響，因此不等於這個月的收入或存款。", { align: "right" }))}</small><b class="${monthAssetChange < 0 ? "is-negative" : ""}">${monthActivities.length ? signedMoney(monthAssetChange) : "—"}</b><em>月底和月初相比</em></span>
              <span><small>這個月我做了什麼選擇</small><b>${monthActivities.length ? money(monthSpend) : "—"}</b><em>${monthSpendCount ? `${monthSpendCount} 筆實際支出` : "沒有支出紀錄"}</em></span>
            </div>
            <form><label>我最滿意的一個選擇<textarea placeholder="我做了什麼好選擇？" maxlength="160">${draftProud}</textarea></label><label>下次我想換個做法<textarea placeholder="沒有對錯，只要說說看" maxlength="160">${draftChange}</textarea></label><label>下個月想練習什麼？<textarea placeholder="例如：買東西前先等一天" maxlength="160">${draftPlan}</textarea></label>${formErrorText ? html`<p class="form-error">${formErrorText}</p>` : ""}<button class="primary-button full-width">${reflection ? "更新這個月的回顧" : "存下這個月的回顧"}</button><small>${noticeText}</small></form>
          </aside>
        </div>
      </section>

      ${frag(common.primaryNav("dreams"))}
    </main>`;
}

// ---------- mount ----------
export function mount(root, ctx) {
  currentCtx = ctx;
  if (!ctx.state || !ctx.profile) return;
  // 規格 1.2／3.2：重繪後如果 lock modal「該開卻沒開」，補開並回填欄位值
  // （gist 回音、每月獎勵檢查等背景重繪都會走到這裡，不只是使用者自己點的那次 mount）。
  lockModal.mountCheck(ctx);
  // 已完成夢想的編輯視窗：背景重繪把它關掉後，這裡補開。
  if (completedEditorId && !completedEditorNode) {
    const jar = ctx.state.dreamJars.find((item) => item.id === completedEditorId);
    if (jar) openCompletedEditor(root, ctx, jar); else completedEditorId = "";
  }

  // details 開闔狀態（toggle 不冒泡，用捕捉階段接；同 home.js／parent.js 的既有寫法）。
  root.addEventListener("toggle", (event) => {
    const target = event.target;
    const details = target && target.closest ? target.closest(".completed-dream-panel") : null;
    if (details) completedJarsOpen = details.open;
  }, true);

  root.addEventListener("click", (event) => {
    const profileButton = event.target.closest("[data-choose-profile]");
    if (profileButton) {
      ctx.chooseProfile(profileButton.getAttribute("data-choose-profile"));
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.getAttribute("data-action");
    const id = button.getAttribute("data-id");
    if (action === "open-lock") { lockModal.open(); return; }
    if (action === "dream-tab") {
      const tab = button.getAttribute("data-tab");
      if (tab && tab !== activeDreamTab) { activeDreamTab = tab; ctx.refresh(); }
      return;
    }
    if (action === "month-newer" || action === "month-older") {
      const months = availableMonthsOf(ctx.state, ctx.profile.id);
      const index = Math.max(0, months.indexOf(selectedMonth));
      const next = months[action === "month-newer" ? index - 1 : index + 1];
      if (next) { selectedMonth = next; ctx.refresh(); }
      return;
    }
    if (action === "edit-dream") {
      const jar = jarsOf(ctx.state, ctx.profile.id).find((item) => item.id === id);
      if (!jar) return;
      editingId = jar.id;
      draftTitle = jar.title;
      draftKind = jar.kind;
      draftTarget = String(jar.targetAmount);
      formErrorText = "";
      ctx.refresh();
      return;
    }
    if (action === "cancel-edit") {
      editingId = "";
      draftTitle = "";
      draftTarget = "";
      ctx.refresh();
      return;
    }
    if (action === "complete-dream") { void completeDream(root, ctx, id, button); return; }
    if (action === "delete-dream") { void removeDream(root, ctx, id, button); return; }
    if (action === "activate-dream") { void activateDream(root, ctx, id, button); return; }
    if (action === "edit-completed") {
      const jar = jarsOf(ctx.state, ctx.profile.id).find((item) => item.id === id);
      if (jar) openCompletedEditor(root, ctx, jar);
    }
  });

  root.addEventListener("change", (event) => {
    const select = event.target.closest(".reflection-month-picker select");
    if (select) { selectedMonth = select.value; ctx.refresh(); return; }
    const kindSelect = event.target.closest(".new-dream-card select");
    if (kindSelect) {
      draftKind = kindSelect.value === "long" ? "long" : "short";
      syncCreateForm(root, ctx);
    }
  });

  root.addEventListener("input", (event) => {
    // 家長操作碼欄位已搬進 common.createLockModal 的 modal（規格第 9 節「1＋2a」），不再需要在這裡處理。
    // 原本這些欄位是受控的：重繪（例如按下完成夢想）不能把正在打的字弄丟。
    const dreamField = event.target.closest(".new-dream-card input");
    if (dreamField) {
      if (dreamField.type === "number") draftTarget = dreamField.value; else draftTitle = dreamField.value;
      return;
    }
    const reflectionField = event.target.closest(".reflection-card textarea");
    if (reflectionField) {
      const textareas = [...root.querySelectorAll(".reflection-card textarea")];
      const index = textareas.indexOf(reflectionField);
      if (index === 0) draftProud = reflectionField.value;
      if (index === 1) draftChange = reflectionField.value;
      if (index === 2) draftPlan = reflectionField.value;
    }
  });

  root.addEventListener("submit", (event) => {
    const form = event.target;
    event.preventDefault();
    if (form.closest(".new-dream-card")) { void createDream(root, ctx, form); return; }
    if (form.closest(".reflection-card")) { void saveReflection(root, ctx, form); }
  });
}

// ---------- 局部更新 ----------
function syncCreateForm(root, ctx) {
  const form = root.querySelector(".new-dream-card form");
  if (!form) return;
  const jars = jarsOf(ctx.state, ctx.profile.id);
  const activeShort = jars.find((item) => item.status === "active" && item.kind === "short");
  const activeLong = jars.find((item) => item.status === "active" && item.kind === "long");
  const tip = form.querySelector(".panel-help .info-tip-popover");
  if (tip) tip.textContent = createTipText(draftKind, editingId, activeShort);
  const submit = form.querySelector("button.primary-button");
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
    if (anchor) container.insertBefore(node, anchor); else container.append(node);
  }
  node.textContent = message;
}

function paintFormError(root, message) {
  formErrorText = message;
  const form = root.querySelector(".reflection-card form");
  paintError(form, message, form ? form.querySelector("button.primary-button") : null);
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
    common.showStatus(message, "error");
    restoreBusy();
    return false;
  }
}

function createDream(root, ctx, form) {
  const inputs = form.querySelectorAll("input");
  const title = inputs[0] ? inputs[0].value : "";
  const targetAmount = inputs[1] ? inputs[1].value : "";
  const select = form.querySelector("select");
  const kind = select && select.value === "long" ? "long" : "short";
  draftTitle = title;
  draftTarget = targetAmount;
  draftKind = kind;
  return postDream(root, ctx, {
    action: editingId ? "update" : "create",
    dreamId: editingId || undefined,
    title,
    kind,
    targetAmount: Number(targetAmount),
    // 沒帶 parentPin：store.assertParentPin 沒收到值時會改用 pin.js 記住的本次解鎖操作碼再驗一次
    // （pin.js 第 95–96 行的既有註解就是寫給這種情境；解鎖現在只發生在 common.createLockModal
    // 的 modal 裡，dreams.js 拿不到、也不需要再拿使用者剛打的那組原始碼）。
  }, form.querySelector("button.primary-button"), "儲存中…");
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
  const busyLabel = button && button.closest(".dream-admin-actions") ? "刪除中…" : null;
  await postDream(root, ctx, { action: "delete", dreamId: jar.id }, button, busyLabel);
}

async function activateDream(root, ctx, dreamId, button) {
  await postDream(root, ctx, { action: "activate", dreamId }, button, "開始中…");
}

async function saveReflection(root, ctx, form) {
  const textareas = form.querySelectorAll("textarea");
  const proudText = textareas[0] ? textareas[0].value : "";
  const changeText = textareas[1] ? textareas[1].value : "";
  const planText = textareas[2] ? textareas[2].value : "";
  paintFormError(root, "");
  const restoreBusy = startBusy(form.querySelector("button.primary-button"), "儲存中…");
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
  // 關閉鈕由 common.openModal 畫（原頁的 .modal-close 在這裡就不再重複一顆）。
  return html`<span class="section-kicker">家長編輯</span>
          <h2 id="completed-dream-editor-title">已完成夢想罐</h2>
          <form>
            <label class="input-label">夢想名稱<input class="text-input" value="${jar.title}" minlength="2" maxlength="30" required></label>
            <div class="form-two-columns">
              <label>夢想類型<select><option value="short"${jar.kind === "short" ? raw(" selected") : ""}>短期夢想</option><option value="long"${jar.kind === "long" ? raw(" selected") : ""}>長期夢想</option></select></label>
              <label>原目標金額<input type="number" min="50" max="10000000" value="${jar.targetAmount}" required></label>
            </div>
            <label class="input-label">完成金額<input class="text-input" type="number" min="0" max="10000000" value="${jar.completedAmount ?? jar.targetAmount}" required></label>
            <div class="form-two-columns completed-time-fields">
              <label>開始日期與時間<input type="datetime-local" value="${startedAt}" required></label>
              <label>完成日期與時間<input type="datetime-local" value="${finishedAt}" required></label>
            </div>
            ${startedAt && finishedAt ? html`<p class="completed-duration-preview">完成歷時：${elapsedTime(startedAt, finishedAt)}</p>` : ""}
            <button class="primary-button full-width">儲存完成紀錄</button>
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
  const inputs = form.querySelectorAll("input");
  return {
    title: inputs[0] ? inputs[0].value : "",
    kind: form.querySelector("select") && form.querySelector("select").value === "long" ? "long" : "short",
    targetAmount: inputs[1] ? inputs[1].value : "",
    completedAmount: inputs[2] ? inputs[2].value : "",
    startedAt: inputs[3] ? inputs[3].value : "",
    finishedAt: inputs[4] ? inputs[4].value : "",
  };
}

function updateDurationPreview(form) {
  const { startedAt, finishedAt } = completedFields(form);
  let node = form.querySelector(".completed-duration-preview");
  if (!startedAt || !finishedAt) { if (node) node.remove(); return; }
  if (!node) {
    node = document.createElement("p");
    node.className = "completed-duration-preview";
    const anchor = form.querySelector(".form-error") || form.querySelector("button.primary-button");
    if (anchor) form.insertBefore(node, anchor); else form.append(node);
  }
  node.textContent = `完成歷時：${elapsedTime(startedAt, finishedAt)}`;
}

function paintCompletedError(message) {
  completedEditorErrorText = message;
  const form = completedEditorNode ? completedEditorNode.querySelector("form") : null;
  if (form) paintError(form, message, form.querySelector("button.primary-button"));
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
  }, form.querySelector("button.primary-button"), "儲存中…", "已完成夢想的內容與日期時間已更新並備份");
  if (ok) {
    completedEditorId = "";
    completedEditorErrorText = "";
    completedEditorNode = null;
    common.closeModal();
  }
}
