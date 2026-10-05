// 小小理財島 PWA：引擎層自我測試（不用任何測試框架）。
// 跑法：用任何靜態伺服器把 docs/ 當根打開 dev/selftest.html。
// db.js 由 importmap 換成 db-mock.js，所以測試不會真的寫進 localStorage 的帳本。

import { KIND_NAMES, coerceLedger, derive, freshState, normalize } from "../js/state.js";
import * as pin from "../js/pin.js";
import * as store from "../js/store.js";
import * as backup from "../js/backup.js";
import * as gist from "../js/gist.js";
import * as common from "../js/ui/common.js";
import { parseStockDayAvg } from "../js/quotes.js";
import { taipeiDate } from "../js/util.js";
import * as db from "./db-mock.js";
import { installFakeFetch, installStorageFakes, jsonResponse } from "./fakes.js";

const PARENT_PIN = "2468";
const WRONG_PIN = "1357";
const CORE_KEYS = ["family", "profiles", "activities", "projects", "holdings", "purchases",
  "investmentPresets", "dreamJars", "reflections", "harvests", "savingsTransfers", "savingsRate"];

function core(state) {
  return JSON.stringify(Object.fromEntries(CORE_KEYS.map((key) => [key, state[key]])));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function runSelfTest(report) {
  let pass = 0;
  let fail = 0;
  const ok = (label) => { pass += 1; report(true, label); };
  const bad = (label, detail) => { fail += 1; report(false, `${label} —— ${detail}`); };
  const assert = (label, condition, detail = "條件不成立") => (condition ? ok(label) : bad(label, detail));
  const assertEqual = (label, actual, expected) => assert(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `預期 ${JSON.stringify(expected)}，實際 ${JSON.stringify(actual)}`,
  );
  const assertThrows = async (label, expected, run) => {
    try {
      await run();
      bad(label, `沒有丟出錯誤（預期「${expected}」）`);
    } catch (error) {
      assertEqual(label, error instanceof Error ? error.message : String(error), expected);
    }
  };

  // 批 1：整輪測試換上假的 localStorage／IndexedDB，跑完換回來——這一頁跟正式 app 同網域，
  // 不能動到家裡真正的帳本、快照、雲端設定與操作碼。
  const fakes = installStorageFakes();
  // 每一段批 1 測試各自包起來：某一支函式還不存在（修之前）只會讓那一段失敗，不會中斷後面全部
  const section = async (name, run) => {
    try { await run(); } catch (error) { bad(`${name}：測試中斷`, error && error.stack ? error.stack : String(error)); }
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    // ---------- 0. 乾淨的起點 ----------
    globalThis.localStorage.removeItem("money-island.v1.security");
    pin.lock();
    db.reset();

    // ---------- 1. 建立帳本 ----------
    const fresh = freshState({ familyName: "測試家庭", kidNames: ["小明", "小美"], savingsRate: 30 });
    store.hydrate(fresh);
    await pin.setup(PARENT_PIN);
    const state = () => store.getState();
    const kid = () => state().profiles.find((profile) => profile.name === "小明");
    const sister = () => state().profiles.find((profile) => profile.name === "小美");
    assertEqual("建立帳本：兩位小朋友", state().profiles.map((profile) => profile.name), ["小明", "小美"]);
    assertEqual("建立帳本：預設兩個小專案", state().projects.map((project) => project.title), ["整理一箱舊玩具", "規劃家庭點心採買"]);
    assertEqual("建立帳本：常用標的 00646 與 0050", state().investmentPresets.map((preset) => preset.symbol), ["00646", "0050"]);
    assertEqual("建立帳本：預先儲蓄比例 30%", state().savingsRate, 30);
    assertEqual("建立帳本：操作碼已設定", pin.status(), "unlocked");
    await assertThrows("建立帳本：家庭名稱太短會擋下", "請輸入家庭名稱", () => freshState({ familyName: "家", kidNames: ["小明"] }));
    await assertThrows("建立帳本：比例必須是 5 的倍數", "預先儲蓄比例請以 5% 為單位，設定在 0% 到 100% 之間",
      () => freshState({ familyName: "測試家庭", kidNames: ["小明"], savingsRate: 33 }));

    // ---------- 2. 記零用錢：30% 拆分與 note 文案 ----------
    await store.addTransaction({ profileId: kid().id, kind: "allowance", amount: 100, operationId: "selftest-allowance-1" });
    assertEqual("零用錢：撲滿 70 元", kid().spendingBalance, 70);
    assertEqual("零用錢：爸媽銀行 30 元", kid().bankBalance, 30);
    const allowanceActivity = state().activities.find((activity) => activity.operationId === "selftest-allowance-1");
    assertEqual("零用錢：預設名稱", allowanceActivity.label, "收到零用錢");
    assertEqual("零用錢：備註文案", allowanceActivity.note, "先存 30 元，留下 70 元自己安排");
    assertEqual("零用錢：提交理由", db.lastReason(), "小明：收到零用錢");
    await store.addTransaction({ profileId: kid().id, kind: "allowance", amount: 100, operationId: "selftest-allowance-1" });
    assertEqual("零用錢：同一個 operationId 只會記一次", kid().spendingBalance, 70);
    await assertThrows("零用錢：金額 0 會被擋下", "請輸入正確的零用錢金額",
      () => store.addTransaction({ profileId: kid().id, kind: "allowance", amount: 0, operationId: "selftest-allowance-x" }));

    // ---------- 3. 花費超額 ----------
    await assertThrows("花費：超過撲滿餘額", "可花零用錢不夠喔",
      () => store.addTransaction({ profileId: kid().id, kind: "spend", amount: 1000, operationId: "selftest-spend-over" }));
    await store.addTransaction({ profileId: kid().id, kind: "spend", amount: 20, operationId: "selftest-spend-1" });
    assertEqual("花費：撲滿剩 50 元", kid().spendingBalance, 50);

    // ---------- 4. 申請多存 ----------
    await store.updateSavingsTransfer({ action: "request", profileId: kid().id, amount: 40, operationId: "selftest-transfer-1" });
    const transfer = () => state().savingsTransfers.find((item) => item.operationId === "selftest-transfer-1");
    assertEqual("多存：申請等待中", transfer().status, "pending");
    assertEqual("多存：預設備註", transfer().note, "我想多存一點給未來");
    await assertThrows("多存：扣掉等待確認後不夠", "撲滿扣掉等待確認的金額後不夠喔",
      () => store.updateSavingsTransfer({ action: "request", profileId: kid().id, amount: 40, operationId: "selftest-transfer-2" }));

    // ---------- 5. 家長核准 ----------
    await assertThrows("家長操作碼：輸入錯誤", "家長操作碼不正確",
      () => store.updateSavingsTransfer({ action: "approve", transferId: transfer().id, parentPin: WRONG_PIN }));
    await store.updateSavingsTransfer({ action: "approve", transferId: transfer().id, parentPin: PARENT_PIN });
    assertEqual("多存核准：撲滿 10 元", kid().spendingBalance, 10);
    assertEqual("多存核准：爸媽銀行 70 元", kid().bankBalance, 70);
    assertEqual("多存核准：狀態 approved", transfer().status, "approved");
    const transferActivity = state().activities.find((activity) => activity.id === transfer().activityId);
    assertEqual("多存核准：紀錄名稱", transferActivity.label, "自主多存到爸媽銀行");
    assertEqual("多存核准：紀錄拆分", [transferActivity.spendDelta, transferActivity.bankDelta], [-40, 40]);
    await assertThrows("多存核准：同一筆不能再處理", "這筆申請已經處理過了",
      () => store.updateSavingsTransfer({ action: "reject", transferId: transfer().id, parentPin: PARENT_PIN }));

    // ---------- 6. 小專案四步狀態機 ----------
    await assertThrows("小專案：報酬超出範圍", "小專案報酬請設定在 10 到 500 元之間",
      () => store.updateFamilyProject({ action: "create", title: "洗碗一週", description: "每天晚餐後洗碗盤並擦乾。", reward: 900, parentPin: PARENT_PIN }));
    await store.updateFamilyProject({ action: "create", title: "洗碗一週", description: "每天晚餐後洗碗盤並擦乾。", reward: 100, parentPin: PARENT_PIN });
    const project = () => state().projects.find((item) => item.title === "洗碗一週");
    assertEqual("小專案：建立後 open", project().status, "open");
    await store.updateFamilyProject({ action: "claim", projectId: project().id, profileId: kid().id });
    assertEqual("小專案：接下後 claimed", project().status, "claimed");
    await assertThrows("小專案：別人不能送出", "目前不能送出這個小專案",
      () => store.updateFamilyProject({ action: "submit", projectId: project().id, profileId: sister().id }));
    await store.updateFamilyProject({ action: "submit", projectId: project().id, profileId: kid().id });
    assertEqual("小專案：送出後 waiting", project().status, "waiting");
    await store.updateFamilyProject({ action: "approve", projectId: project().id, parentPin: PARENT_PIN });
    assertEqual("小專案：核准後 completed", project().status, "completed");
    assertEqual("小專案：撲滿 80 元", kid().spendingBalance, 80);
    assertEqual("小專案：爸媽銀行 100 元", kid().bankBalance, 100);
    const projectActivity = state().activities.find((activity) => activity.kind === "project");
    assertEqual("小專案：紀錄備註", projectActivity.note, "家長確認後發放；依 30% 比例先存 30 元，自己安排 70 元");

    // ---------- 7. 夢想罐 create / queued / activate / complete ----------
    await store.updateDreamJar({ action: "create", profileId: kid().id, title: "買樂高", kind: "short", targetAmount: 500 });
    await store.updateDreamJar({ action: "create", profileId: kid().id, title: "買球鞋", kind: "short", targetAmount: 800 });
    await store.updateDreamJar({ action: "create", profileId: kid().id, title: "買腳踏車", kind: "long", targetAmount: 5000 });
    const dream = (title) => state().dreamJars.find((item) => item.title === title);
    assertEqual("夢想罐：第一個短期是 active", dream("買樂高").status, "active");
    assertEqual("夢想罐：第二個短期進待辦", dream("買球鞋").status, "queued");
    assertEqual("夢想罐：長期是 active", dream("買腳踏車").status, "active");
    await assertThrows("夢想罐：長期只能有一個", "長期夢想同時只能有一個；請先完成或編輯目前的長期夢想",
      () => store.updateDreamJar({ action: "create", profileId: kid().id, title: "買電腦", kind: "long", targetAmount: 20000 }));
    await assertThrows("夢想罐：名稱太短", "請寫出清楚的夢想名稱",
      () => store.updateDreamJar({ action: "create", profileId: kid().id, title: "球", kind: "short", targetAmount: 500 }));
    await assertThrows("夢想罐：目標金額太小", "夢想目標請設定在 50 到 1,000 萬元之間",
      () => store.updateDreamJar({ action: "create", profileId: kid().id, title: "小貼紙", kind: "short", targetAmount: 10 }));
    await assertThrows("夢想罐：還有進行中的短期就不能開始下一個", "請先完成目前的短期夢想，再開始下一個",
      () => store.updateDreamJar({ action: "activate", profileId: kid().id, dreamId: dream("買球鞋").id, parentPin: PARENT_PIN }));
    await store.updateDreamJar({ action: "complete", profileId: kid().id, dreamId: dream("買樂高").id, completedAmount: 500, parentPin: PARENT_PIN });
    assertEqual("夢想罐：完成後 completed", dream("買樂高").status, "completed");
    assertEqual("夢想罐：完成金額", dream("買樂高").completedAmount, 500);
    await assertThrows("夢想罐：已完成不能再編輯", "已完成的夢想會保留原始紀錄，不能再編輯",
      () => store.updateDreamJar({ action: "update", profileId: kid().id, dreamId: dream("買樂高").id, title: "買樂高城堡", kind: "short", targetAmount: 600, parentPin: PARENT_PIN }));
    await store.updateDreamJar({ action: "activate", profileId: kid().id, dreamId: dream("買球鞋").id, parentPin: PARENT_PIN });
    assertEqual("夢想罐：待辦轉成 active", dream("買球鞋").status, "active");

    // ---------- 8. 買入扣爸媽銀行 ----------
    await store.addTransaction({ profileId: kid().id, kind: "allowance", amount: 10000, operationId: "selftest-allowance-2" });
    assertEqual("零用錢：爸媽銀行累積到 3100 元", kid().bankBalance, 3100);
    await assertThrows("買入：超過爸媽銀行餘額", "爸媽銀行的餘額不足以記錄這筆買入",
      () => store.addInvestmentPurchase({
        profileId: kid().id, symbol: "0050", name: "元大台灣 50", category: "ETF",
        units: 10, totalCost: 999999, operationId: "selftest-buy-over", parentPin: PARENT_PIN,
      }));
    await store.addInvestmentPurchase({
      profileId: kid().id, symbol: "0050", name: "元大台灣 50", category: "ETF",
      units: 10, totalCost: 3000, operationId: "selftest-buy-1", parentPin: PARENT_PIN,
    });
    const holding = (symbol) => state().holdings.find((item) => item.profileId === kid().id && item.symbol === symbol);
    assertEqual("買入：爸媽銀行扣到 100 元", kid().bankBalance, 100);
    assertEqual("買入：持股 10 股／成本 3000", [holding("0050").units, holding("0050").costBasis], [10, 3000]);
    assertEqual("買入：帳面市值 3000", kid().marketValue, 3000);
    const buyActivity = state().activities.find((activity) => activity.kind === "stock-buy");
    assertEqual("買入：紀錄名稱", buyActivity.label, "爸媽協助買進 0050");
    assertEqual("買入：紀錄備註", buyActivity.note, "元大台灣 50 · 10 股；真實券商完成後記錄");

    // ---------- 9. 手動市值 ----------
    await assertThrows("市值：超出範圍", "請輸入正確的市值",
      () => store.updateHoldingMarketValue({ holdingId: holding("0050").id, marketValue: -1, parentPin: PARENT_PIN }));
    await store.updateHoldingMarketValue({ holdingId: holding("0050").id, marketValue: 4000, parentPin: PARENT_PIN });
    assertEqual("市值：持股更新為 4000", holding("0050").marketValue, 4000);
    assertEqual("市值：孩子總市值 4000", kid().marketValue, 4000);
    assertEqual("市值：報價來源標記為家長手動輸入", holding("0050").quoteSource, "家長手動輸入");

    // ---------- 10. 收成上限 5% 與一年一次 ----------
    const year = Number(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" }).slice(0, 4));
    await assertThrows("收成：超過 5% 上限", "今年最多可以收成 200 元",
      () => store.recordAnnualHarvest({
        profileId: kid().id, holdingId: holding("0050").id, soldUnits: 0.5, netProceeds: 201, parentPin: PARENT_PIN,
      }));
    await store.recordAnnualHarvest({
      profileId: kid().id, holdingId: holding("0050").id, soldUnits: 0.5, netProceeds: 200,
      destinationDreamId: dream("買球鞋").id, parentPin: PARENT_PIN,
    });
    assertEqual("收成：撲滿加 200 元", kid().spendingBalance, 7280);
    assertEqual("收成：持股剩 9.5 股", holding("0050").units, 9.5);
    assertEqual("收成：扣除成本 150 元", holding("0050").costBasis, 2850);
    assertEqual("收成：扣除市值 200 元", holding("0050").marketValue, 3800);
    const harvestActivity = state().activities.find((activity) => activity.kind === "harvest");
    assertEqual("收成：紀錄備註", harvestActivity.note, "已放進撲滿；短期夢想罐「買球鞋」的進度會自動更新；相對收成前帳面市值增加 0 元");
    await assertThrows("收成：一年只能一次", `${year} 年的過年收成已經使用過了`,
      () => store.recordAnnualHarvest({
        profileId: kid().id, holdingId: holding("0050").id, soldUnits: 0.1, netProceeds: 10, parentPin: PARENT_PIN,
      }));

    // ---------- 11. 撤銷買入 ----------
    await store.addInvestmentPurchase({
      profileId: kid().id, symbol: "00646", name: "元大 S&P 500", category: "ETF",
      units: 1, totalCost: 100, operationId: "selftest-buy-2", parentPin: PARENT_PIN,
    });
    assertEqual("撤銷前：爸媽銀行歸零", kid().bankBalance, 0);
    assertEqual("撤銷前：兩檔持股", state().holdings.length, 2);
    const firstPurchase = () => state().purchases.find((item) => item.symbol === "0050");
    const secondPurchase = () => state().purchases.find((item) => item.symbol === "00646");
    await assertThrows("撤銷買入：後面已有收成就擋下", "這筆買入之後已有賣出紀錄；請先撤銷後續收成，才能安全修正",
      () => store.voidInvestmentPurchase({ purchaseId: firstPurchase().id, parentPin: PARENT_PIN }));
    await store.voidInvestmentPurchase({ purchaseId: secondPurchase().id, parentPin: PARENT_PIN });
    assertEqual("撤銷買入：爸媽銀行退回 100 元", kid().bankBalance, 100);
    assertEqual("撤銷買入：持股整筆移除", state().holdings.length, 1);
    assertEqual("撤銷買入：帳面市值回到 3800", kid().marketValue, 3800);
    const voidActivity = state().activities.find((activity) => activity.kind === "stock-buy-void");
    assertEqual("撤銷買入：紀錄備註", voidActivity.note, "撤銷 1 股；爸媽銀行退回 100 元");

    // ---------- 12. 回顧 ----------
    const month = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" }).slice(0, 7);
    store.saveMonthlyReflection({ profileId: kid().id, month, proudText: "有忍住不亂買", changeText: "想少喝一次飲料", planText: "先存再花" });
    assertEqual("回顧：存下一筆", state().reflections.length, 1);
    store.saveMonthlyReflection({ profileId: kid().id, month, proudText: "改寫過的內容", changeText: "", planText: "" });
    assertEqual("回顧：同月份會覆蓋不會多一筆", state().reflections.length, 1);
    assertEqual("回顧：內容已更新", state().reflections[0].proudText, "改寫過的內容");
    await assertThrows("回顧：月份格式錯誤", "月份格式不正確",
      () => store.saveMonthlyReflection({ profileId: kid().id, month: "2026/01" }));

    // ---------- 13. 紀錄編輯與刪除保護 ----------
    await store.updateActivityRecord({
      action: "edit", activityId: allowanceActivity.id, label: "四月零用錢",
      note: "阿嬤給的", entryDate: "2026-04-05", parentPin: PARENT_PIN,
    });
    const editedActivity = state().activities.find((activity) => activity.id === allowanceActivity.id);
    assertEqual("紀錄編輯：名稱已改", editedActivity.label, "四月零用錢");
    assertEqual("紀錄編輯：日期已改", editedActivity.entryDate, "2026-04-05");
    await assertThrows("紀錄刪除：連結帳務的紀錄不給刪", "這筆紀錄連結其他帳務，請到對應的家長功能調整，避免餘額或持股失真",
      () => store.updateActivityRecord({ action: "delete", activityId: buyActivity.id, parentPin: PARENT_PIN }));

    // ---------- 14. 每月存錢獎勵 ----------
    assertEqual("每月獎勵：第一次會發放", await store.ensureMonthlySavingsRewards(), true);
    assertEqual("每月獎勵：爸媽銀行 100 → 110", kid().bankBalance, 110);
    assertEqual("每月獎勵：同一個月不會再發", await store.ensureMonthlySavingsRewards(), false);
    await assertThrows("每月獎勵：爸媽銀行不足 10 元", "爸媽銀行累積到 10 元後就能得到獎勵",
      () => store.addTransaction({ profileId: sister().id, kind: "reward", parentPin: PARENT_PIN }));

    // ---------- 15. 其他規則 ----------
    await assertThrows("花園：不支援的樹種", "找不到這個樹種或花種",
      () => store.updateGardenSpecies({ profileId: kid().id, gardenSpecies: "cactus" }));
    store.updateGardenSpecies({ profileId: kid().id, gardenSpecies: "daisy" });
    assertEqual("花園：樹種存在 profile 上", kid().gardenSpecies, "daisy");
    await assertThrows("比例：必須是 5 的倍數", "預先儲蓄比例請以 5% 為單位，設定在 0% 到 100% 之間",
      () => store.updateSavingsRate({ savingsRate: 33, parentPin: PARENT_PIN }));
    await assertThrows("小朋友：留下紀錄的不能移除", "這位小朋友已經有紀錄，不能移除",
      () => store.removeProfile({ profileId: kid().id, parentPin: PARENT_PIN }));
    assertEqual("紀錄類型名稱表", [KIND_NAMES.allowance, KIND_NAMES["savings-transfer"], KIND_NAMES.harvest], ["零用錢", "自主存錢", "過年收成"]);

    // ---------- 16. derive 與分頁 ----------
    const view = derive(state());
    const viewKid = view.profiles.find((profile) => profile.name === "小明");
    assertEqual("derive：本月已領獎勵", viewKid.rewardClaimedThisMonth, true);
    assertEqual("derive：短期夢想餘額等於撲滿", viewKid.shortDreamBalance, kid().spendingBalance);
    assertEqual("derive：存給未來的本金", viewKid.futurePrincipal, 2900);
    assertEqual("derive：不會寫回 state", kid().futurePrincipal, undefined);
    const page = store.getActivitiesPage({ profileId: kid().id, kind: "allowance", offset: 0, limit: 40 });
    assertEqual("分頁：零用錢兩筆", page.total, 2);
    assertEqual("分頁：沒有下一頁", page.nextOffset, null);
    const search = store.getActivitiesPage({ profileId: kid().id, query: "樂高", kind: "all" });
    assertEqual("分頁：關鍵字搜尋", search.activities.map((activity) => activity.label), ["完成夢想：買樂高"]);

    // ---------- 17. 匯出後 normalize 能通過 ----------
    const envelope = backup.exportEnvelope(state());
    assertEqual("匯出：信封格式", [envelope.format, envelope.version], ["money-island-backup", 1]);
    const normalized = normalize(envelope);
    assertEqual("匯出：normalize 通過且內容相同", core(normalized), core(state()));
    assert("匯出：裸 state 也能 normalize", Boolean(normalize(clone(state()))));
    const summary = backup.inspect(envelope);
    assertEqual("檢查：摘要筆數", [summary.counts.profiles, summary.counts.holdings, summary.portable], [2, 1, false]);

    // ---------- 18. normalize 反例 ----------
    const duplicated = clone(envelope);
    duplicated.state.profiles.push(clone(duplicated.state.profiles[0]));
    await assertThrows("反例：重複的孩子 ID", "備份檔內容不正確：孩子 ID重複", () => normalize(duplicated));
    const orphan = clone(envelope);
    orphan.state.activities[0].profileId = "not-a-real-profile";
    await assertThrows("反例：孤兒 profileId", "備份檔內容不正確：紀錄連到不存在的孩子", () => normalize(orphan));
    const badRate = clone(envelope);
    badRate.state.savingsRate = 33;
    await assertThrows("反例：比例不是 5 的倍數", "備份檔內容不正確：預先儲蓄比例必須以 5% 為單位", () => normalize(badRate));
    const badFormat = clone(envelope);
    badFormat.format = "something-else";
    await assertThrows("反例：不支援的備份格式", "備份檔版本不支援，請使用網站下載的 JSON 檔案", () => normalize(badFormat));
    const badDate = clone(envelope);
    badDate.state.activities[0].entryDate = "2026-02-30";
    await assertThrows("反例：不存在的日期", "備份檔內容不正確：紀錄日期不是有效日期", () => normalize(badDate));
    const orphanHolding = clone(envelope);
    orphanHolding.state.holdings[0].profileId = "not-a-real-profile";
    await assertThrows("反例：持股連到不存在的孩子", "備份檔內容不正確：持股連到不存在的孩子", () => normalize(orphanHolding));

    // ---------- 19. 可攜備份匯出後再還原回來相等 ----------
    const before = core(state());
    const portable = backup.exportPortableEnvelope(state());
    assertEqual("可攜備份：格式", [portable.format, portable.photos.length], ["money-island-portable-backup", 0]);
    const portableSummary = backup.inspect(portable);
    assertEqual("可攜備份：inspect 認得出來", [portableSummary.portable, portableSummary.photoCount], [true, 0]);
    await backup.restore(portable);
    assertEqual("可攜備份：還原後與匯出前相等", core(state()), before);
    assertEqual("可攜備份：還原會留下提交理由", db.lastReason(), "已由上傳檔案還原");

    // 舊站格式：頭像是 /api/profile-photo 但沒有對應照片 → 用 🙂
    const legacy = clone(portable);
    legacy.state.profiles[0].avatar = "/api/profile-photo?profileId=old&v=1";
    await assertThrows("可攜備份：缺照片內容會被擋下",
      `備份檔內容不正確：${legacy.state.profiles[0].name}缺少照片內容`, () => backup.inspect(legacy));
    const legacyStandard = clone(envelope);
    legacyStandard.state.profiles[0].avatar = "/api/profile-photo?profileId=old&v=1";
    await backup.restore(legacyStandard);
    assertEqual("舊站頭像：沒有照片就換成 🙂", state().profiles[0].avatar, "🙂");

    // ================= 批 1 資料安全（2026-10-05）=================
    // 每一條都是「修之前會失敗、修之後通過」。用到的假資料庫／假網路在 dev/fakes.js。
    // month（台北時間的本月）沿用第 12 段宣告的那一個
    const previousMonth = (() => {
      const [y, m] = month.split("-").map(Number);
      return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    })();
    const twoKids = () => freshState({ familyName: "批一測試家", kidNames: ["阿甲", "阿乙"], savingsRate: 30 });
    const kidNamed = (name) => store.getState().profiles.find((profile) => profile.name === name);
    const validEnvelope = clone(envelope);

    // ---------- B1-2. 換帳本前一定先存「還原前」快照 ----------
    await section("B1-2 還原前快照", async () => {
      db.reset();
      store.hydrate(normalize(clone(validEnvelope)));
      await store.addTransaction({ profileId: kid().id, kind: "allowance", amount: 100, operationId: "selftest-b1-just-recorded" });
      await store.replaceState(normalize(clone(validEnvelope)), "測試還原");
      const preRestore = db.snapshots.filter((item) => item.preRestore);
      assertEqual("還原前快照：換帳本前存了一份", preRestore.length, 1);
      assert("還原前快照：剛記的那一筆在快照裡", preRestore[0] && preRestore[0].raw.includes("selftest-b1-just-recorded"));
      assertEqual("還原前快照：理由是「還原前」", preRestore[0] && preRestore[0].reason, "還原前");
      assert("還原前快照：之後才換成新的帳本", !store.getState().activities.some((item) => item.operationId === "selftest-b1-just-recorded"));

      await store.addTransaction({ profileId: kid().id, kind: "allowance", amount: 100, operationId: "selftest-b1-keep-me" });
      const beforeFailed = core(store.getState());
      db.control.failSnapshot = true;
      await assertThrows("還原前快照：存不進去就中止還原",
        "沒辦法先把目前的帳本另存一份快照，為了安全已經停止，帳本沒有被換掉；請先到家長區下載一份備份再試",
        () => store.replaceState(normalize(clone(validEnvelope)), "不該發生的還原"));
      assertEqual("還原前快照：中止後帳本一字未動", core(store.getState()), beforeFailed);
      await assertThrows("還原前快照：上傳備份檔還原也一樣中止",
        "沒辦法先把目前的帳本另存一份快照，為了安全已經停止，帳本沒有被換掉；請先到家長區下載一份備份再試",
        () => backup.restore(clone(validEnvelope)));
      assertEqual("還原前快照：備份檔還原中止後帳本一字未動", core(store.getState()), beforeFailed);
      db.control.failSnapshot = false;

      store.hydrate(null);
      db.control.broken = true;
      db.control.keepBroken = false;
      await assertThrows("讀不出來的帳本：留存不了就不另建",
        "沒辦法先把讀不出來的那份帳本另外留存（可能容量滿了），為了安全已經停止",
        () => store.replaceState(twoKids(), "建立新帳本"));
      assertEqual("讀不出來的帳本：沒留存就維持原狀", store.getState(), null);
      db.control.keepBroken = true;
      await store.replaceState(twoKids(), "建立新帳本");
      assert("讀不出來的帳本：另建前先留存原始內容", db.control.preserved >= 2 && Boolean(store.getState()));
      db.reset();
    });

    // ---------- B1-3. 存檔失敗要回報，不准說記好了 ----------
    await section("B1-3 存檔失敗", async () => {
      db.reset();
      store.hydrate(twoKids());
      let notified = 0;
      const unsubscribe = store.subscribe(() => { notified += 1; });
      db.control.failSave = true;
      await assertThrows("存檔失敗：commit 丟錯，不會走成功那條路",
        "存不進去（測試）。剛剛的改動還在畫面上，但還沒存進這台裝置，關掉 app 就會不見；請先到家長區下載備份",
        () => store.addTransaction({ profileId: kidNamed("阿甲").id, kind: "allowance", amount: 100, operationId: "selftest-b1-save-fail" }));
      assert("存檔失敗：照樣通知重繪（頁首標記才會出現）", notified > 0);
      unsubscribe();
      db.reset();
    });

    // ---------- 真的 db.js（用假 localStorage／IndexedDB） ----------
    const realDb = await import("../js/db.js?real");
    await realDb.listSnapshots();      // 先把假資料庫開起來快取住：之後 db.js 自己排的快照也只會寫進假的

    await section("B1-3 頁首常駐標記", async () => {
      const shellOf = () => String(common.appShell({ page: "home", title: "首頁", ctx: { profiles: [], profile: null }, body: "" }));
      fakes.storage.quota = 200;
      assertEqual("真 db：容量滿了 save 回報失敗", realDb.save(clone(validEnvelope.state), "測試"), false);
      assert("真 db：記得失敗原因", realDb.saveError().length > 0);
      assertEqual("提示：存檔失敗時成功訊息改成錯誤", common.savedStatus(validEnvelope.state, "零用錢已經記在帳本裡").tone, "error");
      assert("頁首：存檔失敗時有常駐標記", shellOf().includes("save-error-flag"));
      fakes.storage.quota = Infinity;
      assertEqual("真 db：容量回來就存得進去", realDb.save(clone(validEnvelope.state), "測試"), true);
      assertEqual("頁首：存成功後標記消失", shellOf().includes("save-error-flag"), false);
      assertEqual("提示：存成功後照常說記好了", common.savedStatus(validEnvelope.state, "零用錢已經記在帳本裡").tone, "success");
    });

    await section("B1-7 讀不出來的帳本", async () => {
      fakes.storage.setItem("money-island.v1", "{壞掉的 JSON");
      assertEqual("真 db：壞 JSON 讀不出來", realDb.load(), null);
      assert("真 db：記得帳本讀不出來", realDb.hasBrokenLedger());
      realDb.load();
      realDb.load();
      assertEqual("真 db：開三次也只留一份原始內容",
        fakes.storage.keys().filter((key) => key.startsWith("money-island.v1.broken")), ["money-island.v1.broken"]);
      assertEqual("真 db：留存的是原始內容", fakes.storage.getItem("money-island.v1.broken"), "{壞掉的 JSON");
      const missing = clone(validEnvelope.state);
      delete missing.activities;
      fakes.storage.setItem("money-island.v1", JSON.stringify(missing));
      assertEqual("真 db：合法 JSON 缺陣列也當成讀不出來", realDb.load(), null);
      assert("真 db：缺陣列有說原因", realDb.loadError().includes("activities"));
      const loose = clone(validEnvelope.state);
      loose.savingsRate = 33;
      fakes.storage.setItem("money-island.v1", JSON.stringify(loose));
      const opened = realDb.load();
      assert("真 db：規則不過但結構完整的帳本照常打開（不比修之前嚴）", Boolean(opened) && !realDb.hasBrokenLedger());
      assertEqual("開機讀帳本：coerceLedger 通過時回傳整理過的帳本", coerceLedger(clone(validEnvelope.state)).meta.selectedProfileId, validEnvelope.state.profiles[0].id);
      fakes.storage.removeItem("money-island.v1");
    });

    await section("B1-2 快照清理與寫入", async () => {
      for (let index = 0; index < 4; index += 1) {
        assertEqual(`還原前快照 ${index + 1}：寫入成功`, await realDb.takeSnapshot(validEnvelope.state, "還原前", { preRestore: true }), true);
      }
      for (let index = 0; index < 22; index += 1) await realDb.takeSnapshot(validEnvelope.state, "測試");
      const left = fakes.idb.dump("money_island", "snapshots");
      const preLeft = left.filter((record) => record.kind === "pre-restore");
      assertEqual("快照清理：固定保留最近 3 份「還原前」", preLeft.length, 3);
      assert("快照清理：一般快照照樣留最近 20 份", left.length - preLeft.length >= 20);
      await Promise.all([realDb.takeSnapshot(validEnvelope.state, "同時一"), realDb.takeSnapshot(validEnvelope.state, "同時二")]);
      const reasons = fakes.idb.dump("money_island", "snapshots").map((record) => record.reason);
      assert("快照：同一毫秒存兩份不會互蓋", reasons.includes("同時一") && reasons.includes("同時二"));
      fakes.idb.control.failWrites = true;
      assertEqual("快照：寫不進去要回報失敗", await realDb.takeSnapshot(validEnvelope.state, "測試"), false);
      fakes.idb.control.failWrites = false;
      await assertThrows("快照（#8）：找不到那一份就丟錯，不說已還原", "找不到這份快照，可能已經被清掉了", () => realDb.restoreSnapshot(1));
      const newest = (await realDb.listSnapshots())[0];
      assertEqual("快照：讀得回來", (await realDb.restoreSnapshot(newest.ts)).family.id, validEnvelope.state.family.id);
    });

    await section("B1-4 另一個分頁改了帳本", async () => {
      let changes = 0;
      realDb.watchExternalChanges(() => { changes += 1; });
      window.dispatchEvent(new StorageEvent("storage", { key: "money-island.v1" }));
      window.dispatchEvent(new StorageEvent("storage", { key: "money-island-profile" }));
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
      assertEqual("分頁：只有帳本那把鑰匙（或整個清空）才重讀", changes, 2);
    });

    // ---------- B1-1、B1-15、B1-2. 雲端 ----------
    const GIST_KEY = "money-island.v1.gist";
    const connectGist = (extra = {}) => {
      fakes.storage.setItem(GIST_KEY, JSON.stringify({ token: "selftest-token", gistId: "selftest-gist", lastSyncAt: null, lastError: null, remoteStamp: "2026-01-01T00:00:00Z", ...extra }));
      gist.loadGist();
    };
    await section("B1-1 壞帳本不上傳", async () => {
      connectGist();
      const net = installFakeFetch((url, options) => (String(options.method || "GET").toUpperCase() === "PATCH"
        ? jsonResponse(200, { id: "selftest-gist", updated_at: "2026-01-02T00:00:00Z" })
        : jsonResponse(200, { id: "selftest-gist", updated_at: "2026-01-01T00:00:00Z", files: {} })));
      try {
        store.hydrate(null);
        assertEqual("雲端：帳本讀不出來（null）不上傳", await gist.syncCloud(), false);
        const bad = clone(validEnvelope.state);
        bad.savingsRate = 33;
        store.hydrate(bad);
        assertEqual("雲端：還原不回來的帳本不上傳", await gist.syncCloud(), false);
        assertEqual("雲端：完全沒有 PATCH／POST", net.calls.filter((call) => call.method !== "GET").length, 0);
        store.hydrate(normalize(clone(validEnvelope)));
        assertEqual("雲端：好帳本照常上傳", await gist.syncCloud(), true);
        assertEqual("雲端：好帳本真的送出 PATCH", net.calls.filter((call) => call.method === "PATCH").length, 1);
      } finally {
        net.restore();
        gist.disconnect();
      }
    });

    await section("B1-15 連線時不蓋掉本機的夢想", async () => {
      const cloudState = normalize(clone(validEnvelope));
      const cloudFile = { "money-island-backup.json": { content: JSON.stringify(cloudState) } };
      const net = installFakeFetch((url) => {
        if (url.includes("/gists?per_page")) return jsonResponse(200, [{ id: "cloud-gist", files: cloudFile }]);
        if (url.endsWith("/gists/cloud-gist")) return jsonResponse(200, { id: "cloud-gist", updated_at: "2026-01-03T00:00:00Z", files: cloudFile });
        return jsonResponse(404, {});
      });
      try {
        db.reset();
        store.hydrate(twoKids());
        await store.updateDreamJar({ action: "create", profileId: kidNamed("阿甲").id, title: "存錢買書", kind: "short", targetAmount: 300 });
        const withDream = await gist.connect("selftest-token");
        assertEqual("雲端連線：本機只有夢想、沒有紀錄，也要讓家長選", withDream.mode, "conflict");
        assertEqual("雲端連線：本機的夢想還在", store.getState().dreamJars.length, 1);

        db.control.failSnapshot = true;
        assertEqual("雲端拍板：還原前快照存不進去就不換", await gist.adoptCloud(), false);
        assertEqual("雲端拍板：沒換掉本機", store.getState().dreamJars.length, 1);
        db.control.failSnapshot = false;
        assertEqual("雲端拍板：快照存好才改用雲端", await gist.adoptCloud(), true);
        assertEqual("雲端拍板：換之前存了還原前快照", db.snapshots.filter((item) => item.preRestore).length, 1);
        assertEqual("雲端拍板：已換成雲端那份", store.getState().family.id, cloudState.family.id);

        const armedPull = await gist.pullFromCloud();
        assert("雲端拿回：第一按只讀不換", Boolean(armedPull && armedPull.armed));
        store.hydrate(twoKids());
        const localFamily = store.getState().family.id;
        db.control.failSnapshot = true;
        const failedPull = await gist.pullFromCloud();
        assert("雲端拿回：還原前快照存不進去就取消", Boolean(failedPull && failedPull.error));
        assertEqual("雲端拿回：取消後本機沒被換掉", store.getState().family.id, localFamily);
        db.control.failSnapshot = false;
        gist.disconnect();

        store.hydrate(twoKids());
        await store.updateDreamJar({ action: "create", profileId: kidNamed("阿甲").id, title: "存錢買書", kind: "short", targetAmount: 300 });
        await gist.connect("selftest-token");
        db.control.failSave = true;
        assertEqual("雲端拍板：改用雲端後存不進去要回報失敗", await gist.adoptCloud(), false);
        assertEqual("雲端拍板：存不進去就凍結上傳，不拿舊資料蓋雲端", gist.cloudInfo().pending, true);
        db.control.failSave = false;
        gist.disconnect();

        db.reset();
        store.hydrate(twoKids());
        const blank = await gist.connect("selftest-token");
        assertEqual("雲端連線：真的空白才直接拿回", blank.mode, "pulled");
        assertEqual("雲端連線：直接拿回前也存了還原前快照", db.snapshots.filter((item) => item.preRestore).length, 1);
      } finally {
        net.restore();
        gist.disconnect();
      }
    });

    // ---------- B1-10. 危險按鈕與確認框 ----------
    await section("B1-10 刪除雲端備份要真的按兩次", async () => {
      store.hydrate(normalize(clone(validEnvelope)));
      connectGist();
      const net = installFakeFetch((url, options) => (String(options.method || "GET").toUpperCase() === "DELETE"
        ? jsonResponse(204) : jsonResponse(200, {})));
      const panel = document.createElement("div");
      panel.setAttribute("data-gist-root", "");
      document.body.append(panel);
      try {
        panel.innerHTML = gist.renderGistPanel();
        gist.mountGistPanel(panel);
        const deleteButton = () => panel.querySelector('[data-gist="delete"]');
        deleteButton().click();
        deleteButton().click();
        await wait(30);
        assertEqual("刪除雲端備份：連點兩下不會執行", net.calls.filter((call) => call.method === "DELETE").length, 0);
        panel.innerHTML = gist.renderGistPanel();      // 模擬家長區整頁重繪
        assertEqual("刪除雲端備份：重繪後仍看得到「再按一次」", deleteButton().textContent, "再按一次：真的刪除雲端備份");
        await wait(650);
        deleteButton().click();
        await wait(50);
        assertEqual("刪除雲端備份：看到提示再按才刪", net.calls.filter((call) => call.method === "DELETE").length, 1);
      } finally {
        panel.remove();
        net.restore();
        gist.disconnect();
      }
    });

    await section("B1-10 確認框不會被背景重繪關掉", async () => {
      const modalRoot = document.createElement("div");
      modalRoot.id = "modal-root";
      document.body.append(modalRoot);
      try {
        const answer = common.confirmDialog("測試用的確認框");
        common.closeModal("rerender");
        assert("確認框：背景重繪後還開著", common.isModalOpen());
        const okButton = modalRoot.querySelector("[data-confirm-ok]");
        if (okButton) okButton.click(); else common.closeModal();
        assertEqual("確認框：重繪後按確定仍算確定", await answer, true);
      } finally {
        common.closeModal();
        modalRoot.remove();
      }
    });

    // ---------- B1-5. 已完成夢想改成長期 ----------
    await section("B1-5 夢想改類型與匯出前驗證", async () => {
      db.reset();
      store.hydrate(twoKids());
      const owner = () => kidNamed("阿甲");
      await store.addTransaction({ profileId: owner().id, kind: "allowance", amount: 10000, operationId: "selftest-b1-dream-allowance" });
      await store.addInvestmentPurchase({ profileId: owner().id, symbol: "0050", name: "元大台灣 50", category: "ETF", units: 10, totalCost: 3000, operationId: "selftest-b1-dream-buy", parentPin: PARENT_PIN });
      await store.updateDreamJar({ action: "create", profileId: owner().id, title: "買故事書", kind: "short", targetAmount: 200 });
      const jar = () => store.getState().dreamJars.find((item) => item.title === "買故事書");
      const holdingId = store.getState().holdings[0].id;
      await store.recordAnnualHarvest({ profileId: owner().id, holdingId, soldUnits: 0.5, netProceeds: 100, saleDate: taipeiDate(), destinationDreamId: jar().id, parentPin: PARENT_PIN });
      await store.updateDreamJar({ action: "complete", profileId: owner().id, dreamId: jar().id, completedAmount: 200, parentPin: PARENT_PIN });
      await store.updateDreamJar({
        action: "update-completed", profileId: owner().id, dreamId: jar().id, title: "買故事書", kind: "long",
        targetAmount: 200, completedAmount: 200, createdAt: jar().createdAt, completedAt: jar().completedAt, parentPin: PARENT_PIN,
      });
      assertEqual("夢想改長期：指向它的收成目的地已清掉", store.getState().harvests[0].destinationDreamId, null);
      assert("夢想改長期：帳本照樣還原得回來", Boolean(normalize(clone(store.getState()))));
      assert("夢想改長期：照樣匯出得了", Boolean(backup.exportEnvelope(store.getState())));
      const broken = clone(store.getState());
      broken.harvests[0].destinationDreamId = broken.dreamJars[0].id;
      let exportError = "";
      try { backup.exportEnvelope(broken); } catch (error) { exportError = error.message; }
      assert("匯出前驗證：對不起來的帳本先不匯出", exportError.startsWith("這份帳本有資料對不起來，匯出的檔案會還原不回來"), `實際：${exportError || "沒有擋下"}`);
      let portableError = "";
      try { backup.exportPortableEnvelope(broken); } catch (error) { portableError = error.message; }
      assert("匯出前驗證：完整可攜備份也一樣", portableError.startsWith("這份帳本有資料對不起來"), `實際：${portableError || "沒有擋下"}`);
    });

    // ---------- B1-6. 行情回來時帳本已經換了 ----------
    await section("B1-6 行情途中換帳本", async () => {
      db.reset();
      store.hydrate(twoKids());
      const buyer = kidNamed("阿甲");
      await store.addTransaction({ profileId: buyer.id, kind: "allowance", amount: 10000, operationId: "selftest-b1-quote-allowance" });
      await store.addInvestmentPurchase({ profileId: buyer.id, symbol: "0050", name: "元大台灣 50", category: "ETF", units: 10, totalCost: 1000, operationId: "selftest-b1-quote-buy", parentPin: PARENT_PIN });
      const familyA = clone(store.getState());
      const otherFamily = twoKids();
      let swapTo = otherFamily;
      const payload = { stat: "OK", title: "115年10月 0050 元大台灣50 日收盤價及月平均收盤價", fields: ["日期", "收盤價"], data: [["115/10/01", "120.00"], ["月平均收盤價", "120.00"]] };
      const net = installFakeFetch(() => {
        if (swapTo) { store.hydrate(swapTo); swapTo = null; }
        return jsonResponse(200, payload);
      });
      try {
        await assertThrows("行情：途中換成別的帳本就整批放棄", "讀取收盤價的途中帳本換過了，這次的收盤價沒有寫入，請再更新一次",
          () => store.refreshTwseClosingPrices({ mode: "auto" }));
        assertEqual("行情：新帳本沒有被寫進孤兒市值紀錄", store.getState().activities.filter((item) => item.kind === "market-update").length, 0);

        store.hydrate(clone(familyA));
        swapTo = clone(familyA);       // 同一份帳本被另一個分頁重讀過（不同物件）
        await store.refreshTwseClosingPrices({ mode: "auto" });
        const liveHolding = store.getState().holdings[0];
        assertEqual("行情：同一份帳本重讀過，寫進現在那一份", [liveHolding.quotePrice, liveHolding.marketValue], [120, 1200]);
        assertEqual("行情：市值紀錄在現在那一份裡", store.getState().activities.filter((item) => item.kind === "market-update").length, 1);
      } finally {
        net.restore();
      }
    });

    // ---------- B1-9. 證交所欄位 ----------
    await section("B1-9 證交所欄位對位", async () => {
      const base = { stat: "OK", title: "115年10月 0050 元大台灣50 日收盤價及月平均收盤價" };
      assertEqual("行情欄位：照順序取收盤價", parseStockDayAvg({ ...base, fields: ["日期", "收盤價"], data: [["115/10/01", "112.90"]] }, "0050").price, 112.9);
      assertEqual("行情欄位：欄位對調也取對", parseStockDayAvg({ ...base, fields: ["收盤價", "日期"], data: [["112.90", "115/10/01"]] }, "0050").price, 112.9);
      assertEqual("行情欄位：多了成交量也不會拿去當價格",
        parseStockDayAvg({ ...base, fields: ["日期", "成交股數", "收盤價"], data: [["115/10/01", "12,345,678", "112.90"]] }, "0050").price, 112.9);
      await assertThrows("行情欄位：找不到收盤價這一欄就不寫入", "證交所行情格式不正確",
        () => parseStockDayAvg({ ...base, fields: ["日期", "成交股數"], data: [["115/10/01", "12,345,678"]] }, "0050"));
      assertEqual("行情欄位：價格離譜（超過 10 萬元）不採用",
        parseStockDayAvg({ ...base, fields: ["日期", "收盤價"], data: [["115/10/01", "12,345,678"]] }, "0050"), null);
    });

    // ---------- B1-13. Number.isFinite 防護 ----------
    await section("B1-13 數字防護", async () => {
      db.reset();
      store.hydrate(twoKids());
      const someone = () => kidNamed("阿甲");
      await assertThrows("防護：零用錢不是數字", "請輸入正確的零用錢金額",
        () => store.addTransaction({ profileId: someone().id, kind: "allowance", amount: "abc", operationId: "selftest-b1-nan-1" }));
      await assertThrows("防護：花費不是數字", "可花零用錢不夠喔",
        () => store.addTransaction({ profileId: someone().id, kind: "spend", amount: Number.NaN, operationId: "selftest-b1-nan-2" }));
      await assertThrows("防護：多存不是數字", "請輸入想多存的金額",
        () => store.updateSavingsTransfer({ action: "request", profileId: someone().id, amount: "abc", operationId: "selftest-b1-nan-3" }));
      await assertThrows("防護：小專案報酬不是數字", "小專案報酬請設定在 10 到 500 元之間",
        () => store.updateFamilyProject({ action: "create", title: "掃地一週", description: "每天晚餐後掃客廳。", reward: "abc", parentPin: PARENT_PIN }));
      await assertThrows("防護：夢想目標不是數字", "夢想目標請設定在 50 到 1,000 萬元之間",
        () => store.updateDreamJar({ action: "create", profileId: someone().id, title: "買球拍", kind: "short", targetAmount: "abc" }));
      assertEqual("防護：擋下之後餘額不是 NaN", [someone().spendingBalance, someone().bankBalance], [0, 0]);
      assertEqual("防護：擋下之後沒有多出紀錄", store.getState().activities.length + store.getState().savingsTransfers.length, 0);
    });

    // ---------- B1-14. 每月獎勵邊界 ----------
    await section("B1-14 每月獎勵", async () => {
      db.reset();
      store.hydrate(twoKids());
      const first = () => kidNamed("阿甲");
      const second = () => kidNamed("阿乙");
      await store.addTransaction({ profileId: first().id, kind: "allowance", amount: 1000, operationId: "selftest-b1-reward-a" });
      await store.addTransaction({ profileId: second().id, kind: "allowance", amount: 1000, operationId: "selftest-b1-reward-b" });
      // 上個月的獎勵被家長把日期改到這個月：這個月的獎勵照樣要發
      store.getState().activities.push({
        id: "selftest-b1-old-reward", profileId: first().id, kind: "reward", label: "爸媽存錢獎勵", amount: 10,
        spendDelta: 0, bankDelta: 0, marketDelta: 0, note: "", entryDate: `${previousMonth}-01`, source: "system",
        operationId: `reward:${first().id}:${previousMonth}`, createdAt: new Date().toISOString(),
      });
      await store.updateActivityRecord({ action: "edit", activityId: "selftest-b1-old-reward", label: "爸媽存錢獎勵", note: "", entryDate: taipeiDate(), parentPin: PARENT_PIN });
      // 家長手動發的獎勵刪掉了：這個月不會再自動補發
      await store.addTransaction({ profileId: second().id, kind: "reward", parentPin: PARENT_PIN });
      const manual = store.getState().activities.find((item) => item.profileId === second().id && item.kind === "reward");
      await store.updateActivityRecord({ action: "delete", activityId: manual.id, parentPin: PARENT_PIN });
      await store.ensureMonthlySavingsRewards();
      const rewardsOf = (profile) => store.getState().activities.filter((item) => item.profileId === profile.id && item.kind === "reward" && item.operationId === `reward:${profile.id}:${month}`);
      assertEqual("每月獎勵：別月獎勵改到這個月，這個月照樣發", rewardsOf(first()).length, 1);
      assertEqual("每月獎勵：刪掉的獎勵不會自動補發", rewardsOf(second()).length, 0);
      assertEqual("每月獎勵：刪掉後畫面仍算本月已領", derive(store.getState()).profiles.find((item) => item.id === second().id).rewardClaimedThisMonth, true);
      assert("每月獎勵：刪掉的紀錄留在備份裡", (normalize(clone(store.getState())).deletedRewardOperationIds || []).includes(`reward:${second().id}:${month}`));
      await assertThrows("每月獎勵：刪掉後家長也不能再手動領一次", "這個月的爸媽獎勵已經領過了",
        () => store.addTransaction({ profileId: second().id, kind: "reward", parentPin: PARENT_PIN }));
      db.reset();
    });

    // ---------- 20. 操作碼鎖定（放最後，會把操作碼鎖住 15 分鐘）----------
    pin.lock();
    assertEqual("操作碼：鎖上後狀態", pin.status(), "locked");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assertThrows(`操作碼：第 ${attempt + 1} 次輸錯`, "家長操作碼不正確", () => pin.assert(WRONG_PIN));
    }
    await assertThrows("操作碼：第 5 次輸錯就鎖 15 分鐘", "嘗試次數過多，請 15 分鐘後再試", () => pin.assert(WRONG_PIN));
    await assertThrows("操作碼：鎖定期間連正確的也擋", "嘗試次數過多，請 15 分鐘後再試", () => pin.assert(PARENT_PIN));
    globalThis.localStorage.removeItem("money-island.v1.security");
    pin.lock();
    assertEqual("操作碼：清乾淨後回到未設定", pin.status(), "setup");
    await assertThrows("操作碼：沒設定就要求先設定", "請先設定家長操作碼", () => pin.assert(PARENT_PIN));
  } catch (error) {
    fail += 1;
    report(false, `測試中斷：${error && error.stack ? error.stack : error}`);
  } finally {
    try { gist.disconnect(); } catch (error) {}   // 一定要在換回真的 localStorage 之前斷線，才不會動到真的雲端設定
    fakes.restore();
  }

  report(fail === 0, `PASS ${pass} / FAIL ${fail}`, true);
  return { pass, fail };
}
