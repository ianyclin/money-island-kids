// 小小理財島 PWA：空白帳本、備份驗證器（normalize）、畫面用衍生欄位（derive）、排序。
// 規則來源：db/money-store.ts（seedNewFamily L341–376、預設專案 L1138–1161、
// readFuturePrincipals L1323–1337、getMoneyState L1435–1496、validateBackupEnvelope L3207–3456）。

import { uuid, familyCode as newFamilyCode, nowIso, taipeiMonth } from "./util.js";

// ---------- 常數 ----------

// money-store.ts L115–124
export const GARDEN_SPECIES = ["tree", "cherry", "pine", "sunflower", "tulip", "daisy"];
export const PORTABLE_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_PORTABLE_PHOTO_BYTES = 4 * 1024 * 1024;
export const MAX_PORTABLE_PHOTO_TOTAL_BYTES = 18 * 1024 * 1024;
const DEFAULT_GARDENS = { "kid-one": "tree", "kid-two": "cherry", "kid-three": "sunflower" };

// 一位孩子最多 5 位（契約第 5 節 addProfile）。前三位照 seedNewFamily L343–347；
// 第四、五位的表情與色彩是單機版新增的（色碼取自 app/globals.css 既有的兩個主色）。
export const MAX_PROFILES = 5;
const SEED_CHILDREN = [
  { avatar: "🐯", accent: "#5AAE9B", garden: "tree" },
  { avatar: "🐰", accent: "#EF8FB1", garden: "cherry" },
  { avatar: "🐼", accent: "#F4A261", garden: "sunflower" },
  { avatar: "🐨", accent: "#2A8584", garden: "pine" },
  { avatar: "🦊", accent: "#9B4561", garden: "tulip" },
];

// app/history/page.tsx kindName L199–202
export const KIND_NAMES = {
  allowance: "零用錢",
  spend: "花費",
  reward: "爸媽獎勵",
  project: "家庭小專案",
  dream: "夢想罐",
  "savings-transfer": "自主存錢",
  "piggy-adjustment": "撲滿校正",
  "stock-buy": "股票買入",
  etf: "投資",
  harvest: "過年收成",
  "market-update": "市值更新",
  "sheet-deposit": "試算表存款",
  welcome: "開始",
};

export function kindName(kind) {
  return KIND_NAMES[kind] ?? kind;
}

// ---------- 空白帳本 ----------

// money-store.ts seedNewFamily L341–376 ＋ 預設專案 L1138–1161 ＋ 預設常用標的 L367–374
export function freshState({ familyName, kidNames, savingsRate = 30 } = {}) {
  const name = String(familyName ?? "").trim().slice(0, 30);
  if (name.length < 2) throw new Error("請輸入家庭名稱");
  const names = (Array.isArray(kidNames) ? kidNames : [kidNames])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  if (!names.length) throw new Error("請至少輸入一位小朋友的名字");
  if (names.length > MAX_PROFILES) throw new Error(`最多只能有 ${MAX_PROFILES} 位小朋友`);
  for (const kidName of names) {
    if (Array.from(kidName).length > 12) throw new Error("名字請輸入 1 到 12 個字");
  }
  const rate = Math.round(Number(savingsRate));
  if (!Number.isFinite(rate) || rate < 0 || rate > 100 || rate % 5 !== 0) {
    throw new Error("預先儲蓄比例請以 5% 為單位，設定在 0% 到 100% 之間");
  }

  const stamp = nowIso();
  const profiles = names.map((kidName, index) => {
    const seed = SEED_CHILDREN[index % SEED_CHILDREN.length];
    return {
      id: uuid(),
      name: kidName,
      avatar: seed.avatar,
      accent: seed.accent,
      spendingBalance: 0,
      bankBalance: 0,
      marketValue: 0,
      stockCode: null,
      stockUnits: 0,
      stockCost: 0,
      lastSyncedAt: null,
      updatedAt: stamp,
      gardenSpecies: seed.garden,
    };
  });

  const state = {
    version: 1,
    family: { id: uuid(), code: newFamilyCode(), name },
    profiles,
    activities: [],
    projects: [
      {
        id: "project-toys",
        title: "整理一箱舊玩具",
        description: "和家長一起分成保留、送人與回收三類，完成整箱才算完成。",
        reward: 50,
        status: "open",
        assignedProfileId: null,
        createdAt: stamp,
        updatedAt: stamp,
        completedAt: null,
      },
      {
        id: "project-snacks",
        title: "規劃家庭點心採買",
        description: "列出想買的品項、比較價格，並把總額控制在家長給的預算內。",
        reward: 40,
        status: "open",
        assignedProfileId: null,
        createdAt: stamp,
        updatedAt: stamp,
        completedAt: null,
      },
    ],
    holdings: [],
    purchases: [],
    investmentPresets: [
      { id: uuid(), symbol: "00646", name: "元大 S&P 500", category: "ETF", sortOrder: 1, active: true, createdAt: stamp, updatedAt: stamp },
      { id: uuid(), symbol: "0050", name: "元大台灣 50", category: "ETF", sortOrder: 2, active: true, createdAt: stamp, updatedAt: stamp },
    ],
    dreamJars: [],
    reflections: [],
    harvests: [],
    savingsTransfers: [],
    savingsRate: rate,
    latestBackup: null,
    backupHealth: { status: "pending" },
    meta: {
      createdAt: stamp,
      updatedAt: stamp,
      selectedProfileId: profiles[0].id,
      installHintDismissed: false,
    },
  };
  return state;
}

