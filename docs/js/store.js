// 小小理財島 PWA：全部業務規則，從 db/money-store.ts 移植。
// 每支函式開頭標明對應的原始碼行號。錯誤訊息與活動紀錄文案一字不改。
//
// 單機版的三個結構差異：
//   1. 原本靠 SQL 唯一索引做的冪等（operation_id）改成「先查 state 再寫」。
//   2. 原本的 activity_changes 覆蓋層改成直接改 activities；刪除就移除該筆。
//   3. 原本的 profile_preferences.garden_species 改存在 profile 上。
//   withFamilyMutationLock 不需要（單執行緒）；writeBackup 換成 commit() → db.save()。

import {
  calculateProportionalReduction,
  nowIso,
  roundUnits,
  splitBySavingsRate,
  taipeiDate,
  taipeiMonth,
  uuid,
} from "./util.js";
import { GARDEN_SPECIES, MAX_PROFILES, sortAll } from "./state.js";
import { assertParentPin } from "./pin.js";
import { fetchTwseClosingQuotes, isTwseSymbol, TWSE_QUOTE_SOURCE } from "./quotes.js";
import { save } from "./db.js";

// ---------- 單例狀態與提交 ----------

let state = null;
const listeners = new Set();

export function getState() {
  return state;
}

function requireState() {
  if (!state) throw new Error("帳本尚未載入");
  return state;
}

function ensureMeta(next) {
  if (!next.meta) {
    next.meta = {
      createdAt: nowIso(),
      updatedAt: nowIso(),
      selectedProfileId: next.profiles[0]?.id ?? "",
      installHintDismissed: false,
    };
  }
  return next;
}

// 開機用：把 db.load() 讀回來的帳本放進 store，但不回寫。
export function hydrate(next) {
  state = next ? sortAll(ensureMeta(next)) : null;
  notify();
  return state;
}

// 還原備份用：換掉整份帳本並立刻存檔。
export function setState(next, reason = "還原備份") {
  state = sortAll(ensureMeta(next));
  return commit(reason);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of [...listeners]) listener(state);
}

