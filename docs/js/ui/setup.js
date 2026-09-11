// 小小理財島 PWA：第一次使用（取代舊站的家庭入口 app/family-access/page.tsx）。
// 單機版沒有家庭代碼、家庭密碼、離線救援碼、信任裝置與 ChatGPT 登入，文案照這個前提改寫。
//
// v2 重做（notes/redesign-v2/spec.md 5.6）：這一頁不用 appShell，置中一張 .card（max-width 480），
// 內容是品牌、一句話、.segmented「建立新帳本／從備份還原」與表單；
// 欄位、驗證與還原流程（inspect → 摘要 → 確認 → restore）一律沿用。

import { html, raw } from "../util.js";
import { freshState } from "../state.js";
import * as store from "../store.js";
import * as pin from "../pin.js";
import * as backup from "../backup.js";
import { field, infoTip, showStatus, timestampText } from "./common.js";

// 頁面自己的 UI 狀態放模組層級：重繪之後 render 讀回來，使用者不會被踢出流程。
let mode = "create";          // "create" | "restore"
let error = "";
let busy = "";                // ""｜"create"｜"inspect"｜"restore"
let summary = null;           // backup.inspect() 的結果
let parsed = null;            // 選到的備份檔內容

function needsPinSetup() {
  try { return pin.status() === "setup"; } catch (e) { return true; }
}

function pinFields(prefix) {
  return html`${field({
      label: "家長操作碼",
      input: html`<input class="input" type="password" inputmode="numeric" pattern="[0-9]{4,8}" name="${prefix}Pin" placeholder="4–8 位數字" autocomplete="new-password" required>`,
    })}
    ${field({
      label: "再輸入一次",
      input: html`<input class="input" type="password" inputmode="numeric" pattern="[0-9]{4,8}" name="${prefix}PinAgain" placeholder="再打一次同樣的數字" autocomplete="new-password" required>`,
    })}`;
}

export function render() {
  return html`<main class="setup-page">
    <section class="card setup-card">
      <div class="setup-brand">
        <span class="brand-mark" aria-hidden="true">¢</span>
        <div><strong>小小理財島</strong><small>第一次使用</small></div>
      </div>

      <div class="card-head">
        <span class="kicker">這台裝置的帳本</span>
        ${infoTip(html`帳本存在這台裝置裡，不會上傳到任何伺服器。孩子不需要帳號，家長只要記得一組操作碼。建好之後可以在家長區下載備份檔，或開啟 GitHub 雲端備份，換手機時整份拿回來。`, { label: "第一次使用說明", align: "right" })}
      </div>
      <h1 class="setup-title">建立一次，<br><em>這台裝置就會一直記得。</em></h1>
      <p class="setup-copy">零用錢、夢想罐、投資紀錄都存在這支手機或平板上；離線也打得開。記得偶爾在家長區下載一份備份帶出去。</p>

      <div class="segmented" aria-label="第一次使用的兩條路">
        <button type="button" data-mode="create" aria-pressed="${mode === "create" ? "true" : "false"}">建立新帳本</button>
        <button type="button" data-mode="restore" aria-pressed="${mode === "restore" ? "true" : "false"}">從備份還原</button>
      </div>
      ${mode === "create" ? createForm() : restoreForm()}
      ${error ? html`<p class="form-error" role="alert">${error}</p>` : ""}
    </section>
  </main>`;
}

function createForm() {
  return html`<h2 class="setup-subtitle">建立新帳本</h2>
    <p class="setup-copy">填好之後就可以開始記帳。之後在家長區都能改：孩子的名字、照片、預先儲蓄比例、還可以再加或移除小朋友。</p>
    <form data-form="create">
      ${field({ label: "家庭名稱", input: html`<input class="input" name="familyName" placeholder="例如：林家小島" maxlength="30" required>` })}
      <div class="field">
        <span class="field-label">小朋友的名字（至少一位，空白的會略過）</span>
        <div class="setup-kid-grid">
          <label class="sr-only" for="setup-kid-1">小朋友 1</label><input class="input" id="setup-kid-1" name="kid" placeholder="小朋友 1" maxlength="12">
          <label class="sr-only" for="setup-kid-2">小朋友 2</label><input class="input" id="setup-kid-2" name="kid" placeholder="小朋友 2" maxlength="12">
          <label class="sr-only" for="setup-kid-3">小朋友 3</label><input class="input" id="setup-kid-3" name="kid" placeholder="小朋友 3" maxlength="12">
        </div>
      </div>
      ${pinFields("create")}
      ${field({ label: "預先儲蓄比例", input: html`<input class="input" type="number" name="savingsRate" value="30" min="0" max="100" step="5" inputmode="numeric" required>` })}
      <p class="setup-help">零用錢進來時，這個比例會先留給未來（存進爸媽銀行），其餘由孩子自己安排。預設 30%，以 5% 為單位。</p>
      <div class="form-actions">
        <button class="btn btn-primary btn-block" ${busy === "create" ? raw("disabled") : ""}>${busy === "create" ? "建立中…" : "建立帳本"}</button>
      </div>
    </form>`;
}

