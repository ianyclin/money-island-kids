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
import { taipeiDate, entryScrollPlan, ENTRY_SCROLL_KEY } from "../js/util.js";
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
        store.BROKEN_NOT_PRESERVED,
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
      assertEqual("真 db（驗收 #3）：原始內容留存成功", await realDb.ensureBrokenPreserved(), true);
      const brokenCopies = () => fakes.idb.dump("money_island_broken", "ledgers").sort((a, b) => a.ts - b.ts).map((record) => record.raw);
      assertEqual("真 db（驗收 #3）：開三次也只留一份原始內容（存在 IndexedDB）", brokenCopies(), ["{壞掉的 JSON"]);
      assertEqual("真 db（驗收 #3）：不再佔 localStorage", fakes.storage.keys().filter((key) => key.startsWith("money-island.v1.broken")), []);
      assertEqual("真 db（驗收 #3）：出路畫面看得到已留存", realDb.brokenCopyStatus(), "preserved");
      for (const raw of ["{第二份壞掉", "{第三份壞掉", "{第四份壞掉"]) {
        fakes.storage.setItem("money-island.v1", raw);
        realDb.load();
        await realDb.ensureBrokenPreserved();
      }
      assertEqual("真 db（驗收 #6）：後來壞掉的不會蓋掉先前那份，最多留最近 3 份", brokenCopies(), ["{第二份壞掉", "{第三份壞掉", "{第四份壞掉"]);
      fakes.idb.control.failOpen = true;
      fakes.storage.setItem("money-island.v1", "{留存不了的那一份");
      realDb.load();
      assertEqual("真 db（驗收 #3）：IndexedDB 也不行就回報沒有安全副本", await realDb.ensureBrokenPreserved(), false);
      assertEqual("真 db（驗收 #3）：出路畫面據此要求先下載", realDb.brokenCopyStatus(), "failed");
      realDb.markBrokenDownloaded(realDb.brokenRaw());
      assertEqual("真 db（驗收 #3）：家長下載走之後才准換帳本", await realDb.ensureBrokenPreserved(), true);
      fakes.idb.control.failOpen = false;
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
        assertEqual("雲端（驗收 #5）：驗證不過時狀態寫「暫停上傳」，不寫稍後重試", common.backupStatusText({ latestBackup: null }), "等待第一次儲存 · 雲端暫停上傳");
        assert("雲端（驗收 #5）：家長區面板寫出原因與下一步", gist.renderGistPanel().includes("帳本有地方不對，暫停上傳；請先下載原始內容"));
        assertEqual("雲端（驗收 #5）：記帳後的提示也一樣", common.savedStatus({}, "記好了").message, "記好了；帳本有地方不對，暫停上傳；請先下載原始內容");
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
        const tooSoon = await gist.pullFromCloud();
        assert("雲端拿回（驗收 #4）：600ms 內的第二按當成連點，不換", Boolean(tooSoon && tooSoon.tooSoon) && store.getState().family.id === localFamily);
        assertEqual("雲端拿回（驗收 #4）：連點之後仍在等第二按", gist.armState("pull"), "warming");
        await wait(650);
        assertEqual("雲端拿回（驗收 #10）：600ms 後才進入「再按一次」", gist.armState("pull"), "armed");
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
        assertEqual("兩段確認（驗收 #10）：武裝後 600ms 內寫「稍等…」而且不能按", [deleteButton().textContent, deleteButton().disabled], ["稍等…", true]);
        panel.innerHTML = gist.renderGistPanel();      // 模擬家長區整頁重繪
        assertEqual("兩段確認（驗收 #10）：稍等期間重繪也一樣", [deleteButton().textContent, deleteButton().disabled], ["稍等…", true]);
        await wait(650);
        assertEqual("兩段確認（驗收 #10）：600ms 後才變「再按一次」並恢復可按", [deleteButton().textContent, deleteButton().disabled], ["再按一次：真的刪除雲端備份", false]);
        panel.innerHTML = gist.renderGistPanel();      // 模擬家長區整頁重繪
        assertEqual("刪除雲端備份：重繪後仍看得到「再按一次」", deleteButton().textContent, "再按一次：真的刪除雲端備份");
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
        await wait(common.CONFIRM_WARMUP_MS + 50);     // 驗收 C1：確定鈕先停用 600ms
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

    // ---------- 批 5. 換頁關彈窗、危險確認框、深連結、月份箭頭 ----------
    await section("B5-5 換頁時彈窗不會自己彈回", async () => {
      const modalRoot = document.createElement("div");
      modalRoot.id = "modal-root";
      document.body.append(modalRoot);
      try {
        const lock = common.createLockModal({ getPinStatus: () => "locked", onUnlocked() {}, parentHref: "#/parent" });
        lock.open();
        assert("鎖彈窗：打開了", common.isModalOpen());
        common.closeModal("rerender");
        lock.mountCheck();
        assert("鎖彈窗：同一頁重繪後照樣補開", common.isModalOpen());
        common.closeModal("navigate");
        lock.mountCheck();
        assert("鎖彈窗：換頁關掉後回原頁不會自己彈回", !common.isModalOpen());
        const answer = common.confirmDialog("測試用的危險確認框", { danger: true, confirmLabel: "刪除這筆紀錄" });
        const okButton = modalRoot.querySelector("[data-confirm-ok]");
        assert("危險確認框：確認鈕是紅色、寫出具體動詞", Boolean(okButton && okButton.classList.contains("btn-danger") && okButton.textContent === "刪除這筆紀錄"));
        assert("危險確認框：確認鈕不預設聚焦", Boolean(okButton && !okButton.hasAttribute("autofocus") && document.activeElement !== okButton));
        common.closeModal("navigate");
        assertEqual("確認框：開著時換頁等於取消", await answer, false);
      } finally {
        common.closeModal();
        modalRoot.remove();
      }
    });

    await section("B5-6 深連結第二次也帶得到、解鎖後回原處", async () => {
      const investments = await import("../js/ui/parent-investments.js");
      const parentPage = await import("../js/ui/parent.js");
      const purchaseLink = "#/parent/investments?open=purchase";
      investments.forgetDeepLinkIfLeft("#/parent");
      assert("深連結：第一次帶到區塊", investments.shouldApplyDeepLink(purchaseLink));
      assert("深連結：同一頁重繪不會一直捲回去", !investments.shouldApplyDeepLink(purchaseLink));
      investments.forgetDeepLinkIfLeft(purchaseLink);
      assert("深連結：還在投資頁就不重設", !investments.shouldApplyDeepLink(purchaseLink));
      investments.forgetDeepLinkIfLeft("#/parent");
      assert("深連結：離開再點同一個連結，第二次也帶到區塊", investments.shouldApplyDeepLink(purchaseLink));
      investments.forgetDeepLinkIfLeft("#/parent");
      assertEqual("解鎖後回原處：記收成", parentPage.returnTargetOf(`#/parent?return=${encodeURIComponent("#/parent/investments?open=harvest")}`), "#/parent/investments?open=harvest");
      assertEqual("解鎖後回原處：投資頁本身", parentPage.returnTargetOf(`#/parent?return=${encodeURIComponent("#/parent/investments")}`), "#/parent/investments");
      assertEqual("解鎖後回原處：別的網址一律不理", parentPage.returnTargetOf(`#/parent?return=${encodeURIComponent("https://example.com/#/parent/investments")}`), "");
      assertEqual("解鎖後回原處：沒帶就留在家長區", parentPage.returnTargetOf("#/parent"), "");
    });

    await section("B5-10 每月回顧月份箭頭", async () => {
      const growth = await import("../js/ui/growth.js");
      store.hydrate(twoKids());
      const view = derive(store.getState());
      const markup = String(growth.render({
        state: store.getState(), view, profile: view.profiles[0], profiles: view.profiles,
        unlocked: false, pinStatus: "locked", navigate() {}, refresh() {}, chooseProfile() {},
      }));
      const doc = new DOMParser().parseFromString(markup, "text/html");
      const [left, right] = doc.querySelectorAll(".review-month > button");
      assertEqual("月份箭頭：左「‹」＝較早、右「›」＝較新",
        [left && left.textContent, left && left.dataset.action, right && right.textContent, right && right.dataset.action],
        ["‹", "month-older", "›", "month-newer"]);
      assertEqual("月份箭頭：停在這個月時只有「較新」不能按", [left && left.disabled, right && right.disabled], [false, true]);
      db.reset();
    });

    // ================= 批 1 驗收後修正（2026-10-05）=================
    const hashStr = (text) => { let h2 = 5381; for (let i = 0; i < text.length; i++) h2 = ((h2 << 5) + h2 + text.charCodeAt(i)) >>> 0; return text.length + "." + h2.toString(36); };

    await section("驗收 #1 帳本讀不出來後換帳本，不准自動覆蓋雲端", async () => {
      const cloudBody = JSON.stringify(normalize(clone(validEnvelope)), null, 1);
      const runScenario = async (freeze) => {
        db.reset();
        // 雲端版本戳等於本機記的那一個，而且雲端那份就是這台以前傳上去的（指紋相符）
        connectGist({ remoteStamp: "2026-01-01T00:00:00Z", lastSyncAt: "2026-01-01T00:00:00Z", lastPush: hashStr(cloudBody), pendingPush: null });
        const net = installFakeFetch((url, options) => (String(options.method || "GET").toUpperCase() === "PATCH"
          ? jsonResponse(200, { id: "selftest-gist", updated_at: "2026-01-09T00:00:00Z" })
          : jsonResponse(200, { id: "selftest-gist", updated_at: "2026-01-01T00:00:00Z", files: { "money-island-backup.json": { content: cloudBody } } })));
        try {
          store.hydrate(null);
          db.control.broken = true;
          if (freeze) gist.freezeForLedgerSwap();
          await store.replaceState(twoKids(), "建立新帳本");
          db.control.broken = false;
          await gist.syncCloud();
          return { writes: net.calls.filter((call) => call.method === "PATCH" || call.method === "POST").length, info: gist.cloudInfo() };
        } finally {
          net.restore();
          gist.disconnect();
        }
      };
      const unfrozen = await runScenario(false);
      assertEqual("對照組：換帳本前沒凍結的話，下一次同步就把新帳本蓋到雲端", unfrozen.writes, 1);
      const frozen = await runScenario(true);
      assertEqual("讀不出來後另外建立：下一次同步 0 次 PATCH／POST", frozen.writes, 0);
      assertEqual("讀不出來後另外建立：出「要用哪一份」拍板卡", frozen.info.card, "decide");
      assertEqual("讀不出來後另外建立：上傳凍結（落地的待決旗標）", frozen.info.pending, true);
      db.reset();
    });

    await section("驗收 #2 等操作碼的期間帳本被換掉", async () => {
      db.reset();
      store.hydrate(twoKids());
      const owner = () => kidNamed("阿甲");
      await store.addTransaction({ profileId: owner().id, kind: "allowance", amount: 1000, operationId: "selftest-fix2-allowance" });
      await store.updateDreamJar({ action: "create", profileId: owner().id, title: "買拼圖", kind: "short", targetAmount: 300 });
      const jarId = store.getState().dreamJars.find((dream) => dream.title === "買拼圖").id;
      await store.updateSavingsTransfer({ action: "request", profileId: owner().id, amount: 100, operationId: "selftest-fix2-transfer" });
      const transferId = store.getState().savingsTransfers.find((item) => item.operationId === "selftest-fix2-transfer").id;
      // 呼叫之後、驗操作碼的那一下，另一個分頁存了檔：store 換成新的物件（內容一樣）
      const swapDuring = async (label, run, check) => {
        const pending = run();
        store.hydrate(clone(store.getState()));
        await pending;
        assert(label, check(store.getState()));
      };
      await swapDuring("小專案：發布的專案寫進現在那份帳本，沒有丟掉",
        () => store.updateFamilyProject({ action: "create", title: "擦窗戶", description: "把客廳窗戶擦乾淨。", reward: 50, parentPin: PARENT_PIN }),
        (current) => current.projects.some((project) => project.title === "擦窗戶"));
      await swapDuring("家長發獎勵：獎勵寫進現在那份帳本",
        () => store.addTransaction({ profileId: owner().id, kind: "reward", parentPin: PARENT_PIN }),
        (current) => current.activities.some((activity) => activity.kind === "reward" && activity.profileId === owner().id));
      await swapDuring("夢想罐改名：改動寫進現在那份帳本",
        () => store.updateDreamJar({ action: "update", profileId: owner().id, dreamId: jarId, title: "買大拼圖", kind: "short", targetAmount: 300, parentPin: PARENT_PIN }),
        (current) => current.dreamJars.some((dream) => dream.title === "買大拼圖"));
      await swapDuring("自主存錢核准：改動寫進現在那份帳本",
        () => store.updateSavingsTransfer({ action: "approve", transferId, parentPin: PARENT_PIN }),
        (current) => current.savingsTransfers.find((item) => item.id === transferId).status === "approved");
      const stale = store.getState();
      store.hydrate(clone(stale));
      const savesBefore = db.calls.length;
      await assertThrows("commit 防線：傳入的不是目前那份就丟錯", "另一個畫面剛改過帳本，這次沒有存，請再做一次", () => store.commit("不該存", stale));
      assertEqual("commit 防線：丟錯時什麼都沒存", db.calls.length, savesBefore);
      db.reset();
    });

    await section("驗收 #5 驗證不過的帳本", async () => {
      const ghost = clone(validEnvelope.state);
      ghost.harvests[0].destinationDreamId = "selftest-ghost-dream";
      let strict = "";
      try { normalize(clone(ghost)); } catch (error) { strict = error.message; }
      assertEqual("前提：收成指向不存在的夢想，完整驗證不過", strict, "備份檔內容不正確：收成目的夢想關聯錯誤");
      const repaired = coerceLedger(clone(ghost));
      assertEqual("開機自動修：指向不存在的夢想 → 清空收成目的地", repaired.harvests[0].destinationDreamId, null);
      assert("開機自動修：修完就是一份完整驗證得過的帳本", Boolean(normalize(clone(repaired))));
      assertEqual("開機自動修：金額一個都沒動", repaired.profiles.map((profile) => [profile.spendingBalance, profile.bankBalance]), ghost.profiles.map((profile) => [profile.spendingBalance, profile.bankBalance]));
      const longDream = clone(validEnvelope.state);
      const target = longDream.dreamJars.find((dream) => dream.id === longDream.harvests[0].destinationDreamId);
      target.kind = "long";
      target.status = "queued";
      const untouched = coerceLedger(clone(longDream));
      assertEqual("其他驗證失敗不自動修（指向存在、但是長期的夢想）", untouched.harvests[0].destinationDreamId, target.id);
      let exportError = "";
      try { backup.exportEnvelope(untouched); } catch (error) { exportError = error.message; }
      assert("匯出被擋時改指向「下載原始內容」", exportError.includes("下載原始內容") && exportError.includes("不是正式備份"), `實際：${exportError}`);
      fakes.storage.quota = 200;
      realDb.save(clone(untouched), "測試");
      assert("存檔失敗（驗證不過的帳本）：提示改指向下載原始內容，不叫人去下載正式備份",
        common.savedStatus(untouched, "記好了").message.includes("下載原始內容") && !common.savedStatus(untouched, "記好了").message.includes("下載備份"));
      realDb.save(clone(validEnvelope.state), "測試");
      assert("存檔失敗（正常的帳本）：照舊叫人去下載備份", common.savedStatus(validEnvelope.state, "記好了").message.includes("請先到家長區下載備份"));
      fakes.storage.quota = Infinity;
      assertEqual("容量回來就存得進去", realDb.save(clone(validEnvelope.state), "測試"), true);
    });

    await section("驗收 #7 不認得的欄位不丟", async () => {
      const future = clone(validEnvelope.state);
      future.meta.selftestFutureFlag = "留著";
      future.selftestFutureTop = { nested: [1, 2, 3] };
      const once = normalize(clone(future));
      assertEqual("normalize：meta 不認得的欄位留著", once.meta.selftestFutureFlag, "留著");
      assertEqual("normalize：最上層不認得的欄位留著", once.selftestFutureTop, { nested: [1, 2, 3] });
      assertEqual("normalize：已知欄位照樣覆蓋（選中的孩子不存在就換成第一位）",
        normalize(Object.assign(clone(future), { meta: { ...future.meta, selectedProfileId: "nobody" } })).meta.selectedProfileId, future.profiles[0].id);
      fakes.storage.setItem("money-island.v1", JSON.stringify(future));
      const loaded = realDb.load();
      realDb.save(loaded, "測試");
      const reloaded = realDb.load();
      assertEqual("load → save → load：meta 不認得的欄位仍在", reloaded && reloaded.meta.selftestFutureFlag, "留著");
      assertEqual("load → save → load：最上層不認得的欄位仍在", reloaded && reloaded.selftestFutureTop, { nested: [1, 2, 3] });
      const restoredBack = normalize(backup.exportEnvelope(reloaded));
      assertEqual("匯出 → 還原：不認得的欄位仍在", restoredBack.meta.selftestFutureFlag, "留著");
      fakes.storage.removeItem("money-island.v1");
    });

    await section("驗收 #8 快照讀不出來和沒有快照分開講", async () => {
      fakes.idb.control.failReads = true;
      await assertThrows("快照讀不出來：丟錯，不再回「沒有快照」", "快照讀不出來（這台裝置的瀏覽器資料庫有問題），請改用備份檔", () => realDb.listSnapshots());
      fakes.idb.control.failReads = false;
      assert("讀得到時照常回清單", Array.isArray(await realDb.listSnapshots()));
    });

    // ================= 批 2（2026-10-05）=================
    const waitFor = async (check, ms = 4000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (check()) return true; await wait(20); }
      return false;
    };

    await section("批 2 A 第一次使用頁：雲端設定還在時，建立／還原不准自動覆蓋雲端", async () => {
      const setup = await import("../js/ui/setup.js");
      const cloudBody = JSON.stringify(normalize(clone(validEnvelope)), null, 1);
      const STAMP = "2026-01-01T00:00:00Z";
      const host = document.createElement("div");
      document.body.append(host);
      const ctx = { refresh() { host.innerHTML = String(setup.render()); } };
      setup.mount(host, ctx);
      const hashBefore = location.hash;
      const otherFile = backup.exportEnvelope(normalize(clone(freshState({ familyName: "批二還原家", kidNames: ["阿丁"], savingsRate: 30 }))));
      const run = async (how) => {
        db.reset();
        connectGist({ remoteStamp: STAMP, lastSyncAt: STAMP, lastPush: hashStr(cloudBody), pendingPush: null });
        const net = installFakeFetch((url, options) => (String(options.method || "GET").toUpperCase() === "PATCH"
          ? jsonResponse(200, { id: "selftest-gist", updated_at: "2026-01-09T00:00:00Z" })
          : jsonResponse(200, { id: "selftest-gist", updated_at: STAMP, files: { "money-island-backup.json": { content: cloudBody } } })));
        try {
          store.hydrate(null);
          setup.presetMode(how === "restore" ? "restore" : "create");
          ctx.refresh();
          const shown = { cloudTab: Boolean(host.querySelector('[data-mode="cloud"]')), note: (host.querySelector("[data-setup-cloud-note]") || {}).textContent || "" };
          let done = false;
          if (how === "control") {
            await store.replaceState(twoKids(), "建立新帳本");      // b75c09a 的第一次使用頁：直接換上，沒有凍結
            done = true;
          } else if (how === "create") {
            const form = host.querySelector('form[data-form="create"]');
            form.elements.familyName.value = "批二測試家";
            form.querySelector('input[name="kid"]').value = "阿丙";
            form.elements.createPin.value = PARENT_PIN;
            form.elements.createPinAgain.value = PARENT_PIN;
            form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            done = await waitFor(() => Boolean(store.getState()) && store.getState().family.name === "批二測試家");
          } else {
            const input = host.querySelector("[data-backup-file]");
            const transfer = new DataTransfer();
            transfer.items.add(new File([JSON.stringify(otherFile)], "selftest.json", { type: "application/json" }));
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => Boolean(host.querySelector('form[data-form="restore"]')));
            host.querySelector('form[data-form="restore"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            done = await waitFor(() => Boolean(store.getState()) && store.getState().family.name === "批二還原家");
          }
          await gist.syncCloud();
          return { done, shown, writes: net.calls.filter((call) => call.method === "PATCH" || call.method === "POST").length, info: gist.cloudInfo(), text: host.textContent };
        } finally {
          net.restore();
          gist.disconnect();
        }
      };
      try {
        const control = await run("control");
        assertEqual("對照組：第一次使用頁換上新帳本前沒凍結，下一次同步就蓋掉雲端", control.writes, 1);
        const created = await run("create");
        assert("第一次使用頁：建立新帳本有建好", created.done, created.text.slice(0, 200));
        assertEqual("第一次使用頁：雲端設定還在時多一條「從雲端拿回」", created.shown.cloudTab, true);
        assertEqual("第一次使用頁：建立鈕旁的小字", created.shown.note, "這台裝置之前接過雲端備份；建立新帳本不會動到雲端那份，之後會問你要用哪一份");
        assertEqual("建立新帳本之後：下一次同步 0 次 PATCH／POST", created.writes, 0);
        assertEqual("建立新帳本之後：出「要用哪一份」拍板卡", created.info.card, "decide");
        const restored = await run("restore");
        assert("第一次使用頁：從備份檔還原有還原", restored.done, restored.text.slice(0, 200));
        assertEqual("從備份檔還原之後：下一次同步 0 次 PATCH／POST", restored.writes, 0);
        assertEqual("從備份檔還原之後：出「要用哪一份」拍板卡", restored.info.card, "decide");

        store.hydrate(null);
        setup.presetMode("create");
        ctx.refresh();
        assertEqual("沒有雲端設定：不出「從雲端拿回」也不出小字", [Boolean(host.querySelector('[data-mode="cloud"]')), Boolean(host.querySelector("[data-setup-cloud-note]"))], [false, false]);

        // 第三條路：從雲端拿回（沿用 gist.pullFromCloud 的兩段式）
        db.reset();
        connectGist({ remoteStamp: STAMP, lastSyncAt: STAMP });
        const net = installFakeFetch(() => jsonResponse(200, { id: "selftest-gist", updated_at: STAMP, files: { "money-island-backup.json": { content: cloudBody } } }));
        try {
          store.hydrate(null);
          ctx.refresh();
          host.querySelector('[data-mode="cloud"]').click();
          const pullButton = () => host.querySelector("[data-setup-cloud]");
          assert("從雲端拿回：切過去有一顆拿回鈕", Boolean(pullButton()));
          pullButton().click();
          await waitFor(() => gist.armState("pull") !== "idle");
          assertEqual("從雲端拿回：第一按只讀不換", store.getState(), null);
          assert("從雲端拿回：第一按後講出雲端有幾筆", host.textContent.includes(`雲端那份有 ${validEnvelope.state.activities.length} 筆紀錄`), host.textContent.slice(0, 300));
          await wait(650);
          ctx.refresh();
          pullButton().click();
          assert("從雲端拿回：第二按換成雲端那份", await waitFor(() => Boolean(store.getState()) && store.getState().family.id === validEnvelope.state.family.id));
          assertEqual("從雲端拿回：沒有任何上傳", net.calls.filter((call) => call.method !== "GET").length, 0);
        } finally {
          net.restore();
          gist.disconnect();
        }
      } finally {
        host.remove();
        if (location.hash !== hashBefore) history.replaceState(null, "", location.pathname + location.search + hashBefore);
        db.reset();
      }
    });

    await section("v16 第一次使用頁：操作碼欄位不給鑰匙圈當密碼、出錯不清空已輸入的值", async () => {
      const setup = await import("../js/ui/setup.js");
      const host = document.createElement("div");
      document.body.append(host);
      const ctx = { refresh() { host.innerHTML = String(setup.render()); } };
      setup.mount(host, ctx);
      const hashBefore = location.hash;
      const SECURITY = "money-island.v1.security";
      const securityBefore = globalThis.localStorage.getItem(SECURITY);
      const unlockedBefore = pin.isUnlocked();
      const stateBefore = store.getState();
      const form = (kind = "create") => host.querySelector(`form[data-form="${kind}"]`);
      const typeInto = (input, value) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
      const submit = (kind = "create") => form(kind).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      const values = () => {
        const f = form();
        return [f.elements.familyName.value, ...Array.from(f.querySelectorAll('input[name="kid"]')).map((input) => input.value), f.elements.savingsRate.value, f.elements.createPin.value, f.elements.createPinAgain.value];
      };
      const errorText = () => { const node = host.querySelector("[data-setup-error] .form-error"); return node ? node.textContent.trim() : ""; };
      const hintText = () => { const node = host.querySelector("[data-setup-error-hint]"); return node ? node.textContent.trim() : ""; };
      try {
        // 這一段開頭：這台裝置已經有操作碼（第 1 段設的 PARENT_PIN），帳本不在
        db.reset();
        store.hydrate(null);
        setup.presetMode("create");
        ctx.refresh();
        assert("v16：這台裝置已經有操作碼（測試前提）", pin.status() !== "setup", pin.status());

        // 一、操作碼欄位的屬性：不是 password、不是 new-password，遮字靠 CSS
        const pinInputs = Array.from(form().querySelectorAll('input[name="createPin"], input[name="createPinAgain"]'));
        assertEqual("v16：建立表單有兩個操作碼欄", pinInputs.length, 2);
        assertEqual("v16：操作碼欄位的屬性（type／inputmode／autocomplete／autocorrect／autocapitalize／spellcheck／遮字掛勾）",
          pinInputs.map((input) => [input.getAttribute("type"), input.getAttribute("inputmode"), input.getAttribute("autocomplete"), input.getAttribute("autocorrect"), input.getAttribute("autocapitalize"), input.getAttribute("spellcheck"), input.hasAttribute("data-pin-input")]),
          [["text", "numeric", "off", "off", "off", "false", true], ["text", "numeric", "off", "off", "off", "false", true]]);
        assertEqual("v16：建立表單裡沒有任何 type=password／autocomplete=new-password 的欄位", form().querySelectorAll('input[type="password"], [autocomplete="new-password"]').length, 0);
        assertEqual("v16：建立表單關掉瀏覽器原生驗證（錯誤一律走自己的提示）", form().hasAttribute("novalidate"), true);
        // 原始碼層級：家長區解鎖、變更操作碼、情境解鎖彈窗都用同一份屬性
        const sources = {};
        for (const file of ["../js/ui/setup.js", "../js/ui/common.js", "../js/ui/parent.js", "../js/gist.js"]) {
          sources[file] = await (await fetch(new URL(file, import.meta.url), { cache: "no-store" })).text();
        }
        assertEqual("v16：setup／common／parent 原始碼沒有 type=\"password\"",
          ["../js/ui/setup.js", "../js/ui/common.js", "../js/ui/parent.js"].filter((file) => sources[file].includes('type="password"')), []);
        assertEqual("v16：四個檔都沒有 autocomplete=\"new-password\"", Object.keys(sources).filter((file) => sources[file].includes("new-password")), []);
        assertEqual("v16：操作碼欄位都掛共用屬性（解鎖彈窗 1、家長區解鎖 1、變更操作碼 1、第一次使用 2）",
          [(sources["../js/ui/common.js"].match(/id="lock-modal-pin" \$\{PIN_INPUT_ATTRS\}/g) || []).length,
            (sources["../js/ui/parent.js"].match(/\$\{common\.PIN_INPUT_ATTRS\}/g) || []).length,
            (sources["../js/ui/setup.js"].match(/\$\{PIN_INPUT_ATTRS\}/g) || []).length],
          [1, 2, 2]);
        assert("v16：GitHub 金鑰欄維持 autocomplete=\"off\"（不是 new-password）", /data-gist-token autocomplete="off"/.test(sources["../js/gist.js"]));

        // 二、打字之後背景重繪（另一分頁 storage 事件、雲端同步都走整頁重繪）：值還在
        const f0 = form();
        typeInto(f0.elements.familyName, "防清空測試家");
        const kids0 = Array.from(f0.querySelectorAll('input[name="kid"]'));
        typeInto(kids0[0], "小甲");
        typeInto(kids0[1], "小乙");
        typeInto(f0.elements.savingsRate, "20");
        typeInto(f0.elements.createPin, "24");
        ctx.refresh();
        assertEqual("v16：打到一半背景重繪，家庭名稱、孩子、比例、打到一半的操作碼都還在", values(), ["防清空測試家", "小甲", "小乙", "", "20", "24", ""]);

        // 三、模擬鑰匙圈自動填入英數密碼（只改 value、不發 input 事件）後按建立
        form().elements.createPin.value = "Xk3p-9Qwe-r2Tz";
        form().elements.createPinAgain.value = "Xk3p-9Qwe-r2Tz";
        submit();
        await waitFor(() => Boolean(errorText()));
        assertEqual("v16：自動填入英數密碼：帳本沒建", store.getState(), null);
        assertEqual("v16：自動填入英數密碼：錯誤說得出是數字以外的字", errorText(), "家長操作碼只能用 4 到 8 位數字；如果手機自動填入了一串密碼，請清掉後自己打數字");
        assertEqual("v16：自動填入英數密碼：重繪後全部欄位值都還在（含自動填入的兩欄）", values(), ["防清空測試家", "小甲", "小乙", "", "20", "Xk3p-9Qwe-r2Tz", "Xk3p-9Qwe-r2Tz"]);
        const errorNode = host.querySelector("[data-setup-error]");
        assertEqual("v16：錯誤在建立表單裡、送出鈕下面，role=alert", [Boolean(errorNode && errorNode.closest('form[data-form="create"]')), Boolean(errorNode && errorNode.previousElementSibling && errorNode.previousElementSibling.classList.contains("form-actions")), errorNode ? errorNode.getAttribute("role") : ""], [true, true, "alert"]);
        assertEqual("v16：錯誤只畫一次", host.querySelectorAll(".form-error").length, 1);
        const button = form().querySelector(".form-actions button");
        assertEqual("v16：出錯後送出鈕恢復可按", [button.disabled, button.textContent.trim()], [false, "建立帳本"]);

        // 四、驗證錯誤（家庭名稱太短）不先畫成忙碌，值也還在
        typeInto(form().elements.familyName, "家");
        let busyPainted = false;
        const observer = new MutationObserver(() => { if (host.textContent.includes("建立中…")) busyPainted = true; });
        observer.observe(host, { subtree: true, childList: true, characterData: true });
        submit();
        await waitFor(() => errorText() === "請輸入家庭名稱");
        observer.disconnect();
        assertEqual("v16：家庭名稱太短：錯誤", errorText(), "請輸入家庭名稱");
        assertEqual("v16：驗證錯誤沒有先畫成「建立中…」", busyPainted, false);
        assertEqual("v16：家庭名稱太短：其他欄位都還在", values().slice(1), ["小甲", "小乙", "", "20", "Xk3p-9Qwe-r2Tz", "Xk3p-9Qwe-r2Tz"]);
        typeInto(form().elements.familyName, "防清空測試家");

        // 五、這台裝置已經有操作碼，卻打了新的一組
        typeInto(form().elements.createPin, "9999");
        typeInto(form().elements.createPinAgain, "9999");
        submit();
        await waitFor(() => errorText() === setup.EXISTING_PIN_TEXT);
        assertEqual("v16：已有操作碼時打新的一組：錯誤字樣", errorText(), "這台裝置之前設定過家長操作碼，請輸入原本那組。");
        assertEqual("v16：已有操作碼時打新的一組：第二行提示", hintText(), "這通常表示這台裝置以前用過小小理財島，資料可能還在：可以改用上面的「從備份還原」，或聯絡家長確認。");
        assertEqual("v16：已有操作碼時打新的一組：帳本沒建、欄位都還在", [store.getState(), values()], [null, ["防清空測試家", "小甲", "小乙", "", "20", "9999", "9999"]]);

        // 六、手打原本那組數字：建立成功，草稿清空
        typeInto(form().elements.createPin, PARENT_PIN);
        typeInto(form().elements.createPinAgain, PARENT_PIN);
        submit();
        const created = await waitFor(() => Boolean(store.getState()) && store.getState().family.name === "防清空測試家");
        assert("v16：手打正確的操作碼後建立成功", created, errorText());
        assertEqual("v16：建立成功的帳本：孩子與比例照表單", created ? [store.getState().profiles.map((profile) => profile.name), store.getState().savingsRate] : null, [["小甲", "小乙"], 20]);
        store.hydrate(null);
        setup.presetMode("create");
        ctx.refresh();
        assertEqual("v16：建立成功後草稿清空（比例回到預設 30）", values(), ["", "", "", "", "30", "", ""]);

        // 七、還原表單（沒有操作碼的裝置才有操作碼欄）：兩次不一樣時錯誤在還原鈕下、值還在
        globalThis.localStorage.removeItem(SECURITY);
        pin.lock();
        setup.presetMode("restore");
        ctx.refresh();
        const file = backup.exportEnvelope(normalize(clone(freshState({ familyName: "v16還原家", kidNames: ["阿戊"], savingsRate: 30 }))));
        const fileInput = host.querySelector("[data-backup-file]");
        const transfer = new DataTransfer();
        transfer.items.add(new File([JSON.stringify(file)], "selftest.json", { type: "application/json" }));
        fileInput.files = transfer.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        await waitFor(() => Boolean(form("restore")));
        const restorePins = Array.from(form("restore").querySelectorAll('input[name="restorePin"], input[name="restorePinAgain"]'));
        assertEqual("v16：還原表單的操作碼欄也不是 password", restorePins.map((input) => [input.getAttribute("type"), input.getAttribute("autocomplete")]), [["text", "off"], ["text", "off"]]);
        typeInto(form("restore").elements.restorePin, "1234");
        form("restore").elements.restorePinAgain.value = "1243";   // 自動填入：不發 input 事件
        submit("restore");
        await waitFor(() => errorText() === "兩次輸入的家長操作碼不一樣");
        assertEqual("v16：還原兩次不一樣：錯誤", errorText(), "兩次輸入的家長操作碼不一樣");
        assertEqual("v16：還原兩次不一樣：兩欄的值都還在、帳本沒換", [form("restore").elements.restorePin.value, form("restore").elements.restorePinAgain.value, store.getState()], ["1234", "1243", null]);
        const restoreError = host.querySelector("[data-setup-error]");
        assertEqual("v16：還原的錯誤在還原表單裡、還原鈕下面", [Boolean(restoreError && restoreError.closest('form[data-form="restore"]')), Boolean(restoreError && restoreError.previousElementSibling && restoreError.previousElementSibling.classList.contains("form-actions"))], [true, true]);
        ctx.refresh();
        assertEqual("v16：還原表單背景重繪後值還在", [form("restore").elements.restorePin.value, form("restore").elements.restorePinAgain.value], ["1234", "1243"]);
      } finally {
        // 還原進這一段之前的樣子：操作碼紀錄（含輸錯次數）、解鎖狀態、帳本
        if (securityBefore === null) globalThis.localStorage.removeItem(SECURITY); else globalThis.localStorage.setItem(SECURITY, securityBefore);
        pin.lock();
        if (unlockedBefore) await pin.assert(PARENT_PIN);
        setup.presetMode("create");
        host.remove();
        if (location.hash !== hashBefore) history.replaceState(null, "", location.pathname + location.search + hashBefore);
        store.hydrate(stateBefore);
        db.reset();
      }
    });

    await section("批 2 B 舊版 localStorage 的 .broken 搬進 IndexedDB", async () => {
      const LEGACY = "money-island.v1.broken";
      const copies = () => fakes.idb.dump("money_island_broken", "ledgers").map((record) => record.raw);
      assertEqual("沒有舊版留存：什麼都不做", await realDb.migrateLegacyBroken(), "none");
      fakes.storage.setItem(LEGACY, "{舊版壞掉的帳本");
      assertEqual("舊版留存：搬進去", await realDb.migrateLegacyBroken(), "moved");
      assert("舊版留存：IndexedDB 裡有那一份", copies().includes("{舊版壞掉的帳本"));
      assertEqual("舊版留存：存進去之後才移除 localStorage 那把鑰匙", fakes.storage.getItem(LEGACY), null);
      const countAfter = copies().length;
      fakes.storage.setItem(LEGACY, "{舊版壞掉的帳本");
      assertEqual("舊版留存：同一份內容再搬一次", await realDb.migrateLegacyBroken(), "moved");
      assertEqual("舊版留存：相同內容不重存", copies().length, countAfter);
      assert("舊版留存：最多三份", copies().length <= 3);

      fakes.storage.setItem(LEGACY, "{存不進去的舊版帳本");
      fakes.idb.control.failOpen = true;
      assertEqual("資料庫打不開：不搬", await realDb.migrateLegacyBroken(), "kept");
      assertEqual("資料庫打不開：localStorage 那把鑰匙原封不動", fakes.storage.getItem(LEGACY), "{存不進去的舊版帳本");
      fakes.idb.control.failOpen = false;
      fakes.idb.control.failWrites = true;
      assertEqual("寫不進去：不搬", await realDb.migrateLegacyBroken(), "kept");
      assertEqual("寫不進去：localStorage 那把鑰匙原封不動", fakes.storage.getItem(LEGACY), "{存不進去的舊版帳本");
      fakes.idb.control.failWrites = false;
      assertEqual("下次開機資料庫好了：照樣搬", await realDb.migrateLegacyBroken(), "moved");
      assertEqual("下次開機資料庫好了：鑰匙才移除", fakes.storage.getItem(LEGACY), null);

      // 開機時兩邊同時寫（這次讀不出來的那份＋舊版搬家）：排隊寫，不會在同一毫秒互相蓋掉
      fakes.storage.setItem("money-island.v1", "{同時壞掉的這一份");
      fakes.storage.setItem(LEGACY, "{同時搬家的舊版");
      realDb.load();
      await Promise.all([realDb.ensureBrokenPreserved(), realDb.migrateLegacyBroken()]);
      assert("同時寫：兩份都在", copies().includes("{同時壞掉的這一份") && copies().includes("{同時搬家的舊版"), JSON.stringify(copies()));
      fakes.storage.removeItem("money-island.v1");
      realDb.load();
    });

    await section("批 2 C 家長區列出留存的原始內容", async () => {
      const listed = await realDb.listBrokenCopies();
      assert("清單：讀得到留存（由新到舊）", listed.length > 0 && listed.every((record, index) => index === 0 || listed[index - 1].ts > record.ts));
      assert("清單：每份都帶原始內容可以下載", listed.every((record) => typeof record.raw === "string"));
      fakes.idb.control.failOpen = true;
      await assertThrows("清單：資料庫打不開就丟錯，不回「沒有」", realDb.BROKEN_COPIES_READ_ERROR, () => realDb.listBrokenCopies());
      fakes.idb.control.failOpen = false;
      fakes.idb.control.failReads = true;
      await assertThrows("清單：讀到一半出錯也丟錯", realDb.BROKEN_COPIES_READ_ERROR, () => realDb.listBrokenCopies());
      fakes.idb.control.failReads = false;

      const parentPage = await import("../js/ui/parent.js");
      assertEqual("面板：還沒讀到時不顯示", String(parentPage.brokenCopiesMarkup(null, true)), "");
      assertEqual("面板：沒有留存就不顯示這區", String(parentPage.brokenCopiesMarkup([], true)), "");
      const failed = String(parentPage.brokenCopiesMarkup(false, true));
      assert("面板：讀不出來就講讀不出來，不講沒有", failed.includes("讀不出來") && !failed.includes("沒有"), failed);
      const doc = new DOMParser().parseFromString(String(parentPage.brokenCopiesMarkup(listed, true)), "text/html");
      const buttons = [...doc.querySelectorAll('[data-action="download-broken"]')];
      assertEqual("面板：每份一顆下載", buttons.map((button) => Number(button.dataset.ts)), listed.map((record) => record.ts));
      assert("面板：每份寫出時間與大小", [...doc.querySelectorAll(".parent-row small")].every((small) => /(位元組|KB|MB)$/.test(small.textContent)) && doc.querySelectorAll(".parent-row b").length === listed.length);
      assert("面板：還沒解鎖時下載鈕不能按", [...new DOMParser().parseFromString(String(parentPage.brokenCopiesMarkup(listed, false)), "text/html").querySelectorAll('[data-action="download-broken"]')].every((button) => button.disabled));
    });

    // ================= 批 5 驗收後修正（2026-10-05）=================
    const parentPageModule = await import("../js/ui/parent.js");

    // 把家長區畫進一個暫時的 #app（parent.js 的佔位收尾、more.js 的放開都找 #app）
    const mountPage = (pageModule, extra = {}) => {
      const host = document.createElement("div");
      host.id = "app";
      document.body.append(host);
      const makeCtx = () => {
        const current = store.getState();
        const view = derive(current);
        return { state: current, view, profile: view.profiles[0], profiles: view.profiles, unlocked: true, pinStatus: "unlocked", navigate() {}, chooseProfile() {}, refresh, ...extra };
      };
      function refresh() {
        const ctx = makeCtx();
        host.innerHTML = String(pageModule.render(ctx));
        pageModule.mount(host, ctx);
      }
      refresh();
      return { host, refresh, remove() { host.remove(); } };
    };
    const pendingTransfers = () => store.getState().savingsTransfers.filter((item) => item.status === "pending");
    const seedTransfers = async (count) => {
      db.reset();
      store.hydrate(twoKids());
      await pin.assert(PARENT_PIN);
      const owner = kidNamed("阿甲");
      await store.addTransaction({ profileId: owner.id, kind: "allowance", amount: 1000, operationId: `selftest-b5fix-allowance-${count}` });
      for (let i = 0; i < count; i += 1) {
        await store.updateSavingsTransfer({ action: "request", profileId: owner.id, amount: 10 + i, note: `第 ${i + 1} 筆`, operationId: `selftest-b5fix-transfer-${count}-${i}` });
      }
    };

    await section("批 5 疑問-2 同一筆已經有佔位：之後的確認／不執行一律不理", async () => {
      await seedTransfers(2);
      const page = mountPage(parentPageModule);
      try {
        const firstId = page.host.querySelector('.inbox-list > .inbox-item [data-action="approve-transfer"]').dataset.id;
        const button = () => page.host.querySelector(`[data-action="approve-transfer"][data-id="${firstId}"]`);
        const hold = parentPageModule.holdInboxRow(page.host, button(), "已確認 ✓");
        assertEqual("登記佔位後：這一筆算「已經在處理」", parentPageModule.inboxRowHeld(firstId), true);
        assertEqual("登記佔位後：別筆不受影響", parentPageModule.inboxRowHeld(pendingTransfers().find((item) => item.id !== firstId).id), false);
        button().click();
        page.host.querySelector(`[data-action="reject-transfer"][data-id="${firstId}"]`).click();
        await wait(300);
        assertEqual("有佔位時再按「確認存入」「不執行」：都不理，還是待辦", store.getState().savingsTransfers.find((item) => item.id === firstId).status, "pending");
        hold.cancel();
        assertEqual("撤掉佔位後：不再算處理中", parentPageModule.inboxRowHeld(firstId), false);
        button().click();
        assert("撤掉佔位後按「確認存入」：照常核准", await waitFor(() => store.getState().savingsTransfers.find((item) => item.id === firstId).status === "approved"));
        assertEqual("處理完的那一筆：佔位留著（1 秒內再按也不理）", parentPageModule.inboxRowHeld(firstId), true);
        await wait(1100);
        assertEqual("1 秒後佔位收掉", parentPageModule.inboxRowHeld(firstId), false);
      } finally {
        page.remove();
        db.reset();
      }
    });

    await section("批 5 高-2 存檔失敗時：帳本裡已經不是待辦就當成功、佔位留著", async () => {
      await seedTransfers(2);
      const page = mountPage(parentPageModule);
      try {
        const firstButton = page.host.querySelector('.inbox-list > .inbox-item [data-action="approve-transfer"]');
        const firstId = firstButton.dataset.id;
        db.control.failSave = true;
        firstButton.click();
        assert("存檔失敗：記憶體裡這筆已經核准", await waitFor(() => store.getState().savingsTransfers.find((item) => item.id === firstId).status === "approved"));
        await wait(50);
        page.refresh();
        assertEqual("存檔失敗但已不是待辦：佔位留著，不撤", parentPageModule.inboxRowHeld(firstId), true);
        assert("存檔失敗但已不是待辦：畫面上原位是佔位列", Boolean(page.host.querySelector(`.inbox-list > [data-inbox-ghost="${firstId}"]:first-child`)));
        assertEqual("存檔失敗：另一筆還是待辦（只核准 1 筆）", pendingTransfers().length, 1);
        db.control.failSave = false;

        // 對照：丟錯而且帳本裡還是待辦（例如操作碼不對）→ 佔位撤掉、可以再按
        const secondId = pendingTransfers()[0].id;
        pin.lock();
        page.refresh();
        page.host.querySelector(`[data-action="approve-transfer"][data-id="${secondId}"]`).click();
        await wait(400);
        assertEqual("丟錯而且還是待辦：佔位撤掉", parentPageModule.inboxRowHeld(secondId), false);
        assertEqual("丟錯而且還是待辦：那一筆還在", pendingTransfers().map((item) => item.id), [secondId]);
        await pin.assert(PARENT_PIN);
      } finally {
        db.control.failSave = false;
        page.remove();
        db.reset();
      }
    });

    await section("批 5 中-2 佔位用錨點放回原位", async () => {
      const live = (...ids) => ids.map((id) => ({ id, markup: id }));
      const ghost = (id, after, seq, index = 0) => ({ id, after, seq, index, title: id, label: "✓", height: 0, until: Infinity });
      const place = (rows, ghosts, retired) => parentPageModule.placeInboxGhosts(rows, ghosts, (item) => `g${item.id}`, retired).map((row) => row.markup);
      assertEqual("第 1、2 筆先後處理：照原本順序", place(live("C", "D"), [ghost("A", "", 1), ghost("B", "", 2)]), ["gA", "gB", "C", "D"]);
      assertEqual("第 1 筆佔位收掉後再處理當時第 2 列：不跟前一個佔位換位", place(live("D", "E"), [ghost("B", "", 2), ghost("C", "", 3)], new Map([["A", ""]])), ["gB", "gC", "D", "E"]);
      assertEqual("錨點本身也是佔位（先處理後面、再處理前面）", place(live("A", "D"), [ghost("C", "B", 1), ghost("B", "A", 2)]), ["A", "gB", "gC", "D"]);
      assertEqual("錨點的佔位已經收掉：順著它的錨點往前找", place(live("A", "D"), [ghost("C", "B", 1)], new Map([["B", "A"]])), ["A", "gC", "D"]);
      assertEqual("同一個錨點後面的佔位照登記順序", place(live("A", "E"), [ghost("B", "A", 1), ghost("D", "C", 2), ghost("C", "A", 3)]), ["A", "gB", "gC", "gD", "E"]);
      assertEqual("錨點那一列沒做成（還是真實待辦）：插在它後面", place(live("A", "B", "D"), [ghost("C", "B", 1)]), ["A", "B", "gC", "D"]);
    });

    await section("批 5 低-1 關彈窗後只吞同一點附近的點擊、鍵盤關不吞", async () => {
      const modalRoot = document.createElement("div");
      modalRoot.id = "modal-root";
      document.body.append(modalRoot);
      try {
        window.dispatchEvent(new PointerEvent("pointerdown", { clientX: 100, clientY: 100 }));
        common.openModal("<p>測試</p>");
        common.closeModal();
        assertEqual("指標關閉：同一點的點擊被吞", common.tapGuardSwallows(100, 100), true);
        assertEqual("指標關閉：28px 內也吞", common.tapGuardSwallows(120, 120), true);
        assertEqual("指標關閉：遠處（100px）照常", common.tapGuardSwallows(100, 200), false);
        assertEqual("指標關閉：400ms 後照常", common.tapGuardSwallows(100, 100, Date.now() + 450), false);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        common.openModal("<p>測試</p>");
        common.closeModal();
        assertEqual("鍵盤關閉：不吞", common.tapGuardSwallows(100, 100), false);
      } finally {
        common.closeModal();
        modalRoot.remove();
      }
    });

    await section("批 5 中-1 專案清單：任一顆按下後整份停用", async () => {
      const morePage = await import("../js/ui/more.js");
      db.reset();
      store.hydrate(twoKids());
      const owner = kidNamed("阿甲");
      const [z, y] = store.getState().projects.map((project) => project.id);
      await store.updateFamilyProject({ action: "claim", projectId: z, profileId: owner.id });
      const page = mountPage(morePage);
      try {
        const claimY = page.host.querySelector(`[data-action="claim-project"][data-id="${y}"]`);
        assert("前提：Y 可以認領、Z 有「我完成了」", Boolean(claimY && page.host.querySelector(`[data-action="submit-project"][data-id="${z}"]`)));
        claimY.click();
        const submitZ = page.host.querySelector(`[data-action="submit-project"][data-id="${z}"]`);
        assert("按下 Y 之後：Z 的「我完成了」也停用", Boolean(submitZ && submitZ.disabled));
        submitZ.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await wait(300);
        assertEqual("第二下落到 Z：Z 不會變成等待家長確認", store.getState().projects.find((project) => project.id === z).status, "claimed");
        assertEqual("Y 有接下", store.getState().projects.find((project) => project.id === y).status, "claimed");
        page.refresh();
        assert("重繪後停用期還沒過：整份清單的按鈕都停用", [...page.host.querySelectorAll('[data-action="submit-project"], [data-action="claim-project"]')].every((button) => button.disabled));
        await wait(900);
        assert("800ms 後放開", [...page.host.querySelectorAll('[data-action="submit-project"], [data-action="claim-project"]')].every((button) => !button.disabled));
      } finally {
        page.remove();
        db.reset();
      }
    });

    await section("批 5 附加 換帳本凍結時 gistId 是空的：先找既有備份，不新建", async () => {
      const otherBody = JSON.stringify(normalize(clone(validEnvelope)), null, 1);
      const run = async ({ freeze, listing }) => {
        db.reset();
        connectGist({ gistId: null, remoteStamp: null, lastPush: null, pendingPush: null });
        const net = installFakeFetch((url, options) => {
          const method = String(options.method || "GET").toUpperCase();
          if (method === "POST") return jsonResponse(201, { id: "selftest-new-gist", updated_at: "2026-01-09T00:00:00Z" });
          if (method === "PATCH") return jsonResponse(200, { id: "selftest-orphan", updated_at: "2026-01-09T00:00:00Z" });
          if (url.includes("/gists?")) return listing === "fail" ? jsonResponse(500, {}) : jsonResponse(200, listing === "none" ? [] : [{ id: "selftest-orphan", description: "小小理財島備份（自動同步）", files: { "money-island-backup.json": {} } }]);
          return jsonResponse(200, { id: "selftest-orphan", updated_at: "2026-01-01T00:00:00Z", files: { "money-island-backup.json": { content: otherBody } } });
        });
        try {
          store.hydrate(twoKids());
          if (freeze) gist.freezeForLedgerSwap();
          await gist.syncCloud();
          const saved = JSON.parse(fakes.storage.getItem(GIST_KEY) || "null") || {};
          return { writes: net.calls.filter((call) => call.method === "PATCH" || call.method === "POST").length, searched: net.calls.some((call) => call.url.includes("/gists?")), info: gist.cloudInfo(), saved };
        } finally {
          net.restore();
          gist.disconnect();
        }
      };
      const found = await run({ freeze: true, listing: "hit" });
      assertEqual("凍結後同步：先列出帳號裡的 gist 找本 app 的備份", found.searched, true);
      assertEqual("找到既有那份：0 次 PATCH／POST（不新建）", found.writes, 0);
      assertEqual("找到既有那份：掛回去", found.info.gistId, "selftest-orphan");
      assertEqual("找到既有那份：出「要用哪一份」拍板卡", found.info.card, "decide");
      const offline = await run({ freeze: true, listing: "fail" });
      assertEqual("搜尋連不上：這趟不新建", offline.writes, 0);
      assertEqual("搜尋連不上：「曾嘗試建立」的記號留著，下次再找", offline.saved.swapSearch, true);
      const none = await run({ freeze: true, listing: "none" });
      assertEqual("確定沒有既有備份：才新建一份", none.writes, 1);
      assertEqual("確定沒有：記號清掉", Boolean(none.saved.swapSearch), false);
      db.reset();
    });

    await section("批 5 附加 舊版 .broken.<時間> 也搬進 IndexedDB", async () => {
      const copies = () => fakes.idb.dump("money_island_broken", "ledgers");
      const newest = Math.max(0, ...copies().map((record) => record.ts));
      const keys = [1, 2, 3, 4].map((step) => `money-island.v1.broken.${newest + step * 1000}`);
      keys.forEach((key, index) => fakes.storage.setItem(key, `{舊版第 ${index + 1} 份`));
      fakes.storage.setItem("money-island.v1.broken.1000", "{很舊的那一份");
      const result = await realDb.migrateLegacyBroken();
      assertEqual("有搬不進去的：回報 kept", result, "kept");
      const raws = copies().map((record) => record.raw);
      assertEqual("三份上限：留最新的三份", [...raws].sort(), ["{舊版第 2 份", "{舊版第 3 份", "{舊版第 4 份"]);
      assertEqual("搬進去的鑰匙才刪", keys.map((key) => fakes.storage.getItem(key) !== null), [true, false, false, false]);
      assertEqual("搬不進去（比現有三份都舊）的鑰匙不刪", fakes.storage.getItem("money-island.v1.broken.1000"), "{很舊的那一份");
      assertEqual("留存的時間是當初留下的時間", copies().map((record) => record.ts).sort(), [newest + 2000, newest + 3000, newest + 4000]);
      fakes.storage.removeItem(keys[0]);
      fakes.storage.removeItem("money-island.v1.broken.1000");
      assertEqual("清乾淨後：沒有要搬的", await realDb.migrateLegacyBroken(), "none");
    });

    // ================= 三位驗收員複驗後修正（2026-10-07，SW v13）=================
    // 操作碼驗證「慢 1.2 秒而且失敗」：把 PBKDF2 換成會等 1.2 秒再丟錯的替身（只在這幾段測試期間）
    const slowFailingPin = () => {
      const subtle = globalThis.crypto.subtle;
      subtle.deriveBits = async () => { await wait(1200); throw new Error("操作碼驗證失敗（測試）"); };
      return () => { delete subtle.deriveBits; };
    };
    const seedHoldings = async () => {
      db.reset();
      store.hydrate(twoKids());
      await pin.assert(PARENT_PIN);
      const owner = kidNamed("阿甲");
      await store.addTransaction({ profileId: owner.id, kind: "allowance", amount: 10000, operationId: "selftest-v13-allowance" });
      await store.addInvestmentPurchase({ profileId: owner.id, symbol: "0050", name: "元大台灣 50", category: "ETF", units: 2, totalCost: 300, operationId: "selftest-v13-buy-1", parentPin: PARENT_PIN });
      await store.addInvestmentPurchase({ profileId: owner.id, symbol: "00646", name: "元大S&P500", category: "ETF", units: 3, totalCost: 200, operationId: "selftest-v13-buy-2", parentPin: PARENT_PIN });
      return owner;
    };
    const typeInto = (input, value) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
    const marketUpdates = () => store.getState().activities.filter((item) => item.kind === "market-update").length;

    await section("v13 A1 持股「記錄今日市值」：欄位空白不寫入、停用期過了仍停用", async () => {
      const investments = await import("../js/ui/parent-investments.js");
      assertEqual("能不能按：空白、只有空格、不是數字都不行；數字可以",
        ["", "   ", "abc", "Infinity", "600", " 700 "].map((value) => investments.marketValueReady(value)), [false, false, false, false, true, true]);
      await seedHoldings();
      const page = mountPage(investments);
      try {
        const holdings = store.getState().holdings.map((item) => item.id);
        const input = (id) => page.host.querySelector(`[data-draft="market-${id}"]`);
        const button = (id) => page.host.querySelector(`[data-action="update-market-value"][data-id="${id}"]`);
        const [first, second] = holdings;
        assertEqual("前提：欄位空白時兩顆都停用", [button(first).disabled, button(second).disabled], [true, true]);
        typeInto(input(first), "600");
        typeInto(input(second), "700");
        assertEqual("填了數字：兩顆都可以按", [button(first).disabled, button(second).disabled], [false, false]);
        const before = marketUpdates();
        button(first).click();
        assert("按下第一顆：第二顆跟著停用（整排停用）", button(second).disabled);
        typeInto(input(second), "");
        assert("停用期間清空第二顆的欄位：還是停用（不會因為打字被放開）", button(second).disabled);
        await waitFor(() => marketUpdates() === before + 1, 3000);
        await wait(900);
        assertEqual("停用期過了：欄位空白的那一顆仍停用", button(second).disabled, true);
        button(second).disabled = false;
        button(second).click();
        await wait(300);
        assertEqual("強制把空白那一顆變成可按再按：不寫入", marketUpdates(), before + 1);
        typeInto(input(second), "   ");
        assertEqual("只有空格：按鈕停用", button(second).disabled, true);
      } finally {
        page.remove();
        db.reset();
      }
    });

    await section("v13 A2 整排停用＋處理中：操作碼驗證慢而且失敗時，按鈕最後恢復正確狀態", async () => {
      // 共用 helper 本身
      const host = document.createElement("div");
      host.id = "selftest-hold";
      host.innerHTML = '<button type="button">一</button><button type="button">二</button>';
      document.body.append(host);
      try {
        const [one, two] = host.querySelectorAll("button");
        common.holdList("#selftest-hold button", 200);
        assertEqual("整排停用：兩顆都停用", [one.disabled, two.disabled], [true, true]);
        assertEqual("處理中記原狀態：被整排停用的記成「可按」", common.busyBaseline(one), false);
        common.markBusy(one);
        await wait(260);
        assertEqual("停用期到了：處理中的那顆不放開、另一顆放開", [one.disabled, two.disabled], [true, false]);
        common.settleAfterBusy(one, false);
        assertEqual("處理完（失敗）：恢復可按", one.disabled, false);
        common.holdList("#selftest-hold button", 200, { recheck: (element) => element !== two });
        common.markBusy(one);
        common.settleAfterBusy(one, false);
        assertEqual("停用期還沒過就處理完：維持停用，等停用期", one.disabled, true);
        await wait(260);
        assertEqual("停用期過了：照 recheck 放開（不能按的那顆維持停用）", [one.disabled, two.disabled], [false, true]);
      } finally {
        host.remove();
      }

      // 持股頁
      const investments = await import("../js/ui/parent-investments.js");
      await seedHoldings();
      let page = mountPage(investments);
      let restorePin = null;
      try {
        const [first, second] = store.getState().holdings.map((item) => item.id);
        const button = (id) => page.host.querySelector(`[data-action="update-market-value"][data-id="${id}"]`);
        typeInto(page.host.querySelector(`[data-draft="market-${first}"]`), "600");
        typeInto(page.host.querySelector(`[data-draft="market-${second}"]`), "700");
        const before = marketUpdates();
        restorePin = slowFailingPin();
        button(first).click();
        await wait(950);
        assertEqual("持股頁：停用期過了但還在驗操作碼——按下的那顆仍不能按，另一顆放開", [button(first).disabled, button(second).disabled], [true, false]);
        button(first).click();
        assert("持股頁：處理中再按一次不會開始第二趟（按鈕還寫「更新中…」）", button(first).textContent.includes("更新中"));
        await waitFor(() => !button(first).textContent.includes("更新中"), 2500);
        assertEqual("持股頁：驗證失敗後兩顆都恢復可按", [button(first).disabled, button(second).disabled], [false, false]);
        assertEqual("持股頁：沒有寫入", marketUpdates(), before);
      } finally {
        if (restorePin) restorePin();
        page.remove();
      }

      // 夢想頁
      const growth = await import("../js/ui/growth.js");
      await pin.assert(PARENT_PIN);
      const owner = kidNamed("阿甲");
      await store.updateDreamJar({ action: "create", profileId: owner.id, title: "買拼圖", kind: "short", targetAmount: 300 });
      await store.updateDreamJar({ action: "create", profileId: owner.id, title: "買球鞋", kind: "short", targetAmount: 900 });
      await store.updateDreamJar({ action: "create", profileId: owner.id, title: "買畫筆", kind: "short", targetAmount: 200 });
      const activeJar = store.getState().dreamJars.find((dream) => dream.status === "active");
      await store.updateDreamJar({ action: "complete", profileId: owner.id, dreamId: activeJar.id, completedAmount: 300, parentPin: PARENT_PIN });
      page = mountPage(growth);
      restorePin = null;
      try {
        const activates = () => [...page.host.querySelectorAll('[data-action="activate-dream"]')];
        assert("前提：有兩顆「開始這個夢想」可以按", activates().length === 2 && activates().every((item) => !item.disabled));
        const [target, other] = activates();
        restorePin = slowFailingPin();
        target.click();
        await wait(950);
        assertEqual("夢想頁：停用期過了但還在驗操作碼——按下的那顆仍不能按，另一顆放開", [target.disabled, other.disabled], [true, false]);
        await waitFor(() => !target.textContent.includes("開始中"), 2500);
        assertEqual("夢想頁：驗證失敗後恢復可按", [target.disabled, other.disabled], [false, false]);
        assertEqual("夢想頁：沒有開始任何夢想", store.getState().dreamJars.filter((dream) => dream.status === "active").length, 0);
      } finally {
        if (restorePin) restorePin();
        page.remove();
        db.reset();
      }
    });

    await section("v13 C1／C2 確認框：確定鈕先停用 600ms、彈窗換彈窗保留吞點擊、完成夢想的確認框", async () => {
      const modalRoot = document.createElement("div");
      modalRoot.id = "modal-root";
      document.body.append(modalRoot);
      try {
        let settled = null;
        const answer = common.confirmDialog("測試", { danger: true, confirmLabel: "刪除這筆紀錄" });
        answer.then((value) => { settled = value; });
        const okButton = modalRoot.querySelector("[data-confirm-ok]");
        assertEqual("確認框：剛打開時確定鈕停用", okButton.disabled, true);
        okButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await wait(20);
        assertEqual("確認框：停用期間的點擊（含冒泡上來的）不算確定", settled, null);
        await wait(common.CONFIRM_WARMUP_MS);
        assertEqual("確認框：600ms 後可以按", okButton.disabled, false);
        okButton.click();
        assertEqual("確認框：600ms 後按確定才算確定", await answer, true);

        window.dispatchEvent(new PointerEvent("pointerdown", { clientX: 200, clientY: 300 }));
        common.openModal("<p>選單</p>");
        const swapped = common.confirmDialog("換上來的確認框");
        assertEqual("彈窗換彈窗：關掉選單那一下的吞點擊留著", common.tapGuardSwallows(200, 300), true);
        common.closeModal();
        assertEqual("彈窗換彈窗：取消照舊回答「取消」", await swapped, false);
        common.closeModal();
        common.openModal("<p>新的</p>");
        assertEqual("原本沒有彈窗才打開的：吞點擊清掉", common.tapGuardSwallows(200, 300), false);
        common.closeModal();

        const growth = await import("../js/ui/growth.js");
        db.reset();
        store.hydrate(twoKids());
        await pin.assert(PARENT_PIN);
        await store.updateDreamJar({ action: "create", profileId: kidNamed("阿甲").id, title: "買故事書", kind: "short", targetAmount: 200 });
        const page = mountPage(growth);
        try {
          page.host.querySelector('[data-action="complete-dream"]').click();
          await wait(20);
          const ok = modalRoot.querySelector("[data-confirm-ok]");
          assertEqual("完成夢想：確定鈕寫具體動詞", ok && ok.textContent, "完成這個夢想");
          assert("完成夢想：不用紅色", Boolean(ok) && !ok.classList.contains("btn-danger"));
          assert("完成夢想：焦點在取消", document.activeElement === modalRoot.querySelector("[data-confirm-cancel]"));
          assert("完成夢想：多一行「完成後就不能再改回進行中。」", modalRoot.textContent.includes("完成後就不能再改回進行中。"));
          assertEqual("完成夢想：確定鈕同樣先停用", ok && ok.disabled, true);
          modalRoot.querySelector("[data-confirm-cancel]").click();
          await wait(20);
          assertEqual("完成夢想：取消就不完成", store.getState().dreamJars[0].status, "active");
        } finally {
          page.remove();
        }
      } finally {
        common.closeModal();
        modalRoot.remove();
        db.reset();
      }
    });

    await section("v13 B1 多分頁雲端設定一致", async () => {
      const otherCloud = JSON.stringify(normalize(clone(validEnvelope)), null, 1);
      const STAMP = "2026-01-01T00:00:00Z";
      const serve = (onGet) => installFakeFetch((url, options) => {
        const method = String(options.method || "GET").toUpperCase();
        if (method === "PATCH" || method === "POST") return jsonResponse(200, { id: "selftest-gist", updated_at: "2026-01-09T00:00:00Z" });
        if (onGet) onGet();
        return jsonResponse(200, { id: "selftest-gist", updated_at: STAMP, files: { "money-island-backup.json": { content: otherCloud } } });
      });
      const writes = (net) => net.calls.filter((call) => call.method === "PATCH" || call.method === "POST").length;
      db.reset();
      store.hydrate(twoKids());
      // 對照組：沒有別的分頁動過，版本戳一樣就上傳
      connectGist({ remoteStamp: STAMP });
      let net = serve();
      try {
        assertEqual("對照組：雲端版本戳跟記的一樣就上傳", await gist.syncCloud(), true);
        assertEqual("對照組：送出 1 次", writes(net), 1);
      } finally { net.restore(); gist.disconnect(); }

      // 別的分頁換了帳本、凍結了雲端（指紋清掉）：這個分頁記憶體裡還是舊設定
      connectGist({ remoteStamp: STAMP });
      fakes.storage.setItem(GIST_KEY, JSON.stringify({ token: "selftest-token", gistId: "selftest-gist", lastSyncAt: null, lastError: null, remoteStamp: null, lastPush: null, pendingPush: null, swapSearch: true }));
      net = serve();
      try {
        await gist.syncCloud();
        assertEqual("別的分頁凍結過：0 次 PATCH／POST", writes(net), 0);
        assertEqual("別的分頁凍結過：改用 localStorage 那一份、出「要用哪一份」卡", gist.cloudInfo().card, "decide");
        assert("等家長決定時：儲存狀態寫「等你決定要用哪一份」", common.backupStatusText({ latestBackup: null }).includes("等你決定要用哪一份"));
      } finally { net.restore(); gist.disconnect(); }

      // 上傳途中別的分頁中斷連線：放棄這一趟、不把金鑰寫回
      connectGist({ remoteStamp: STAMP });
      net = serve(() => fakes.storage.removeItem(GIST_KEY));
      try {
        await gist.syncCloud();
        assertEqual("途中被別的分頁中斷：0 次 PATCH／POST", writes(net), 0);
        assertEqual("途中被別的分頁中斷：不把金鑰寫回", fakes.storage.getItem(GIST_KEY), null);
        assertEqual("途中被別的分頁中斷：這個分頁也算中斷了", gist.cloudOn(), false);
      } finally { net.restore(); gist.disconnect(); }

      // 別的分頁中斷之後，這個分頁的任何存檔都不會把舊設定寫回
      connectGist({ remoteStamp: STAMP });
      fakes.storage.removeItem(GIST_KEY);
      net = serve();
      try {
        gist.freezeForLedgerSwap();
        await gist.syncCloud();
        assertEqual("別的分頁中斷後換帳本凍結：不寫回金鑰", fakes.storage.getItem(GIST_KEY), null);
        assertEqual("別的分頁中斷後：0 次 PATCH／POST", writes(net), 0);
      } finally { net.restore(); gist.disconnect(); }
      db.reset();
    });

    await section("v13 B3／B4 換帳本凍結：記號一律設、404 走「備份不見了」、清掉帳本壞了的錯誤", async () => {
      const run = async ({ freeze, remoteStamp, lastError }) => {
        db.reset();
        connectGist({ remoteStamp, lastError: lastError || null, lastPush: null, pendingPush: null });
        const net = installFakeFetch((url, options) => {
          const method = String(options.method || "GET").toUpperCase();
          if (method === "POST") return jsonResponse(201, { id: "selftest-new-gist", updated_at: "2026-01-09T00:00:00Z" });
          if (url.includes("/gists?")) return jsonResponse(200, []);
          return jsonResponse(404, {});
        });
        try {
          store.hydrate(twoKids());
          if (freeze) gist.freezeForLedgerSwap();
          const afterFreeze = JSON.parse(fakes.storage.getItem(GIST_KEY) || "null") || {};
          await gist.syncCloud();
          return { writes: net.calls.filter((call) => call.method === "PATCH" || call.method === "POST").length, info: gist.cloudInfo(), afterFreeze, status: common.backupStatusText({ latestBackup: null }) };
        } finally {
          net.restore();
          gist.disconnect();
        }
      };
      const control = await run({ freeze: false, remoteStamp: "2026-01-01T00:00:00Z" });
      assertEqual("對照組（沒換帳本、同步過）：404 → 0 次 POST", control.writes, 0);
      assertEqual("對照組：出「備份不見了」卡", control.info.card, "gone");
      assertEqual("v14：「備份不見了」卡掛著時，儲存狀態跟雲端面板講同一句", control.status, "等待第一次儲存 · 雲端那份備份不見了，自動上傳暫停");
      const swapped = await run({ freeze: true, remoteStamp: "2026-01-01T00:00:00Z", lastError: "這台裝置的帳本讀不出來或資料對不起來，先暫停上傳，以免蓋掉雲端那份備份" });
      assertEqual("換帳本凍結（gistId 有值）：記號照樣設", swapped.afterFreeze.swapSearch, true);
      assertEqual("換帳本凍結：清掉「帳本壞了、暫停上傳」的錯誤", swapped.afterFreeze.lastError, null);
      assertEqual("換帳本凍結後遇到 404：0 次 POST（不自動新建）", swapped.writes, 0);
      assertEqual("換帳本凍結後遇到 404：出「備份不見了」卡（跟對照組一樣）", swapped.info.card, "gone");
      assertEqual("v14：換帳本凍結後「備份不見了」：儲存狀態也講同一句", swapped.status, "等待第一次儲存 · 雲端那份備份不見了，自動上傳暫停");
      // 其他 failed（例如網路失敗、沒有卡）：維持「雲端待同步」
      connectGist({ lastError: "網路斷了（selftest）" });
      try {
        assertEqual("v14 對照：一般同步失敗沒有卡", gist.cloudInfo().card, "");
        assertEqual("v14 對照：一般同步失敗的儲存狀態維持「雲端待同步」", common.backupStatusText({ latestBackup: null }), "等待第一次儲存 · 雲端待同步");
      } finally { gist.disconnect(); }
      db.reset();
    });

    await section("v13 B2 帳本修訂號：另一個分頁剛存過就不寫、被蓋掉要報錯", async () => {
      const KEY = "money-island.v1";
      const ledger = (rev, label) => {
        const value = clone(validEnvelope.state);
        value.meta.rev = rev;
        value.selftestLabel = label;
        return value;
      };
      // 舊帳本沒有 rev：視為 0，存一次變 1
      const legacy = clone(validEnvelope.state);
      delete legacy.meta.rev;
      fakes.storage.setItem(KEY, JSON.stringify(legacy));
      const loaded = realDb.load();
      assertEqual("舊帳本沒有 rev：視為 0", realDb.ledgerRev(), 0);
      assertEqual("存檔：照常寫進去", realDb.save(loaded, "測試"), true);
      assertEqual("存檔：rev 變 1", JSON.parse(fakes.storage.getItem(KEY)).meta.rev, 1);
      // 另一個分頁剛存過（localStorage 現在那一份不是這個分頁上次讀到／寫入的）
      fakes.storage.setItem(KEY, JSON.stringify(ledger(2, "另一個分頁")));
      const otherRaw = fakes.storage.getItem(KEY);
      assertEqual("另一個分頁剛存過：這次不寫", realDb.save(clone(loaded), "測試"), realDb.STALE_SAVE);
      assertEqual("另一個分頁剛存過：localStorage 原封不動", fakes.storage.getItem(KEY), otherRaw);
      // 重讀之後再存就可以；換整份帳本（備份檔裡的 rev 比較小）也不會被自己擋掉
      realDb.load();
      assertEqual("重讀之後：可以存", realDb.save(ledger(1, "備份檔"), "測試還原"), true);
      assertEqual("換整份帳本：rev 接著這個分頁知道的往上加", JSON.parse(fakes.storage.getItem(KEY)).meta.rev, 3);
      // 同一瞬間兩邊都過了檢查、後寫的蓋掉這個分頁那一份：收到 storage 事件時報錯
      let lastInfo = null;
      realDb.watchExternalChanges((event, info) => { lastInfo = info; });
      fakes.storage.setItem(KEY, JSON.stringify(ledger(3, "同時寫的另一份")));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
      assertEqual("同一瞬間被蓋掉（rev 一樣、內容不同）：報錯", lastInfo && lastInfo.lostWrite, true);
      realDb.load();
      realDb.save(ledger(3, "我的"), "測試");
      fakes.storage.setItem(KEY, JSON.stringify(ledger(5, "從我的接著改的")));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
      assertEqual("從我的那一份接著改（rev 比較大）：不報錯", lastInfo && lastInfo.lostWrite, false);
      fakes.storage.removeItem(KEY);
      realDb.load();

      // store：另一個分頁剛存過 → 丟 STALE_LEDGER_ERROR、重讀帳本，這一筆不留在畫面上
      db.reset();
      store.hydrate(twoKids());
      const fresh = clone(store.getState());
      db.control.stale = true;
      db.control.reloadWith = fresh;
      await assertThrows("store：另一個分頁剛存過就丟錯", store.STALE_LEDGER_ERROR,
        () => store.addTransaction({ profileId: kidNamed("阿甲").id, kind: "allowance", amount: 100, operationId: "selftest-v13-stale" }));
      assertEqual("store：重讀了帳本", db.control.loads, 1);
      assertEqual("store：這一筆不在（輸的一方明確報錯，不是假裝存好）", store.getState().activities.some((item) => item.operationId === "selftest-v13-stale"), false);
      db.reset();
    });

    await section("v13 B5 舊版 .broken.* 搬不進去的也列出來、可下載、下載後可刪", async () => {
      const keys = ["money-island.v1.broken.1000", "money-island.v1.broken.2000"];
      keys.forEach((key, index) => fakes.storage.setItem(key, `{舊版留在這台裝置第 ${index + 1} 份`));
      fakes.storage.setItem("money-island.v1.brokenish", "不是留存");
      const left = await realDb.listLegacyBrokenLeft();
      assertEqual("列出：還留在 localStorage 的舊版留存", left.map((item) => item.key).sort(), keys);
      assert("列出：每份帶原始內容與時間", left.every((item) => typeof item.raw === "string" && item.at > 0));
      const parentPage = await import("../js/ui/parent.js");
      const doc = new DOMParser().parseFromString(String(parentPage.brokenCopiesMarkup([], true, left)), "text/html");
      assertEqual("面板：沒有新存法的留存也照樣顯示這區", doc.querySelectorAll('[data-action="download-legacy-broken"]').length, 2);
      assert("面板：標「舊版留在這台裝置」", doc.body.textContent.includes("舊版留在這台裝置"));
      assertEqual("面板：還沒下載就沒有刪除鈕", doc.querySelectorAll('[data-action="delete-legacy-broken"]').length, 0);
      assertEqual("刪除：鑰匙名稱不是留存格式就不動", realDb.removeLegacyBroken("money-island.v1.brokenish"), false);
      assertEqual("刪除：不是留存的鑰匙還在", fakes.storage.getItem("money-island.v1.brokenish"), "不是留存");
      assertEqual("刪除：只刪那一把", realDb.removeLegacyBroken(keys[0]), true);
      assertEqual("刪除：那一把不見了、另一把還在", [fakes.storage.getItem(keys[0]), fakes.storage.getItem(keys[1])], [null, "{舊版留在這台裝置第 2 份"]);
      fakes.storage.removeItem(keys[1]);
      fakes.storage.removeItem("money-island.v1.brokenish");
    });

    await section("v14 出路畫面一律回頂端、不記捲動", async () => {
      const visited = { moneyIslandEntry: true, [ENTRY_SCROLL_KEY]: 1500 };
      assertEqual("對照：上一頁回到有記號的紀錄，恢復 1500", entryScrollPlan(visited, true), { top: 1500, track: true });
      assertEqual("對照：點連結進新頁回頂端", entryScrollPlan(visited, false), { top: 0, track: true });
      assertEqual("出路畫面：同一筆有記號、位置 1500，照樣回頂端而且不記捲動", entryScrollPlan(visited, true, true), { top: 0, track: false });
      assertEqual("出路畫面：沒有記號也回頂端、不記捲動", entryScrollPlan({}, false, true), { top: 0, track: false });
    });

    await section("v14 確認框：點到停用中的確定鈕，焦點回到「取消」", async () => {
      const modalRoot = document.createElement("div");
      modalRoot.id = "modal-root";
      document.body.append(modalRoot);
      try {
        for (const danger of [true, false]) {
          const label = danger ? "危險確認框" : "一般確認框";
          const answer = common.confirmDialog("測試焦點", danger ? { danger: true, confirmLabel: "刪除這筆紀錄" } : {});
          const dialog = modalRoot.querySelector(".modal");
          const okButton = modalRoot.querySelector("[data-confirm-ok]");
          const cancelButton = modalRoot.querySelector("[data-confirm-cancel]");
          assertEqual(`${label}：剛打開時確定鈕停用`, okButton.disabled, true);
          // 模擬瀏覽器點停用按鈕的結果：pointerdown 之後焦點移走（危險確認框掉到 body、一般確認框停在對話框本身）
          okButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          if (danger) document.activeElement.blur(); else dialog.focus();
          await wait(20);
          assert(`${label}：焦點沒有掉到 body`, document.activeElement !== document.body);
          assert(`${label}：焦點回到「取消」`, Boolean(cancelButton) && document.activeElement === cancelButton);
          // 停用期間焦點直接被移走（沒有點確定鈕）也交回取消
          cancelButton.blur();
          await wait(20);
          assert(`${label}：停用期間焦點掉到 body 也交回「取消」`, document.activeElement === cancelButton);
          common.closeModal();
          assertEqual(`${label}：關掉照舊回答「取消」`, await answer, false);
        }
      } finally {
        common.closeModal();
        modalRoot.remove();
      }
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
