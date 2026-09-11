// 小小理財島 PWA：引擎層自我測試（不用任何測試框架）。
// 跑法：用任何靜態伺服器把 docs/ 當根打開 dev/selftest.html。
// db.js 由 importmap 換成 db-mock.js，所以測試不會真的寫進 localStorage 的帳本。

import { KIND_NAMES, derive, freshState, normalize } from "../js/state.js";
import * as pin from "../js/pin.js";
import * as store from "../js/store.js";
import * as backup from "../js/backup.js";
import * as db from "./db-mock.js";

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
  }

  report(fail === 0, `PASS ${pass} / FAIL ${fail}`, true);
  return { pass, fail };
}