// ---------- 排序（原本由 SQL ORDER BY 負責）----------

const PROJECT_STATUS_ORDER = { waiting: 1, claimed: 2, open: 3 };

function descend(a, b) {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

function ascend(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// readActivities L1339–1346、readProjects L1280–1285、readHoldings L1287–1291、
// readPurchases L1293–1297、readDreamJars L1299–1303、readReflections L1305–1309、
// readHarvests L1311–1315、readSavingsTransfers L1317–1321、readInvestmentPresets L1398–1402
export function sortAll(state) {
  state.activities.sort((a, b) => descend(a.entryDate, b.entryDate) || descend(a.createdAt, b.createdAt) || descend(a.id, b.id));
  state.projects.sort((a, b) =>
    ascend(PROJECT_STATUS_ORDER[a.status] ?? 4, PROJECT_STATUS_ORDER[b.status] ?? 4)
    || descend(a.updatedAt, b.updatedAt));
  state.holdings.sort((a, b) => ascend(a.profileId, b.profileId) || descend(a.marketValue, b.marketValue) || ascend(a.symbol, b.symbol));
  state.purchases.sort((a, b) => descend(a.purchaseDate, b.purchaseDate) || descend(a.createdAt, b.createdAt));
  state.investmentPresets.sort((a, b) => ascend(a.sortOrder, b.sortOrder) || ascend(a.symbol, b.symbol));
  state.dreamJars.sort((a, b) => ascend(a.status, b.status) || descend(a.updatedAt, b.updatedAt));
  state.reflections.sort((a, b) => descend(a.month, b.month) || descend(a.updatedAt, b.updatedAt));
  state.harvests.sort((a, b) => descend(a.year, b.year) || descend(a.createdAt, b.createdAt));
  state.savingsTransfers.sort((a, b) =>
    ascend(a.status === "pending" ? 1 : 2, b.status === "pending" ? 1 : 2)
    || descend(a.updatedAt, b.updatedAt));
  return state;
}

// ---------- 畫面用衍生欄位 ----------

// readFuturePrincipals L1323–1337
export function futurePrincipalOf(activities, profileId) {
  let amount = 0;
  for (const activity of activities) {
    if (activity.profileId !== profileId) continue;
    if (["allowance", "project", "sheet-deposit", "savings-transfer"].includes(activity.kind)) amount += activity.bankDelta;
    else if (activity.kind === "harvest") amount -= activity.amount;
    else if (activity.kind === "harvest-void") amount += activity.amount;
    else if (activity.kind === "harvest-correction") amount -= activity.amount;
  }
  return Math.max(0, Math.round(amount));
}

// getMoneyState L1461–1473：rewardClaimedThisMonth／shortDreamBalance／gardenSpecies／futurePrincipal
export function derive(state) {
  const month = taipeiMonth();
  const profiles = state.profiles.map((profile) => ({
    ...profile,
    rewardClaimedThisMonth: state.activities.some((activity) =>
      activity.profileId === profile.id && activity.kind === "reward" && activity.entryDate.slice(0, 7) === month),
    shortDreamBalance: profile.spendingBalance,
    gardenSpecies: profile.gardenSpecies ?? DEFAULT_GARDENS[profile.id] ?? "tree",
    futurePrincipal: futurePrincipalOf(state.activities, profile.id),
  }));
  return {
    ...state,
    profiles,
    // readInvestmentPresets L1398–1402 只回傳 active = 1 的常用標的。
    investmentPresets: state.investmentPresets.filter((preset) => preset.active !== false),
  };
}

// ---------- 備份驗證器 ----------
// money-store.ts L3126–3456 的完整移植；錯誤文案一字不改。

export function invalidBackup(detail) {
  throw new Error(`備份檔內容不正確：${detail}`);
}

export function backupRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidBackup(`${label}格式錯誤`);
  return value;
}

export function backupString(value, label, min = 1, max = 500) {
  if (typeof value !== "string" || value.length < min || value.length > max) invalidBackup(`${label}格式錯誤`);
  return value;
}

export function backupId(value, label) {
  const id = backupString(value, label, 1, 128);
  if (/\s/.test(id)) invalidBackup(`${label}不能包含空白`);
  return id;
}

export function backupNumber(value, label, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidBackup(`${label}不是有效數字`);
  if (options.integer && !Number.isInteger(value)) invalidBackup(`${label}必須是整數`);
  if (options.min !== undefined && value < options.min) invalidBackup(`${label}小於允許範圍`);
  if (options.max !== undefined && value > options.max) invalidBackup(`${label}超過允許範圍`);
  return value;
}

export function backupNullableString(value, label, max = 500) {
  if (value === null || value === undefined) return null;
  return backupString(value, label, 0, max);
}

export function backupTimestamp(value, label, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  const stamp = backupString(value, label, 1, 48);
  if (!Number.isFinite(Date.parse(stamp))) invalidBackup(`${label}不是有效日期時間`);
  return stamp;
}

export function backupDate(value, label) {
  const date = backupString(value, label, 10, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) invalidBackup(`${label}不是有效日期`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() + 1 !== Number(match[2]) || parsed.getUTCDate() !== Number(match[3])) {
    invalidBackup(`${label}不是有效日期`);
  }
  return date;
}

export function backupMonth(value, label) {
  const month = backupString(value, label, 7, 7);
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) invalidBackup(`${label}不是有效月份`);
  return month;
}

