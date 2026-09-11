// 暫時性自測（建造者 D）：用 jsc 在沒有瀏覽器的環境把三支頁面模組的 render() 跑一次，
// 檢查不丟例外、標籤收支平衡、關鍵掛勾（data-action／data-draft／錯誤錨點）都還在。
// 驗完即刪，不進 CORE 清單。
import "./_d-stubs.mjs";
import { derive, freshState } from "../js/state.js";
import * as parent from "../js/ui/parent.js";
import * as investments from "../js/ui/parent-investments.js";
import * as setup from "../js/ui/setup.js";

const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "source", "area", "base", "col", "embed", "param", "track", "wbr"]);

function checkBalance(name, htmlText) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  let match;
  while ((match = re.exec(htmlText))) {
    const [, closing, tag, attrs, selfClose] = match;
    const lower = tag.toLowerCase();
    if (VOID.has(lower) || selfClose) continue;
    if (closing) {
      const last = stack.pop();
      if (last !== lower) {
        throw new Error(`${name}: 標籤不平衡，關的是 </${lower}>，堆疊頂端是 <${last}>（位置 ${match.index}）`);
      }
    } else {
      stack.push(lower);
    }
    void attrs;
  }
  if (stack.length) throw new Error(`${name}: 還有沒關的標籤 ${stack.join(", ")}`);
}

function must(name, htmlText, needles) {
  for (const needle of needles) {
    if (!htmlText.includes(needle)) throw new Error(`${name}: 少了「${needle}」`);
  }
}

const state = freshState({ familyName: "測試家", kidNames: ["大寶", "二寶"], savingsRate: 30 });
state.projects.push({
  id: "p1", title: "整理一箱舊玩具", description: "整理好並分類", reward: 50,
  status: "waiting", assignedProfileId: state.profiles[0].id, createdAt: new Date().toISOString(),
});
state.savingsTransfers.push({
  id: "t1", profileId: state.profiles[0].id, amount: 20, note: "自己想多存",
  status: "pending", createdAt: new Date().toISOString(),
});
state.holdings.push({
  id: "h1", profileId: state.profiles[0].id, symbol: "00646", name: "元大 S&P 500", category: "ETF",
  units: 10, costBasis: 1000, marketValue: 1200, currency: "TWD",
  priceUpdatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quoteAsOf: "",
});
state.purchases.push({
  id: "b1", profileId: state.profiles[0].id, symbol: "00646", name: "元大 S&P 500", category: "ETF",
  units: 10, totalCost: 1000, purchaseDate: "2026-09-01", note: "第一筆", createdAt: new Date().toISOString(),
});

state.harvests.push({
  id: "hv1", profileId: state.profiles[0].id, year: 2026, holdingId: "h1", soldUnits: 1,
  netProceeds: 50, destinationDreamId: null, saleDate: "2026-02-10", note: "", createdAt: new Date().toISOString(),
});

const view = derive(state);
function ctxFor(pinStatus) {
  return {
    state,
    view,
    profile: view.profiles[0],
    profiles: view.profiles,
    unlocked: pinStatus === "unlocked",
    pinStatus,
    navigate() {},
    refresh() {},
    chooseProfile() {},
  };
}

const unlockedHtml = String(parent.render(ctxFor("unlocked")));
checkBalance("parent(unlocked)", unlockedHtml);
must("parent(unlocked)", unlockedHtml, [
  'data-page="parent"', '<h1 class="page-title">家長區</h1>', 'class="tabbar"',
  'data-action="toggle-pin-change"', 'data-action="approve-transfer"', 'data-action="reject-transfer"',
  'data-action="approve-project"', 'data-action="open-correction"', 'data-action="savings-up"',
  'data-action="savings-down"', 'data-action="toggle-add-profile"',
  'data-action="edit-project"', 'data-action="download-backup"',
  'data-form="savings-rate"', 'data-form="profile-identity"', 'data-form="piggy"', 'data-form="project"',
  'data-draft="piggy-balance"', 'data-draft="project-title"', 'data-input="profile-photo"',
  'data-input="backup-file"', 'data-gist-root', 'data-snapshot-list',
  'class="profile-editor-forms"', 'parent-inbox', 'parent-project-panel', 'parent-device-panel',
  'href="#/parent/investments?open=purchase"', 'href="#/parent/investments?open=harvest"',
  'data-choose-profile', '前往投資管理 →',
]);

// 空待辦與空持股的那一態（規格 5.5 的空狀態文案）
const emptyState = freshState({ familyName: "空帳本", kidNames: ["小寶", "小小寶"], savingsRate: 30 });
const emptyView = derive(emptyState);
const emptyCtx = {
  state: emptyState, view: emptyView, profile: emptyView.profiles[0], profiles: emptyView.profiles,
  unlocked: true, pinStatus: "unlocked", navigate() {}, refresh() {}, chooseProfile() {},
};
const emptyHtml = String(parent.render(emptyCtx));
checkBalance("parent(empty)", emptyHtml);
must("parent(empty)", emptyHtml, ["這個月都核對過了 ✓", "尚未記錄任何持股", 'data-action="remove-profile"']);
const emptyInvestHtml = String(investments.render(emptyCtx));
checkBalance("investments(empty)", emptyInvestHtml);
must("investments(empty)", emptyInvestHtml, ["第一棵投資小樹還在等你", "新記錄會自動留在這裡。", "尚未有過年收成紀錄。"]);

const lockedHtml = String(parent.render(ctxFor("locked")));
checkBalance("parent(locked)", lockedHtml);
must("parent(locked)", lockedHtml, ['data-form="pin"', 'parent-lock-card', '解鎖後才能看到家長功能', '輸入家長操作碼']);
for (const forbidden of ["parent-device-panel", "parent-guide", "data-action=\"open-correction\""]) {
  if (lockedHtml.includes(forbidden)) throw new Error(`parent(locked): 不該出現 ${forbidden}`);
}

const setupPinHtml = String(parent.render(ctxFor("setup")));
checkBalance("parent(setup)", setupPinHtml);
must("parent(setup)", setupPinHtml, ["第一次使用：設定家長操作碼", "設定並解鎖"]);

const investHtml = String(investments.render(ctxFor("unlocked")));
checkBalance("investments", investHtml);
must("investments", investHtml, [
  '<h1 class="page-title">投資管理</h1>', 'href="#/parent"', '‹ 家長區', 'class="narrow"',
  'data-form="purchase"', 'data-purchase-submit', 'data-form="harvest"', 'data-harvest-submit',
  'data-action="choose-preset"', 'data-action="edit-preset"', 'data-action="delete-preset"',
  'data-action="refresh-quotes"', 'data-action="update-market-value"', 'data-action="edit-purchase"',
  'data-action="void-purchase"', 'data-action="void-harvest"', 'data-draft="market-h1"',
  'holding-panel', 'harvest-content', 'harvest-panel', 'parent-save-note', 'data-planned-cost',
]);

const lockedInvest = String(investments.render(ctxFor("locked")));
must("investments(locked)", lockedInvest, ["請先從家長區解鎖"]);

const setupHtml = String(setup.render());
checkBalance("setup", setupHtml);
must("setup", setupHtml, [
  'class="card setup-card"', 'class="segmented"', 'data-mode="create"', 'data-mode="restore"',
  'name="familyName"', 'name="kid"', 'name="createPin"', 'name="createPinAgain"', 'name="savingsRate"',
  "建立新帳本", "從備份還原",
]);

print("PASS：parent（unlocked／locked／setup）、investments（unlocked／locked）、setup 的 render() 都通過標籤平衡與掛勾檢查");