// money-store.ts L2489–2494（更新收盤價後重算）與 L3792–3806（還原後重算）：
// 持股彙總一律以 holdings 為準，不信任 profile 上重複存的數字。
function recomputeHoldingTotals(next) {
  for (const profile of next.profiles) {
    const owned = next.holdings.filter((holding) => holding.profileId === profile.id);
    profile.marketValue = owned.reduce((sum, holding) => sum + Math.round(holding.marketValue), 0);
    profile.stockCost = owned.reduce((sum, holding) => sum + Math.round(holding.costBasis), 0);
    profile.stockUnits = roundUnits(owned.reduce((sum, holding) => sum + holding.units, 0));
    const first = [...owned].sort((a, b) =>
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    profile.stockCode = first ? first.symbol : null;
  }
}

export function commit(reason) {
  const next = requireState();
  recomputeHoldingTotals(next);
  ensureMeta(next).meta.updatedAt = nowIso();
  sortAll(next);
  save(next, reason);
  notify();
  return next;
}

// ---------- 共用小工具 ----------

function findProfile(profileId) {
  const profile = requireState().profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error("找不到這位小朋友");
  return profile;
}

// money-store.ts normalizeOperationId L1423–1427
function normalizeOperationId(value) {
  const operationId = String(value ?? "").trim() || uuid();
  if (!/^[0-9A-Za-z._:-]{8,120}$/.test(operationId)) throw new Error("操作識別碼格式不正確");
  return operationId;
}

function addActivity(fields) {
  const activity = {
    id: uuid(),
    profileId: fields.profileId,
    kind: fields.kind,
    label: fields.label,
    amount: fields.amount,
    spendDelta: fields.spendDelta ?? 0,
    bankDelta: fields.bankDelta ?? 0,
    marketDelta: fields.marketDelta ?? 0,
    note: fields.note ?? "",
    entryDate: fields.entryDate,
    source: fields.source,
    operationId: fields.operationId ?? null,
    createdAt: fields.createdAt,
  };
  requireState().activities.push(activity);
  return activity;
}

function hasRewardThisMonth(profileId, month) {
  return requireState().activities.some((activity) =>
    activity.profileId === profileId && activity.kind === "reward" && activity.entryDate.slice(0, 7) === month);
}

function descendBy(a, b) {
  const left = a ?? "";
  const right = b ?? "";
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

// ---------- 每月存錢獎勵 ----------

// money-store.ts ensureMonthlySavingsRewards L1498–1568
export async function ensureMonthlySavingsRewards() {
  const next = requireState();
  const month = taipeiMonth();
  const candidates = next.profiles.filter((profile) => profile.bankBalance >= 10 && !hasRewardThisMonth(profile.id, month));
  if (candidates.length === 0) return false;

  const stamp = nowIso();
  const entryDate = `${month}-01`;
  let changed = false;
  for (const profile of candidates) {
    const reward = Math.min(100, Math.floor(profile.bankBalance * 0.1));
    if (reward <= 0) continue;
    const operationId = `reward:${profile.id}:${month}`;
    if (next.activities.some((activity) => activity.operationId === operationId)) continue;
    profile.bankBalance += reward;
    profile.updatedAt = stamp;
    addActivity({
      profileId: profile.id,
      kind: "reward",
      label: "爸媽存錢獎勵",
      amount: reward,
      bankDelta: reward,
      note: "每月第一次開啟帳本時自動發放；這是爸媽鼓勵好習慣的加碼，不是市場保證報酬",
      entryDate,
      source: "system",
      operationId,
      createdAt: stamp,
    });
    changed = true;
  }
  if (!changed) return false;
  commit(`${month} 每月存錢獎勵自動發放`);
  return true;
}

// ---------- 記帳 ----------

// money-store.ts addTransaction L1733–1811
export async function addTransaction(input) {
  const next = requireState();
  const month = taipeiMonth();
  const operationId = input.kind === "reward"
    ? `reward:${input.profileId}:${month}`
    : normalizeOperationId(input.operationId);
  if (next.activities.some((activity) => activity.operationId === operationId)) return next;
  const profile = findProfile(input.profileId);

  const amount = Math.round(Number(input.amount ?? 0));
  let recordedAmount = amount;
  let spendDelta = 0;
  let bankDelta = 0;
  let label = String(input.label ?? "").trim().slice(0, 120) || "新增一筆紀錄";
  let note = String(input.note ?? "").trim().slice(0, 1000) || "";

  if (input.kind === "allowance") {
    if (amount <= 0 || amount > 100000) throw new Error("請輸入正確的零用錢金額");
    const split = splitBySavingsRate(amount, next.savingsRate);
    bankDelta = split.bankDelta;
    spendDelta = split.spendDelta;
    label = String(input.label ?? "").trim() || "收到零用錢";
    note = `先存 ${bankDelta} 元，留下 ${spendDelta} 元自己安排`;
  } else if (input.kind === "spend") {
    if (amount <= 0 || amount > profile.spendingBalance) throw new Error("可花零用錢不夠喔");
    spendDelta = -amount;
    label = String(input.label ?? "").trim() || "買了想要的東西";
  } else if (input.kind === "reward") {
    await assertParentPin(input.parentPin);
    if (hasRewardThisMonth(profile.id, month)) throw new Error("這個月的爸媽獎勵已經領過了");
    recordedAmount = Math.min(100, Math.floor(profile.bankBalance * 0.1));
    if (recordedAmount <= 0) throw new Error("爸媽銀行累積到 10 元後就能得到獎勵");
    bankDelta = recordedAmount;
    label = "爸媽存錢獎勵";
    note = "這是爸媽鼓勵好習慣的加碼，不是市場保證報酬";
  }

  const stamp = nowIso();
  const date = taipeiDate();
  profile.spendingBalance += spendDelta;
  profile.bankBalance += bankDelta;
  profile.updatedAt = stamp;
  addActivity({
    profileId: profile.id,
    kind: input.kind,
    label,
    amount: recordedAmount,
    spendDelta,
    bankDelta,
    note,
    entryDate: date,
    source: "app",
    operationId,
    createdAt: stamp,
  });
  return commit(`${profile.name}：${label}`);
}

// money-store.ts setPiggyBankBalance L1813–1845
export async function setPiggyBankBalance(input) {
  await assertParentPin(input.parentPin);
  const profile = findProfile(input.profileId);
  const balance = Math.round(Number(input.balance));
  if (!Number.isFinite(balance) || balance < 0 || balance > 1000000) throw new Error("撲滿金額請設定在 0 到 100 萬元之間");
  const delta = balance - profile.spendingBalance;
  if (delta === 0) return requireState();
  const stamp = nowIso();
  const note = String(input.note ?? "").trim().slice(0, 100)
    || `家長核對實際撲滿：${profile.spendingBalance} 元調整為 ${balance} 元`;
  profile.spendingBalance = balance;
  profile.updatedAt = stamp;
  addActivity({
    profileId: profile.id,
    kind: "piggy-adjustment",
    label: "家長校正撲滿金額",
    amount: Math.abs(delta),
    spendDelta: delta,
    note,
    entryDate: taipeiDate(),
    source: "parent",
    createdAt: stamp,
  });
  return commit(`${profile.name}校正撲滿為 ${balance} 元`);
}

// money-store.ts updateActivityRecord L2747–2824
// 單機版：編輯直接改 activities 的那一筆，刪除直接移除該筆（原本是 activity_changes 覆蓋層）。
export async function updateActivityRecord(input) {
  await assertParentPin(input.parentPin);
  const next = requireState();
  const activity = next.activities.find((item) => item.id === input.activityId);
  if (!activity) throw new Error("找不到這筆紀錄");
  const profile = findProfile(activity.profileId);
  const stamp = nowIso();

  if (input.action === "edit") {
    const label = String(input.label ?? "").trim();
    const note = String(input.note ?? "").trim();
    const entryDate = String(input.entryDate ?? "").trim();
    if (label.length < 1 || label.length > 60) throw new Error("紀錄名稱請保持在 60 個字以內");
    if (note.length > 160) throw new Error("備註請保持在 160 個字以內");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new Error("請輸入正確的日期");
    activity.label = label;
    activity.note = note;
    activity.entryDate = entryDate;
    return commit(`${profile.name}編輯紀錄：${label}`);
  }

  const deletable = (activity.source === "app" && ["allowance", "spend", "reward", "dream", "savings-transfer"].includes(activity.kind))
    || (activity.source === "parent" && activity.kind === "piggy-adjustment");
  if (!deletable) throw new Error("這筆紀錄連結其他帳務，請到對應的家長功能調整，避免餘額或持股失真");
  const nextSpend = profile.spendingBalance - activity.spendDelta;
  const nextBank = profile.bankBalance - activity.bankDelta;
  const nextMarket = profile.marketValue - activity.marketDelta;
  if (nextSpend < 0 || nextBank < 0 || nextMarket < 0) throw new Error("目前餘額不足以撤銷這筆紀錄，請先調整後續帳務");
  let relatedTransfer = null;
  if (activity.kind === "savings-transfer") {
    relatedTransfer = next.savingsTransfers
      .filter((transfer) => transfer.profileId === activity.profileId && transfer.status === "approved"
        && (transfer.activityId === activity.id || (!transfer.activityId && transfer.amount === activity.amount)))
      .sort((a, b) =>
        ((a.activityId === activity.id ? 0 : 1) - (b.activityId === activity.id ? 0 : 1))
        || descendBy(a.resolvedAt, b.resolvedAt))[0] ?? null;
    if (!relatedTransfer) throw new Error("找不到這筆自主存錢所連結的申請，已停止撤銷以避免帳務失真");
  }
  next.activities = next.activities.filter((item) => item.id !== activity.id);
  profile.spendingBalance = nextSpend;
  profile.bankBalance = nextBank;
  profile.marketValue = nextMarket;
  profile.updatedAt = stamp;
  if (relatedTransfer) {
    relatedTransfer.status = "reversed";
    relatedTransfer.resolvedAt = stamp;
    relatedTransfer.updatedAt = stamp;
  }
  return commit(`${profile.name}刪除紀錄：${activity.label}`);
}

// ---------- 設定 ----------

// money-store.ts updateSavingsRate L1570–1586
export async function updateSavingsRate(input) {
  await assertParentPin(input.parentPin);
  const savingsRate = Math.round(Number(input.savingsRate));
  if (!Number.isFinite(savingsRate) || savingsRate < 0 || savingsRate > 100 || savingsRate % 5 !== 0) {
    throw new Error("預先儲蓄比例請以 5% 為單位，設定在 0% 到 100% 之間");
  }
  requireState().savingsRate = savingsRate;
  return commit(`預先儲蓄比例調整為 ${savingsRate}%`);
}

// money-store.ts updateSavingsTransfer L1588–1682
export async function updateSavingsTransfer(input) {
  const next = requireState();
  const stamp = nowIso();

  if (input.action === "request") {
    if (!input.profileId) throw new Error("找不到要存錢的小朋友");
    const operationId = normalizeOperationId(input.operationId);
    if (next.savingsTransfers.some((transfer) => transfer.operationId === operationId)) return next;
    const profile = findProfile(input.profileId);
    const amount = Math.round(Number(input.amount ?? 0));
    const pending = next.savingsTransfers
      .filter((transfer) => transfer.profileId === profile.id && transfer.status === "pending")
      .reduce((sum, transfer) => sum + transfer.amount, 0);
    const available = Math.max(0, profile.spendingBalance - Math.round(pending));
    if (amount <= 0) throw new Error("請輸入想多存的金額");
    if (amount > available) throw new Error("撲滿扣掉等待確認的金額後不夠喔");
    next.savingsTransfers.push({
      id: uuid(),
      profileId: profile.id,
      amount,
      note: String(input.note ?? "").trim().slice(0, 80) || "我想多存一點給未來",
      status: "pending",
      activityId: null,
      operationId,
      createdAt: stamp,
      updatedAt: stamp,
      resolvedAt: null,
    });
    return commit(`${profile.name}提出自主存錢申請`);
  }

  await assertParentPin(input.parentPin);
  if (!input.transferId) throw new Error("找不到這筆自主存錢申請");
  const transfer = next.savingsTransfers.find((item) => item.id === input.transferId);
  if (!transfer) throw new Error("找不到這筆自主存錢申請");
  if ((input.action === "approve" && transfer.status === "approved")
    || (input.action === "reject" && transfer.status === "rejected")) {
    return next;
  }
  if (transfer.status !== "pending") throw new Error("這筆申請已經處理過了");
  const profile = findProfile(transfer.profileId);

  if (input.action === "reject") {
    transfer.status = "rejected";
    transfer.resolvedAt = stamp;
    transfer.updatedAt = stamp;
    return commit(`${profile.name}的自主存錢申請未執行`);
  }

  if (input.action !== "approve") throw new Error("不支援的自主存錢操作");
  if (transfer.amount > profile.spendingBalance) throw new Error("撲滿餘額已變動，目前不足以完成這筆存錢");
  profile.spendingBalance -= transfer.amount;
  profile.bankBalance += transfer.amount;
  profile.updatedAt = stamp;
  const activity = addActivity({
    profileId: profile.id,
    kind: "savings-transfer",
    label: "自主多存到爸媽銀行",
    amount: transfer.amount,
    spendDelta: -transfer.amount,
    bankDelta: transfer.amount,
    note: transfer.note,
    entryDate: taipeiDate(),
    source: "app",
    createdAt: stamp,
  });
  transfer.status = "approved";
  transfer.activityId = activity.id;
  transfer.resolvedAt = stamp;
  transfer.updatedAt = stamp;
  return commit(`${profile.name}自主多存 ${transfer.amount} 元`);
}

// money-store.ts updateGardenSpecies L1684–1698（gardenSpecies 改存在 profile 上）
export function updateGardenSpecies(input) {
  if (!GARDEN_SPECIES.includes(input.gardenSpecies)) throw new Error("找不到這個樹種或花種");
  const profile = findProfile(input.profileId);
  profile.gardenSpecies = input.gardenSpecies;
  return commit("更新 ETF 花園樣式");
}

// money-store.ts updateProfile L1700–1731（單機版沒有找回家庭，refreshRecoveryLookupHash 拿掉）
export async function updateProfile(input) {
  await assertParentPin(input.parentPin);
  const name = String(input.name ?? "").trim();
  if (!name || Array.from(name).length > 12) throw new Error("名字請輸入 1 到 12 個字");
  const profile = findProfile(input.profileId);
  const stamp = nowIso();
  profile.name = name;
  if (input.avatar) profile.avatar = input.avatar;
  profile.updatedAt = stamp;
  return commit(`更新${name}的名字或照片`);
}

// 單機版新增：加入一位小朋友（上限 5 位）。名字驗證沿用 updateProfile L1710 的文案。
const NEW_PROFILE_LOOK = [
  { avatar: "🐯", accent: "#5AAE9B", garden: "tree" },
  { avatar: "🐰", accent: "#EF8FB1", garden: "cherry" },
  { avatar: "🐼", accent: "#F4A261", garden: "sunflower" },
  { avatar: "🐨", accent: "#2A8584", garden: "pine" },
  { avatar: "🦊", accent: "#9B4561", garden: "tulip" },
];

export async function addProfile(input) {
  await assertParentPin(input.parentPin);
  const next = requireState();
  const name = String(input.name ?? "").trim();
  if (!name || Array.from(name).length > 12) throw new Error("名字請輸入 1 到 12 個字");
  if (next.profiles.length >= MAX_PROFILES) throw new Error(`最多只能有 ${MAX_PROFILES} 位小朋友`);
  const stamp = nowIso();
  const used = new Set(next.profiles.map((profile) => profile.avatar));
  const look = NEW_PROFILE_LOOK.find((item) => !used.has(item.avatar)) ?? NEW_PROFILE_LOOK[next.profiles.length % NEW_PROFILE_LOOK.length];
  next.profiles.push({
    id: uuid(),
    name,
    avatar: look.avatar,
    accent: look.accent,
    spendingBalance: 0,
    bankBalance: 0,
    marketValue: 0,
    stockCode: null,
    stockUnits: 0,
    stockCost: 0,
    lastSyncedAt: null,
    updatedAt: stamp,
    gardenSpecies: look.garden,
  });
  return commit(`新增小朋友：${name}`);
}

// 單機版新增：移除一位小朋友；只允許完全沒有留下任何資料的孩子，避免備份出現孤兒參照。
export async function removeProfile(input) {
  await assertParentPin(input.parentPin);
  const next = requireState();
  const profile = findProfile(input.profileId);
  if (next.profiles.length <= 1) throw new Error("至少要保留一位小朋友");
  const referenced = next.activities.some((item) => item.profileId === profile.id)
    || next.holdings.some((item) => item.profileId === profile.id)
    || next.purchases.some((item) => item.profileId === profile.id)
    || next.dreamJars.some((item) => item.profileId === profile.id)
    || next.reflections.some((item) => item.profileId === profile.id)
    || next.harvests.some((item) => item.profileId === profile.id)
    || next.savingsTransfers.some((item) => item.profileId === profile.id)
    || next.projects.some((item) => item.assignedProfileId === profile.id);
  if (referenced) throw new Error("這位小朋友已經有紀錄，不能移除");
  next.profiles = next.profiles.filter((item) => item.id !== profile.id);
  if (next.meta?.selectedProfileId === profile.id) next.meta.selectedProfileId = next.profiles[0].id;
  return commit(`移除小朋友：${profile.name}`);
}

// ---------- 家庭小專案 ----------

// money-store.ts updateFamilyProject L1847–1964
export async function updateFamilyProject(input) {
  const next = requireState();
  const stamp = nowIso();

  if (input.action === "create") {
    await assertParentPin(input.parentPin);
    const title = String(input.title ?? "").trim();
    const description = String(input.description ?? "").trim();
    const reward = Math.round(Number(input.reward ?? 0));
    if (title.length < 2 || title.length > 40) throw new Error("請寫出清楚的小專案名稱");
    if (description.length < 4 || description.length > 180) throw new Error("請簡短說明完成條件");
    if (reward < 10 || reward > 500) throw new Error("小專案報酬請設定在 10 到 500 元之間");
    next.projects.push({
      id: uuid(),
      title,
      description,
      reward,
      status: "open",
      assignedProfileId: null,
      createdAt: stamp,
      updatedAt: stamp,
      completedAt: null,
    });
    return commit(`家長發布小專案：${title}`);
  }

  if (!input.projectId) throw new Error("找不到這個小專案");
  const project = next.projects.find((item) => item.id === input.projectId);
  if (!project) throw new Error("找不到這個小專案");

  if (input.action === "update") {
    await assertParentPin(input.parentPin);
    if (project.status !== "open") throw new Error("只有尚未被接下的專案可以修改");
    const title = String(input.title ?? "").trim();
    const description = String(input.description ?? "").trim();
    const reward = Math.round(Number(input.reward ?? 0));
    if (title.length < 2 || title.length > 40) throw new Error("請寫出清楚的小專案名稱");
    if (description.length < 4 || description.length > 180) throw new Error("請簡短說明完成條件");
    if (reward < 10 || reward > 500) throw new Error("小專案報酬請設定在 10 到 500 元之間");
    project.title = title;
    project.description = description;
    project.reward = reward;
    project.updatedAt = stamp;
    return commit(`家長修改小專案：${title}`);
  }

  if (input.action === "claim") {
    if (!input.profileId) throw new Error("請先選擇小朋友");
    if (project.status !== "open") throw new Error("這個小專案已經有人接了");
    const profile = findProfile(input.profileId);
    project.status = "claimed";
    project.assignedProfileId = profile.id;
    project.updatedAt = stamp;
    return commit(`${profile.name}接下小專案：${project.title}`);
  }

  if (input.action === "submit") {
    if (project.status !== "claimed" || project.assignedProfileId !== input.profileId) {
      throw new Error("目前不能送出這個小專案");
    }
    project.status = "waiting";
    project.updatedAt = stamp;
    return commit(`等待家長確認：${project.title}`);
  }

  if (input.action === "approve") {
    await assertParentPin(input.parentPin);
    if (project.status !== "waiting" || !project.assignedProfileId) throw new Error("這個小專案還沒有等待確認");
    const profile = next.profiles.find((item) => item.id === project.assignedProfileId);
    if (!profile) throw new Error("找不到完成專案的小朋友");
    const savingsRate = next.savingsRate;
    const { bankDelta, spendDelta } = splitBySavingsRate(project.reward, savingsRate);
    profile.spendingBalance += spendDelta;
    profile.bankBalance += bankDelta;
    profile.updatedAt = stamp;
    project.status = "completed";
    project.completedAt = stamp;
    project.updatedAt = stamp;
    addActivity({
      profileId: profile.id,
      kind: "project",
      label: `完成家庭小專案：${project.title}`,
      amount: project.reward,
      spendDelta,
      bankDelta,
      note: `家長確認後發放；依 ${savingsRate}% 比例先存 ${bankDelta} 元，自己安排 ${spendDelta} 元`,
      entryDate: taipeiDate(),
      source: "app",
      createdAt: stamp,
    });
    return commit(`${profile.name}完成小專案：${project.title}`);
  }

  throw new Error("不支援的操作");
}

// ---------- 投資買入 ----------

// money-store.ts addInvestmentPurchase L1966–2067
export async function addInvestmentPurchase(input) {
  await assertParentPin(input.parentPin);
  const next = requireState();
  const operationId = normalizeOperationId(input.operationId);
  if (next.purchases.some((purchase) => purchase.operationId === operationId)) return next;
  const profile = findProfile(input.profileId);

  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  const name = String(input.name ?? "").trim();
  const category = input.category === "股票" ? "股票" : "ETF";
  const units = roundUnits(Number(input.units));
  const totalCost = Math.round(Number(input.totalCost));
  const purchaseDate = String(input.purchaseDate ?? "").trim() || taipeiDate();
  const note = String(input.note ?? "").trim().slice(0, 100) || "爸媽已在真實券商完成買入";

  if (!/^[0-9A-Z.\-]{2,12}$/.test(symbol)) throw new Error("請輸入正確的股票代號");
  if (name.length < 2 || name.length > 40) throw new Error("請輸入標的名稱");
  if (!Number.isFinite(units) || units <= 0 || units > 100000000) throw new Error("請輸入正確的股數");
  if (!Number.isFinite(totalCost) || totalCost <= 0 || totalCost > profile.bankBalance) throw new Error("爸媽銀行的餘額不足以記錄這筆買入");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) throw new Error("請輸入正確的買入日期");

  const stamp = nowIso();
  const existing = next.holdings.find((holding) => holding.profileId === profile.id && holding.symbol === symbol);
  const holdingId = existing?.id ?? uuid();
  if (existing) {
    existing.name = name;
    existing.category = category;
    existing.units = roundUnits(existing.units + units);
    existing.costBasis += totalCost;
    existing.marketValue += totalCost;
    existing.quotePrice = null;
    existing.quoteAsOf = null;
    existing.quoteSource = null;
    existing.priceUpdatedAt = null;
    existing.updatedAt = stamp;
  } else {
    next.holdings.push({
      id: holdingId,
      profileId: profile.id,
      symbol,
      name,
      category,
      units,
      costBasis: totalCost,
      marketValue: totalCost,
      currency: "TWD",
      quotePrice: null,
      quoteAsOf: null,
      quoteSource: null,
      priceUpdatedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  profile.bankBalance -= totalCost;
  profile.marketValue += totalCost;
  profile.stockCost += totalCost;
  profile.updatedAt = stamp;
  next.purchases.push({
    id: uuid(),
    profileId: profile.id,
    holdingId,
    symbol,
    name,
    units,
    totalCost,
    purchaseDate,
    note,
    operationId,
    createdAt: stamp,
  });
  addActivity({
    profileId: profile.id,
    kind: "stock-buy",
    label: `爸媽協助買進 ${symbol}`,
    amount: totalCost,
    bankDelta: -totalCost,
    marketDelta: totalCost,
    note: `${name} · ${units} 股；真實券商完成後記錄`,
    entryDate: purchaseDate,
    source: "parent",
    createdAt: stamp,
  });
  return commit(`${profile.name}買進 ${symbol}`);
}

// money-store.ts loadCorrectablePurchase L2069–2092
function loadCorrectablePurchase(purchaseId) {
  const next = requireState();
  const purchase = next.purchases.find((item) => item.id === purchaseId);
  if (!purchase) throw new Error("找不到這筆買入紀錄");
  const holding = next.holdings.find((item) => item.id === purchase.holdingId);
  const profile = next.profiles.find((item) => item.id === purchase.profileId);
  const laterHarvest = next.harvests.find((item) => item.holdingId === purchase.holdingId && item.saleDate >= purchase.purchaseDate);
  if (!holding || !profile) throw new Error("這筆買入所連結的持股資料不存在");
  if (laterHarvest) throw new Error("這筆買入之後已有賣出紀錄；請先撤銷後續收成，才能安全修正");
  if (holding.units + 0.00001 < purchase.units || holding.costBasis < purchase.totalCost) {
    throw new Error("目前持股不足以安全撤銷這筆買入");
  }
  return { purchase, holding, profile };
}

// money-store.ts voidInvestmentPurchase L2094–2139
export async function voidInvestmentPurchase(input) {
  await assertParentPin(input.parentPin);
  const next = requireState();
  const { purchase, holding, profile } = loadCorrectablePurchase(input.purchaseId);
  const { marketReduction } = calculateProportionalReduction({
    holdingUnits: holding.units,
    soldUnits: purchase.units,
    costBasis: holding.costBasis,
    marketValue: holding.marketValue,
  });
  const nextUnits = Math.max(0, roundUnits(holding.units - purchase.units));
  const nextMarket = Math.max(0, holding.marketValue - marketReduction);
  const nextCost = Math.max(0, holding.costBasis - purchase.totalCost);
  const stamp = nowIso();
  if (nextUnits === 0) {
    next.holdings = next.holdings.filter((item) => item.id !== holding.id);
  } else {
    holding.units = nextUnits;
    holding.costBasis = nextCost;
    holding.marketValue = nextMarket;
    holding.updatedAt = stamp;
  }
  profile.bankBalance += purchase.totalCost;
  profile.marketValue = Math.max(0, profile.marketValue - marketReduction);
  profile.stockCost = Math.max(0, profile.stockCost - purchase.totalCost);
  profile.updatedAt = stamp;
  next.purchases = next.purchases.filter((item) => item.id !== purchase.id);
  addActivity({
    profileId: profile.id,
    kind: "stock-buy-void",
    label: `撤銷買進 ${purchase.symbol}`,
    amount: purchase.totalCost,
    bankDelta: purchase.totalCost,
    marketDelta: -marketReduction,
    note: `撤銷 ${purchase.units} 股；爸媽銀行退回 ${purchase.totalCost} 元`,
    entryDate: taipeiDate(),
    source: "parent",
    createdAt: stamp,
  });
  return commit(`${profile.name}撤銷 ${purchase.symbol} 買入`);
}

// money-store.ts correctInvestmentPurchase L2141–2199
export async function correctInvestmentPurchase(input) {
  await assertParentPin(input.parentPin);
  const { purchase, holding, profile } = loadCorrectablePurchase(input.purchaseId);
  const units = roundUnits(Number(input.units));
  const totalCost = Math.round(Number(input.totalCost));
  const purchaseDate = String(input.purchaseDate ?? "").trim() || purchase.purchaseDate;
  if (!Number.isFinite(units) || units <= 0) throw new Error("請輸入正確的股數");
  if (!Number.isFinite(totalCost) || totalCost <= 0) throw new Error("請輸入正確的投入金額");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) throw new Error("請輸入正確的買入日期");
  const nextBank = profile.bankBalance + purchase.totalCost - totalCost;
  if (nextBank < 0) throw new Error("爸媽銀行的餘額不足以把這筆買入改成較高金額");
  const oldMarketShare = calculateProportionalReduction({
    holdingUnits: holding.units,
    soldUnits: purchase.units,
    costBasis: holding.costBasis,
    marketValue: holding.marketValue,
  }).marketReduction;
  const newMarketShare = holding.quotePrice !== null && holding.quotePrice !== undefined
    ? Math.round(units * holding.quotePrice)
    : totalCost;
  const nextUnits = roundUnits(holding.units - purchase.units + units);
  const nextCost = holding.costBasis - purchase.totalCost + totalCost;
  const nextMarket = Math.max(0, holding.marketValue - oldMarketShare + newMarketShare);
  const stamp = nowIso();
  holding.units = nextUnits;
  holding.costBasis = nextCost;
  holding.marketValue = nextMarket;
  holding.updatedAt = stamp;
  profile.bankBalance = nextBank;
  profile.marketValue = Math.max(0, profile.marketValue - oldMarketShare + newMarketShare);
  profile.stockCost = Math.max(0, profile.stockCost - purchase.totalCost + totalCost);
  profile.updatedAt = stamp;
  const previousUnits = purchase.units;
  const previousTotalCost = purchase.totalCost;
  purchase.units = units;
  purchase.totalCost = totalCost;
  purchase.purchaseDate = purchaseDate;
  purchase.note = input.note === undefined || input.note === null
    ? purchase.note
    : String(input.note).trim().slice(0, 100);
  addActivity({
    profileId: profile.id,
    kind: "stock-buy-correction",
    label: `修正 ${purchase.symbol} 買入`,
    amount: Math.abs(totalCost - previousTotalCost),
    bankDelta: previousTotalCost - totalCost,
    marketDelta: newMarketShare - oldMarketShare,
    note: `由 ${previousUnits} 股／${previousTotalCost} 元修正為 ${units} 股／${totalCost} 元`,
    entryDate: purchaseDate,
    source: "parent",
    createdAt: stamp,
  });
  return commit(`${profile.name}修正 ${purchase.symbol} 買入`);
}

// ---------- 市值與行情 ----------

// money-store.ts updateHoldingMarketValue L2392–2432
export async function updateHoldingMarketValue(input) {
  await assertParentPin(input.parentPin);
  const next = requireState();
  const holding = next.holdings.find((item) => item.id === input.holdingId);
  if (!holding) throw new Error("找不到這個投資標的");
  const profile = findProfile(holding.profileId);
  const marketValue = Math.round(Number(input.marketValue));
  if (!Number.isFinite(marketValue) || marketValue < 0 || marketValue > 100000000) throw new Error("請輸入正確的市值");
  const delta = marketValue - holding.marketValue;
  const stamp = nowIso();
  const quotePrice = holding.units > 0 ? marketValue / holding.units : null;
  holding.marketValue = marketValue;
  holding.quotePrice = quotePrice;
  holding.quoteAsOf = taipeiDate();
  holding.quoteSource = "家長手動輸入";
  holding.priceUpdatedAt = stamp;
  holding.updatedAt = stamp;
  profile.marketValue += delta;
  profile.updatedAt = stamp;
  addActivity({
    profileId: profile.id,
    kind: "market-update",
    label: `更新 ${holding.symbol} 市值`,
    amount: Math.abs(delta),
    marketDelta: delta,
    note: `家長更新為 ${marketValue} 元；不是即時報價`,
    entryDate: taipeiDate(),
    source: "parent",
    createdAt: stamp,
  });
  return commit(`${profile.name}更新 ${holding.symbol} 市值`);
}

// money-store.ts refreshTwseClosingPrices L2434–2506
// 契約第 5 節：回傳 { updatedSymbols, unavailableSymbols, fetchedAt, source }。
export async function refreshTwseClosingPrices(input = {}) {
  if (input.mode !== "auto") await assertParentPin(input.parentPin);
  const next = requireState();
  const holdings = next.holdings.filter((holding) => !input.profileId || holding.profileId === input.profileId);
  const supportedSymbols = [...new Set(holdings.map((holding) => holding.symbol).filter(isTwseSymbol))];
  if (supportedSymbols.length === 0) throw new Error("目前沒有可由臺灣證券交易所更新的上市標的");

  const quoteRows = await fetchTwseClosingQuotes(supportedSymbols);
  const quotes = new Map(quoteRows.map((quote) => [quote.symbol, quote]));
  const available = supportedSymbols.filter((symbol) => quotes.has(symbol));
  const unavailableSymbols = supportedSymbols.filter((symbol) => !quotes.has(symbol));
  if (available.length === 0) throw new Error("臺灣證券交易所目前沒有回傳這些標的的最新收盤價，仍可由家長手動輸入市值");

  const stamp = nowIso();
  const updatedSymbols = new Set();
  for (const holding of holdings) {
    const quote = quotes.get(holding.symbol);
    if (!quote) continue;
    if (holding.quoteAsOf && quote.asOf < holding.quoteAsOf) continue;
    const marketValue = Math.max(0, Math.round(holding.units * quote.price));
    if (holding.quoteAsOf === quote.asOf && holding.quotePrice === quote.price && holding.marketValue === marketValue) {
      continue;
    }
    const delta = marketValue - holding.marketValue;
    holding.marketValue = marketValue;
    holding.quotePrice = quote.price;
    holding.quoteAsOf = quote.asOf;
    holding.quoteSource = quote.source;
    holding.priceUpdatedAt = stamp;
    holding.updatedAt = stamp;
    if (delta !== 0) {
      addActivity({
        profileId: holding.profileId,
        kind: "market-update",
        label: `更新 ${holding.symbol} 收盤市值`,
        amount: Math.abs(delta),
        marketDelta: delta,
        note: `${quote.asOf} 最新收盤價 ${quote.price} 元；非盤中即時報價`,
        entryDate: quote.asOf,
        source: "system",
        createdAt: stamp,
      });
    }
    updatedSymbols.add(holding.symbol);
  }
  const result = {
    source: TWSE_QUOTE_SOURCE,
    fetchedAt: stamp,
    updatedSymbols: [...updatedSymbols],
    unavailableSymbols,
  };
  next.quoteRefresh = { ...result };
  if (updatedSymbols.size > 0) commit("更新最新收盤價");
  else notify();
  return result;
}

// ---------- 過年收成 ----------

// money-store.ts recordAnnualHarvest L2508–2599
export async function recordAnnualHarvest(input) {
  await assertParentPin(input.parentPin);
  const next = requireState();
  const profile = findProfile(input.profileId);
  const holding = next.holdings.find((item) => item.id === input.holdingId && item.profileId === profile.id);
  if (!holding) throw new Error("找不到要收成的投資標的");
  const soldUnits = roundUnits(Number(input.soldUnits));
  const netProceeds = Math.round(Number(input.netProceeds));
  const saleDate = String(input.saleDate ?? "").trim() || taipeiDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) throw new Error("請輸入正確的賣出日期");
  const year = Number(saleDate.slice(0, 4));
  if (next.harvests.some((harvest) => harvest.profileId === profile.id && harvest.year === year)) {
    throw new Error(`${year} 年的過年收成已經使用過了`);
  }
  const maxHarvest = Math.floor(profile.marketValue * .05);
  if (!Number.isFinite(netProceeds) || netProceeds <= 0 || netProceeds > maxHarvest) throw new Error(`今年最多可以收成 ${maxHarvest} 元`);
  if (!Number.isFinite(soldUnits) || soldUnits <= 0 || soldUnits > holding.units) throw new Error("請輸入正確的實際賣出股數");

  let destination = null;
  if (input.destinationDreamId) {
    destination = next.dreamJars.find((dream) => dream.id === input.destinationDreamId && dream.profileId === profile.id) ?? null;
    if (!destination || destination.kind !== "short" || destination.status !== "active") {
      throw new Error("過年收成只能對應使用中的短期夢想罐");
    }
  }

  const { costReduction, marketReduction } = calculateProportionalReduction({
    holdingUnits: holding.units,
    soldUnits,
    costBasis: holding.costBasis,
    marketValue: holding.marketValue,
  });
  const nextUnits = Math.max(0, roundUnits(holding.units - soldUnits));
  const nextMarket = Math.max(0, holding.marketValue - marketReduction);
  const nextCost = Math.max(0, holding.costBasis - costReduction);
  const stamp = nowIso();
  const referenceMarketValue = profile.marketValue;
  holding.units = nextUnits;
  holding.costBasis = nextCost;
  holding.marketValue = nextMarket;
  holding.updatedAt = stamp;
  profile.spendingBalance += netProceeds;
  profile.marketValue = Math.max(0, profile.marketValue - marketReduction);
  profile.stockCost = Math.max(0, profile.stockCost - costReduction);
  profile.updatedAt = stamp;
  next.harvests.push({
    id: uuid(),
    profileId: profile.id,
    holdingId: holding.id,
    year,
    percentage: referenceMarketValue ? netProceeds / referenceMarketValue * 100 : 0,
    soldUnits,
    referenceMarketValue,
    netProceeds,
    marketValueReduction: marketReduction,
    costBasisReduction: costReduction,
    destinationDreamId: destination?.id ?? null,
    saleDate,
    note: String(input.note ?? "").trim().slice(0, 100) || "過年投資收成",
    createdAt: stamp,
  });
  addActivity({
    profileId: profile.id,
    kind: "harvest",
    label: "過年投資收成",
    amount: netProceeds,
    spendDelta: netProceeds,
    marketDelta: -marketReduction,
    note: `${destination ? `已放進撲滿；短期夢想罐「${destination.title}」的進度會自動更新` : "已放進可以自己決定的撲滿"}；相對收成前帳面市值${netProceeds - marketReduction >= 0 ? "增加" : "減少"} ${Math.abs(netProceeds - marketReduction)} 元`,
    entryDate: saleDate,
    source: "parent",
    createdAt: stamp,
  });
  return commit(`${profile.name}完成 ${year} 過年投資收成`);
}

// money-store.ts loadReversibleHarvest L2601–2621
function loadReversibleHarvest(harvestId) {
  const next = requireState();
  const harvest = next.harvests.find((item) => item.id === harvestId);
  if (!harvest) throw new Error("找不到這筆過年收成");
  const holding = next.holdings.find((item) => item.id === harvest.holdingId);
  const profile = next.profiles.find((item) => item.id === harvest.profileId);
  if (!holding || !profile) throw new Error("這筆收成所連結的持股資料不存在");
  if (!(harvest.marketValueReduction ?? 0) && !(harvest.costBasisReduction ?? 0)) {
    throw new Error("這是舊版收成紀錄，缺少比例成本資料；為避免餘額失真，請保留原紀錄");
  }
  return { harvest, holding, profile };
}

// money-store.ts voidAnnualHarvest L2623–2659
export async function voidAnnualHarvest(input) {
  await assertParentPin(input.parentPin);
  const next = requireState();
  const { harvest, holding, profile } = loadReversibleHarvest(input.harvestId);
  if (profile.spendingBalance < harvest.netProceeds) throw new Error("撲滿目前不足以退回這筆收成，請先調整後續花費");
  const marketReduction = harvest.marketValueReduction ?? 0;
  const costReduction = harvest.costBasisReduction ?? 0;
  const stamp = nowIso();
  holding.units = roundUnits(holding.units + harvest.soldUnits);
  holding.costBasis += costReduction;
  holding.marketValue += marketReduction;
  holding.updatedAt = stamp;
  profile.spendingBalance -= harvest.netProceeds;
  profile.marketValue += marketReduction;
  profile.stockCost += costReduction;
  profile.updatedAt = stamp;
  next.harvests = next.harvests.filter((item) => item.id !== harvest.id);
  addActivity({
    profileId: profile.id,
    kind: "harvest-void",
    label: "撤銷過年投資收成",
    amount: harvest.netProceeds,
    spendDelta: -harvest.netProceeds,
    marketDelta: marketReduction,
    note: `恢復 ${harvest.soldUnits} 股及對應投入成本`,
    entryDate: taipeiDate(),
    source: "parent",
    createdAt: stamp,
  });
  return commit(`${profile.name}撤銷 ${harvest.year} 過年投資收成`);
}

// money-store.ts correctAnnualHarvest L2661–2745
export async function correctAnnualHarvest(input) {
  await assertParentPin(input.parentPin);
  const next = requireState();
  const { harvest, holding, profile } = loadReversibleHarvest(input.harvestId);
  const oldMarketReduction = harvest.marketValueReduction ?? 0;
  const oldCostReduction = harvest.costBasisReduction ?? 0;
  const baseUnits = roundUnits(holding.units + harvest.soldUnits);
  const baseMarket = holding.marketValue + oldMarketReduction;
  const baseCost = holding.costBasis + oldCostReduction;
  const baseProfileMarket = profile.marketValue + oldMarketReduction;
  const baseProfileCost = profile.stockCost + oldCostReduction;
  const baseSpending = profile.spendingBalance - harvest.netProceeds;
  if (baseSpending < 0) throw new Error("撲滿目前不足以安全修正這筆收成，請先調整後續花費");

  const soldUnits = roundUnits(Number(input.soldUnits));
  const netProceeds = Math.round(Number(input.netProceeds));
  const saleDate = String(input.saleDate ?? "").trim() || harvest.saleDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) throw new Error("請輸入正確的賣出日期");
  const year = Number(saleDate.slice(0, 4));
  if (next.harvests.some((item) => item.profileId === profile.id && item.year === year && item.id !== harvest.id)) {
    throw new Error(`${year} 年已有另一筆過年收成`);
  }
  const maxHarvest = Math.floor(baseProfileMarket * 0.05);
  if (!Number.isFinite(netProceeds) || netProceeds <= 0 || netProceeds > maxHarvest) throw new Error(`今年最多可以收成 ${maxHarvest} 元`);
  if (!Number.isFinite(soldUnits) || soldUnits <= 0 || soldUnits > baseUnits) throw new Error("請輸入正確的實際賣出股數");

  let destination = null;
  if (input.destinationDreamId) {
    destination = next.dreamJars.find((dream) => dream.id === input.destinationDreamId && dream.profileId === profile.id) ?? null;
    if (!destination || destination.kind !== "short" || destination.status !== "active") {
      throw new Error("過年收成只能對應使用中的短期夢想罐");
    }
  }
  const reductions = calculateProportionalReduction({
    holdingUnits: baseUnits,
    soldUnits,
    costBasis: baseCost,
    marketValue: baseMarket,
  });
  const nextUnits = Math.max(0, roundUnits(baseUnits - soldUnits));
  const nextMarket = Math.max(0, baseMarket - reductions.marketReduction);
  const nextCost = Math.max(0, baseCost - reductions.costReduction);
  const stamp = nowIso();
  holding.units = nextUnits;
  holding.costBasis = nextCost;
  holding.marketValue = nextMarket;
  holding.updatedAt = stamp;
  profile.spendingBalance = baseSpending + netProceeds;
  profile.marketValue = Math.max(0, baseProfileMarket - reductions.marketReduction);
  profile.stockCost = Math.max(0, baseProfileCost - reductions.costReduction);
  profile.updatedAt = stamp;
  const previousSoldUnits = harvest.soldUnits;
  const previousNetProceeds = harvest.netProceeds;
  harvest.year = year;
  harvest.percentage = baseProfileMarket ? netProceeds / baseProfileMarket * 100 : 0;
  harvest.soldUnits = soldUnits;
  harvest.referenceMarketValue = baseProfileMarket;
  harvest.netProceeds = netProceeds;
  harvest.marketValueReduction = reductions.marketReduction;
  harvest.costBasisReduction = reductions.costReduction;
  harvest.destinationDreamId = destination?.id ?? null;
  harvest.saleDate = saleDate;
  harvest.note = input.note === undefined || input.note === null
    ? harvest.note
    : String(input.note).trim().slice(0, 100);
  addActivity({
    profileId: profile.id,
    kind: "harvest-correction",
    label: "修正過年投資收成",
    amount: netProceeds - previousNetProceeds,
    spendDelta: netProceeds - previousNetProceeds,
    marketDelta: oldMarketReduction - reductions.marketReduction,
    note: `由 ${previousSoldUnits} 股／${previousNetProceeds} 元修正為 ${soldUnits} 股／${netProceeds} 元`,
    entryDate: saleDate,
    source: "parent",
    createdAt: stamp,
  });
  return commit(`${profile.name}修正 ${year} 過年投資收成`);
}

// ---------- 夢想罐 ----------

// money-store.ts updateDreamJar L2201–2355
export async function updateDreamJar(input) {
  const next = requireState();
  const profile = findProfile(input.profileId);
  const stamp = nowIso();

  if (input.action === "update-completed") {
    await assertParentPin(input.parentPin);
    if (!input.dreamId) throw new Error("找不到這個夢想罐");
    const current = next.dreamJars.find((dream) => dream.id === input.dreamId && dream.profileId === profile.id);
    if (!current || current.status !== "completed") throw new Error("找不到這筆已完成夢想");
    const title = String(input.title ?? "").trim();
    const kind = input.kind === "long" ? "long" : "short";
    const targetAmount = Math.round(Number(input.targetAmount ?? 0));
    const completedAmount = Math.round(Number(input.completedAmount ?? 0));
    const createdAtMs = Date.parse(input.createdAt ?? "");
    const completedAtMs = Date.parse(input.completedAt ?? "");
    if (title.length < 2 || title.length > 30) throw new Error("請寫出清楚的夢想名稱");
    if (targetAmount < 50 || targetAmount > 10000000) throw new Error("夢想目標請設定在 50 到 1,000 萬元之間");
    if (completedAmount < 0 || completedAmount > 10000000) throw new Error("完成金額請設定在 0 到 1,000 萬元之間");
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(completedAtMs)) throw new Error("請輸入完整的開始與完成日期時間");
    if (completedAtMs < createdAtMs) throw new Error("完成時間不能早於開始時間");
    current.title = title;
    current.kind = kind;
    current.targetAmount = targetAmount;
    current.completedAmount = completedAmount;
    current.createdAt = new Date(createdAtMs).toISOString();
    current.completedAt = new Date(completedAtMs).toISOString();
    current.updatedAt = stamp;
    return commit(`${profile.name}編輯已完成夢想：${title}`);
  }

  if (input.action === "create" || input.action === "update") {
    if (input.action === "update") await assertParentPin(input.parentPin);
    const title = String(input.title ?? "").trim();
    const kind = input.kind === "long" ? "long" : "short";
    const targetAmount = Math.round(Number(input.targetAmount ?? 0));
    if (title.length < 2 || title.length > 30) throw new Error("請寫出清楚的夢想名稱");
    if (targetAmount < 50 || targetAmount > 10000000) throw new Error("夢想目標請設定在 50 到 1,000 萬元之間");
    const activeExists = next.dreamJars.some((dream) => dream.profileId === profile.id
      && dream.kind === kind && dream.status === "active" && dream.id !== (input.dreamId ?? ""));
    if (input.action === "create") {
      if (kind === "long" && activeExists) throw new Error("長期夢想同時只能有一個；請先完成或編輯目前的長期夢想");
      const status = kind === "short" && activeExists ? "queued" : "active";
      next.dreamJars.push({
        id: uuid(),
        profileId: profile.id,
        title,
        kind,
        targetAmount,
        balance: 0,
        status,
        createdAt: stamp,
        updatedAt: stamp,
        completedAt: null,
        completedAmount: null,
      });
    } else {
      if (!input.dreamId) throw new Error("找不到這個夢想罐");
      const current = next.dreamJars.find((dream) => dream.id === input.dreamId && dream.profileId === profile.id);
      if (!current) throw new Error("找不到這個夢想罐");
      if (current.status === "completed") throw new Error("已完成的夢想會保留原始紀錄，不能再編輯");
      if (current.status === "active" && activeExists) throw new Error(`每位小朋友同時只能有一個${kind === "short" ? "短期" : "長期"}夢想`);
      if (current.status === "queued" && kind === "long" && activeExists) throw new Error("長期夢想同時只能有一個");
      current.title = title;
      current.kind = kind;
      current.targetAmount = targetAmount;
      current.balance = 0;
      current.status = current.status === "queued" ? "queued" : "active";
      current.updatedAt = stamp;
    }
    return commit(`${profile.name}${input.action === "create" ? "建立" : "編輯"}${kind === "short" ? "短期" : "長期"}夢想：${title}`);
  }

  if (input.action === "complete") {
    await assertParentPin(input.parentPin);
    if (!input.dreamId) throw new Error("找不到這個夢想罐");
    const jar = next.dreamJars.find((dream) => dream.id === input.dreamId && dream.profileId === profile.id);
    if (!jar || jar.status !== "active") throw new Error("只有目前進行中的夢想可以完成");
    const accountAmount = jar.kind === "short" ? profile.spendingBalance : profile.bankBalance + profile.marketValue;
    const completedAmount = Math.max(0, Math.round(Number(input.completedAmount ?? accountAmount)));
    jar.status = "completed";
    jar.completedAt = stamp;
    jar.completedAmount = completedAmount;
    jar.updatedAt = stamp;
    addActivity({
      profileId: profile.id,
      kind: "dream",
      label: `完成夢想：${jar.title}`,
      amount: completedAmount,
      note: `${jar.kind === "short" ? "短期" : "長期"}夢想完成`,
      entryDate: taipeiDate(),
      source: "app",
      createdAt: stamp,
    });
    return commit(`${profile.name}完成夢想：${jar.title}`);
  }

  if (input.action === "activate") {
    await assertParentPin(input.parentPin);
    if (!input.dreamId) throw new Error("找不到這個夢想罐");
    const jar = next.dreamJars.find((dream) => dream.id === input.dreamId && dream.profileId === profile.id);
    if (!jar || jar.status !== "queued" || jar.kind !== "short") throw new Error("只有短期夢想清單中的項目可以開始");
    const active = next.dreamJars.some((dream) => dream.profileId === profile.id && dream.kind === "short" && dream.status === "active");
    if (active) throw new Error("請先完成目前的短期夢想，再開始下一個");
    jar.status = "active";
    jar.updatedAt = stamp;
    return commit(`${profile.name}開始短期夢想：${jar.title}`);
  }

  if (input.action === "delete") {
    await assertParentPin(input.parentPin);
    if (!input.dreamId) throw new Error("找不到這個夢想罐");
    const jar = next.dreamJars.find((dream) => dream.id === input.dreamId && dream.profileId === profile.id);
    if (!jar) throw new Error("找不到這個夢想罐");
    for (const harvest of next.harvests) {
      if (harvest.destinationDreamId === jar.id) harvest.destinationDreamId = null;
    }
    next.dreamJars = next.dreamJars.filter((dream) => dream.id !== jar.id);
    return commit(`${profile.name}刪除夢想罐：${jar.title}`);
  }

  throw new Error("不支援的夢想罐操作");
}