export function backupEnum(value, label, values) {
  const item = backupString(value, label, 1, 40);
  if (!values.includes(item)) invalidBackup(`${label}不是支援的選項`);
  return item;
}

function backupRecords(state, key, minimum, maximum) {
  const value = state[key];
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalidBackup(`${key}筆數不正確`);
  return value.map((item, index) => backupRecord(item, `${key}[${index}]`));
}

export function addBackupUnique(seen, value, label) {
  if (seen.has(value)) invalidBackup(`${label}重複`);
  seen.add(value);
}

// validateBackupEnvelope L3207–3456
export function validateBackupEnvelope(value) {
  const root = backupRecord(value, "備份檔");
  if (root.format !== "money-island-backup" || root.version !== 1) {
    throw new Error("備份檔版本不支援，請使用網站下載的 JSON 檔案");
  }
  backupTimestamp(root.exportedAt, "匯出時間");
  const family = backupRecord(root.family, "家庭資料");
  const familyId = backupId(family.id, "家庭代碼");
  backupString(family.code, "家庭代碼", 1, 64);
  backupString(family.name, "家庭名稱", 1, 80);
  const state = backupRecord(root.state, "帳本資料");
  if (state.family !== undefined && state.family !== null) {
    const stateFamily = backupRecord(state.family, "帳本家庭資料");
    if (backupId(stateFamily.id, "帳本家庭代碼") !== familyId) invalidBackup("帳本家庭與備份家庭不一致");
    backupString(stateFamily.code, "帳本家庭代碼", 1, 64);
    backupString(stateFamily.name, "帳本家庭名稱", 1, 80);
  }

  const profiles = backupRecords(state, "profiles", 1, 12);
  const activities = backupRecords(state, "activities", 0, 10000);
  const projects = backupRecords(state, "projects", 0, 2000);
  const holdings = backupRecords(state, "holdings", 0, 1000);
  const purchases = backupRecords(state, "purchases", 0, 20000);
  const presets = backupRecords(state, "investmentPresets", 0, 200);
  const dreams = backupRecords(state, "dreamJars", 0, 2000);
  const reflections = backupRecords(state, "reflections", 0, 5000);
  const harvests = backupRecords(state, "harvests", 0, 2000);
  const savingsTransfers = backupRecords(state, "savingsTransfers", 0, 10000);
  const savingsRate = backupNumber(state.savingsRate, "預先儲蓄比例", { min: 0, max: 100, integer: true });
  if (savingsRate % 5 !== 0) invalidBackup("預先儲蓄比例必須以 5% 為單位");

  const profileIds = new Set();
  for (const profile of profiles) {
    const id = backupId(profile.id, "孩子 ID");
    addBackupUnique(profileIds, id, "孩子 ID");
    backupString(profile.name, "孩子名字", 1, 30);
    // 原本上限 2048（舊站頭像是短網址）；單機版照片直接存 data URL，放寬到 200,000 字（壓縮後約 60,000 以內）。
    const avatarIsDataUrl = typeof profile.avatar === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(profile.avatar);
    backupString(profile.avatar, "孩子頭像", 1, avatarIsDataUrl ? 200000 : 2048);
    backupString(profile.accent, "孩子色彩", 1, 64);
    backupNumber(profile.spendingBalance, "撲滿金額", { min: 0, max: 1000000000000, integer: true });
    backupNumber(profile.bankBalance, "爸媽銀行金額", { min: 0, max: 1000000000000, integer: true });
    backupNumber(profile.marketValue, "投資市值", { min: 0, max: 1000000000000, integer: true });
    backupNullableString(profile.stockCode, "投資代號", 32);
    backupNumber(profile.stockUnits, "投資股數", { min: 0, max: 1000000000000 });
    backupNumber(profile.stockCost, "投資成本", { min: 0, max: 1000000000000, integer: true });
    backupTimestamp(profile.lastSyncedAt, "同步時間", true);
    backupTimestamp(profile.updatedAt, "孩子更新時間");
    if (profile.rewardClaimedThisMonth !== undefined && typeof profile.rewardClaimedThisMonth !== "boolean") invalidBackup("本月獎勵狀態格式錯誤");
    if (profile.shortDreamBalance !== undefined) backupNumber(profile.shortDreamBalance, "短期夢想金額", { min: 0, max: 1000000000000, integer: true });
    if (profile.futurePrincipal !== undefined) backupNumber(profile.futurePrincipal, "累積存給未來", { min: 0, max: 1000000000000, integer: true });
    if (profile.gardenSpecies !== undefined) backupEnum(profile.gardenSpecies, "花園種類", GARDEN_SPECIES);
  }

  const activityIds = new Set();
  const activityProfiles = new Map();
  for (const activity of activities) {
    const id = backupId(activity.id, "紀錄 ID");
    addBackupUnique(activityIds, id, "紀錄 ID");
    const profileId = backupId(activity.profileId, "紀錄孩子 ID");
    if (!profileIds.has(profileId)) invalidBackup("紀錄連到不存在的孩子");
    activityProfiles.set(id, profileId);
    backupString(activity.kind, "紀錄類型", 1, 50);
    backupString(activity.label, "紀錄名稱", 1, 120);
    backupNumber(activity.amount, "紀錄金額", { min: -1000000000000, max: 1000000000000, integer: true });
    backupNumber(activity.spendDelta, "撲滿變動", { min: -1000000000000, max: 1000000000000, integer: true });
    backupNumber(activity.bankDelta, "爸媽銀行變動", { min: -1000000000000, max: 1000000000000, integer: true });
    backupNumber(activity.marketDelta, "投資市值變動", { min: -1000000000000, max: 1000000000000, integer: true });
    backupString(activity.note, "紀錄備註", 0, 1000);
    backupDate(activity.entryDate, "紀錄日期");
    backupString(activity.source, "紀錄來源", 1, 40);
    if (activity.operationId !== undefined && activity.operationId !== null) {
      backupString(activity.operationId, "紀錄操作 ID", 8, 120);
    }
    backupTimestamp(activity.createdAt, "紀錄建立時間");
  }

  const projectIds = new Set();
  for (const project of projects) {
    addBackupUnique(projectIds, backupId(project.id, "專案 ID"), "專案 ID");
    backupString(project.title, "專案名稱", 1, 80);
    backupString(project.description, "專案說明", 0, 1000);
    backupNumber(project.reward, "專案獎勵", { min: 0, max: 10000000, integer: true });
    const status = backupEnum(project.status, "專案狀態", ["open", "claimed", "waiting", "completed"]);
    const assignedProfileId = backupNullableString(project.assignedProfileId, "專案孩子 ID", 128);
    if (assignedProfileId && !profileIds.has(assignedProfileId)) invalidBackup("專案連到不存在的孩子");
    if (status !== "open" && !assignedProfileId) invalidBackup("已接下的專案缺少孩子資料");
    backupTimestamp(project.createdAt, "專案建立時間");
    backupTimestamp(project.updatedAt, "專案更新時間");
    const completedAt = backupTimestamp(project.completedAt, "專案完成時間", true);
    if (status === "completed" && !completedAt) invalidBackup("已完成專案缺少完成時間");
  }

  const holdingIds = new Set();
  const holdingKeys = new Set();
  const holdingRefs = new Map();
  for (const holding of holdings) {
    const id = backupId(holding.id, "持股 ID");
    addBackupUnique(holdingIds, id, "持股 ID");
    const profileId = backupId(holding.profileId, "持股孩子 ID");
    if (!profileIds.has(profileId)) invalidBackup("持股連到不存在的孩子");
    const symbol = backupString(holding.symbol, "投資代號", 2, 12).toUpperCase();
    if (!/^[0-9A-Z.\-]{2,12}$/.test(symbol)) invalidBackup("投資代號格式錯誤");
    addBackupUnique(holdingKeys, `${profileId}\n${symbol}`, "同一孩子的投資代號");
    holdingRefs.set(id, { profileId, symbol });
    backupString(holding.name, "投資名稱", 1, 80);
    backupEnum(holding.category, "投資類型", ["ETF", "股票"]);
    backupNumber(holding.units, "持股股數", { min: 0, max: 1000000000000 });
    backupNumber(holding.costBasis, "持股成本", { min: 0, max: 1000000000000, integer: true });
    backupNumber(holding.marketValue, "持股市值", { min: 0, max: 1000000000000, integer: true });
    backupString(holding.currency, "持股幣別", 1, 8);
    if (holding.quotePrice !== undefined && holding.quotePrice !== null) backupNumber(holding.quotePrice, "收盤價", { min: 0, max: 1000000000 });
    if (holding.quoteAsOf !== undefined && holding.quoteAsOf !== null) backupDate(holding.quoteAsOf, "收盤價日期");
    backupNullableString(holding.quoteSource, "報價來源", 120);
    backupTimestamp(holding.priceUpdatedAt, "報價更新時間", true);
    backupTimestamp(holding.createdAt, "持股建立時間");
    backupTimestamp(holding.updatedAt, "持股更新時間");
  }

  const purchaseIds = new Set();
  const operationIds = new Set();
  for (const purchase of purchases) {
    addBackupUnique(purchaseIds, backupId(purchase.id, "買入 ID"), "買入 ID");
    const profileId = backupId(purchase.profileId, "買入孩子 ID");
    const holdingId = backupId(purchase.holdingId, "買入持股 ID");
    const holding = holdingRefs.get(holdingId);
    if (!holding || holding.profileId !== profileId || !profileIds.has(profileId)) invalidBackup("買入紀錄的孩子或持股關聯錯誤");
    const symbol = backupString(purchase.symbol, "買入代號", 2, 12).toUpperCase();
    if (holding.symbol !== symbol) invalidBackup("買入紀錄與持股代號不一致");
    backupString(purchase.name, "買入名稱", 1, 80);
    backupNumber(purchase.units, "買入股數", { min: Number.EPSILON, max: 1000000000000 });
    backupNumber(purchase.totalCost, "買入成本", { min: 1, max: 1000000000000, integer: true });
    backupDate(purchase.purchaseDate, "買入日期");
    backupString(purchase.note, "買入備註", 0, 1000);
    const operationId = backupNullableString(purchase.operationId, "買入操作 ID", 128);
    if (operationId) addBackupUnique(operationIds, operationId, "買入操作 ID");
    backupTimestamp(purchase.createdAt, "買入建立時間");
  }

  const presetIds = new Set();
  const presetSymbols = new Set();
  for (const preset of presets) {
    addBackupUnique(presetIds, backupId(preset.id, "常用標的 ID"), "常用標的 ID");
    const symbol = backupString(preset.symbol, "常用標的代號", 2, 12).toUpperCase();
    if (!/^[0-9A-Z.\-]{2,12}$/.test(symbol)) invalidBackup("常用標的代號格式錯誤");
    addBackupUnique(presetSymbols, symbol, "常用標的代號");
    backupString(preset.name, "常用標的名稱", 1, 80);
    backupEnum(preset.category, "常用標的類型", ["ETF", "股票"]);
    backupNumber(preset.sortOrder, "常用標的順序", { min: 0, max: 10000, integer: true });
    if (typeof preset.active !== "boolean") invalidBackup("常用標的啟用狀態格式錯誤");
    backupTimestamp(preset.createdAt, "常用標的建立時間");
    backupTimestamp(preset.updatedAt, "常用標的更新時間");
  }

  const dreamIds = new Set();
  const dreamRefs = new Map();
  const activeDreamKeys = new Set();
  for (const dream of dreams) {
    const id = backupId(dream.id, "夢想 ID");
    addBackupUnique(dreamIds, id, "夢想 ID");
    const profileId = backupId(dream.profileId, "夢想孩子 ID");
    if (!profileIds.has(profileId)) invalidBackup("夢想連到不存在的孩子");
    backupString(dream.title, "夢想名稱", 1, 80);
    const kind = backupEnum(dream.kind, "夢想類型", ["short", "long"]);
    const status = backupEnum(dream.status, "夢想狀態", ["active", "queued", "completed"]);
    if (status === "active") addBackupUnique(activeDreamKeys, `${profileId}\n${kind}`, "同類型進行中的夢想");
    backupNumber(dream.targetAmount, "夢想目標", { min: 0, max: 1000000000000, integer: true });
    backupNumber(dream.balance, "夢想金額", { min: 0, max: 1000000000000, integer: true });
    backupTimestamp(dream.createdAt, "夢想建立時間");
    backupTimestamp(dream.updatedAt, "夢想更新時間");
    const completedAt = backupTimestamp(dream.completedAt, "夢想完成時間", true);
    const completedAmount = dream.completedAmount === null || dream.completedAmount === undefined
      ? null
      : backupNumber(dream.completedAmount, "夢想完成金額", { min: 0, max: 1000000000000, integer: true });
    if (status === "completed" && (!completedAt || completedAmount === null)) invalidBackup("已完成夢想缺少完成資料");
    dreamRefs.set(id, { profileId, kind });
  }

  const reflectionIds = new Set();
  const reflectionKeys = new Set();
  for (const reflection of reflections) {
    addBackupUnique(reflectionIds, backupId(reflection.id, "回顧 ID"), "回顧 ID");
    const profileId = backupId(reflection.profileId, "回顧孩子 ID");
    if (!profileIds.has(profileId)) invalidBackup("回顧連到不存在的孩子");
    const month = backupMonth(reflection.month, "回顧月份");
    addBackupUnique(reflectionKeys, `${profileId}\n${month}`, "同月份回顧");
    backupString(reflection.proudText, "回顧內容", 0, 2000);
    backupString(reflection.changeText, "回顧內容", 0, 2000);
    backupString(reflection.planText, "回顧內容", 0, 2000);
    backupTimestamp(reflection.updatedAt, "回顧更新時間");
  }

  const harvestIds = new Set();
  const harvestKeys = new Set();
  for (const harvest of harvests) {
    addBackupUnique(harvestIds, backupId(harvest.id, "收成 ID"), "收成 ID");
    const profileId = backupId(harvest.profileId, "收成孩子 ID");
    const holdingId = backupId(harvest.holdingId, "收成持股 ID");
    const holding = holdingRefs.get(holdingId);
    if (!holding || holding.profileId !== profileId || !profileIds.has(profileId)) invalidBackup("收成紀錄的孩子或持股關聯錯誤");
    const year = backupNumber(harvest.year, "收成年份", { min: 1900, max: 2200, integer: true });
    addBackupUnique(harvestKeys, `${profileId}\n${year}`, "同年度收成");
    backupNumber(harvest.percentage, "收成比例", { min: 0, max: 100 });
    backupNumber(harvest.soldUnits, "收成賣出股數", { min: Number.EPSILON, max: 1000000000000 });
    backupNumber(harvest.referenceMarketValue, "收成參考市值", { min: 0, max: 1000000000000, integer: true });
    backupNumber(harvest.netProceeds, "收成淨入帳", { min: 1, max: 1000000000000, integer: true });
    if (harvest.marketValueReduction !== undefined) backupNumber(harvest.marketValueReduction, "收成扣除市值", { min: 0, max: 1000000000000, integer: true });
    if (harvest.costBasisReduction !== undefined) backupNumber(harvest.costBasisReduction, "收成扣除成本", { min: 0, max: 1000000000000, integer: true });
    const destinationDreamId = backupNullableString(harvest.destinationDreamId, "收成夢想 ID", 128);
    if (destinationDreamId) {
      const dream = dreamRefs.get(destinationDreamId);
      if (!dream || dream.profileId !== profileId || dream.kind !== "short") invalidBackup("收成目的夢想關聯錯誤");
    }
    const saleDate = backupDate(harvest.saleDate, "收成日期");
    if (Number(saleDate.slice(0, 4)) !== year) invalidBackup("收成年份與日期不一致");
    backupString(harvest.note, "收成備註", 0, 1000);
    backupTimestamp(harvest.createdAt, "收成建立時間");
  }

  const savingsIds = new Set();
  for (const transfer of savingsTransfers) {
    addBackupUnique(savingsIds, backupId(transfer.id, "自主存錢 ID"), "自主存錢 ID");
    const profileId = backupId(transfer.profileId, "自主存錢孩子 ID");
    if (!profileIds.has(profileId)) invalidBackup("自主存錢連到不存在的孩子");
    backupNumber(transfer.amount, "自主存錢金額", { min: 1, max: 1000000000000, integer: true });
    backupString(transfer.note, "自主存錢備註", 0, 1000);
    const status = backupEnum(transfer.status, "自主存錢狀態", ["pending", "approved", "rejected", "reversed"]);
    const activityId = backupNullableString(transfer.activityId, "自主存錢紀錄 ID", 128);
    if (transfer.operationId !== undefined && transfer.operationId !== null) {
      backupString(transfer.operationId, "自主存錢操作 ID", 8, 120);
    }
    if (status === "approved" && (!activityId || !activityIds.has(activityId))) invalidBackup("已核准自主存錢缺少對應紀錄");
    if (activityId && activityIds.has(activityId) && activityProfiles.get(activityId) !== profileId) invalidBackup("自主存錢與紀錄的孩子不一致");
    backupTimestamp(transfer.createdAt, "自主存錢建立時間");
    backupTimestamp(transfer.updatedAt, "自主存錢更新時間");
    backupTimestamp(transfer.resolvedAt, "自主存錢處理時間", true);
  }

  if (state.latestBackup !== undefined && state.latestBackup !== null) {
    const latest = backupRecord(state.latestBackup, "最新備份");
    backupId(latest.id, "最新備份 ID");
    backupString(latest.reason, "最新備份原因", 1, 200);
    backupTimestamp(latest.createdAt, "最新備份時間");
  }
  if (state.quoteRefresh !== undefined) {
    const refresh = backupRecord(state.quoteRefresh, "行情更新資料");
    backupString(refresh.source, "行情來源", 1, 200);
    backupTimestamp(refresh.fetchedAt, "行情更新時間");
    if (!Array.isArray(refresh.updatedSymbols) || !Array.isArray(refresh.unavailableSymbols)) invalidBackup("行情標的清單格式錯誤");
    for (const symbol of [...refresh.updatedSymbols, ...refresh.unavailableSymbols]) backupString(symbol, "行情標的", 1, 12);
  }
  return root;
}

