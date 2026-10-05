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
import * as gist from "../gist.js";
import { field, infoTip, showStatus, timestampText } from "./common.js";

// 頁面自己的 UI 狀態放模組層級：重繪之後 render 讀回來，使用者不會被踢出流程。
let mode = "create";          // "create" | "restore" | "cloud"（"cloud" 只在這台裝置還留著雲端設定時出現）
let error = "";
let busy = "";                // ""｜"create"｜"inspect"｜"restore"｜"cloud"
let summary = null;           // backup.inspect() 的結果
let parsed = null;            // 選到的備份檔內容
let cloudNote = "";           // 「從雲端拿回」第一按之後的說明（雲端那份有幾筆）

// 批 2 A：帳本不在了、雲端設定（money-island.v1.gist）卻還在——這台裝置之前接過雲端備份。
// 這時候建立新帳本或從備份檔還原，雲端那份不准被自動覆蓋；另外多給一條「從 GitHub 雲端拿回」。
function cloudLeft() {
  try { return gist.cloudOn(); } catch (e) { return false; }
}

function currentMode() {
  return mode === "cloud" && !cloudLeft() ? "create" : mode;
}

function needsPinSetup() {
  try { return pin.status() === "setup"; } catch (e) { return true; }
}

// 帳本讀不出來的出路畫面（app.js）帶家長來這裡時，直接切到對應的那一條路。
export function presetMode(next) {
  mode = next === "restore" ? "restore" : "create";
  error = "";
  summary = null;
  parsed = null;
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
  const shown = currentMode();
  const cloud = cloudLeft();
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

      <div class="segmented" aria-label="${cloud ? "第一次使用的三條路" : "第一次使用的兩條路"}">
        <button type="button" data-mode="create" aria-pressed="${shown === "create" ? "true" : "false"}">建立新帳本</button>
        <button type="button" data-mode="restore" aria-pressed="${shown === "restore" ? "true" : "false"}">從備份還原</button>
        ${cloud ? html`<button type="button" data-mode="cloud" aria-pressed="${shown === "cloud" ? "true" : "false"}">從雲端拿回</button>` : ""}
      </div>
      ${shown === "create" ? createForm(cloud) : shown === "restore" ? restoreForm() : cloudForm()}
      ${error ? html`<p class="form-error" role="alert">${error}</p>` : ""}
    </section>
  </main>`;
}

function createForm(cloud) {
  return html`<h2 class="setup-subtitle">建立新帳本</h2>
    <p class="setup-copy">填好之後就可以開始記帳。之後在家長區都能改：孩子的名字、照片、預先儲蓄比例、還可以再加或移除小朋友。</p>
    <form data-form="create">
      ${field({ label: "家庭名稱", input: html`<input class="input" name="familyName" placeholder="例如：小樹家" maxlength="30" required>` })}
      <div class="field">
        <span class="field-label">小朋友的名字（至少一位，空白的會略過）</span>
        <div class="setup-kid-grid">
          <label class="sr-only" for="setup-kid-1">小朋友 1</label><input class="input" id="setup-kid-1" name="kid" placeholder="小朋友 1" maxlength="12">
          <label class="sr-only" for="setup-kid-2">小朋友 2</label><input class="input" id="setup-kid-2" name="kid" placeholder="小朋友 2" maxlength="12">
          <label class="sr-only" for="setup-kid-3">小朋友 3</label><input class="input" id="setup-kid-3" name="kid" placeholder="小朋友 3" maxlength="12">
        </div>
      </div>
      ${needsPinSetup() ? "" : html`<p class="setup-help">這台裝置已經設定過家長操作碼，請輸入原本那一組。</p>`}
      ${pinFields("create")}
      ${field({ label: "預先儲蓄比例", input: html`<input class="input" type="number" name="savingsRate" value="30" min="0" max="100" step="5" inputmode="numeric" required>` })}
      <p class="setup-help">零用錢進來時，這個比例會先留給未來（存進爸媽銀行），其餘由孩子自己安排。預設 30%，以 5% 為單位。</p>
      <div class="form-actions">
        <button class="btn btn-primary btn-block" ${busy === "create" ? raw("disabled") : ""}>${busy === "create" ? "建立中…" : "建立帳本"}</button>
      </div>
      ${cloud ? html`<p class="setup-help" data-setup-cloud-note>這台裝置之前接過雲端備份；建立新帳本不會動到雲端那份，之後會問你要用哪一份</p>` : ""}
    </form>`;
}

function cloudButton() {
  if (busy === "cloud") return html`<button type="button" class="btn btn-primary btn-block" data-setup-cloud disabled>讀取中…</button>`;
  const arm = gist.armState("pull");
  const label = arm === "warming" ? "稍等…" : arm === "armed" ? "再按一次：從雲端還原" : "從雲端拿回備份";
  return html`<button type="button" class="btn btn-primary btn-block" data-setup-cloud${arm === "warming" ? raw(" disabled") : ""}>${label}</button>`;
}

function cloudForm() {
  return html`<h2 class="setup-subtitle">從 GitHub 雲端拿回</h2>
    <p class="setup-copy">這台裝置之前接過 GitHub 雲端備份。按一下先讀雲端、告訴你有幾筆紀錄，5 秒內再按一次才會換成雲端那份。</p>
    <div class="form-actions">${cloudButton()}</div>
    ${cloudNote && gist.armState("pull") !== "idle" ? html`<p class="setup-help" role="status">${cloudNote}</p>` : ""}`;
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
    if (event.target.closest("[data-setup-cloud]")) { void pullCloud(ctx); return; }
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
    // 帳本讀不出來後另建時，這台裝置早就有操作碼了：驗原本那一組，不重設（pin.setup 會擋「已經設定」）
    const firstPin = needsPinSetup();
    if (!firstPin) await pin.assert(parentPin);
    // 批 2 A：雲端設定還在的話，換上新帳本之前先凍結——下一次同步一定先讀雲端、出「要用哪一份」，不會自動覆蓋
    gist.freezeForLedgerSwap();
    // 讀不出來的那份會在 replaceState 裡先留存，留存不了就丟錯、不另建
    await store.replaceState(next, "建立新帳本");
    // 批 1 驗收 #3：新的操作碼等帳本真的換好了才設——以前先設，換帳本失敗時操作碼已經變了、帳本卻沒建
    if (firstPin) await pin.setup(parentPin);
    busy = "";
    showStatus(`${familyName}的帳本建好了，開始記第一筆吧`, "success");
    location.hash = "#/";
  } catch (caught) {
    busy = "";
    error = caught instanceof Error && caught.message ? caught.message : "建立失敗";
    ctx.refresh();
  }
}

// 批 2 A：沿用家長區同一套「從雲端拿回」（gist.pullFromCloud）——第一按只讀、武裝 5 秒，600ms 內的第二按不算；
// 第二按換之前先存「還原前」，存不進去就取消。換好之後雲端版本戳跟著拿回來的那份，照常自動同步。
async function pullCloud(ctx) {
  if (busy) return;
  const first = gist.armState("pull") === "idle";
  error = "";
  if (first) { busy = "cloud"; ctx.refresh(); }
  let result = null;
  try { result = await gist.pullFromCloud(); } catch (caught) { error = caught && caught.message ? caught.message : "讀取失敗"; }
  if (first) busy = "";
  if (result && result.tooSoon) return;
  if (result && result.applied) {
    cloudNote = "";
    location.hash = "#/";
    return;
  }
  // 讀不到、雲端沒有、不見了：pullFromCloud 自己會跳提示，這裡不再重複寫一次
  cloudNote = result && result.armed ? `雲端那份有 ${result.activities} 筆紀錄；5 秒內再按一次就會換成雲端那份` : "";
  ctx.refresh();
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
    // 批 2 A：同上，雲端設定還在就先凍結，還原上來的這份不會被自動傳上去蓋掉雲端那份
    gist.freezeForLedgerSwap();
    // backup.restore 內部已經 setState 並存檔。
    await backup.restore(parsed);
    // 批 1 驗收 #3：還原真的成功了才設操作碼，不先設
    if (parentPin) await pin.setup(parentPin);
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