// ---------- 每月回顧 ----------

// money-store.ts saveMonthlyReflection L2357–2390
export function saveMonthlyReflection(input) {
  const next = requireState();
  const profile = findProfile(input.profileId);
  const month = String(input.month ?? "").trim() || taipeiMonth();
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("月份格式不正確");
  const proudText = String(input.proudText ?? "").trim().slice(0, 160);
  const changeText = String(input.changeText ?? "").trim().slice(0, 160);
  const planText = String(input.planText ?? "").trim().slice(0, 160);
  const stamp = nowIso();
  const existing = next.reflections.find((item) => item.profileId === profile.id && item.month === month);
  if (existing) {
    existing.proudText = proudText;
    existing.changeText = changeText;
    existing.planText = planText;
    existing.updatedAt = stamp;
  } else {
    next.reflections.push({
      id: uuid(),
      profileId: profile.id,
      month,
      proudText,
      changeText,
      planText,
      updatedAt: stamp,
    });
  }
  return commit(`${profile.name}完成 ${month} 理財回顧`);
}

// ---------- 常用投資標的 ----------

// money-store.ts updateInvestmentPreset L2826–2874
// 刪除是把 active 設成 false（原本 active = 0），仍留在 state 裡；derive() 只回傳 active 的。
export async function updateInvestmentPreset(input) {
  await assertParentPin(input.parentPin);
  const next = requireState();
  const stamp = nowIso();
  if (input.action === "delete") {
    if (!input.presetId) throw new Error("找不到這個常用標的");
    const preset = next.investmentPresets.find((item) => item.id === input.presetId);
    if (preset) {
      preset.active = false;
      preset.updatedAt = stamp;
    }
  } else {
    const symbol = String(input.symbol ?? "").trim().toUpperCase();
    const name = String(input.name ?? "").trim();
    const category = input.category === "股票" ? "股票" : "ETF";
    const sortOrder = Math.max(0, Math.min(100, Math.round(Number(input.sortOrder ?? 0))));
    if (!/^[0-9A-Z.\-]{2,12}$/.test(symbol)) throw new Error("請輸入正確的標的代號");
    if (name.length < 2 || name.length > 40) throw new Error("請輸入標的名稱");
    if (input.action === "create") {
      const existing = next.investmentPresets.find((item) => item.symbol === symbol);
      if (existing) {
        existing.name = name;
        existing.category = category;
        existing.sortOrder = sortOrder;
        existing.active = true;
        existing.updatedAt = stamp;
      } else {
        next.investmentPresets.push({
          id: uuid(),
          symbol,
          name,
          category,
          sortOrder,
          active: true,
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
    } else {
      if (!input.presetId) throw new Error("找不到這個常用標的");
      const preset = next.investmentPresets.find((item) => item.id === input.presetId);
      if (preset) {
        preset.symbol = symbol;
        preset.name = name;
        preset.category = category;
        preset.sortOrder = sortOrder;
        preset.active = true;
        preset.updatedAt = stamp;
      }
    }
  }
  return commit("家長調整常用投資標的");
}

// ---------- 所有紀錄分頁 ----------

// money-store.ts getActivitiesPage L1348–1396
export function getActivitiesPage(input) {
  const next = requireState();
  const profile = next.profiles.find((item) => item.id === input.profileId);
  if (!profile) throw new Error("找不到這位小朋友");
  const kind = String(input.kind ?? "").trim();
  const query = String(input.query ?? "").trim().toLocaleLowerCase("zh-TW");
  const mine = next.activities.filter((activity) => activity.profileId === profile.id);
  const filtered = mine.filter((activity) => {
    if (kind && kind !== "all" && activity.kind !== kind) return false;
    if (!query) return true;
    return `${activity.label} ${activity.note} ${activity.entryDate}`.toLocaleLowerCase("zh-TW").includes(query);
  });
  const limit = Math.max(10, Math.min(100, Math.round(Number(input.limit ?? 40))));
  const offset = Math.max(0, Math.round(Number(input.offset ?? 0)));
  const activities = filtered.slice(offset, offset + limit);
  const total = filtered.length;
  const nextOffset = offset + activities.length < total ? offset + activities.length : null;
  const kinds = [...new Set(mine.map((activity) => activity.kind))].sort();
  return { activities, total, nextOffset, kinds };
}