// 單機版：normalize 同時吃「備份信封」與「裸的 state」（db.load、gist 還原走裸 state）。
// 裸 state 會先包成信封再走同一套 validateBackupEnvelope，錯誤文案完全一致。
export function normalize(raw) {
  const looksLikeEnvelope = Boolean(raw && typeof raw === "object" && !Array.isArray(raw) && "format" in raw);
  const envelope = looksLikeEnvelope ? raw : {
    format: "money-island-backup",
    version: 1,
    exportedAt: (raw && typeof raw === "object" && !Array.isArray(raw)
      && (raw.meta?.updatedAt || raw.latestBackup?.createdAt)) || nowIso(),
    family: raw && typeof raw === "object" && !Array.isArray(raw) ? raw.family : undefined,
    state: raw,
  };
  validateBackupEnvelope(envelope);
  const source = envelope.state;
  const state = {
    version: 1,
    family: source.family ?? envelope.family,
    profiles: source.profiles.map((profile) => ({ ...profile })),
    activities: source.activities.map((activity) => ({ ...activity })),
    projects: source.projects.map((project) => ({ ...project })),
    holdings: source.holdings.map((holding) => ({ ...holding })),
    purchases: source.purchases.map((purchase) => ({ ...purchase })),
    investmentPresets: source.investmentPresets.map((preset) => ({ ...preset })),
    dreamJars: source.dreamJars.map((dream) => ({ ...dream })),
    reflections: source.reflections.map((reflection) => ({ ...reflection })),
    harvests: source.harvests.map((harvest) => ({ ...harvest })),
    savingsTransfers: source.savingsTransfers.map((transfer) => ({ ...transfer })),
    savingsRate: source.savingsRate,
    latestBackup: source.latestBackup ?? null,
    backupHealth: source.backupHealth ?? { status: "pending" },
    meta: {
      createdAt: source.meta?.createdAt ?? nowIso(),
      updatedAt: source.meta?.updatedAt ?? nowIso(),
      selectedProfileId: source.profiles.some((profile) => profile.id === source.meta?.selectedProfileId)
        ? source.meta.selectedProfileId
        : source.profiles[0].id,
      installHintDismissed: Boolean(source.meta?.installHintDismissed),
    },
  };
  if (source.quoteRefresh) state.quoteRefresh = { ...source.quoteRefresh };
  return sortAll(state);
}
