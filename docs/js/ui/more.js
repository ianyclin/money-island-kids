// 小小理財島 PWA：更多頁（v2 規格 5.4）。
// 四張卡：家庭小專案、我們家的約定、家長區入口、關於。
// 專案的 claim／submit 邏輯（store 呼叫、busy 狀態、錯誤處理、文案）從舊 home.js 原樣搬過來，
// 只換 markup 的 class。

import { html, raw, money, errorMessage } from "../util.js";
import { appShell, showStatus, stateGate } from "./common.js";
import * as store from "../store.js";

// 規格 5.4 第 4 列：版本號寫死一行（sw.js 的 VERSION 讀不到）。
const APP_VERSION = "v2";

// ---------- 頁面暫存（重繪後由 render 讀回） ----------
let projectBusy = "";
let projectError = "";
let currentCtx = null;
const boundRoots = new WeakSet();

function attr(condition, text) {
  return condition ? raw(text) : "";
}

function savingsRateOf(state) {
  return Math.min(100, Math.max(0, state.savingsRate ?? 30));
}

function projectStatus(status, name) {
  if (status === "claimed") return `${name ?? "小朋友"}進行中`;
  if (status === "waiting") return "等待家長確認";
  if (status === "completed") return "已完成";
  return "可以認領";
}

function rule(number, title, text) {
  return html`<article class="rule"><span>${number}</span><div><h3>${title}</h3><p>${text}</p></div></article>`;
}

// ---------- render ----------
export function render(ctx) {
  const state = ctx.state;
  const profile = ctx.profile;
  if (!state || !profile) return stateGate("", () => ctx.refresh());

  const savingsRate = savingsRateOf(state);

  const body = html`
      <div class="grid-2 grid-2-more">
        <section class="card projects" aria-labelledby="projects-title">
          <span class="kicker">偶爾才開放</span>
          <h2 class="card-title" id="projects-title">家庭小專案</h2>
          <p class="projects-note">只有家長事前約定、超出日常責任的完整任務才會出現在這裡。</p>
          <p class="projects-note">完成後才發放，報酬一樣先存 ${savingsRate}%</p>
          ${state.projects.length === 0 ? html`<p class="empty">目前沒有開放的小專案</p>` : html`
          <div class="project-list">
            ${state.projects.map((item) => {
              const assigned = state.profiles.find((kid) => kid.id === item.assignedProfileId);
              const isMine = item.assignedProfileId === profile.id;
              return html`
            <article class="project-card status-${item.status}">
              <div class="project-card-top">
                <span class="badge">${projectStatus(item.status, assigned?.name)}</span>
                <strong>${money(item.reward)}</strong>
              </div>
              <h3>${item.title}</h3>
              <p>${item.description}</p>
              ${item.status === "open" ? html`<button type="button" class="btn btn-secondary btn-block"${attr(projectBusy === item.id, " disabled")} data-action="claim-project" data-id="${item.id}">${projectBusy === item.id ? "正在登記…" : `${profile.name}想接這個專案`}</button>` : ""}
              ${item.status === "claimed" && isMine ? html`<button type="button" class="btn btn-secondary btn-block"${attr(projectBusy === item.id, " disabled")} data-action="submit-project" data-id="${item.id}">${projectBusy === item.id ? "正在送出…" : "我完成了，請家長確認"}</button>` : ""}
              ${item.status === "claimed" && !isMine ? html`<small>${assigned?.name}正在進行中</small>` : ""}
              ${item.status === "waiting" ? html`<small class="waiting-note">⌛ 等待家長在家長專區確認</small>` : ""}
              ${item.status === "completed" ? html`<small class="completed-note">✓ 已完成並分配報酬</small>` : ""}
            </article>`;
            })}
          </div>`}
          ${projectError ? html`<p class="form-error project-error">${projectError}</p>` : ""}
        </section>

        <section class="card rules-card" aria-labelledby="rules-title">
          <span class="kicker">我們家的約定</span>
          <h2 id="rules-title">錢是用來練習選擇，<br />不是拿來考試。</h2>
          <p class="rules-lead">記不清楚時，我們一起補帳；花錯一次，也能變成下次更好的選擇。</p>
          <div class="rule-list">
            ${rule("01", "先存再花", `每次收到零用錢，先留下 ${savingsRate}% 給未來。`)}
            ${rule("02", "想要自己買", "飲料、小玩具和非必要文具，用自己的零用錢選擇。")}
            ${rule("03", "需要由爸媽負責", "餐點、衣服、學校用品、書籍與教育需要，由爸媽準備。")}
            ${rule("04", "一起記、一起想", "漏記就一起回想，不會因為忘記記帳而取消零用錢。")}
          </div>
        </section>

        <section class="card parent-entry">
          <div>
            <b>👨‍👩‍👧 家長區</b>
            <small>管理帳本、專案與投資，需要家長操作碼</small>
          </div>
          <a class="btn btn-secondary" href="#/parent">進入 →</a>
        </section>

        <section class="card about">
          <strong>小小理財島 · 讓好習慣慢慢長大</strong>
          <small>著作注記 · <a href="https://www.facebook.com/profile.php?id=100084000897269" target="_blank" rel="noreferrer">fb/指數三寶飯</a></small>
          <small>${APP_VERSION}</small>
        </section>
      </div>`;

  return appShell({ page: "more", title: "更多", ctx, body });
}

// ---------- 專案（邏輯原樣搬自舊 home.js） ----------
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
    showStatus(
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

// ---------- mount ----------
export function mount(root, ctx) {
  currentCtx = ctx;
  if (!ctx.profile) return;
  if (!boundRoots.has(root)) {
    boundRoots.add(root);
    root.addEventListener("click", onRootClick);
  }
}

function onRootClick(event) {
  const ctx = currentCtx;
  if (!ctx) return;
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const name = button.dataset.action;
  if (name === "claim-project") void runProject(ctx, "claim", button.dataset.id, button);
  else if (name === "submit-project") void runProject(ctx, "submit", button.dataset.id, button);
}