function restoreForm() {
  return html`<h2 class="setup-subtitle">從備份檔還原</h2>
    <p class="setup-copy">選一份以前下載的帳本備份或完整可攜備份（.json）。還原會用備份的內容取代這台裝置上的帳本。</p>
    <label class="backup-file-label">選擇備份檔<input class="input file-input" type="file" accept="application/json,.json" data-backup-file ${busy ? raw("disabled") : ""}></label>
    ${busy === "inspect" ? html`<p class="setup-help">正在檢查備份內容…</p>` : ""}
    ${summary ? html`<div class="restore-summary">
      <b>${summary.family && summary.family.name ? summary.family.name : "（沒有家庭名稱）"} · ${timestampText(summary.exportedAt)}</b>
      <small>${summary.portable ? `完整可攜備份${summary.photoCount ? `，包含 ${summary.photoCount} 張照片` : ""}` : "帳本備份"}</small>
      <small>${summary.counts.profiles} 位孩子、${summary.counts.activities} 筆紀錄、${summary.counts.dreams} 個夢想、${summary.counts.holdings} 個投資標的</small>
      <form data-form="restore">
        ${needsPinSetup() ? html`<p class="setup-help">備份檔裡不含家長操作碼（它從來不會被匯出）。先設定一組，還原完就能用它解鎖家長區。</p>${pinFields("restore")}` : ""}
        <div class="form-actions">
          <button class="btn btn-primary btn-block restore-button" ${busy === "restore" ? raw("disabled") : ""}>${busy === "restore" ? "還原中…" : "確認覆蓋並還原"}</button>
        </div>
      </form>
    </div>` : ""}`;
}

export function mount(root, ctx) {
  root.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-mode]");
    if (!tab) return;
    mode = tab.getAttribute("data-mode");
    error = "";
    ctx.refresh();
  });

  root.addEventListener("change", (event) => {
    const input = event.target.closest("[data-backup-file]");
    if (!input || !input.files || !input.files[0]) return;
    void inspectFile(input.files[0], ctx);
  });

  root.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-form]");
    if (!form) return;
    event.preventDefault();
    if (form.getAttribute("data-form") === "create") void createLedger(form, ctx);
    else void restoreLedger(form, ctx);
  });
}

function readPin(form, prefix) {
  const value = String(form.elements[`${prefix}Pin`].value || "").trim();
  const again = String(form.elements[`${prefix}PinAgain`].value || "").trim();
  if (!/^\d{4,8}$/.test(value)) throw new Error("家長操作碼請使用 4 到 8 位數字");
  if (value !== again) throw new Error("兩次輸入的家長操作碼不一樣");
  return value;
}

async function createLedger(form, ctx) {
  if (busy) return;
  error = "";
  try {
    const familyName = String(form.elements.familyName.value || "").trim().slice(0, 30);
    if (familyName.length < 2) throw new Error("請輸入家庭名稱");
    const kidNames = Array.from(form.querySelectorAll('input[name="kid"]'))
      .map((input) => String(input.value || "").trim())
      .filter(Boolean);
    if (!kidNames.length) throw new Error("至少要填一位小朋友的名字");
    const savingsRate = Math.round(Number(form.elements.savingsRate.value));
    if (!Number.isFinite(savingsRate) || savingsRate < 0 || savingsRate > 100 || savingsRate % 5 !== 0) {
      throw new Error("預先儲蓄比例請以 5% 為單位，設定在 0% 到 100% 之間");
    }
    const parentPin = readPin(form, "create");

    busy = "create";
    ctx.refresh();
    const next = freshState({ familyName, kidNames, savingsRate });
    await pin.setup(parentPin);
    store.setState(next, "建立新帳本");
    busy = "";
    showStatus(`${familyName}的帳本建好了，開始記第一筆吧`, "success");
    location.hash = "#/";
  } catch (caught) {
    busy = "";
    error = caught instanceof Error && caught.message ? caught.message : "建立失敗";
    ctx.refresh();
  }
}

async function inspectFile(file, ctx) {
  busy = "inspect";
  error = "";
  summary = null;
  parsed = null;
  ctx.refresh();
  try {
    const text = await file.text();
    const content = JSON.parse(text);
    summary = backup.inspect(content);
    parsed = content;
  } catch (caught) {
    summary = null;
    parsed = null;
    error = caught instanceof Error && caught.message ? caught.message : "無法讀取備份檔";
  }
  busy = "";
  ctx.refresh();
}

async function restoreLedger(form, ctx) {
  if (busy || !parsed) return;
  error = "";
  try {
    const parentPin = needsPinSetup() ? readPin(form, "restore") : "";
    busy = "restore";
    ctx.refresh();
    if (parentPin) await pin.setup(parentPin);
    // backup.restore 內部已經 setState 並存檔。
    await backup.restore(parsed);
    busy = "";
    summary = null;
    parsed = null;
    showStatus("備份已經還原到這台裝置", "success");
    location.hash = "#/";
  } catch (caught) {
    busy = "";
    error = caught instanceof Error && caught.message ? caught.message : "還原失敗";
    ctx.refresh();
  }
}
