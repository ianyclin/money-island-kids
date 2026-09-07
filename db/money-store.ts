import { env } from "cloudflare:workers";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import type {
  FamilyProject,
  AnnualHarvest,
  DreamAction,
  DreamJar,
  GardenSpecies,
  InvestmentHolding,
  InvestmentPreset,
  InvestmentPurchase,
  KidProfile,
  MoneyActivity,
  MoneyBackupEnvelope,
  MoneyState,
  MonthlyReflection,
  MoneyPortableBackupEnvelope,
  ProjectAction,
  SavingsTransfer,
  SavingsTransferAction,
  TransactionKind,
} from "../app/money-types";
import { calculateProportionalReduction, roundUnits } from "../lib/investment-math";
import { fetchTwseClosingQuotes, isTwseSymbol, TWSE_QUOTE_SOURCE } from "../lib/market-quotes";

const PROFILE_COLUMNS = `
  id, name, avatar, accent,
  spending_balance AS spendingBalance,
  bank_balance AS bankBalance,
  market_value AS marketValue,
  stock_code AS stockCode,
  stock_units AS stockUnits,
  stock_cost AS stockCost,
  last_synced_at AS lastSyncedAt,
  updated_at AS updatedAt
`;

const ACTIVITY_COLUMNS = `
  id, profile_id AS profileId, kind, label, amount,
  spend_delta AS spendDelta, bank_delta AS bankDelta,
  market_delta AS marketDelta, note,
  entry_date AS entryDate, source, operation_id AS operationId,
  created_at AS createdAt
`;

const ACTIVITY_EDITED_COLUMNS = `
  a.id, a.profile_id AS profileId, a.kind,
  COALESCE(c.edited_label, a.label) AS label,
  a.amount, a.spend_delta AS spendDelta,
  a.bank_delta AS bankDelta, a.market_delta AS marketDelta,
  COALESCE(c.edited_note, a.note) AS note,
  COALESCE(c.edited_entry_date, a.entry_date) AS entryDate,
  a.source, a.operation_id AS operationId, a.created_at AS createdAt
`;

const PROJECT_COLUMNS = `
  id, title, description, reward, status,
  assigned_profile_id AS assignedProfileId,
  created_at AS createdAt, updated_at AS updatedAt,
  completed_at AS completedAt
`;

const HOLDING_COLUMNS = `
  id, profile_id AS profileId, symbol, name, category, units,
  cost_basis AS costBasis, market_value AS marketValue, currency,
  quote_price AS quotePrice, quote_as_of AS quoteAsOf,
  quote_source AS quoteSource,
  price_updated_at AS priceUpdatedAt,
  created_at AS createdAt, updated_at AS updatedAt
`;

const PURCHASE_COLUMNS = `
  id, profile_id AS profileId, holding_id AS holdingId,
  symbol, name, units, total_cost AS totalCost,
  purchase_date AS purchaseDate, note, operation_id AS operationId,
  created_at AS createdAt
`;

const DREAM_COLUMNS = `
  id, profile_id AS profileId, title, kind,
  target_amount AS targetAmount, balance, status,
  created_at AS createdAt, updated_at AS updatedAt,
  completed_at AS completedAt, completed_amount AS completedAmount
`;

const REFLECTION_COLUMNS = `
  id, profile_id AS profileId, month,
  proud_text AS proudText, change_text AS changeText,
  plan_text AS planText, updated_at AS updatedAt
`;

const HARVEST_COLUMNS = `
  id, profile_id AS profileId, holding_id AS holdingId, year,
  percentage, sold_units AS soldUnits,
  reference_market_value AS referenceMarketValue,
  net_proceeds AS netProceeds,
  market_value_reduction AS marketValueReduction,
  cost_basis_reduction AS costBasisReduction,
  destination_dream_id AS destinationDreamId,
  sale_date AS saleDate, note, created_at AS createdAt
`;

const PRESET_COLUMNS = `
  id, symbol, name, category, sort_order AS sortOrder,
  active, created_at AS createdAt, updated_at AS updatedAt
`;

const SAVINGS_TRANSFER_COLUMNS = `
  id, profile_id AS profileId, amount, note, status, activity_id AS activityId,
  operation_id AS operationId,
  created_at AS createdAt, updated_at AS updatedAt,
  resolved_at AS resolvedAt
`;

const GARDEN_SPECIES = new Set<GardenSpecies>(["tree", "cherry", "pine", "sunflower", "tulip", "daisy"]);
const PORTABLE_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"] as const);
const MAX_PORTABLE_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_PORTABLE_PHOTO_TOTAL_BYTES = 18 * 1024 * 1024;
export const LEGACY_FAMILY_ID = "family-default";
const DEFAULT_GARDENS: Record<string, GardenSpecies> = {
  "kid-one": "tree",
  "kid-two": "cherry",
  "kid-three": "sunflower",
};

function db(): D1Database {
  if (!env.DB) throw new Error("雲端資料庫尚未連線");
  return env.DB;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function addColumnIfMissing(d1: D1Database, table: string, column: string, definition: string): Promise<void> {
  const columns = await d1.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (columns.results.some((item) => item.name === column)) return;
  try {
    await d1.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch (error) {
    if (!String(error).toLowerCase().includes("duplicate column")) throw error;
  }
}

function taipeiDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const pairs = hex.match(/.{1,2}/g) ?? [];
  return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
}

const PBKDF2_ITERATIONS = 100_000;
const PIN_MAX_FAILED_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60_000;
const DEVICE_LAST_USED_WRITE_INTERVAL_MS = 15 * 60_000;
const FAMILY_MUTATION_LOCK_MS = 2 * 60_000;

export async function withFamilyMutationLock<T>(familyId: string, work: () => Promise<T>): Promise<T> {
  await ensureSchema();
  const d1 = db();
  const token = crypto.randomUUID();
  const acquiredAt = nowIso();
  const expiresAt = new Date(Date.now() + FAMILY_MUTATION_LOCK_MS).toISOString();
  const result = await d1.prepare(`INSERT INTO family_mutation_locks (
      family_id, token, acquired_at, expires_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(family_id) DO UPDATE SET
      token = excluded.token,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
    WHERE family_mutation_locks.expires_at <= ?`)
    .bind(familyId, token, acquiredAt, expiresAt, acquiredAt)
    .run();
  if (Number(result.meta?.changes ?? 0) < 1) {
    throw new Error("帳本正在同步另一筆操作，請稍候再試");
  }
  try {
    return await work();
  } finally {
    await d1.prepare("DELETE FROM family_mutation_locks WHERE family_id = ? AND token = ?")
      .bind(familyId, token)
      .run()
      .catch(() => undefined);
  }
}

function validateFamilyPassword(password: string): void {
  if (password.length < 8 || password.length > 64) throw new Error("家庭密碼請使用 8 到 64 個字元");
}

async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    material,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

async function hashDeviceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

function normalizeRecoveryName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-TW");
}

async function hashRecoveryNames(names: string[]): Promise<string> {
  const normalized = names.map(normalizeRecoveryName).filter(Boolean).sort();
  if (normalized.length !== 3) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`money-island-recovery-v1\n${normalized.join("\n")}`));
  return bytesToHex(new Uint8Array(digest));
}

async function refreshRecoveryLookupHashWithDb(d1: D1Database, familyId: string): Promise<void> {
  const rows = await d1.prepare("SELECT name FROM profiles WHERE family_id = ? ORDER BY id")
    .bind(familyId)
    .all<{ name: string }>();
  const recoveryLookupHash = await hashRecoveryNames(rows.results.map((row) => row.name));
  await d1.prepare("UPDATE family_security SET recovery_lookup_hash = ?, updated_at = ? WHERE family_id = ?")
    .bind(recoveryLookupHash || null, nowIso(), familyId)
    .run();
}

export async function refreshRecoveryLookupHash(familyId: string): Promise<void> {
  await ensureSchema();
  await refreshRecoveryLookupHashWithDb(db(), familyId);
}

function newDeviceToken(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export type TrustedDeviceInfo = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
  familyId?: string;
};

export type FamilySession = {
  familyId: string;
  familyCode: string;
  familyName: string;
  device: TrustedDeviceInfo;
};

export async function getDeviceAccessStatus(token?: string | null): Promise<{
  configured: boolean;
  trusted: boolean;
  device: TrustedDeviceInfo | null;
  family?: { id: string; code: string; name: string } | null;
}> {
  await ensureSchema();
  const session = await resolveFamilySession(token);
  if (!session) return { configured: false, trusted: false, device: null, family: null };
  return {
    configured: true,
    trusted: true,
    device: session.device,
    family: { id: session.familyId, code: session.familyCode, name: session.familyName },
  };
}

async function createTrustedDevice(familyId: string, labelInput?: string): Promise<{ token: string; device: TrustedDeviceInfo }> {
  const label = labelInput?.trim().slice(0, 40) || "家庭裝置";
  const token = newDeviceToken();
  const tokenHash = await hashDeviceToken(token);
  const stamp = nowIso();
  const device: TrustedDeviceInfo = { id: crypto.randomUUID(), label, createdAt: stamp, lastUsedAt: stamp, revokedAt: null, familyId };
  await db().prepare(`INSERT INTO trusted_devices (
    id, family_id, token_hash, label, created_at, last_used_at, revoked_at
  ) VALUES (?, ?, ?, ?, ?, ?, NULL)`).bind(device.id, familyId, tokenHash, device.label, stamp, stamp).run();
  return { token, device };
}

function normalizeFamilyCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

function randomReadableCode(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function uniqueFamilyCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `MI-${randomReadableCode(6)}`;
    const existing = await db().prepare("SELECT id FROM families WHERE code = ?").bind(code).first<{ id: string }>();
    if (!existing) return code;
  }
  throw new Error("暫時無法產生家庭代碼，請稍後再試");
}

async function storeFamilyCredentials(familyId: string, password: string, recoveryCode: string): Promise<void> {
  validateFamilyPassword(password);
  const passwordSalt = crypto.getRandomValues(new Uint8Array(16));
  const recoverySalt = crypto.getRandomValues(new Uint8Array(16));
  const stamp = nowIso();
  await db().prepare(`INSERT INTO family_credentials (
    family_id, password_salt, password_hash, recovery_salt, recovery_hash,
    failed_attempts, locked_until, updated_at
  ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
  ON CONFLICT(family_id) DO UPDATE SET password_salt = excluded.password_salt,
    password_hash = excluded.password_hash, recovery_salt = excluded.recovery_salt,
    recovery_hash = excluded.recovery_hash, failed_attempts = 0,
    locked_until = NULL, updated_at = excluded.updated_at`)
    .bind(
      familyId,
      bytesToHex(passwordSalt),
      await hashPin(password, passwordSalt),
      bytesToHex(recoverySalt),
      await hashPin(recoveryCode, recoverySalt),
      stamp,
    )
    .run();
}

async function seedNewFamily(familyId: string, parentPin: string): Promise<void> {
  const stamp = nowIso();
  const children = [
    { name: "小朋友一", avatar: "🐯", accent: "#5AAE9B", garden: "tree" },
    { name: "小朋友二", avatar: "🐰", accent: "#EF8FB1", garden: "cherry" },
    { name: "小朋友三", avatar: "🐼", accent: "#F4A261", garden: "sunflower" },
  ].map((child, index) => ({ ...child, id: `${familyId}-${index + 1}` }));
  const pinSalt = crypto.getRandomValues(new Uint8Array(16));
  const pinHash = await hashPin(parentPin, pinSalt);
  const recoveryLookupHash = await hashRecoveryNames(children.map((child) => child.name));
  await db().batch([
    ...children.map((child) => db().prepare(`INSERT INTO profiles (
      id, family_id, name, avatar, accent, spending_balance, bank_balance,
      market_value, stock_code, stock_units, stock_cost, last_synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL, 0, 0, NULL, ?, ?)`)
      .bind(child.id, familyId, child.name, child.avatar, child.accent, stamp, stamp)),
    ...children.map((child) => db().prepare(`INSERT INTO profile_preferences
      (profile_id, family_id, garden_species, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(child.id, familyId, child.garden, stamp)),
    db().prepare(`INSERT INTO family_security (
      id, family_id, pin_salt, pin_hash, pin_failed_attempts, pin_locked_until,
      recovery_lookup_hash, updated_at
    ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`)
      .bind(familyId, familyId, bytesToHex(pinSalt), pinHash, recoveryLookupHash, stamp),
    db().prepare("INSERT INTO family_settings (id, family_id, value, updated_at) VALUES (?, ?, '30', ?)")
      .bind(`${familyId}:savings_rate`, familyId, stamp),
    db().prepare(`INSERT INTO investment_presets
      (id, family_id, symbol, name, category, sort_order, active, created_at, updated_at)
      VALUES (?, ?, '00646', '元大 S&P 500', 'ETF', 1, 1, ?, ?)`)
      .bind(crypto.randomUUID(), familyId, stamp, stamp),
    db().prepare(`INSERT INTO investment_presets
      (id, family_id, symbol, name, category, sort_order, active, created_at, updated_at)
      VALUES (?, ?, '0050', '元大台灣 50', 'ETF', 2, 1, ?, ?)`)
      .bind(crypto.randomUUID(), familyId, stamp, stamp),
  ]);
}

export async function createFamilyAccount(input: {
  familyName: string;
  password: string;
  parentPin: string;
  deviceLabel?: string;
}): Promise<{ token: string; device: TrustedDeviceInfo; family: { id: string; code: string; name: string }; recoveryCode: string }> {
  await ensureSchema();
  const familyName = input.familyName.trim().slice(0, 30);
  if (familyName.length < 2) throw new Error("請輸入家庭名稱");
  validateFamilyPassword(input.password);
  if (!/^\d{4,8}$/.test(input.parentPin)) throw new Error("家長操作碼請使用 4 到 8 位數字");
  const familyId = crypto.randomUUID();
  const familyCode = await uniqueFamilyCode();
  const recoveryCode = `${familyCode}-${randomReadableCode(6)}-${randomReadableCode(6)}-${randomReadableCode(6)}`;
  const stamp = nowIso();
  let trusted: Awaited<ReturnType<typeof createTrustedDevice>>;
  try {
    await db().prepare("INSERT INTO families (id, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(familyId, familyCode, familyName, stamp, stamp)
      .run();
    await storeFamilyCredentials(familyId, input.password, recoveryCode);
    await seedNewFamily(familyId, input.parentPin);
    trusted = await createTrustedDevice(familyId, input.deviceLabel);
  } catch (error) {
    await db().batch([
      db().prepare("DELETE FROM trusted_devices WHERE family_id = ?").bind(familyId),
      db().prepare("DELETE FROM investment_presets WHERE family_id = ?").bind(familyId),
      db().prepare("DELETE FROM family_settings WHERE family_id = ?").bind(familyId),
      db().prepare("DELETE FROM profile_preferences WHERE family_id = ?").bind(familyId),
      db().prepare("DELETE FROM profiles WHERE family_id = ?").bind(familyId),
      db().prepare("DELETE FROM family_security WHERE family_id = ?").bind(familyId),
      db().prepare("DELETE FROM family_credentials WHERE family_id = ?").bind(familyId),
      db().prepare("DELETE FROM families WHERE id = ?").bind(familyId),
    ]).catch(() => undefined);
    throw error;
  }
  const state = await getMoneyState(familyId);
  await writeBackup(familyId, "建立家庭帳本", state, stamp);
  return { ...trusted, family: { id: familyId, code: familyCode, name: familyName }, recoveryCode };
}

export async function legacyFamilyNeedsClaim(): Promise<boolean> {
  await ensureSchema();
  const [credentials, profiles] = await Promise.all([
    db().prepare("SELECT family_id FROM family_credentials WHERE family_id = ?").bind(LEGACY_FAMILY_ID).first<{ family_id: string }>(),
    db().prepare("SELECT COUNT(*) AS count FROM profiles WHERE family_id = ?").bind(LEGACY_FAMILY_ID).first<{ count: number }>(),
  ]);
  return !credentials && (profiles?.count ?? 0) > 0;
}

export async function claimLegacyFamilyAccount(input: {
  familyName: string;
  password: string;
  parentPin?: string;
  deviceLabel?: string;
}): Promise<{ token: string; device: TrustedDeviceInfo; family: { id: string; code: string; name: string }; recoveryCode: string }> {
  await ensureSchema();
  if (!(await legacyFamilyNeedsClaim())) throw new Error("目前帳本已經建立家庭代碼，請改用「登入家庭」");
  const configured = await configureExistingFamilyAccount({
    familyId: LEGACY_FAMILY_ID,
    familyName: input.familyName,
    password: input.password,
    parentPin: input.parentPin,
  });
  const trusted = await createTrustedDevice(LEGACY_FAMILY_ID, input.deviceLabel);
  const state = await getMoneyState(LEGACY_FAMILY_ID);
  await writeBackup(LEGACY_FAMILY_ID, "保留現有帳本並建立家庭代碼", state);
  return { ...trusted, ...configured };
}

export async function configureExistingFamilyAccount(input: {
  familyId: string;
  familyName: string;
  password: string;
  parentPin?: string;
}): Promise<{ family: { id: string; code: string; name: string }; recoveryCode: string }> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const familyName = input.familyName.trim().slice(0, 30);
  if (familyName.length < 2) throw new Error("請輸入家庭名稱");
  validateFamilyPassword(input.password);
  const familyCode = await uniqueFamilyCode();
  const recoveryCode = `${familyCode}-${randomReadableCode(6)}-${randomReadableCode(6)}-${randomReadableCode(6)}`;
  const previous = await db().prepare("SELECT code, name FROM families WHERE id = ?")
    .bind(input.familyId)
    .first<{ code: string; name: string }>();
  if (!previous) throw new Error("找不到這個家庭帳本");
  try {
    await db().prepare("UPDATE families SET code = ?, name = ?, updated_at = ? WHERE id = ?")
      .bind(familyCode, familyName, nowIso(), input.familyId)
      .run();
    await storeFamilyCredentials(input.familyId, input.password, recoveryCode);
  } catch (error) {
    await db().prepare("UPDATE families SET code = ?, name = ?, updated_at = ? WHERE id = ?")
      .bind(previous.code, previous.name, nowIso(), input.familyId)
      .run()
      .catch(() => undefined);
    throw error;
  }
  return { family: { id: input.familyId, code: familyCode, name: familyName }, recoveryCode };
}

export async function loginFamily(input: {
  familyCode: string;
  password: string;
  deviceLabel?: string;
}): Promise<{ token: string; device: TrustedDeviceInfo; family: { id: string; code: string; name: string } }> {
  await ensureSchema();
  const familyCode = normalizeFamilyCode(input.familyCode);
  const family = await db().prepare(`SELECT f.id, f.code, f.name,
      c.password_salt AS passwordSalt, c.password_hash AS passwordHash,
      c.failed_attempts AS failedAttempts, c.locked_until AS lockedUntil
    FROM families f JOIN family_credentials c ON c.family_id = f.id WHERE f.code = ?`)
    .bind(familyCode)
    .first<{ id: string; code: string; name: string; passwordSalt: string; passwordHash: string; failedAttempts: number; lockedUntil: string | null }>();
  if (!family) throw new Error("家庭代碼或密碼不正確");
  if (family.lockedUntil && Date.parse(family.lockedUntil) > Date.now()) throw new Error("嘗試次數過多，請 15 分鐘後再試");
  const candidate = await hashPin(input.password, hexToBytes(family.passwordSalt));
  if (candidate !== family.passwordHash) {
    const stamp = nowIso();
    const lockExpiry = new Date(Date.now() + PIN_LOCK_MS).toISOString();
    await db().prepare(`UPDATE family_credentials SET
      failed_attempts = CASE WHEN failed_attempts >= ? THEN 0 ELSE failed_attempts + 1 END,
      locked_until = CASE WHEN failed_attempts >= ? THEN ? ELSE NULL END,
      updated_at = ? WHERE family_id = ?`)
      .bind(PIN_MAX_FAILED_ATTEMPTS - 1, PIN_MAX_FAILED_ATTEMPTS - 1, lockExpiry, stamp, family.id)
      .run();
    const updated = await db().prepare("SELECT locked_until AS lockedUntil FROM family_credentials WHERE family_id = ?")
      .bind(family.id)
      .first<{ lockedUntil: string | null }>();
    const locked = Boolean(updated?.lockedUntil && Date.parse(updated.lockedUntil) > Date.now());
    throw new Error(locked ? "嘗試次數過多，請 15 分鐘後再試" : "家庭代碼或密碼不正確");
  }
  await db().prepare("UPDATE family_credentials SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE family_id = ?")
    .bind(nowIso(), family.id)
    .run();
  const trusted = await createTrustedDevice(family.id, input.deviceLabel);
  return { ...trusted, family: { id: family.id, code: family.code, name: family.name } };
}

export async function recoverFamilyPassword(input: {
  familyCode?: string;
  recoveryCode: string;
  newPassword: string;
}): Promise<{ familyCode: string; recoveryCode: string }> {
  await ensureSchema();
  const recoveryCode = normalizeFamilyCode(input.recoveryCode);
  const embedded = recoveryCode.match(/^(MI-[A-Z2-9]{6})-/)?.[1];
  const familyCode = embedded ?? normalizeFamilyCode(input.familyCode ?? "");
  if (!familyCode) throw new Error("請輸入完整的離線救援碼");
  const family = await db().prepare(`SELECT f.id,
      c.recovery_salt AS recoverySalt, c.recovery_hash AS recoveryHash
    FROM families f JOIN family_credentials c ON c.family_id = f.id WHERE f.code = ?`)
    .bind(familyCode)
    .first<{ id: string; recoverySalt: string; recoveryHash: string }>();
  if (!family) throw new Error("家庭代碼或救援碼不正確");
  const candidate = await hashPin(recoveryCode, hexToBytes(family.recoverySalt));
  if (candidate !== family.recoveryHash) throw new Error("家庭代碼或救援碼不正確");
  validateFamilyPassword(input.newPassword);
  const nextRecoveryCode = `${familyCode}-${randomReadableCode(6)}-${randomReadableCode(6)}-${randomReadableCode(6)}`;
  const passwordSalt = crypto.getRandomValues(new Uint8Array(16));
  const recoverySalt = crypto.getRandomValues(new Uint8Array(16));
  const stamp = nowIso();
  await db().batch([
    db().prepare(`UPDATE family_credentials SET password_salt = ?, password_hash = ?,
      recovery_salt = ?, recovery_hash = ?, failed_attempts = 0,
      locked_until = NULL, updated_at = ? WHERE family_id = ?`)
      .bind(
        bytesToHex(passwordSalt), await hashPin(input.newPassword, passwordSalt),
        bytesToHex(recoverySalt), await hashPin(nextRecoveryCode, recoverySalt),
        stamp, family.id,
      ),
    db().prepare("UPDATE trusted_devices SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
      .bind(stamp, family.id),
  ]);
  return { familyCode, recoveryCode: nextRecoveryCode };
}

export async function recoverFamilyWithSecurityAnswers(input: {
  profileNames: string[];
  parentPin: string;
  newPassword: string;
  deviceLabel?: string;
}): Promise<{
  token: string;
  device: TrustedDeviceInfo;
  family: { id: string; code: string; name: string };
  recoveryCode: string;
}> {
  await ensureSchema();
  const submittedNames = input.profileNames.map(normalizeRecoveryName).filter(Boolean).sort();
  if (submittedNames.length !== 3) throw new Error("請輸入三個孩子頁面的名稱");
  if (!/^\d{4,8}$/.test(input.parentPin)) throw new Error("請輸入 4 到 8 位數字的家長操作碼");
  validateFamilyPassword(input.newPassword);

  const recoveryLookupHash = await hashRecoveryNames(submittedNames);
  const matches = await db().prepare(`SELECT family_id AS familyId
    FROM family_security WHERE recovery_lookup_hash = ? LIMIT 2`)
    .bind(recoveryLookupHash)
    .all<{ familyId: string }>();
  const matchingFamilyIds = matches.results.map((item) => item.familyId);

  if (matchingFamilyIds.length !== 1) {
    throw new Error(matchingFamilyIds.length > 1
      ? "這組名稱無法唯一辨認家庭，請改用離線救援碼"
      : "頁面名稱或家長操作碼不正確");
  }

  const family = await db().prepare(`SELECT f.id, f.code, f.name,
      s.pin_failed_attempts AS failedAttempts, s.pin_locked_until AS lockedUntil,
      s.pin_salt AS pinSalt, s.pin_hash AS pinHash
    FROM families f
    JOIN family_security s ON s.family_id = f.id
    WHERE f.id = ?`)
    .bind(matchingFamilyIds[0])
    .first<{
      id: string;
      code: string;
      name: string;
      failedAttempts: number;
      lockedUntil: string | null;
      pinSalt: string;
      pinHash: string;
    }>();
  if (!family) throw new Error("頁面名稱或家長操作碼不正確");
  if (family.lockedUntil && Date.parse(family.lockedUntil) > Date.now()) {
    throw new Error("嘗試次數過多，請 15 分鐘後再試");
  }

  const candidate = await hashPin(input.parentPin, hexToBytes(family.pinSalt));
  if (candidate !== family.pinHash) {
    const locked = await recordFailedParentPin(family.id);
    throw new Error(locked ? "嘗試次數過多，請 15 分鐘後再試" : "頁面名稱或家長操作碼不正確");
  }

  const recoveryCode = `${family.code}-${randomReadableCode(6)}-${randomReadableCode(6)}-${randomReadableCode(6)}`;
  await storeFamilyCredentials(family.id, input.newPassword, recoveryCode);
  await db().batch([
    db().prepare("UPDATE family_security SET pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = ? WHERE family_id = ?")
      .bind(nowIso(), family.id),
    db().prepare("UPDATE trusted_devices SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
      .bind(nowIso(), family.id),
  ]);
  const trusted = await createTrustedDevice(family.id, input.deviceLabel);
  const state = await getMoneyState(family.id);
  await writeBackup(family.id, "使用安全問題找回家庭", state);
  return { ...trusted, family: { id: family.id, code: family.code, name: family.name }, recoveryCode };
}

export async function resolveFamilySession(token?: string | null): Promise<FamilySession | null> {
  await ensureSchema();
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await hashDeviceToken(token);
  const row = await db().prepare(`SELECT d.id, d.family_id AS familyId, d.label,
      d.created_at AS createdAt, d.last_used_at AS lastUsedAt, d.revoked_at AS revokedAt,
      f.code AS familyCode, f.name AS familyName
    FROM trusted_devices d JOIN families f ON f.id = d.family_id
    WHERE d.token_hash = ? AND d.revoked_at IS NULL`)
    .bind(tokenHash)
    .first<TrustedDeviceInfo & { familyId: string; familyCode: string; familyName: string }>();
  if (!row) return null;
  const previousUsedAt = Date.parse(row.lastUsedAt);
  const shouldTouch = !Number.isFinite(previousUsedAt) || Date.now() - previousUsedAt >= DEVICE_LAST_USED_WRITE_INTERVAL_MS;
  const usedAt = shouldTouch ? nowIso() : row.lastUsedAt;
  if (shouldTouch) {
    await db().prepare("UPDATE trusted_devices SET last_used_at = ? WHERE id = ? AND family_id = ?")
      .bind(usedAt, row.id, row.familyId)
      .run();
  }
  return {
    familyId: row.familyId,
    familyCode: row.familyCode,
    familyName: row.familyName,
    device: { id: row.id, familyId: row.familyId, label: row.label, createdAt: row.createdAt, lastUsedAt: usedAt, revokedAt: null },
  };
}

export async function revokeTrustedDeviceByToken(token?: string | null): Promise<void> {
  await ensureSchema();
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return;
  const tokenHash = await hashDeviceToken(token);
  await db().prepare("UPDATE trusted_devices SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(nowIso(), tokenHash)
    .run();
}

export async function configureFamilyAccess(input: {
  familyCode: string;
  deviceLabel?: string;
  parentPin?: string;
}): Promise<{ token: string; device: TrustedDeviceInfo }> {
  await ensureSchema();
  await assertParentPin(LEGACY_FAMILY_ID, input.parentPin);
  if (!/^\d{6,12}$/.test(input.familyCode)) throw new Error("家庭碼請使用 6 到 12 位數字");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPin(input.familyCode, salt);
  const stamp = nowIso();
  await db().prepare(`INSERT INTO family_access (id, code_salt, code_hash, updated_at)
    VALUES ('family', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET code_salt = excluded.code_salt,
      code_hash = excluded.code_hash, updated_at = excluded.updated_at`)
    .bind(bytesToHex(salt), hash, stamp)
    .run();
  return createTrustedDevice(LEGACY_FAMILY_ID, input.deviceLabel);
}

export async function enrollTrustedDevice(input: {
  familyCode: string;
  deviceLabel?: string;
}): Promise<{ token: string; device: TrustedDeviceInfo }> {
  await ensureSchema();
  if (!/^\d{6,12}$/.test(input.familyCode)) throw new Error("家庭碼不正確");
  const access = await db().prepare("SELECT code_salt AS codeSalt, code_hash AS codeHash FROM family_access WHERE id = 'family'")
    .first<{ codeSalt: string; codeHash: string }>();
  if (!access) throw new Error("家長尚未設定家庭碼");
  const candidate = await hashPin(input.familyCode, hexToBytes(access.codeSalt));
  if (candidate !== access.codeHash) throw new Error("家庭碼不正確");
  return createTrustedDevice(LEGACY_FAMILY_ID, input.deviceLabel);
}

export async function listTrustedDevices(familyId: string, parentPin?: string): Promise<TrustedDeviceInfo[]> {
  await ensureSchema();
  await assertParentPin(familyId, parentPin);
  const result = await db().prepare(`SELECT id, label, created_at AS createdAt,
    last_used_at AS lastUsedAt, revoked_at AS revokedAt
    FROM trusted_devices WHERE family_id = ? ORDER BY revoked_at IS NOT NULL, last_used_at DESC`)
    .bind(familyId)
    .all<TrustedDeviceInfo>();
  return result.results;
}

export async function revokeTrustedDevice(familyId: string, deviceId: string, parentPin?: string): Promise<void> {
  await ensureSchema();
  await assertParentPin(familyId, parentPin);
  if (!deviceId) throw new Error("找不到這台裝置");
  await db().prepare("UPDATE trusted_devices SET revoked_at = ? WHERE id = ? AND family_id = ? AND revoked_at IS NULL")
    .bind(nowIso(), deviceId, familyId)
    .run();
}

export async function getParentPinStatus(familyId: string): Promise<{ configured: boolean }> {
  await ensureSchema();
  const row = await db().prepare("SELECT id FROM family_security WHERE family_id = ?").bind(familyId).first<{ id: string }>();
  return { configured: Boolean(row) };
}

async function recordFailedParentPin(familyId: string): Promise<boolean> {
  const stamp = nowIso();
  const lockExpiry = new Date(Date.now() + PIN_LOCK_MS).toISOString();
  await db().prepare(`UPDATE family_security SET
    pin_failed_attempts = CASE WHEN pin_failed_attempts >= ? THEN 0 ELSE pin_failed_attempts + 1 END,
    pin_locked_until = CASE WHEN pin_failed_attempts >= ? THEN ? ELSE NULL END,
    updated_at = ? WHERE family_id = ?`)
    .bind(PIN_MAX_FAILED_ATTEMPTS - 1, PIN_MAX_FAILED_ATTEMPTS - 1, lockExpiry, stamp, familyId)
    .run();
  const updated = await db().prepare("SELECT pin_locked_until AS lockedUntil FROM family_security WHERE family_id = ?")
    .bind(familyId)
    .first<{ lockedUntil: string | null }>();
  return Boolean(updated?.lockedUntil && Date.parse(updated.lockedUntil) > Date.now());
}

export async function setParentPin(familyId: string, pin: string): Promise<void> {
  await ensureSchema();
  if (!/^\d{4,8}$/.test(pin)) throw new Error("操作碼請使用 4 到 8 位數字");
  const existing = await db().prepare("SELECT id FROM family_security WHERE family_id = ?").bind(familyId).first<{ id: string }>();
  if (existing) throw new Error("家長操作碼已經設定");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPin(pin, salt);
  await db().prepare(`INSERT INTO family_security (
    id, family_id, pin_salt, pin_hash, pin_failed_attempts, pin_locked_until, updated_at
  ) VALUES (?, ?, ?, ?, 0, NULL, ?)`)
    .bind(familyId, familyId, bytesToHex(salt), hash, nowIso())
    .run();
  await refreshRecoveryLookupHashWithDb(db(), familyId);
}

export async function assertParentPin(familyId: string, pin?: string): Promise<void> {
  await ensureSchema();
  const row = await db().prepare(`SELECT pin_salt AS pinSalt, pin_hash AS pinHash,
    pin_failed_attempts AS failedAttempts, pin_locked_until AS lockedUntil
    FROM family_security WHERE family_id = ?`)
    .bind(familyId)
    .first<{ pinSalt: string; pinHash: string; failedAttempts: number; lockedUntil: string | null }>();
  if (!row) throw new Error("請先設定家長操作碼");
  if (!pin || !/^\d{4,8}$/.test(pin)) throw new Error("請輸入家長操作碼");
  if (row.lockedUntil && Date.parse(row.lockedUntil) > Date.now()) throw new Error("嘗試次數過多，請 15 分鐘後再試");
  const candidate = await hashPin(pin, hexToBytes(row.pinSalt));
  if (candidate !== row.pinHash) {
    const locked = await recordFailedParentPin(familyId);
    throw new Error(locked ? "嘗試次數過多，請 15 分鐘後再試" : "家長操作碼不正確");
  }
  if (row.failedAttempts || row.lockedUntil) {
    await db().prepare("UPDATE family_security SET pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = ? WHERE family_id = ?")
      .bind(nowIso(), familyId)
      .run();
  }
}

export async function changeParentPin(familyId: string, currentPin: string, newPin: string): Promise<void> {
  await assertParentPin(familyId, currentPin);
  if (!/^\d{4,8}$/.test(newPin)) throw new Error("新操作碼請使用 4 到 8 位數字");
  if (currentPin === newPin) throw new Error("新操作碼需與目前操作碼不同");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPin(newPin, salt);
  await db().prepare(`UPDATE family_security SET pin_salt = ?, pin_hash = ?,
    pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = ? WHERE family_id = ?`)
    .bind(bytesToHex(salt), hash, nowIso(), familyId)
    .run();
}

let schemaReadyPromise: Promise<void> | undefined;

async function ensureSchema(): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = initializeSchema().catch((error) => {
      schemaReadyPromise = undefined;
      throw error;
    });
  }
  return schemaReadyPromise;
}

async function initializeSchema(): Promise<void> {
  const d1 = db();
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS families (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS family_credentials (
      family_id TEXT PRIMARY KEY,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      recovery_salt TEXT NOT NULL,
      recovery_hash TEXT NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      accent TEXT NOT NULL,
      spending_balance INTEGER NOT NULL DEFAULT 0,
      bank_balance INTEGER NOT NULL DEFAULT 0,
      market_value INTEGER NOT NULL DEFAULT 0,
      stock_code TEXT,
      stock_units REAL NOT NULL DEFAULT 0,
      stock_cost INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS profile_preferences (
      profile_id TEXT PRIMARY KEY,
      garden_species TEXT NOT NULL DEFAULT 'tree',
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      amount INTEGER NOT NULL,
      spend_delta INTEGER NOT NULL DEFAULT 0,
      bank_delta INTEGER NOT NULL DEFAULT 0,
      market_delta INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      entry_date TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'app',
      operation_id TEXT,
      created_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      r2_key TEXT,
      r2_status TEXT NOT NULL DEFAULT 'pending',
      r2_attempts INTEGER NOT NULL DEFAULT 0,
      r2_error TEXT,
      created_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS family_projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      reward INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      assigned_profile_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS investment_holdings (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'ETF',
      units REAL NOT NULL DEFAULT 0,
      cost_basis INTEGER NOT NULL DEFAULT 0,
      market_value INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'TWD',
      quote_price REAL,
      quote_as_of TEXT,
      quote_source TEXT,
      price_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS investment_purchases (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      holding_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      units REAL NOT NULL,
      total_cost INTEGER NOT NULL,
      purchase_date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      operation_id TEXT,
      created_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS family_security (
      id TEXT PRIMARY KEY,
      pin_salt TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      pin_failed_attempts INTEGER NOT NULL DEFAULT 0,
      pin_locked_until TEXT,
      recovery_lookup_hash TEXT,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS dream_jars (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_amount INTEGER NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      completed_amount INTEGER
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS monthly_reflections (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      month TEXT NOT NULL,
      proud_text TEXT NOT NULL DEFAULT '',
      change_text TEXT NOT NULL DEFAULT '',
      plan_text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS annual_harvests (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      holding_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      percentage REAL NOT NULL,
      sold_units REAL NOT NULL,
      reference_market_value INTEGER NOT NULL,
      net_proceeds INTEGER NOT NULL,
      market_value_reduction INTEGER NOT NULL DEFAULT 0,
      cost_basis_reduction INTEGER NOT NULL DEFAULT 0,
      destination_dream_id TEXT,
      sale_date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS savings_transfers (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      activity_id TEXT,
      operation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS activity_changes (
      activity_id TEXT PRIMARY KEY,
      edited_label TEXT,
      edited_note TEXT,
      edited_entry_date TEXT,
      deleted_at TEXT,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS investment_presets (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'ETF',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS data_imports (
      id TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      record_count INTEGER NOT NULL DEFAULT 0
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS family_access (
      id TEXT PRIMARY KEY,
      code_salt TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS family_settings (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS trusted_devices (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      revoked_at TEXT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS family_mutation_locks (
      family_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_activities_profile_date ON activities(profile_id, entry_date)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups(created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_family_projects_status_updated ON family_projects(status, updated_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_investment_holdings_profile_symbol ON investment_holdings(profile_id, symbol)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_investment_purchases_profile_date ON investment_purchases(profile_id, purchase_date)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_dream_jars_profile_status ON dream_jars(profile_id, status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_monthly_reflections_profile_month ON monthly_reflections(profile_id, month)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_annual_harvests_profile_year ON annual_harvests(profile_id, year)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_savings_transfers_profile_status ON savings_transfers(profile_id, status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_trusted_devices_token_hash ON trusted_devices(token_hash)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_trusted_devices_active ON trusted_devices(revoked_at, last_used_at)"),
  ]);

  const familyTables = [
    "profiles", "profile_preferences", "activities", "backups", "family_projects",
    "investment_holdings", "investment_purchases", "family_security", "dream_jars",
    "monthly_reflections", "annual_harvests", "savings_transfers", "activity_changes",
    "investment_presets", "data_imports", "family_settings", "trusted_devices",
  ];
  for (const table of familyTables) {
    await addColumnIfMissing(d1, table, "family_id", `TEXT NOT NULL DEFAULT '${LEGACY_FAMILY_ID}'`);
  }
  await d1.prepare("DROP INDEX IF EXISTS idx_investment_presets_symbol").run();

  const familyStamp = nowIso();
  await d1.prepare(`INSERT OR IGNORE INTO families (id, code, name, created_at, updated_at)
    VALUES (?, 'MY-FAMILY', '我的家庭', ?, ?)`)
    .bind(LEGACY_FAMILY_ID, familyStamp, familyStamp)
    .run();
  await d1.prepare("UPDATE family_security SET family_id = ? WHERE family_id IS NULL OR family_id = ''")
    .bind(LEGACY_FAMILY_ID)
    .run();
  await d1.prepare("UPDATE trusted_devices SET family_id = ? WHERE family_id IS NULL OR family_id = ''")
    .bind(LEGACY_FAMILY_ID)
    .run();
  await d1.batch([
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_profiles_family ON profiles(family_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_activities_family_date ON activities(family_id, entry_date)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_backups_family_created ON backups(family_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_projects_family_status ON family_projects(family_id, status, updated_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_holdings_family_profile ON investment_holdings(family_id, profile_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_purchases_family_profile ON investment_purchases(family_id, profile_id, purchase_date)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_dreams_family_profile ON dream_jars(family_id, profile_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_reflections_family_profile ON monthly_reflections(family_id, profile_id, month)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_savings_family_profile ON savings_transfers(family_id, profile_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_devices_family_active ON trusted_devices(family_id, revoked_at, last_used_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_settings_family ON family_settings(family_id, id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_investment_presets_family_symbol ON investment_presets(family_id, symbol)"),
  ]);

  await addColumnIfMissing(d1, "dream_jars", "completed_at", "TEXT");
  await addColumnIfMissing(d1, "dream_jars", "completed_amount", "INTEGER");
  await addColumnIfMissing(d1, "family_security", "pin_failed_attempts", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(d1, "family_security", "pin_locked_until", "TEXT");
  await addColumnIfMissing(d1, "family_security", "recovery_lookup_hash", "TEXT");
  await d1.prepare("CREATE INDEX IF NOT EXISTS idx_family_security_recovery_lookup ON family_security(recovery_lookup_hash)").run();
  await addColumnIfMissing(d1, "backups", "r2_key", "TEXT");
  await addColumnIfMissing(d1, "backups", "r2_status", "TEXT NOT NULL DEFAULT 'pending'");
  await addColumnIfMissing(d1, "backups", "r2_attempts", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(d1, "backups", "r2_error", "TEXT");
  await addColumnIfMissing(d1, "investment_holdings", "quote_price", "REAL");
  await addColumnIfMissing(d1, "investment_holdings", "quote_as_of", "TEXT");
  await addColumnIfMissing(d1, "investment_holdings", "quote_source", "TEXT");
  await addColumnIfMissing(d1, "investment_purchases", "operation_id", "TEXT");
  await addColumnIfMissing(d1, "annual_harvests", "market_value_reduction", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(d1, "annual_harvests", "cost_basis_reduction", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(d1, "savings_transfers", "activity_id", "TEXT");
  await addColumnIfMissing(d1, "savings_transfers", "operation_id", "TEXT");
  await addColumnIfMissing(d1, "activities", "operation_id", "TEXT");
  await d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_investment_purchases_family_operation ON investment_purchases(family_id, operation_id)").run();
  await d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_family_operation ON activities(family_id, operation_id)").run();
  await d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_savings_transfers_family_operation ON savings_transfers(family_id, operation_id)").run();

  const recoveryLookupMigrationId = "family-security-recovery-lookup-v1";
  const recoveryLookupMigrated = await d1.prepare("SELECT id FROM data_imports WHERE id = ?")
    .bind(recoveryLookupMigrationId)
    .first<{ id: string }>();
  if (!recoveryLookupMigrated) {
    const securityFamilies = await d1.prepare("SELECT family_id AS familyId FROM family_security")
      .all<{ familyId: string }>();
    for (const row of securityFamilies.results) await refreshRecoveryLookupHashWithDb(d1, row.familyId);
    await d1.prepare("INSERT OR IGNORE INTO data_imports (id, family_id, imported_at, record_count) VALUES (?, ?, ?, ?)")
      .bind(recoveryLookupMigrationId, LEGACY_FAMILY_ID, nowIso(), securityFamilies.results.length)
      .run();
  }

  await d1.prepare("INSERT OR IGNORE INTO family_settings (id, value, updated_at) VALUES ('savings_rate', '30', ?)")
    .bind(nowIso())
    .run();

  const presetCount = await d1.prepare("SELECT COUNT(*) AS count FROM investment_presets").first<{ count: number }>();
  if ((presetCount?.count ?? 0) === 0) {
    const presetStamp = nowIso();
    await d1.batch([
      d1.prepare("INSERT INTO investment_presets (id, symbol, name, category, sort_order, active, created_at, updated_at) VALUES (?, '00646', '元大 S&P 500', 'ETF', 1, 1, ?, ?)")
        .bind(crypto.randomUUID(), presetStamp, presetStamp),
      d1.prepare("INSERT INTO investment_presets (id, symbol, name, category, sort_order, active, created_at, updated_at) VALUES (?, '0050', '元大台灣 50', 'ETF', 2, 1, ?, ?)")
        .bind(crypto.randomUUID(), presetStamp, presetStamp),
    ]);
  }

  const holdingCount = await d1.prepare("SELECT COUNT(*) AS count FROM investment_holdings").first<{ count: number }>();
  if ((holdingCount?.count ?? 0) === 0) {
    const imported = await d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE stock_units > 0`).all<KidProfile>();
    const holdingStamp = nowIso();
    if (imported.results.length) {
      await d1.batch(imported.results.map((profile) => d1.prepare(`INSERT INTO investment_holdings (
        id, profile_id, symbol, name, category, units, cost_basis, market_value,
        currency, price_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'ETF', ?, ?, ?, 'TWD', ?, ?, ?)`)
        .bind(
          crypto.randomUUID(),
          profile.id,
          profile.stockCode ?? "00646",
          profile.stockCode === "00646" ? "元大 S&P 500" : `標的 ${profile.stockCode ?? ""}`,
          profile.stockUnits,
          profile.stockCost,
          profile.marketValue,
          profile.lastSyncedAt,
          holdingStamp,
          holdingStamp,
        )));
    }
  }

  const projectCount = await d1.prepare("SELECT COUNT(*) AS count FROM family_projects").first<{ count: number }>();
  if ((projectCount?.count ?? 0) === 0) {
    const projectStamp = nowIso();
    await d1.batch([
      d1.prepare(`INSERT INTO family_projects (id, title, description, reward, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?)`).bind(
          "project-toys",
          "整理一箱舊玩具",
          "和家長一起分成保留、送人與回收三類，完成整箱才算完成。",
          50,
          projectStamp,
          projectStamp,
        ),
      d1.prepare(`INSERT INTO family_projects (id, title, description, reward, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?)`).bind(
          "project-snacks",
          "規劃家庭點心採買",
          "列出想買的品項、比較價格，並把總額控制在家長給的預算內。",
          40,
          projectStamp,
          projectStamp,
        ),
    ]);
  }

  const count = await d1.prepare("SELECT COUNT(*) AS count FROM profiles").first<{ count: number }>();
  if ((count?.count ?? 0) > 0) {
    await migrateDreamBalancesIntoPiggyBank(d1);
    return;
  }

  const stamp = nowIso();
  const seedProfiles = [
    {
      id: "kid-one",
      name: "小朋友一",
      avatar: "🐯",
      accent: "#5AAE9B",
      bank: 0,
      market: 0,
      code: null,
      units: 0,
      cost: 0,
      synced: null,
    },
    {
      id: "kid-two",
      name: "小朋友二",
      avatar: "🐰",
      accent: "#EF8FB1",
      bank: 0,
      market: 0,
      code: null,
      units: 0,
      cost: 0,
      synced: null,
    },
    {
      id: "kid-three",
      name: "小朋友三",
      avatar: "🐼",
      accent: "#F4A261",
      bank: 0,
      market: 0,
      code: null,
      units: 0,
      cost: 0,
      synced: null,
    },
  ];

  const inserts = seedProfiles.map((profile) =>
    d1.prepare(`INSERT INTO profiles (
      id, name, avatar, accent, spending_balance, bank_balance,
      market_value, stock_code, stock_units, stock_cost,
      last_synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        profile.id,
        profile.name,
        profile.avatar,
        profile.accent,
        profile.bank,
        profile.market,
        profile.code,
        profile.units,
        profile.cost,
        profile.synced,
        stamp,
        stamp,
      ),
  );

  const holdingInserts = seedProfiles.filter((profile) => profile.units > 0).map((profile) =>
    d1.prepare(`INSERT INTO investment_holdings (
      id, profile_id, symbol, name, category, units, cost_basis, market_value,
      currency, price_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'ETF', ?, ?, ?, 'TWD', ?, ?, ?)`)
      .bind(
        crypto.randomUUID(),
        profile.id,
        profile.code,
        profile.code === "00646" ? "元大 S&P 500" : `標的 ${profile.code}`,
        profile.units,
        profile.cost,
        profile.market,
        profile.synced,
        stamp,
        stamp,
      ),
  );

  await d1.batch([...inserts, ...holdingInserts]);
  await migrateDreamBalancesIntoPiggyBank(d1);
}

async function migrateDreamBalancesIntoPiggyBank(d1: D1Database): Promise<void> {
  const importId = "dream-jar-balances-into-piggy-bank-v2";
  const imported = await d1.prepare("SELECT id FROM data_imports WHERE id = ?")
    .bind(importId)
    .first<{ id: string }>();
  if (imported) return;

  const total = await d1.prepare("SELECT COALESCE(SUM(balance), 0) AS amount FROM dream_jars WHERE kind = 'short'")
    .first<{ amount: number }>();
  await d1.batch([
    d1.prepare(`UPDATE profiles SET spending_balance = spending_balance + COALESCE((
      SELECT SUM(balance) FROM dream_jars WHERE dream_jars.profile_id = profiles.id AND kind = 'short'
    ), 0)`),
    d1.prepare("UPDATE dream_jars SET balance = 0 WHERE kind = 'short' AND balance <> 0"),
    d1.prepare("INSERT INTO data_imports (id, imported_at, record_count) VALUES (?, ?, ?)")
      .bind(importId, nowIso(), Math.round(total?.amount ?? 0)),
  ]);
}

async function readProfiles(familyId: string): Promise<KidProfile[]> {
  const result = await db().prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE family_id = ? ORDER BY CASE id
    WHEN 'kid-one' THEN 1 WHEN 'kid-two' THEN 2 WHEN 'kid-three' THEN 3 ELSE 4 END, created_at, id`)
    .bind(familyId).all<KidProfile>();
  return result.results;
}

async function readProjects(familyId: string): Promise<FamilyProject[]> {
  const result = await db().prepare(`SELECT ${PROJECT_COLUMNS} FROM family_projects
    WHERE family_id = ? ORDER BY CASE status WHEN 'waiting' THEN 1 WHEN 'claimed' THEN 2 WHEN 'open' THEN 3 ELSE 4 END,
    updated_at DESC LIMIT 20`).bind(familyId).all<FamilyProject>();
  return result.results;
}

async function readHoldings(familyId: string): Promise<InvestmentHolding[]> {
  const result = await db().prepare(`SELECT ${HOLDING_COLUMNS} FROM investment_holdings
    WHERE family_id = ? ORDER BY profile_id, market_value DESC, symbol`).bind(familyId).all<InvestmentHolding>();
  return result.results;
}

async function readPurchases(familyId: string): Promise<InvestmentPurchase[]> {
  const result = await db().prepare(`SELECT ${PURCHASE_COLUMNS} FROM investment_purchases
    WHERE family_id = ? ORDER BY purchase_date DESC, created_at DESC LIMIT 60`).bind(familyId).all<InvestmentPurchase>();
  return result.results;
}

async function readDreamJars(familyId: string): Promise<DreamJar[]> {
  const result = await db().prepare(`SELECT ${DREAM_COLUMNS} FROM dream_jars
    WHERE family_id = ? ORDER BY status, updated_at DESC`).bind(familyId).all<DreamJar>();
  return result.results;
}

async function readReflections(familyId: string): Promise<MonthlyReflection[]> {
  const result = await db().prepare(`SELECT ${REFLECTION_COLUMNS} FROM monthly_reflections
    WHERE family_id = ? ORDER BY month DESC, updated_at DESC LIMIT 36`).bind(familyId).all<MonthlyReflection>();
  return result.results;
}

async function readHarvests(familyId: string): Promise<AnnualHarvest[]> {
  const result = await db().prepare(`SELECT ${HARVEST_COLUMNS} FROM annual_harvests
    WHERE family_id = ? ORDER BY year DESC, created_at DESC LIMIT 30`).bind(familyId).all<AnnualHarvest>();
  return result.results;
}

async function readSavingsTransfers(familyId: string): Promise<SavingsTransfer[]> {
  const result = await db().prepare(`SELECT ${SAVINGS_TRANSFER_COLUMNS} FROM savings_transfers
    WHERE family_id = ? ORDER BY CASE status WHEN 'pending' THEN 1 ELSE 2 END, updated_at DESC LIMIT 60`).bind(familyId).all<SavingsTransfer>();
  return result.results;
}

async function readFuturePrincipals(familyId: string): Promise<Record<string, number>> {
  const result = await db().prepare(`SELECT a.profile_id AS profileId,
      COALESCE(SUM(CASE
        WHEN a.kind IN ('allowance', 'project', 'sheet-deposit', 'savings-transfer') THEN a.bank_delta
        WHEN a.kind = 'harvest' THEN -a.amount
        WHEN a.kind = 'harvest-void' THEN a.amount
        WHEN a.kind = 'harvest-correction' THEN -a.amount
        ELSE 0
      END), 0) AS amount
    FROM activities a
    LEFT JOIN activity_changes c ON c.activity_id = a.id
    WHERE a.family_id = ? AND c.deleted_at IS NULL
    GROUP BY a.profile_id`).bind(familyId).all<{ profileId: string; amount: number }>();
  return Object.fromEntries(result.results.map((item) => [item.profileId, Math.max(0, Math.round(item.amount))]));
}

async function readActivities(familyId: string): Promise<MoneyActivity[]> {
  const result = await db().prepare(`SELECT ${ACTIVITY_EDITED_COLUMNS}
    FROM activities a LEFT JOIN activity_changes c ON c.activity_id = a.id
    WHERE a.family_id = ? AND c.deleted_at IS NULL
    ORDER BY COALESCE(c.edited_entry_date, a.entry_date) DESC, a.created_at DESC
    LIMIT 120`).bind(familyId).all<MoneyActivity>();
  return result.results;
}

export async function getActivitiesPage(input: {
  familyId: string;
  profileId: string;
  query?: string;
  kind?: string;
  offset?: number;
  limit?: number;
}): Promise<{ activities: MoneyActivity[]; total: number; nextOffset: number | null; kinds: string[] }> {
  await ensureSchema();
  const d1 = db();
  const profile = await d1.prepare("SELECT id FROM profiles WHERE id = ? AND family_id = ?")
    .bind(input.profileId, input.familyId)
    .first<{ id: string }>();
  if (!profile) throw new Error("找不到這位小朋友");

  const conditions = ["a.family_id = ?", "a.profile_id = ?", "c.deleted_at IS NULL"];
  const values: unknown[] = [input.familyId, input.profileId];
  const kind = input.kind?.trim() ?? "";
  if (kind && kind !== "all") {
    conditions.push("a.kind = ?");
    values.push(kind);
  }
  const query = input.query?.trim().toLocaleLowerCase("zh-TW") ?? "";
  if (query) {
    conditions.push(`LOWER(COALESCE(c.edited_label, a.label) || ' ' ||
      COALESCE(c.edited_note, a.note) || ' ' || COALESCE(c.edited_entry_date, a.entry_date)) LIKE ?`);
    values.push(`%${query.replace(/[%_]/g, "\\$&")}%`);
  }
  const where = conditions.join(" AND ");
  const limit = Math.max(10, Math.min(100, Math.round(Number(input.limit ?? 40))));
  const offset = Math.max(0, Math.round(Number(input.offset ?? 0)));
  const [rows, count, kinds] = await Promise.all([
    d1.prepare(`SELECT ${ACTIVITY_EDITED_COLUMNS}
      FROM activities a LEFT JOIN activity_changes c ON c.activity_id = a.id
      WHERE ${where}
      ORDER BY COALESCE(c.edited_entry_date, a.entry_date) DESC, a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?`).bind(...values, limit, offset).all<MoneyActivity>(),
    d1.prepare(`SELECT COUNT(*) AS count FROM activities a
      LEFT JOIN activity_changes c ON c.activity_id = a.id WHERE ${where}`)
      .bind(...values).first<{ count: number }>(),
    d1.prepare(`SELECT DISTINCT a.kind AS kind FROM activities a
      LEFT JOIN activity_changes c ON c.activity_id = a.id
      WHERE a.family_id = ? AND a.profile_id = ? AND c.deleted_at IS NULL ORDER BY a.kind`)
      .bind(input.familyId, input.profileId).all<{ kind: string }>(),
  ]);
  const total = Math.max(0, Number(count?.count ?? 0));
  const nextOffset = offset + rows.results.length < total ? offset + rows.results.length : null;
  return { activities: rows.results, total, nextOffset, kinds: kinds.results.map((item) => item.kind) };
}

async function readInvestmentPresets(familyId: string): Promise<InvestmentPreset[]> {
  const result = await db().prepare(`SELECT ${PRESET_COLUMNS} FROM investment_presets
    WHERE family_id = ? AND active = 1 ORDER BY sort_order, symbol`).bind(familyId).all<InvestmentPreset>();
  return result.results.map((item) => ({ ...item, active: Boolean(item.active) }));
}

async function readGardenPreferences(familyId: string): Promise<Record<string, GardenSpecies>> {
  const result = await db().prepare("SELECT profile_id AS profileId, garden_species AS gardenSpecies FROM profile_preferences WHERE family_id = ?")
    .bind(familyId).all<{ profileId: string; gardenSpecies: GardenSpecies }>();
  return Object.fromEntries(result.results.map((item) => [item.profileId, item.gardenSpecies]));
}

async function readSavingsRate(familyId: string): Promise<number> {
  const row = await db().prepare("SELECT value FROM family_settings WHERE family_id = ? AND id = ?")
    .bind(familyId, familyId === LEGACY_FAMILY_ID ? "savings_rate" : `${familyId}:savings_rate`)
    .first<{ value: string }>();
  const rate = Math.round(Number(row?.value ?? 30));
  return Number.isFinite(rate) ? Math.min(100, Math.max(0, rate)) : 30;
}

function splitBySavingsRate(amount: number, rate: number): { bankDelta: number; spendDelta: number } {
  const bankDelta = Math.round(amount * rate / 100);
  return { bankDelta, spendDelta: amount - bankDelta };
}

function normalizeOperationId(value?: string): string {
  const operationId = value?.trim() || crypto.randomUUID();
  if (!/^[0-9A-Za-z._:-]{8,120}$/.test(operationId)) throw new Error("操作識別碼格式不正確");
  return operationId;
}

function isDuplicateOperationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("idx_investment_purchases_family_operation")
    || (message.toLowerCase().includes("unique") && message.includes("operation_id"));
}

export async function getMoneyState(familyId: string): Promise<MoneyState> {
  await ensureSchema();
  const d1 = db();
  const [profiles, activities, projects, holdings, purchases, investmentPresets, dreamJars, reflections, harvests, savingsTransfers, futurePrincipals, gardenPreferences, savingsRate, backup] = await Promise.all([
    readProfiles(familyId),
    readActivities(familyId),
    readProjects(familyId),
    readHoldings(familyId),
    readPurchases(familyId),
    readInvestmentPresets(familyId),
    readDreamJars(familyId),
    readReflections(familyId),
    readHarvests(familyId),
    readSavingsTransfers(familyId),
    readFuturePrincipals(familyId),
    readGardenPreferences(familyId),
    readSavingsRate(familyId),
    d1.prepare(`SELECT id, reason, created_at AS createdAt, r2_status AS copyStatus
      FROM backups WHERE family_id = ? ORDER BY created_at DESC LIMIT 1`).bind(familyId).first<{
      id: string;
      reason: string;
      createdAt: string;
      copyStatus: "pending" | "ready" | "failed";
    }>(),
  ]);

  const month = taipeiDate().slice(0, 7);
  for (const profile of profiles) {
    const claim = await d1.prepare(
      `SELECT COUNT(*) AS count
       FROM activities a LEFT JOIN activity_changes c ON c.activity_id = a.id
       WHERE a.family_id = ? AND a.profile_id = ? AND a.kind = 'reward'
         AND substr(a.entry_date, 1, 7) = ? AND c.deleted_at IS NULL`,
    ).bind(familyId, profile.id, month).first<{ count: number }>();
    profile.rewardClaimedThisMonth = (claim?.count ?? 0) > 0;
    profile.shortDreamBalance = profile.spendingBalance;
    profile.gardenSpecies = gardenPreferences[profile.id] ?? DEFAULT_GARDENS[profile.id] ?? "tree";
    profile.futurePrincipal = futurePrincipals[profile.id] ?? 0;
  }

  const family = await d1.prepare("SELECT id, code, name FROM families WHERE id = ?").bind(familyId)
    .first<{ id: string; code: string; name: string }>();
  return {
    family: family ?? null,
    profiles,
    activities,
    projects,
    holdings,
    purchases,
    investmentPresets,
    dreamJars,
    reflections,
    harvests,
    savingsTransfers,
    savingsRate,
    latestBackup: backup ?? null,
    backupHealth: backup ? {
      status: backup.copyStatus,
      message: backup.copyStatus === "failed" ? "帳本已儲存，獨立雲端副本會稍後重試" : undefined,
    } : { status: "pending", message: "等待第一次雲端備份" },
  };
}

export async function ensureMonthlySavingsRewards(familyId: string): Promise<boolean> {
  await ensureSchema();
  const d1 = db();
  const month = taipeiDate().slice(0, 7);
  const candidates = await d1.prepare(`SELECT p.id, p.name, p.bank_balance AS bankBalance
      FROM profiles p
      WHERE p.family_id = ? AND p.bank_balance >= 10
        AND NOT EXISTS (
          SELECT 1 FROM activities a
          WHERE a.family_id = p.family_id AND a.profile_id = p.id
            AND a.kind = 'reward' AND substr(a.entry_date, 1, 7) = ?
        )`)
    .bind(familyId, month)
    .all<{ id: string; name: string; bankBalance: number }>();
  if (candidates.results.length === 0) return false;

  try {
    return await withFamilyMutationLock(familyId, async () => {
      const freshCandidates = await d1.prepare(`SELECT p.id, p.name, p.bank_balance AS bankBalance
          FROM profiles p
          WHERE p.family_id = ? AND p.bank_balance >= 10
            AND NOT EXISTS (
              SELECT 1 FROM activities a
              WHERE a.family_id = p.family_id AND a.profile_id = p.id
                AND a.kind = 'reward' AND substr(a.entry_date, 1, 7) = ?
            )`)
        .bind(familyId, month)
        .all<{ id: string; name: string; bankBalance: number }>();
      if (freshCandidates.results.length === 0) return false;

      const stamp = nowIso();
      const entryDate = `${month}-01`;
      const statements: D1PreparedStatement[] = [];
      for (const profile of freshCandidates.results) {
        const reward = Math.min(100, Math.floor(profile.bankBalance * 0.1));
        if (reward <= 0) continue;
        const operationId = `reward:${profile.id}:${month}`;
        statements.push(
          d1.prepare(`UPDATE profiles SET bank_balance = bank_balance + ?, updated_at = ?
            WHERE id = ? AND family_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM activities
                WHERE family_id = ? AND profile_id = ?
                  AND kind = 'reward' AND substr(entry_date, 1, 7) = ?
              )`)
            .bind(reward, stamp, profile.id, familyId, familyId, profile.id, month),
          d1.prepare(`INSERT OR IGNORE INTO activities (
              id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
              market_delta, note, entry_date, source, operation_id, created_at
            ) VALUES (?, ?, ?, 'reward', '爸媽存錢獎勵', ?, 0, ?, 0, ?, ?, 'system', ?, ?)`)
            .bind(
              crypto.randomUUID(), familyId, profile.id, reward, reward,
              "每月第一次開啟帳本時自動發放；這是爸媽鼓勵好習慣的加碼，不是市場保證報酬",
              entryDate, operationId, stamp,
            ),
        );
      }
      if (statements.length === 0) return false;

      const results = await d1.batch(statements);
      const changed = results.some((result, index) => index % 2 === 0 && Number(result.meta?.changes ?? 0) > 0);
      if (!changed) return false;
      const state = await getMoneyState(familyId);
      await writeBackup(familyId, `${month} 每月存錢獎勵自動發放`, state, stamp);
      return true;
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("帳本正在同步另一筆操作")) return false;
    throw error;
  }
}

export async function updateSavingsRate(input: { familyId: string; savingsRate?: number; parentPin?: string }): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const savingsRate = Math.round(Number(input.savingsRate));
  if (!Number.isFinite(savingsRate) || savingsRate < 0 || savingsRate > 100 || savingsRate % 5 !== 0) {
    throw new Error("預先儲蓄比例請以 5% 為單位，設定在 0% 到 100% 之間");
  }
  const stamp = nowIso();
  const settingId = input.familyId === LEGACY_FAMILY_ID ? "savings_rate" : `${input.familyId}:savings_rate`;
  await db().prepare(`INSERT INTO family_settings (id, family_id, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(settingId, input.familyId, String(savingsRate), stamp)
    .run();
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `預先儲蓄比例調整為 ${savingsRate}%`, state, stamp);
  return state;
}

export async function updateSavingsTransfer(input: {
  familyId: string;
  action: SavingsTransferAction;
  transferId?: string;
  profileId?: string;
  amount?: number;
  note?: string;
  operationId?: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  const d1 = db();
  const stamp = nowIso();

  if (input.action === "request") {
    if (!input.profileId) throw new Error("找不到要存錢的小朋友");
    const operationId = normalizeOperationId(input.operationId);
    const alreadySaved = await d1.prepare("SELECT id FROM savings_transfers WHERE family_id = ? AND operation_id = ?")
      .bind(input.familyId, operationId)
      .first<{ id: string }>();
    if (alreadySaved) return getMoneyState(input.familyId);
  const profile = await d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
      .bind(input.profileId, input.familyId)
      .first<KidProfile>();
    if (!profile) throw new Error("找不到這位小朋友");
    const amount = Math.round(Number(input.amount ?? 0));
    const pending = await d1.prepare("SELECT COALESCE(SUM(amount), 0) AS amount FROM savings_transfers WHERE family_id = ? AND profile_id = ? AND status = 'pending'")
      .bind(input.familyId, profile.id)
      .first<{ amount: number }>();
    const available = Math.max(0, profile.spendingBalance - Math.round(pending?.amount ?? 0));
    if (amount <= 0) throw new Error("請輸入想多存的金額");
    if (amount > available) throw new Error("撲滿扣掉等待確認的金額後不夠喔");
    await d1.prepare(`INSERT INTO savings_transfers (
      id, family_id, profile_id, amount, note, status, operation_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).bind(
      crypto.randomUUID(), input.familyId, profile.id, amount,
      input.note?.trim().slice(0, 80) || "我想多存一點給未來",
      operationId, stamp, stamp,
    ).run();
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `${profile.name}提出自主存錢申請`, state, stamp);
    return state;
  }

  await assertParentPin(input.familyId, input.parentPin);
  if (!input.transferId) throw new Error("找不到這筆自主存錢申請");
  const transfer = await d1.prepare(`SELECT ${SAVINGS_TRANSFER_COLUMNS} FROM savings_transfers WHERE id = ? AND family_id = ?`)
    .bind(input.transferId, input.familyId)
    .first<SavingsTransfer>();
  if (!transfer) throw new Error("找不到這筆自主存錢申請");
  if ((input.action === "approve" && transfer.status === "approved")
    || (input.action === "reject" && transfer.status === "rejected")) {
    return getMoneyState(input.familyId);
  }
  if (transfer.status !== "pending") throw new Error("這筆申請已經處理過了");
  const profile = await d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
    .bind(transfer.profileId, input.familyId)
    .first<KidProfile>();
  if (!profile) throw new Error("找不到這位小朋友");

  if (input.action === "reject") {
    await d1.prepare("UPDATE savings_transfers SET status = 'rejected', resolved_at = ?, updated_at = ? WHERE id = ? AND family_id = ? AND status = 'pending'")
      .bind(stamp, stamp, transfer.id, input.familyId)
      .run();
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `${profile.name}的自主存錢申請未執行`, state, stamp);
    return state;
  }

  if (input.action !== "approve") throw new Error("不支援的自主存錢操作");
  if (transfer.amount > profile.spendingBalance) throw new Error("撲滿餘額已變動，目前不足以完成這筆存錢");
  const nextProfile = {
    ...profile,
    spendingBalance: profile.spendingBalance - transfer.amount,
    bankBalance: profile.bankBalance + transfer.amount,
    updatedAt: stamp,
  };
  const activityId = crypto.randomUUID();
  await d1.batch([
    d1.prepare("UPDATE profiles SET spending_balance = ?, bank_balance = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(nextProfile.spendingBalance, nextProfile.bankBalance, stamp, profile.id, input.familyId),
    d1.prepare("UPDATE savings_transfers SET status = 'approved', activity_id = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND family_id = ? AND status = 'pending'")
      .bind(activityId, stamp, stamp, transfer.id, input.familyId),
    d1.prepare(`INSERT INTO activities (
      id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
      market_delta, note, entry_date, source, created_at
    ) VALUES (?, ?, ?, 'savings-transfer', '自主多存到爸媽銀行', ?, ?, ?, 0, ?, ?, 'app', ?)`).bind(
      activityId, input.familyId, profile.id, transfer.amount, -transfer.amount, transfer.amount,
      transfer.note, taipeiDate(), stamp,
    ),
  ]);
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}自主多存 ${transfer.amount} 元`, state, stamp);
  return state;
}

export async function updateGardenSpecies(input: { familyId: string; profileId: string; gardenSpecies: GardenSpecies }): Promise<MoneyState> {
  await ensureSchema();
  if (!GARDEN_SPECIES.has(input.gardenSpecies)) throw new Error("找不到這個樹種或花種");
  const profile = await db().prepare("SELECT id FROM profiles WHERE id = ? AND family_id = ?").bind(input.profileId, input.familyId).first<{ id: string }>();
  if (!profile) throw new Error("找不到這位小朋友");
  const stamp = nowIso();
  await db().prepare(`INSERT INTO profile_preferences (profile_id, family_id, garden_species, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET garden_species = excluded.garden_species, updated_at = excluded.updated_at`)
    .bind(input.profileId, input.familyId, input.gardenSpecies, stamp)
    .run();
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, "更新 ETF 花園樣式", state, stamp);
  return state;
}

export async function updateProfile(input: {
  familyId: string;
  profileId: string;
  name: string;
  avatar?: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const name = input.name.trim();
  if (!name || Array.from(name).length > 12) throw new Error("名字請輸入 1 到 12 個字");
  const profile = await db().prepare("SELECT id FROM profiles WHERE id = ? AND family_id = ?")
    .bind(input.profileId, input.familyId)
    .first<{ id: string }>();
  if (!profile) throw new Error("找不到這位小朋友");

  const stamp = nowIso();
  if (input.avatar) {
    await db().prepare("UPDATE profiles SET name = ?, avatar = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(name, input.avatar, stamp, input.profileId, input.familyId)
      .run();
  } else {
    await db().prepare("UPDATE profiles SET name = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(name, stamp, input.profileId, input.familyId)
      .run();
  }
  await refreshRecoveryLookupHashWithDb(db(), input.familyId);

  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `更新${name}的名字或照片`, state, stamp);
  return state;
}

export async function addTransaction(input: {
  familyId: string;
  profileId: string;
  kind: TransactionKind;
  amount?: number;
  label?: string;
  note?: string;
  operationId?: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  const d1 = db();
  const month = taipeiDate().slice(0, 7);
  const operationId = input.kind === "reward"
    ? `reward:${input.profileId}:${month}`
    : normalizeOperationId(input.operationId);
  const alreadySaved = await d1.prepare("SELECT id FROM activities WHERE family_id = ? AND operation_id = ?")
    .bind(input.familyId, operationId)
    .first<{ id: string }>();
  if (alreadySaved) return getMoneyState(input.familyId);
  const profile = await d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
    .bind(input.profileId, input.familyId)
    .first<KidProfile>();
  if (!profile) throw new Error("找不到這位小朋友");

  const amount = Math.round(Number(input.amount ?? 0));
  let recordedAmount = amount;
  let spendDelta = 0;
  let bankDelta = 0;
  let label = input.label?.trim().slice(0, 120) || "新增一筆紀錄";
  let note = input.note?.trim().slice(0, 1000) || "";

  if (input.kind === "allowance") {
    if (amount <= 0 || amount > 100000) throw new Error("請輸入正確的零用錢金額");
    const split = splitBySavingsRate(amount, await readSavingsRate(input.familyId));
    bankDelta = split.bankDelta;
    spendDelta = split.spendDelta;
    label = input.label?.trim() || "收到零用錢";
    note = `先存 ${bankDelta} 元，留下 ${spendDelta} 元自己安排`;
  } else if (input.kind === "spend") {
    if (amount <= 0 || amount > profile.spendingBalance) throw new Error("可花零用錢不夠喔");
    spendDelta = -amount;
    label = input.label?.trim() || "買了想要的東西";
  } else if (input.kind === "reward") {
    await assertParentPin(input.familyId, input.parentPin);
    const claimed = await d1.prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE family_id = ? AND profile_id = ? AND kind = 'reward' AND substr(entry_date, 1, 7) = ?",
    ).bind(input.familyId, profile.id, month).first<{ count: number }>();
    if ((claimed?.count ?? 0) > 0) throw new Error("這個月的爸媽獎勵已經領過了");
    recordedAmount = Math.min(100, Math.floor(profile.bankBalance * 0.1));
    if (recordedAmount <= 0) throw new Error("爸媽銀行累積到 10 元後就能得到獎勵");
    bankDelta = recordedAmount;
    label = "爸媽存錢獎勵";
    note = "這是爸媽鼓勵好習慣的加碼，不是市場保證報酬";
  }

  const stamp = nowIso();
  const date = taipeiDate();
  const activityId = crypto.randomUUID();

  try {
    await d1.batch([
      d1.prepare(`UPDATE profiles SET spending_balance = spending_balance + ?,
        bank_balance = bank_balance + ?, updated_at = ? WHERE id = ? AND family_id = ?`)
        .bind(spendDelta, bankDelta, stamp, profile.id, input.familyId),
      d1.prepare(`INSERT INTO activities (
      id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
      market_delta, note, entry_date, source, operation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'app', ?, ?)`)
        .bind(activityId, input.familyId, profile.id, input.kind, label, recordedAmount, spendDelta, bankDelta, note, date, operationId, stamp),
    ]);
  } catch (error) {
    if (isDuplicateOperationError(error)) return getMoneyState(input.familyId);
    throw error;
  }
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}：${label}`, state, stamp);
  return state;
}

export async function setPiggyBankBalance(input: {
  familyId: string;
  profileId: string;
  balance: number;
  note?: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const d1 = db();
  const profile = await d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
    .bind(input.profileId, input.familyId)
    .first<KidProfile>();
  if (!profile) throw new Error("找不到這位小朋友");
  const balance = Math.round(Number(input.balance));
  if (!Number.isFinite(balance) || balance < 0 || balance > 1000000) throw new Error("撲滿金額請設定在 0 到 100 萬元之間");
  const delta = balance - profile.spendingBalance;
  if (delta === 0) return getMoneyState(input.familyId);
  const stamp = nowIso();
  const note = input.note?.trim().slice(0, 100) || `家長核對實際撲滿：${profile.spendingBalance} 元調整為 ${balance} 元`;
  await d1.batch([
    d1.prepare("UPDATE profiles SET spending_balance = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(balance, stamp, profile.id, input.familyId),
    d1.prepare(`INSERT INTO activities (
      id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
      market_delta, note, entry_date, source, created_at
    ) VALUES (?, ?, ?, 'piggy-adjustment', '家長校正撲滿金額', ?, ?, 0, 0, ?, ?, 'parent', ?)`)
      .bind(crypto.randomUUID(), input.familyId, profile.id, Math.abs(delta), delta, note, taipeiDate(), stamp),
  ]);
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}校正撲滿為 ${balance} 元`, state, stamp);
  return state;
}

export async function updateFamilyProject(input: {
  familyId: string;
  action: ProjectAction;
  projectId?: string;
  profileId?: string;
  title?: string;
  description?: string;
  reward?: number;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  const d1 = db();
  const stamp = nowIso();

  if (input.action === "create") {
    await assertParentPin(input.familyId, input.parentPin);
    const title = input.title?.trim() ?? "";
    const description = input.description?.trim() ?? "";
    const reward = Math.round(Number(input.reward ?? 0));
    if (title.length < 2 || title.length > 40) throw new Error("請寫出清楚的小專案名稱");
    if (description.length < 4 || description.length > 180) throw new Error("請簡短說明完成條件");
    if (reward < 10 || reward > 500) throw new Error("小專案報酬請設定在 10 到 500 元之間");
    await d1.prepare(`INSERT INTO family_projects (
      id, family_id, title, description, reward, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`).bind(
      crypto.randomUUID(), input.familyId, title, description, reward, stamp, stamp,
    ).run();
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `家長發布小專案：${title}`, state, stamp);
    return state;
  }

  if (!input.projectId) throw new Error("找不到這個小專案");
  const project = await d1.prepare(`SELECT ${PROJECT_COLUMNS} FROM family_projects WHERE id = ? AND family_id = ?`)
    .bind(input.projectId, input.familyId)
    .first<FamilyProject>();
  if (!project) throw new Error("找不到這個小專案");

  if (input.action === "update") {
    await assertParentPin(input.familyId, input.parentPin);
    if (project.status !== "open") throw new Error("只有尚未被接下的專案可以修改");
    const title = input.title?.trim() ?? "";
    const description = input.description?.trim() ?? "";
    const reward = Math.round(Number(input.reward ?? 0));
    if (title.length < 2 || title.length > 40) throw new Error("請寫出清楚的小專案名稱");
    if (description.length < 4 || description.length > 180) throw new Error("請簡短說明完成條件");
    if (reward < 10 || reward > 500) throw new Error("小專案報酬請設定在 10 到 500 元之間");
    await d1.prepare("UPDATE family_projects SET title = ?, description = ?, reward = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(title, description, reward, stamp, project.id, input.familyId)
      .run();
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `家長修改小專案：${title}`, state, stamp);
    return state;
  }

  if (input.action === "claim") {
    if (!input.profileId) throw new Error("請先選擇小朋友");
    if (project.status !== "open") throw new Error("這個小專案已經有人接了");
    const profile = await d1.prepare("SELECT name FROM profiles WHERE id = ? AND family_id = ?")
      .bind(input.profileId, input.familyId)
      .first<{ name: string }>();
    if (!profile) throw new Error("找不到這位小朋友");
    await d1.prepare("UPDATE family_projects SET status = 'claimed', assigned_profile_id = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(input.profileId, stamp, project.id, input.familyId)
      .run();
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `${profile.name}接下小專案：${project.title}`, state, stamp);
    return state;
  }

  if (input.action === "submit") {
    if (project.status !== "claimed" || project.assignedProfileId !== input.profileId) {
      throw new Error("目前不能送出這個小專案");
    }
    await d1.prepare("UPDATE family_projects SET status = 'waiting', updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(stamp, project.id, input.familyId)
      .run();
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `等待家長確認：${project.title}`, state, stamp);
    return state;
  }

  if (input.action === "approve") {
    await assertParentPin(input.familyId, input.parentPin);
    if (project.status !== "waiting" || !project.assignedProfileId) throw new Error("這個小專案還沒有等待確認");
    const profile = await d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
      .bind(project.assignedProfileId, input.familyId)
      .first<KidProfile>();
    if (!profile) throw new Error("找不到完成專案的小朋友");
    const savingsRate = await readSavingsRate(input.familyId);
    const { bankDelta, spendDelta } = splitBySavingsRate(project.reward, savingsRate);
    const nextProfile = {
      ...profile,
      spendingBalance: profile.spendingBalance + spendDelta,
      bankBalance: profile.bankBalance + bankDelta,
      updatedAt: stamp,
    };
    await d1.batch([
      d1.prepare("UPDATE profiles SET spending_balance = ?, bank_balance = ?, updated_at = ? WHERE id = ? AND family_id = ?")
        .bind(nextProfile.spendingBalance, nextProfile.bankBalance, stamp, profile.id, input.familyId),
      d1.prepare("UPDATE family_projects SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND family_id = ?")
        .bind(stamp, stamp, project.id, input.familyId),
      d1.prepare(`INSERT INTO activities (
        id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
        market_delta, note, entry_date, source, created_at
      ) VALUES (?, ?, ?, 'project', ?, ?, ?, ?, 0, ?, ?, 'app', ?)`).bind(
        crypto.randomUUID(), input.familyId, profile.id, `完成家庭小專案：${project.title}`,
        project.reward, spendDelta, bankDelta,
        `家長確認後發放；依 ${savingsRate}% 比例先存 ${bankDelta} 元，自己安排 ${spendDelta} 元`, taipeiDate(), stamp,
      ),
    ]);
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `${profile.name}完成小專案：${project.title}`, state, stamp);
    return state;
  }

  throw new Error("不支援的操作");
}

export async function addInvestmentPurchase(input: {
  familyId: string;
  profileId: string;
  symbol: string;
  name: string;
  category: "ETF" | "股票";
  units: number;
  totalCost: number;
  purchaseDate?: string;
  note?: string;
  operationId?: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const d1 = db();
  const operationId = normalizeOperationId(input.operationId);
  const alreadySaved = await d1.prepare("SELECT id FROM investment_purchases WHERE family_id = ? AND operation_id = ?")
    .bind(input.familyId, operationId)
    .first<{ id: string }>();
  if (alreadySaved) return getMoneyState(input.familyId);
  const profile = await d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
    .bind(input.profileId, input.familyId)
    .first<KidProfile>();
  if (!profile) throw new Error("找不到這位小朋友");

  const symbol = input.symbol.trim().toUpperCase();
  const name = input.name.trim();
  const category = input.category === "股票" ? "股票" : "ETF";
  const units = roundUnits(Number(input.units));
  const totalCost = Math.round(Number(input.totalCost));
  const purchaseDate = input.purchaseDate?.trim() || taipeiDate();
  const note = input.note?.trim().slice(0, 100) || "爸媽已在真實券商完成買入";

  if (!/^[0-9A-Z.\-]{2,12}$/.test(symbol)) throw new Error("請輸入正確的股票代號");
  if (name.length < 2 || name.length > 40) throw new Error("請輸入標的名稱");
  if (!Number.isFinite(units) || units <= 0 || units > 100000000) throw new Error("請輸入正確的股數");
  if (!Number.isFinite(totalCost) || totalCost <= 0 || totalCost > profile.bankBalance) throw new Error("爸媽銀行的餘額不足以記錄這筆買入");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) throw new Error("請輸入正確的買入日期");

  const stamp = nowIso();
  const existing = await d1.prepare(`SELECT ${HOLDING_COLUMNS} FROM investment_holdings
    WHERE family_id = ? AND profile_id = ? AND symbol = ?`).bind(input.familyId, profile.id, symbol).first<InvestmentHolding>();
  const holdingId = existing?.id ?? crypto.randomUUID();
  const nextProfile: KidProfile = {
    ...profile,
    bankBalance: profile.bankBalance - totalCost,
    marketValue: profile.marketValue + totalCost,
    stockCost: profile.stockCost + totalCost,
    updatedAt: stamp,
  };

  try {
    await d1.batch([
    d1.prepare(`UPDATE profiles SET bank_balance = ?, market_value = ?, stock_cost = ?, updated_at = ? WHERE id = ? AND family_id = ?`)
      .bind(nextProfile.bankBalance, nextProfile.marketValue, nextProfile.stockCost, stamp, profile.id, input.familyId),
    d1.prepare(`INSERT INTO investment_holdings (
      id, family_id, profile_id, symbol, name, category, units, cost_basis, market_value,
      currency, quote_price, quote_as_of, quote_source, price_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'TWD', NULL, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(profile_id, symbol) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      units = investment_holdings.units + excluded.units,
      cost_basis = investment_holdings.cost_basis + excluded.cost_basis,
      market_value = investment_holdings.market_value + excluded.market_value,
      quote_price = NULL,
      quote_as_of = NULL,
      quote_source = NULL,
      price_updated_at = NULL,
      updated_at = excluded.updated_at`)
      .bind(holdingId, input.familyId, profile.id, symbol, name, category, units, totalCost, totalCost, stamp, stamp),
    d1.prepare(`INSERT INTO investment_purchases (
      id, family_id, profile_id, holding_id, symbol, name, units, total_cost, purchase_date, note, operation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), input.familyId, profile.id, holdingId, symbol, name, units, totalCost, purchaseDate, note, operationId, stamp),
    d1.prepare(`INSERT INTO activities (
      id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
      market_delta, note, entry_date, source, created_at
    ) VALUES (?, ?, ?, 'stock-buy', ?, ?, 0, ?, ?, ?, ?, 'parent', ?)`)
      .bind(
        crypto.randomUUID(),
        input.familyId,
        profile.id,
        `爸媽協助買進 ${symbol}`,
        totalCost,
        -totalCost,
        totalCost,
        `${name} · ${units} 股；真實券商完成後記錄`,
        purchaseDate,
        stamp,
      ),
    ]);
  } catch (error) {
    if (isDuplicateOperationError(error)) return getMoneyState(input.familyId);
    throw error;
  }

  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}買進 ${symbol}`, state, stamp);
  return state;
}

async function loadCorrectablePurchase(familyId: string, purchaseId: string): Promise<{
  purchase: InvestmentPurchase;
  holding: InvestmentHolding;
  profile: KidProfile;
}> {
  const d1 = db();
  const purchase = await d1.prepare(`SELECT ${PURCHASE_COLUMNS} FROM investment_purchases
    WHERE id = ? AND family_id = ?`).bind(purchaseId, familyId).first<InvestmentPurchase>();
  if (!purchase) throw new Error("找不到這筆買入紀錄");
  const [holding, profile, laterHarvest] = await Promise.all([
    d1.prepare(`SELECT ${HOLDING_COLUMNS} FROM investment_holdings WHERE id = ? AND family_id = ?`)
      .bind(purchase.holdingId, familyId).first<InvestmentHolding>(),
    d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
      .bind(purchase.profileId, familyId).first<KidProfile>(),
    d1.prepare(`SELECT id FROM annual_harvests WHERE family_id = ? AND holding_id = ?
      AND sale_date >= ? LIMIT 1`).bind(familyId, purchase.holdingId, purchase.purchaseDate).first<{ id: string }>(),
  ]);
  if (!holding || !profile) throw new Error("這筆買入所連結的持股資料不存在");
  if (laterHarvest) throw new Error("這筆買入之後已有賣出紀錄；請先撤銷後續收成，才能安全修正");
  if (holding.units + 0.00001 < purchase.units || holding.costBasis < purchase.totalCost) {
    throw new Error("目前持股不足以安全撤銷這筆買入");
  }
  return { purchase, holding, profile };
}

export async function voidInvestmentPurchase(input: {
  familyId: string;
  purchaseId: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const d1 = db();
  const { purchase, holding, profile } = await loadCorrectablePurchase(input.familyId, input.purchaseId);
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
  const holdingStatement = nextUnits === 0
    ? d1.prepare("DELETE FROM investment_holdings WHERE id = ? AND family_id = ?").bind(holding.id, input.familyId)
    : d1.prepare(`UPDATE investment_holdings SET units = ?, cost_basis = ?, market_value = ?, updated_at = ?
      WHERE id = ? AND family_id = ?`).bind(nextUnits, nextCost, nextMarket, stamp, holding.id, input.familyId);
  await d1.batch([
    holdingStatement,
    d1.prepare(`UPDATE profiles SET bank_balance = ?, market_value = ?, stock_cost = ?, updated_at = ?
      WHERE id = ? AND family_id = ?`).bind(
        profile.bankBalance + purchase.totalCost,
        Math.max(0, profile.marketValue - marketReduction),
        Math.max(0, profile.stockCost - purchase.totalCost),
        stamp, profile.id, input.familyId,
      ),
    d1.prepare("DELETE FROM investment_purchases WHERE id = ? AND family_id = ?").bind(purchase.id, input.familyId),
    d1.prepare(`INSERT INTO activities (
      id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
      market_delta, note, entry_date, source, created_at
    ) VALUES (?, ?, ?, 'stock-buy-void', ?, ?, 0, ?, ?, ?, ?, 'parent', ?)`).bind(
      crypto.randomUUID(), input.familyId, profile.id, `撤銷買進 ${purchase.symbol}`,
      purchase.totalCost, purchase.totalCost, -marketReduction,
      `撤銷 ${purchase.units} 股；爸媽銀行退回 ${purchase.totalCost} 元`, taipeiDate(), stamp,
    ),
  ]);
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}撤銷 ${purchase.symbol} 買入`, state, stamp);
  return state;
}

export async function correctInvestmentPurchase(input: {
  familyId: string;
  purchaseId: string;
  units: number;
  totalCost: number;
  purchaseDate?: string;
  note?: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const d1 = db();
  const { purchase, holding, profile } = await loadCorrectablePurchase(input.familyId, input.purchaseId);
  const units = roundUnits(Number(input.units));
  const totalCost = Math.round(Number(input.totalCost));
  const purchaseDate = input.purchaseDate?.trim() || purchase.purchaseDate;
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
  await d1.batch([
    d1.prepare(`UPDATE investment_holdings SET units = ?, cost_basis = ?, market_value = ?, updated_at = ?
      WHERE id = ? AND family_id = ?`).bind(nextUnits, nextCost, nextMarket, stamp, holding.id, input.familyId),
    d1.prepare(`UPDATE profiles SET bank_balance = ?, market_value = ?, stock_cost = ?, updated_at = ?
      WHERE id = ? AND family_id = ?`).bind(
        nextBank, Math.max(0, profile.marketValue - oldMarketShare + newMarketShare),
        Math.max(0, profile.stockCost - purchase.totalCost + totalCost), stamp, profile.id, input.familyId,
      ),
    d1.prepare(`UPDATE investment_purchases SET units = ?, total_cost = ?, purchase_date = ?, note = ?
      WHERE id = ? AND family_id = ?`).bind(
        units, totalCost, purchaseDate, input.note?.trim().slice(0, 100) ?? purchase.note, purchase.id, input.familyId,
      ),
    d1.prepare(`INSERT INTO activities (
      id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
      market_delta, note, entry_date, source, created_at
    ) VALUES (?, ?, ?, 'stock-buy-correction', ?, ?, 0, ?, ?, ?, ?, 'parent', ?)`).bind(
      crypto.randomUUID(), input.familyId, profile.id, `修正 ${purchase.symbol} 買入`, Math.abs(totalCost - purchase.totalCost),
      purchase.totalCost - totalCost, newMarketShare - oldMarketShare,
      `由 ${purchase.units} 股／${purchase.totalCost} 元修正為 ${units} 股／${totalCost} 元`, purchaseDate, stamp,
    ),
  ]);
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}修正 ${purchase.symbol} 買入`, state, stamp);
  return state;
}

export async function updateDreamJar(input: {
  familyId: string;
  action: DreamAction;
  profileId: string;
  dreamId?: string;
  title?: string;
  kind?: "short" | "long";
  targetAmount?: number;
  completedAmount?: number;
  createdAt?: string;
  completedAt?: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  const d1 = db();
  const profile = await d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
    .bind(input.profileId, input.familyId)
    .first<KidProfile>();
  if (!profile) throw new Error("找不到這位小朋友");
  const stamp = nowIso();

  if (input.action === "update-completed") {
    await assertParentPin(input.familyId, input.parentPin);
    if (!input.dreamId) throw new Error("找不到這個夢想罐");
    const current = await d1.prepare(`SELECT ${DREAM_COLUMNS} FROM dream_jars WHERE id = ? AND profile_id = ? AND family_id = ?`)
      .bind(input.dreamId, profile.id, input.familyId)
      .first<DreamJar>();
    if (!current || current.status !== "completed") throw new Error("找不到這筆已完成夢想");
    const title = input.title?.trim() ?? "";
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
    const createdAt = new Date(createdAtMs).toISOString();
    const completedAt = new Date(completedAtMs).toISOString();
    const result = await d1.prepare(`UPDATE dream_jars SET title = ?, kind = ?, target_amount = ?,
      completed_amount = ?, created_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND profile_id = ? AND family_id = ? AND status = 'completed'`)
      .bind(title, kind, targetAmount, completedAmount, createdAt, completedAt, stamp, current.id, profile.id, input.familyId)
      .run();
    if (!result.meta.changes) throw new Error("找不到這筆已完成夢想");
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `${profile.name}編輯已完成夢想：${title}`, state, stamp);
    return state;
  }

  if (input.action === "create" || input.action === "update") {
    if (input.action === "update") await assertParentPin(input.familyId, input.parentPin);
    const title = input.title?.trim() ?? "";
    const kind = input.kind === "long" ? "long" : "short";
    const targetAmount = Math.round(Number(input.targetAmount ?? 0));
    if (title.length < 2 || title.length > 30) throw new Error("請寫出清楚的夢想名稱");
    if (targetAmount < 50 || targetAmount > 10000000) throw new Error("夢想目標請設定在 50 到 1,000 萬元之間");
    const existing = await d1.prepare("SELECT COUNT(*) AS count FROM dream_jars WHERE family_id = ? AND profile_id = ? AND kind = ? AND status = 'active' AND id <> ?")
      .bind(input.familyId, profile.id, kind, input.dreamId ?? "")
      .first<{ count: number }>();
    const activeExists = (existing?.count ?? 0) > 0;
    if (input.action === "create") {
      if (kind === "long" && activeExists) throw new Error("長期夢想同時只能有一個；請先完成或編輯目前的長期夢想");
      const status = kind === "short" && activeExists ? "queued" : "active";
      await d1.prepare(`INSERT INTO dream_jars (
        id, family_id, profile_id, title, kind, target_amount, balance, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).bind(
        crypto.randomUUID(), input.familyId, profile.id, title, kind, targetAmount, status, stamp, stamp,
      ).run();
    } else {
      if (!input.dreamId) throw new Error("找不到這個夢想罐");
      const current = await d1.prepare(`SELECT ${DREAM_COLUMNS} FROM dream_jars WHERE id = ? AND profile_id = ? AND family_id = ?`)
        .bind(input.dreamId, profile.id, input.familyId)
        .first<DreamJar>();
      if (!current) throw new Error("找不到這個夢想罐");
      if (current.status === "completed") throw new Error("已完成的夢想會保留原始紀錄，不能再編輯");
      if (current.status === "active" && activeExists) throw new Error(`每位小朋友同時只能有一個${kind === "short" ? "短期" : "長期"}夢想`);
      if (current.status === "queued" && kind === "long" && activeExists) throw new Error("長期夢想同時只能有一個");
      const nextStatus = current.status === "queued" ? "queued" : "active";
      const result = await d1.prepare(`UPDATE dream_jars SET title = ?, kind = ?, target_amount = ?,
        balance = 0, status = ?, updated_at = ? WHERE id = ? AND profile_id = ? AND family_id = ?`)
        .bind(title, kind, targetAmount, nextStatus, stamp, input.dreamId, profile.id, input.familyId)
        .run();
      if (!result.meta.changes) throw new Error("找不到這個夢想罐");
    }
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `${profile.name}${input.action === "create" ? "建立" : "編輯"}${kind === "short" ? "短期" : "長期"}夢想：${title}`, state, stamp);
    return state;
  }

  if (input.action === "complete") {
    await assertParentPin(input.familyId, input.parentPin);
    if (!input.dreamId) throw new Error("找不到這個夢想罐");
    const jar = await d1.prepare(`SELECT ${DREAM_COLUMNS} FROM dream_jars WHERE id = ? AND profile_id = ? AND family_id = ?`)
      .bind(input.dreamId, profile.id, input.familyId)
      .first<DreamJar>();
    if (!jar || jar.status !== "active") throw new Error("只有目前進行中的夢想可以完成");
    const accountAmount = jar.kind === "short" ? profile.spendingBalance : profile.bankBalance + profile.marketValue;
    const completedAmount = Math.max(0, Math.round(Number(input.completedAmount ?? accountAmount)));
    await d1.batch([
      d1.prepare("UPDATE dream_jars SET status = 'completed', completed_at = ?, completed_amount = ?, updated_at = ? WHERE id = ? AND family_id = ?")
        .bind(stamp, completedAmount, stamp, jar.id, input.familyId),
      d1.prepare(`INSERT INTO activities (
        id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
        market_delta, note, entry_date, source, created_at
      ) VALUES (?, ?, ?, 'dream', ?, ?, 0, 0, 0, ?, ?, 'app', ?)`).bind(
        crypto.randomUUID(), input.familyId, profile.id, `完成夢想：${jar.title}`, completedAmount,
        `${jar.kind === "short" ? "短期" : "長期"}夢想完成`, taipeiDate(), stamp,
      ),
    ]);
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `${profile.name}完成夢想：${jar.title}`, state, stamp);
    return state;
  }

  if (input.action === "activate") {
    await assertParentPin(input.familyId, input.parentPin);
    if (!input.dreamId) throw new Error("找不到這個夢想罐");
    const jar = await d1.prepare(`SELECT ${DREAM_COLUMNS} FROM dream_jars WHERE id = ? AND profile_id = ? AND family_id = ?`)
      .bind(input.dreamId, profile.id, input.familyId)
      .first<DreamJar>();
    if (!jar || jar.status !== "queued" || jar.kind !== "short") throw new Error("只有短期夢想清單中的項目可以開始");
    const active = await d1.prepare("SELECT id FROM dream_jars WHERE family_id = ? AND profile_id = ? AND kind = 'short' AND status = 'active'")
      .bind(input.familyId, profile.id)
      .first<{ id: string }>();
    if (active) throw new Error("請先完成目前的短期夢想，再開始下一個");
    await d1.prepare("UPDATE dream_jars SET status = 'active', updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(stamp, jar.id, input.familyId)
      .run();
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `${profile.name}開始短期夢想：${jar.title}`, state, stamp);
    return state;
  }

  if (input.action === "delete") {
    await assertParentPin(input.familyId, input.parentPin);
    if (!input.dreamId) throw new Error("找不到這個夢想罐");
    const jar = await d1.prepare(`SELECT ${DREAM_COLUMNS} FROM dream_jars WHERE id = ? AND profile_id = ? AND family_id = ?`)
      .bind(input.dreamId, profile.id, input.familyId)
      .first<DreamJar>();
    if (!jar) throw new Error("找不到這個夢想罐");
    await d1.batch([
      d1.prepare(`UPDATE annual_harvests SET destination_dream_id = NULL
        WHERE family_id = ? AND destination_dream_id = ?`).bind(input.familyId, jar.id),
      d1.prepare("DELETE FROM dream_jars WHERE id = ? AND family_id = ?").bind(jar.id, input.familyId),
    ]);
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `${profile.name}刪除夢想罐：${jar.title}`, state, stamp);
    return state;
  }

  throw new Error("不支援的夢想罐操作");
}

export async function saveMonthlyReflection(input: {
  familyId: string;
  profileId: string;
  month?: string;
  proudText?: string;
  changeText?: string;
  planText?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  const d1 = db();
  const profile = await d1.prepare("SELECT name FROM profiles WHERE id = ? AND family_id = ?")
    .bind(input.profileId, input.familyId)
    .first<{ name: string }>();
  if (!profile) throw new Error("找不到這位小朋友");
  const month = input.month?.trim() || taipeiDate().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("月份格式不正確");
  const proudText = input.proudText?.trim().slice(0, 160) ?? "";
  const changeText = input.changeText?.trim().slice(0, 160) ?? "";
  const planText = input.planText?.trim().slice(0, 160) ?? "";
  const stamp = nowIso();
  await d1.prepare(`INSERT INTO monthly_reflections (
    id, family_id, profile_id, month, proud_text, change_text, plan_text, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, month) DO UPDATE SET
    proud_text = excluded.proud_text,
    change_text = excluded.change_text,
    plan_text = excluded.plan_text,
    updated_at = excluded.updated_at`).bind(
      crypto.randomUUID(), input.familyId, input.profileId, month, proudText, changeText, planText, stamp,
    ).run();
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}完成 ${month} 理財回顧`, state, stamp);
  return state;
}

export async function updateHoldingMarketValue(input: {
  familyId: string;
  holdingId: string;
  marketValue: number;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const d1 = db();
  const holding = await d1.prepare(`SELECT ${HOLDING_COLUMNS} FROM investment_holdings WHERE id = ? AND family_id = ?`)
    .bind(input.holdingId, input.familyId)
    .first<InvestmentHolding>();
  if (!holding) throw new Error("找不到這個投資標的");
  const profile = await d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
    .bind(holding.profileId, input.familyId)
    .first<KidProfile>();
  if (!profile) throw new Error("找不到這位小朋友");
  const marketValue = Math.round(Number(input.marketValue));
  if (!Number.isFinite(marketValue) || marketValue < 0 || marketValue > 100000000) throw new Error("請輸入正確的市值");
  const delta = marketValue - holding.marketValue;
  const stamp = nowIso();
  const quotePrice = holding.units > 0 ? marketValue / holding.units : null;
  await d1.batch([
    d1.prepare(`UPDATE investment_holdings SET market_value = ?, quote_price = ?, quote_as_of = ?,
      quote_source = '家長手動輸入', price_updated_at = ?, updated_at = ? WHERE id = ? AND family_id = ?`)
      .bind(marketValue, quotePrice, taipeiDate(), stamp, stamp, holding.id, input.familyId),
    d1.prepare("UPDATE profiles SET market_value = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(profile.marketValue + delta, stamp, profile.id, input.familyId),
    d1.prepare(`INSERT INTO activities (
      id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
      market_delta, note, entry_date, source, created_at
    ) VALUES (?, ?, ?, 'market-update', ?, ?, 0, 0, ?, ?, ?, 'parent', ?)`)
      .bind(
        crypto.randomUUID(), input.familyId, profile.id, `更新 ${holding.symbol} 市值`, Math.abs(delta), delta,
        `家長更新為 ${marketValue} 元；不是即時報價`, taipeiDate(), stamp,
      ),
  ]);
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}更新 ${holding.symbol} 市值`, state, stamp);
  return state;
}

export async function refreshTwseClosingPrices(input: {
  familyId: string;
  profileId?: string;
  mode?: "auto" | "parent";
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  if (input.mode !== "auto") await assertParentPin(input.familyId, input.parentPin);
  const d1 = db();
  // A trusted family session may refresh official closing prices in the
  // background. No balances, units, or symbols are accepted from the client.
  const holdings = (await readHoldings(input.familyId))
    .filter((holding) => !input.profileId || holding.profileId === input.profileId);
  const supportedSymbols = [...new Set(holdings.map((holding) => holding.symbol).filter(isTwseSymbol))];
  if (supportedSymbols.length === 0) throw new Error("目前沒有可由臺灣證券交易所更新的上市標的");

  const quoteRows = await fetchTwseClosingQuotes(supportedSymbols);
  const quotes = new Map(quoteRows.map((quote) => [quote.symbol, quote]));
  const available = supportedSymbols.flatMap((symbol) => {
    const quote = quotes.get(symbol);
    return quote ? [{ symbol, quote }] : [];
  });
  const unavailableSymbols = supportedSymbols.filter((symbol) => !quotes.has(symbol));
  if (available.length === 0) throw new Error("臺灣證券交易所目前沒有回傳這些標的的最新收盤價，仍可由家長手動輸入市值");

  const stamp = nowIso();
  const statements: D1PreparedStatement[] = [];
  const updatedSymbols = new Set<string>();
  for (const holding of holdings) {
    const quote = quotes.get(holding.symbol);
    if (!quote) continue;
    if (holding.quoteAsOf && quote.asOf < holding.quoteAsOf) continue;
    const marketValue = Math.max(0, Math.round(holding.units * quote.price));
    if (holding.quoteAsOf === quote.asOf && holding.quotePrice === quote.price && holding.marketValue === marketValue) {
      continue;
    }
    statements.push(d1.prepare(`UPDATE investment_holdings SET market_value = ?, quote_price = ?,
      quote_as_of = ?, quote_source = ?, price_updated_at = ?, updated_at = ?
      WHERE id = ? AND family_id = ?`).bind(
        marketValue, quote.price, quote.asOf, quote.source, stamp, stamp, holding.id, input.familyId,
      ));
    const delta = marketValue - holding.marketValue;
    if (delta !== 0) {
      statements.push(d1.prepare(`INSERT INTO activities (
        id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
        market_delta, note, entry_date, source, created_at
      ) VALUES (?, ?, ?, 'market-update', ?, ?, 0, 0, ?, ?, ?, 'system', ?)`).bind(
        crypto.randomUUID(), input.familyId, holding.profileId, `更新 ${holding.symbol} 收盤市值`,
        Math.abs(delta), delta, `${quote.asOf} 最新收盤價 ${quote.price} 元；非盤中即時報價`,
        quote.asOf, stamp,
      ));
    }
    updatedSymbols.add(holding.symbol);
  }
  if (statements.length > 0) {
    statements.push(d1.prepare(`UPDATE profiles SET
      market_value = COALESCE((SELECT SUM(h.market_value) FROM investment_holdings h
        WHERE h.family_id = profiles.family_id AND h.profile_id = profiles.id), 0),
      stock_cost = COALESCE((SELECT SUM(h.cost_basis) FROM investment_holdings h
        WHERE h.family_id = profiles.family_id AND h.profile_id = profiles.id), 0),
      updated_at = ? WHERE family_id = ?`).bind(stamp, input.familyId));
    await d1.batch(statements);
  }
  const state = await getMoneyState(input.familyId);
  state.quoteRefresh = {
    source: TWSE_QUOTE_SOURCE,
    fetchedAt: stamp,
    updatedSymbols: [...updatedSymbols],
    unavailableSymbols,
  };
  if (updatedSymbols.size > 0) await writeBackup(input.familyId, "更新最新收盤價", state, stamp);
  return state;
}

export async function recordAnnualHarvest(input: {
  familyId: string;
  profileId: string;
  holdingId: string;
  soldUnits: number;
  netProceeds: number;
  destinationDreamId?: string | null;
  saleDate?: string;
  note?: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const d1 = db();
  const profile = await d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
    .bind(input.profileId, input.familyId)
    .first<KidProfile>();
  if (!profile) throw new Error("找不到這位小朋友");
  const holding = await d1.prepare(`SELECT ${HOLDING_COLUMNS} FROM investment_holdings WHERE id = ? AND profile_id = ? AND family_id = ?`)
    .bind(input.holdingId, profile.id, input.familyId)
    .first<InvestmentHolding>();
  if (!holding) throw new Error("找不到要收成的投資標的");
  const soldUnits = roundUnits(Number(input.soldUnits));
  const netProceeds = Math.round(Number(input.netProceeds));
  const saleDate = input.saleDate?.trim() || taipeiDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) throw new Error("請輸入正確的賣出日期");
  const year = Number(saleDate.slice(0, 4));
  const claimed = await d1.prepare("SELECT COUNT(*) AS count FROM annual_harvests WHERE family_id = ? AND profile_id = ? AND year = ?")
    .bind(input.familyId, profile.id, year)
    .first<{ count: number }>();
  if ((claimed?.count ?? 0) > 0) throw new Error(`${year} 年的過年收成已經使用過了`);
  const maxHarvest = Math.floor(profile.marketValue * .05);
  if (!Number.isFinite(netProceeds) || netProceeds <= 0 || netProceeds > maxHarvest) throw new Error(`今年最多可以收成 ${maxHarvest} 元`);
  if (!Number.isFinite(soldUnits) || soldUnits <= 0 || soldUnits > holding.units) throw new Error("請輸入正確的實際賣出股數");

  let destination: DreamJar | null = null;
  if (input.destinationDreamId) {
    destination = await d1.prepare(`SELECT ${DREAM_COLUMNS} FROM dream_jars WHERE id = ? AND profile_id = ? AND family_id = ?`)
      .bind(input.destinationDreamId, profile.id, input.familyId)
      .first<DreamJar>();
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
  const statements = [
    d1.prepare("UPDATE investment_holdings SET units = ?, cost_basis = ?, market_value = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(nextUnits, nextCost, nextMarket, stamp, holding.id, input.familyId),
    d1.prepare("UPDATE profiles SET spending_balance = ?, market_value = ?, stock_cost = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(
        profile.spendingBalance + netProceeds,
        Math.max(0, profile.marketValue - marketReduction),
        Math.max(0, profile.stockCost - costReduction),
        stamp,
        profile.id,
        input.familyId,
      ),
    d1.prepare(`INSERT INTO annual_harvests (
      id, family_id, profile_id, holding_id, year, percentage, sold_units,
      reference_market_value, net_proceeds, market_value_reduction, cost_basis_reduction,
      destination_dream_id, sale_date, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      crypto.randomUUID(), input.familyId, profile.id, holding.id, year,
      profile.marketValue ? netProceeds / profile.marketValue * 100 : 0,
      soldUnits, profile.marketValue, netProceeds, marketReduction, costReduction, destination?.id ?? null,
      saleDate, input.note?.trim().slice(0, 100) || "過年投資收成", stamp,
    ),
    d1.prepare(`INSERT INTO activities (
      id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
      market_delta, note, entry_date, source, created_at
    ) VALUES (?, ?, ?, 'harvest', ?, ?, ?, ?, ?, ?, ?, 'parent', ?)`).bind(
      crypto.randomUUID(), input.familyId, profile.id, "過年投資收成", netProceeds,
      netProceeds, 0, -marketReduction,
      `${destination ? `已放進撲滿；短期夢想罐「${destination.title}」的進度會自動更新` : "已放進可以自己決定的撲滿"}；相對收成前帳面市值${netProceeds - marketReduction >= 0 ? "增加" : "減少"} ${Math.abs(netProceeds - marketReduction)} 元`,
      saleDate, stamp,
    ),
  ];
  await d1.batch(statements);
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}完成 ${year} 過年投資收成`, state, stamp);
  return state;
}

async function loadReversibleHarvest(familyId: string, harvestId: string): Promise<{
  harvest: AnnualHarvest;
  holding: InvestmentHolding;
  profile: KidProfile;
}> {
  const d1 = db();
  const harvest = await d1.prepare(`SELECT ${HARVEST_COLUMNS} FROM annual_harvests
    WHERE id = ? AND family_id = ?`).bind(harvestId, familyId).first<AnnualHarvest>();
  if (!harvest) throw new Error("找不到這筆過年收成");
  const [holding, profile] = await Promise.all([
    d1.prepare(`SELECT ${HOLDING_COLUMNS} FROM investment_holdings WHERE id = ? AND family_id = ?`)
      .bind(harvest.holdingId, familyId).first<InvestmentHolding>(),
    d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
      .bind(harvest.profileId, familyId).first<KidProfile>(),
  ]);
  if (!holding || !profile) throw new Error("這筆收成所連結的持股資料不存在");
  if (!(harvest.marketValueReduction ?? 0) && !(harvest.costBasisReduction ?? 0)) {
    throw new Error("這是舊版收成紀錄，缺少比例成本資料；為避免餘額失真，請保留原紀錄");
  }
  return { harvest, holding, profile };
}

export async function voidAnnualHarvest(input: {
  familyId: string;
  harvestId: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const d1 = db();
  const { harvest, holding, profile } = await loadReversibleHarvest(input.familyId, input.harvestId);
  if (profile.spendingBalance < harvest.netProceeds) throw new Error("撲滿目前不足以退回這筆收成，請先調整後續花費");
  const marketReduction = harvest.marketValueReduction ?? 0;
  const costReduction = harvest.costBasisReduction ?? 0;
  const stamp = nowIso();
  await d1.batch([
    d1.prepare(`UPDATE investment_holdings SET units = ?, cost_basis = ?, market_value = ?, updated_at = ?
      WHERE id = ? AND family_id = ?`).bind(
        roundUnits(holding.units + harvest.soldUnits), holding.costBasis + costReduction,
        holding.marketValue + marketReduction, stamp, holding.id, input.familyId,
      ),
    d1.prepare(`UPDATE profiles SET spending_balance = ?, market_value = ?, stock_cost = ?, updated_at = ?
      WHERE id = ? AND family_id = ?`).bind(
        profile.spendingBalance - harvest.netProceeds, profile.marketValue + marketReduction,
        profile.stockCost + costReduction, stamp, profile.id, input.familyId,
      ),
    d1.prepare("DELETE FROM annual_harvests WHERE id = ? AND family_id = ?").bind(harvest.id, input.familyId),
    d1.prepare(`INSERT INTO activities (
      id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
      market_delta, note, entry_date, source, created_at
    ) VALUES (?, ?, ?, 'harvest-void', '撤銷過年投資收成', ?, ?, 0, ?, ?, ?, 'parent', ?)`).bind(
      crypto.randomUUID(), input.familyId, profile.id, harvest.netProceeds, -harvest.netProceeds,
      marketReduction, `恢復 ${harvest.soldUnits} 股及對應投入成本`, taipeiDate(), stamp,
    ),
  ]);
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}撤銷 ${harvest.year} 過年投資收成`, state, stamp);
  return state;
}

export async function correctAnnualHarvest(input: {
  familyId: string;
  harvestId: string;
  soldUnits: number;
  netProceeds: number;
  destinationDreamId?: string | null;
  saleDate?: string;
  note?: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const d1 = db();
  const { harvest, holding, profile } = await loadReversibleHarvest(input.familyId, input.harvestId);
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
  const saleDate = input.saleDate?.trim() || harvest.saleDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) throw new Error("請輸入正確的賣出日期");
  const year = Number(saleDate.slice(0, 4));
  const duplicateYear = await d1.prepare(`SELECT id FROM annual_harvests
    WHERE family_id = ? AND profile_id = ? AND year = ? AND id <> ? LIMIT 1`)
    .bind(input.familyId, profile.id, year, harvest.id).first<{ id: string }>();
  if (duplicateYear) throw new Error(`${year} 年已有另一筆過年收成`);
  const maxHarvest = Math.floor(baseProfileMarket * 0.05);
  if (!Number.isFinite(netProceeds) || netProceeds <= 0 || netProceeds > maxHarvest) throw new Error(`今年最多可以收成 ${maxHarvest} 元`);
  if (!Number.isFinite(soldUnits) || soldUnits <= 0 || soldUnits > baseUnits) throw new Error("請輸入正確的實際賣出股數");

  let destination: DreamJar | null = null;
  if (input.destinationDreamId) {
    destination = await d1.prepare(`SELECT ${DREAM_COLUMNS} FROM dream_jars
      WHERE id = ? AND profile_id = ? AND family_id = ?`).bind(
        input.destinationDreamId, profile.id, input.familyId,
      ).first<DreamJar>();
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
  await d1.batch([
    d1.prepare(`UPDATE investment_holdings SET units = ?, cost_basis = ?, market_value = ?, updated_at = ?
      WHERE id = ? AND family_id = ?`).bind(nextUnits, nextCost, nextMarket, stamp, holding.id, input.familyId),
    d1.prepare(`UPDATE profiles SET spending_balance = ?, market_value = ?, stock_cost = ?, updated_at = ?
      WHERE id = ? AND family_id = ?`).bind(
        baseSpending + netProceeds, Math.max(0, baseProfileMarket - reductions.marketReduction),
        Math.max(0, baseProfileCost - reductions.costReduction), stamp, profile.id, input.familyId,
      ),
    d1.prepare(`UPDATE annual_harvests SET year = ?, percentage = ?, sold_units = ?,
      reference_market_value = ?, net_proceeds = ?, market_value_reduction = ?, cost_basis_reduction = ?,
      destination_dream_id = ?, sale_date = ?, note = ? WHERE id = ? AND family_id = ?`).bind(
        year, baseProfileMarket ? netProceeds / baseProfileMarket * 100 : 0, soldUnits, baseProfileMarket,
        netProceeds, reductions.marketReduction, reductions.costReduction, destination?.id ?? null,
        saleDate, input.note?.trim().slice(0, 100) ?? harvest.note, harvest.id, input.familyId,
      ),
    d1.prepare(`INSERT INTO activities (
      id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta,
      market_delta, note, entry_date, source, created_at
    ) VALUES (?, ?, ?, 'harvest-correction', '修正過年投資收成', ?, ?, 0, ?, ?, ?, 'parent', ?)`).bind(
      crypto.randomUUID(), input.familyId, profile.id, netProceeds - harvest.netProceeds,
      netProceeds - harvest.netProceeds, oldMarketReduction - reductions.marketReduction,
      `由 ${harvest.soldUnits} 股／${harvest.netProceeds} 元修正為 ${soldUnits} 股／${netProceeds} 元`, saleDate, stamp,
    ),
  ]);
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}修正 ${year} 過年投資收成`, state, stamp);
  return state;
}

export async function updateActivityRecord(input: {
  familyId: string;
  action: "edit" | "delete";
  activityId: string;
  label?: string;
  note?: string;
  entryDate?: string;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const d1 = db();
  const activity = await d1.prepare(`SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE id = ? AND family_id = ?`)
    .bind(input.activityId, input.familyId)
    .first<MoneyActivity>();
  if (!activity) throw new Error("找不到這筆紀錄");
  const profile = await d1.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ? AND family_id = ?`)
    .bind(activity.profileId, input.familyId)
    .first<KidProfile>();
  if (!profile) throw new Error("找不到這位小朋友");
  const stamp = nowIso();

  if (input.action === "edit") {
    const label = input.label?.trim() ?? "";
    const note = input.note?.trim() ?? "";
    const entryDate = input.entryDate?.trim() ?? "";
    if (label.length < 1 || label.length > 60) throw new Error("紀錄名稱請保持在 60 個字以內");
    if (note.length > 160) throw new Error("備註請保持在 160 個字以內");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new Error("請輸入正確的日期");
    await d1.prepare(`INSERT INTO activity_changes (
      activity_id, family_id, edited_label, edited_note, edited_entry_date, deleted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(activity_id) DO UPDATE SET
      edited_label = excluded.edited_label,
      edited_note = excluded.edited_note,
      edited_entry_date = excluded.edited_entry_date,
      updated_at = excluded.updated_at`).bind(activity.id, input.familyId, label, note, entryDate, stamp).run();
    const state = await getMoneyState(input.familyId);
    await writeBackup(input.familyId, `${profile.name}編輯紀錄：${label}`, state, stamp);
    return state;
  }

  const deletable = (activity.source === "app" && ["allowance", "spend", "reward", "dream", "savings-transfer"].includes(activity.kind))
    || (activity.source === "parent" && activity.kind === "piggy-adjustment");
  if (!deletable) throw new Error("這筆紀錄連結其他帳務，請到對應的家長功能調整，避免餘額或持股失真");
  const nextSpend = profile.spendingBalance - activity.spendDelta;
  const nextBank = profile.bankBalance - activity.bankDelta;
  const nextMarket = profile.marketValue - activity.marketDelta;
  if (nextSpend < 0 || nextBank < 0 || nextMarket < 0) throw new Error("目前餘額不足以撤銷這筆紀錄，請先調整後續帳務");
  let relatedTransferId: string | null = null;
  if (activity.kind === "savings-transfer") {
    const related = await d1.prepare(`SELECT id FROM savings_transfers
      WHERE family_id = ? AND profile_id = ? AND status = 'approved'
        AND (activity_id = ? OR (activity_id IS NULL AND amount = ?))
      ORDER BY CASE WHEN activity_id = ? THEN 0 ELSE 1 END, resolved_at DESC LIMIT 1`)
      .bind(input.familyId, activity.profileId, activity.id, activity.amount, activity.id)
      .first<{ id: string }>();
    relatedTransferId = related?.id ?? null;
    if (!relatedTransferId) throw new Error("找不到這筆自主存錢所連結的申請，已停止撤銷以避免帳務失真");
  }
  const statements: D1PreparedStatement[] = [
    d1.prepare(`INSERT INTO activity_changes (
      activity_id, family_id, deleted_at, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`)
      .bind(activity.id, input.familyId, stamp, stamp),
    d1.prepare("UPDATE profiles SET spending_balance = ?, bank_balance = ?, market_value = ?, updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(nextSpend, nextBank, nextMarket, stamp, profile.id, input.familyId),
  ];
  if (relatedTransferId) {
    statements.push(d1.prepare(`UPDATE savings_transfers SET status = 'reversed', resolved_at = ?, updated_at = ?
      WHERE id = ? AND family_id = ? AND status = 'approved'`).bind(stamp, stamp, relatedTransferId, input.familyId));
  }
  await d1.batch(statements);
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, `${profile.name}刪除紀錄：${activity.label}`, state, stamp);
  return state;
}

export async function updateInvestmentPreset(input: {
  familyId: string;
  action: "create" | "update" | "delete";
  presetId?: string;
  symbol?: string;
  name?: string;
  category?: "ETF" | "股票";
  sortOrder?: number;
  parentPin?: string;
}): Promise<MoneyState> {
  await ensureSchema();
  await assertParentPin(input.familyId, input.parentPin);
  const d1 = db();
  const stamp = nowIso();
  if (input.action === "delete") {
    if (!input.presetId) throw new Error("找不到這個常用標的");
    await d1.prepare("UPDATE investment_presets SET active = 0, updated_at = ? WHERE id = ? AND family_id = ?")
      .bind(stamp, input.presetId, input.familyId)
      .run();
  } else {
    const symbol = input.symbol?.trim().toUpperCase() ?? "";
    const name = input.name?.trim() ?? "";
    const category = input.category === "股票" ? "股票" : "ETF";
    const sortOrder = Math.max(0, Math.min(100, Math.round(Number(input.sortOrder ?? 0))));
    if (!/^[0-9A-Z.\-]{2,12}$/.test(symbol)) throw new Error("請輸入正確的標的代號");
    if (name.length < 2 || name.length > 40) throw new Error("請輸入標的名稱");
    if (input.action === "create") {
      await d1.prepare(`INSERT INTO investment_presets (
        id, family_id, symbol, name, category, sort_order, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(family_id, symbol) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        sort_order = excluded.sort_order,
        active = 1,
        updated_at = excluded.updated_at`)
        .bind(crypto.randomUUID(), input.familyId, symbol, name, category, sortOrder, stamp, stamp)
        .run();
    } else {
      if (!input.presetId) throw new Error("找不到這個常用標的");
      await d1.prepare("UPDATE investment_presets SET symbol = ?, name = ?, category = ?, sort_order = ?, active = 1, updated_at = ? WHERE id = ? AND family_id = ?")
        .bind(symbol, name, category, sortOrder, stamp, input.presetId, input.familyId)
        .run();
    }
  }
  const state = await getMoneyState(input.familyId);
  await writeBackup(input.familyId, "家長調整常用投資標的", state, stamp);
  return state;
}

type BackupCopyRow = {
  id: string;
  familyId: string;
  reason: string;
  snapshotJson: string;
  createdAt: string;
  r2Key: string;
  r2Attempts: number;
};

function backupErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 500) || "獨立雲端副本暫時無法寫入";
}

async function uploadBackupCopy(row: BackupCopyRow): Promise<void> {
  const d1 = db();
  try {
    if (!env.PROFILE_PHOTOS) throw new Error("獨立雲端儲存空間尚未連線");
    await d1.prepare("UPDATE backups SET r2_status = 'pending', r2_error = NULL WHERE id = ? AND family_id = ?")
      .bind(row.id, row.familyId)
      .run();
    const state = JSON.parse(row.snapshotJson) as MoneyState;
    await env.PROFILE_PHOTOS.put(
      row.r2Key,
      new Blob([JSON.stringify({
        format: "money-island-snapshot",
        version: 1,
        familyId: row.familyId,
        reason: row.reason,
        createdAt: row.createdAt,
        state,
      })], { type: "application/json" }),
      { httpMetadata: { contentType: "application/json; charset=utf-8" } },
    );
    await d1.prepare(`UPDATE backups SET r2_status = 'ready', r2_attempts = ?, r2_error = NULL,
      snapshot_json = ''
      WHERE id = ? AND family_id = ?`)
      .bind(row.r2Attempts + 1, row.id, row.familyId)
      .run();
  } catch (error) {
    try {
      await d1.prepare(`UPDATE backups SET r2_status = 'failed', r2_attempts = ?, r2_error = ?
        WHERE id = ? AND family_id = ?`)
        .bind(row.r2Attempts + 1, backupErrorMessage(error), row.id, row.familyId)
        .run();
    } catch {
      // The D1 snapshot was already saved. Metadata/R2 failures must never
      // make an already-applied financial operation appear to have failed.
    }
  }
}

async function pruneOldBackups(familyId: string, keep = 30): Promise<void> {
  try {
    const obsolete = await db().prepare(`SELECT id, r2_key AS r2Key FROM backups
      WHERE family_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?`)
      .bind(familyId, keep)
      .all<{ id: string; r2Key: string | null }>();
    if (!obsolete.results.length) return;
    if (env.PROFILE_PHOTOS) {
      for (const row of obsolete.results) {
        if (row.r2Key) await env.PROFILE_PHOTOS.delete(row.r2Key).catch(() => undefined);
      }
    }
    const ids = obsolete.results.map((row) => row.id);
    for (let index = 0; index < ids.length; index += 50) {
      const chunk = ids.slice(index, index + 50);
      await db().prepare(`DELETE FROM backups WHERE family_id = ? AND id IN (${chunk.map(() => "?").join(",")})`)
        .bind(familyId, ...chunk)
        .run();
    }
  } catch {
    // Retention is best-effort and must not change the result of a money action.
  }
}

async function retryFailedBackupCopies(familyId: string, excludeId: string): Promise<void> {
  if (!env.PROFILE_PHOTOS) return;
  try {
    const rows = await db().prepare(`SELECT id, family_id AS familyId, reason,
      snapshot_json AS snapshotJson, created_at AS createdAt, r2_key AS r2Key,
      r2_attempts AS r2Attempts
      FROM backups
      WHERE family_id = ? AND id <> ? AND r2_status = 'failed'
        AND r2_attempts < 3 AND r2_key IS NOT NULL
      ORDER BY created_at ASC LIMIT 3`)
      .bind(familyId, excludeId)
      .all<BackupCopyRow>();
    for (const row of rows.results) await uploadBackupCopy(row);
  } catch {
    // Retry bookkeeping is best-effort; the complete D1 snapshots remain usable.
  }
}

async function readCompleteBackupState(familyId: string, visibleState: MoneyState): Promise<MoneyState> {
  const d1 = db();
  const [activities, projects, purchases, reflections, harvests, savingsTransfers] = await Promise.all([
    d1.prepare(`SELECT ${ACTIVITY_EDITED_COLUMNS}
      FROM activities a LEFT JOIN activity_changes c ON c.activity_id = a.id
      WHERE a.family_id = ? AND c.deleted_at IS NULL
      ORDER BY COALESCE(c.edited_entry_date, a.entry_date) DESC, a.created_at DESC`)
      .bind(familyId).all<MoneyActivity>(),
    d1.prepare(`SELECT ${PROJECT_COLUMNS} FROM family_projects
      WHERE family_id = ? ORDER BY updated_at DESC`).bind(familyId).all<FamilyProject>(),
    d1.prepare(`SELECT ${PURCHASE_COLUMNS} FROM investment_purchases
      WHERE family_id = ? ORDER BY purchase_date DESC, created_at DESC`).bind(familyId).all<InvestmentPurchase>(),
    d1.prepare(`SELECT ${REFLECTION_COLUMNS} FROM monthly_reflections
      WHERE family_id = ? ORDER BY month DESC, updated_at DESC`).bind(familyId).all<MonthlyReflection>(),
    d1.prepare(`SELECT ${HARVEST_COLUMNS} FROM annual_harvests
      WHERE family_id = ? ORDER BY year DESC, created_at DESC`).bind(familyId).all<AnnualHarvest>(),
    d1.prepare(`SELECT ${SAVINGS_TRANSFER_COLUMNS} FROM savings_transfers
      WHERE family_id = ? ORDER BY updated_at DESC`).bind(familyId).all<SavingsTransfer>(),
  ]);
  return {
    ...visibleState,
    activities: activities.results,
    projects: projects.results,
    purchases: purchases.results,
    reflections: reflections.results,
    harvests: harvests.results.map((harvest) => harvest.destinationDreamId
      && !visibleState.dreamJars.some((dream) => dream.id === harvest.destinationDreamId)
      ? { ...harvest, destinationDreamId: null }
      : harvest),
    savingsTransfers: savingsTransfers.results,
  };
}

async function writeBackup(familyId: string, reason: string, state: MoneyState, stamp = nowIso()): Promise<void> {
  const id = crypto.randomUUID();
  const r2Key = `family-backups/${familyId}/${stamp.replace(/[:.]/g, "-")}-${id}.json`;
  try {
    const completeState = await readCompleteBackupState(familyId, state);
    const nextBackup = { id, reason, createdAt: stamp, copyStatus: "pending" as const };
    const canonicalState: MoneyState = {
      ...completeState,
      latestBackup: nextBackup,
      backupHealth: { status: "pending" },
    };
    const snapshotJson = JSON.stringify(canonicalState);
    await db().prepare(`INSERT INTO backups (
      id, family_id, reason, snapshot_json, r2_key, r2_status, r2_attempts, r2_error, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?)`)
      .bind(id, familyId, reason, snapshotJson, r2Key, stamp)
      .run();

    state.latestBackup = nextBackup;
    state.backupHealth = { status: "pending" };
    const copyRow: BackupCopyRow = {
      id,
      familyId,
      reason,
      snapshotJson,
      createdAt: stamp,
      r2Key,
      r2Attempts: 0,
    };
    const backgroundCopy = (async () => {
      await uploadBackupCopy(copyRow);
      await retryFailedBackupCopies(familyId, id);
      await pruneOldBackups(familyId);
    })();
    const executionContext = getRequestExecutionContext();
    if (executionContext) executionContext.waitUntil(backgroundCopy);
    else void backgroundCopy;
  } catch (error) {
    // The money mutation has already committed. Never report it as failed just
    // because the follow-up snapshot could not be created.
    state.backupHealth = {
      status: "failed",
      message: `帳本已儲存，雲端備份稍後重試：${backupErrorMessage(error)}`,
    };
  }
}

export async function createBackupEnvelope(familyId: string, parentPin?: string): Promise<MoneyBackupEnvelope> {
  await assertParentPin(familyId, parentPin);
  const visibleState = await getMoneyState(familyId);
  if (!visibleState.family) throw new Error("找不到這個家庭帳本");
  const state = await readCompleteBackupState(familyId, visibleState);
  return {
    format: "money-island-backup",
    version: 1,
    exportedAt: nowIso(),
    family: visibleState.family,
    state,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    invalidBackup("照片內容格式錯誤");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    invalidBackup("照片內容格式錯誤");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function createPortableBackupEnvelope(
  familyId: string,
  parentPin?: string,
): Promise<MoneyPortableBackupEnvelope> {
  const backup = await createBackupEnvelope(familyId, parentPin);
  const photos: MoneyPortableBackupEnvelope["photos"] = [];
  let totalPhotoBytes = 0;
  for (const profile of backup.state.profiles) {
    if (!profile.avatar.startsWith("/api/profile-photo")) continue;
    if (!env.PROFILE_PHOTOS) throw new Error("照片儲存空間尚未連線，無法製作完整可攜備份");
    const object = await env.PROFILE_PHOTOS.get(`profile-photos/${familyId}/${profile.id}`)
      ?? (familyId === LEGACY_FAMILY_ID ? await env.PROFILE_PHOTOS.get(`profile-photos/${profile.id}`) : null);
    if (!object) throw new Error(`找不到${profile.name}的照片，請重新上傳照片後再製作完整備份`);
    const contentType = object.httpMetadata?.contentType ?? "image/jpeg";
    if (!PORTABLE_PHOTO_TYPES.has(contentType as "image/jpeg" | "image/png" | "image/webp")) {
      throw new Error(`${profile.name}的照片格式不支援完整備份`);
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_PORTABLE_PHOTO_BYTES) throw new Error(`${profile.name}的照片大小不符合限制`);
    totalPhotoBytes += bytes.length;
    if (totalPhotoBytes > MAX_PORTABLE_PHOTO_TOTAL_BYTES) throw new Error("照片總容量過大，請縮小照片後再製作完整備份");
    photos.push({
      profileId: profile.id,
      contentType: contentType as "image/jpeg" | "image/png" | "image/webp",
      base64: bytesToBase64(bytes),
    });
  }
  return {
    format: "money-island-portable-backup",
    version: 1,
    exportedAt: backup.exportedAt,
    family: backup.family,
    state: backup.state,
    photos,
  };
}

type BackupRecord = Record<string, unknown>;

function invalidBackup(detail: string): never {
  throw new Error(`備份檔內容不正確：${detail}`);
}

function backupRecord(value: unknown, label: string): BackupRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidBackup(`${label}格式錯誤`);
  return value as BackupRecord;
}

function backupString(value: unknown, label: string, min = 1, max = 500): string {
  if (typeof value !== "string" || value.length < min || value.length > max) invalidBackup(`${label}格式錯誤`);
  return value;
}

function backupId(value: unknown, label: string): string {
  const id = backupString(value, label, 1, 128);
  if (/\s/.test(id)) invalidBackup(`${label}不能包含空白`);
  return id;
}

function backupNumber(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidBackup(`${label}不是有效數字`);
  if (options.integer && !Number.isInteger(value)) invalidBackup(`${label}必須是整數`);
  if (options.min !== undefined && value < options.min) invalidBackup(`${label}小於允許範圍`);
  if (options.max !== undefined && value > options.max) invalidBackup(`${label}超過允許範圍`);
  return value;
}

function backupNullableString(value: unknown, label: string, max = 500): string | null {
  if (value === null || value === undefined) return null;
  return backupString(value, label, 0, max);
}

function backupTimestamp(value: unknown, label: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  const stamp = backupString(value, label, 1, 48);
  if (!Number.isFinite(Date.parse(stamp))) invalidBackup(`${label}不是有效日期時間`);
  return stamp;
}

function backupDate(value: unknown, label: string): string {
  const date = backupString(value, label, 10, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) invalidBackup(`${label}不是有效日期`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() + 1 !== Number(match[2]) || parsed.getUTCDate() !== Number(match[3])) {
    invalidBackup(`${label}不是有效日期`);
  }
  return date;
}

function backupMonth(value: unknown, label: string): string {
  const month = backupString(value, label, 7, 7);
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) invalidBackup(`${label}不是有效月份`);
  return month;
}

function backupEnum(value: unknown, label: string, values: readonly string[]): string {
  const item = backupString(value, label, 1, 40);
  if (!values.includes(item)) invalidBackup(`${label}不是支援的選項`);
  return item;
}

function backupRecords(state: BackupRecord, key: string, minimum: number, maximum: number): BackupRecord[] {
  const value = state[key];
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalidBackup(`${key}筆數不正確`);
  return value.map((item, index) => backupRecord(item, `${key}[${index}]`));
}

function addBackupUnique(seen: Set<string>, value: string, label: string): void {
  if (seen.has(value)) invalidBackup(`${label}重複`);
  seen.add(value);
}

function validateBackupEnvelope(value: unknown): asserts value is MoneyBackupEnvelope {
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
  const activities = backupRecords(state, "activities", 0, 10_000);
  const projects = backupRecords(state, "projects", 0, 2_000);
  const holdings = backupRecords(state, "holdings", 0, 1_000);
  const purchases = backupRecords(state, "purchases", 0, 20_000);
  const presets = backupRecords(state, "investmentPresets", 0, 200);
  const dreams = backupRecords(state, "dreamJars", 0, 2_000);
  const reflections = backupRecords(state, "reflections", 0, 5_000);
  const harvests = backupRecords(state, "harvests", 0, 2_000);
  const savingsTransfers = backupRecords(state, "savingsTransfers", 0, 10_000);
  const savingsRate = backupNumber(state.savingsRate, "預先儲蓄比例", { min: 0, max: 100, integer: true });
  if (savingsRate % 5 !== 0) invalidBackup("預先儲蓄比例必須以 5% 為單位");

  const profileIds = new Set<string>();
  for (const profile of profiles) {
    const id = backupId(profile.id, "孩子 ID");
    addBackupUnique(profileIds, id, "孩子 ID");
    backupString(profile.name, "孩子名字", 1, 30);
    backupString(profile.avatar, "孩子頭像", 1, 2_048);
    backupString(profile.accent, "孩子色彩", 1, 64);
    backupNumber(profile.spendingBalance, "撲滿金額", { min: 0, max: 1_000_000_000_000, integer: true });
    backupNumber(profile.bankBalance, "爸媽銀行金額", { min: 0, max: 1_000_000_000_000, integer: true });
    backupNumber(profile.marketValue, "投資市值", { min: 0, max: 1_000_000_000_000, integer: true });
    backupNullableString(profile.stockCode, "投資代號", 32);
    backupNumber(profile.stockUnits, "投資股數", { min: 0, max: 1_000_000_000_000 });
    backupNumber(profile.stockCost, "投資成本", { min: 0, max: 1_000_000_000_000, integer: true });
    backupTimestamp(profile.lastSyncedAt, "同步時間", true);
    backupTimestamp(profile.updatedAt, "孩子更新時間");
    if (profile.rewardClaimedThisMonth !== undefined && typeof profile.rewardClaimedThisMonth !== "boolean") invalidBackup("本月獎勵狀態格式錯誤");
    if (profile.shortDreamBalance !== undefined) backupNumber(profile.shortDreamBalance, "短期夢想金額", { min: 0, max: 1_000_000_000_000, integer: true });
    if (profile.futurePrincipal !== undefined) backupNumber(profile.futurePrincipal, "累積存給未來", { min: 0, max: 1_000_000_000_000, integer: true });
    if (profile.gardenSpecies !== undefined) backupEnum(profile.gardenSpecies, "花園種類", [...GARDEN_SPECIES]);
  }

  const activityIds = new Set<string>();
  const activityProfiles = new Map<string, string>();
  for (const activity of activities) {
    const id = backupId(activity.id, "紀錄 ID");
    addBackupUnique(activityIds, id, "紀錄 ID");
    const profileId = backupId(activity.profileId, "紀錄孩子 ID");
    if (!profileIds.has(profileId)) invalidBackup("紀錄連到不存在的孩子");
    activityProfiles.set(id, profileId);
    backupString(activity.kind, "紀錄類型", 1, 50);
    backupString(activity.label, "紀錄名稱", 1, 120);
    backupNumber(activity.amount, "紀錄金額", { min: -1_000_000_000_000, max: 1_000_000_000_000, integer: true });
    backupNumber(activity.spendDelta, "撲滿變動", { min: -1_000_000_000_000, max: 1_000_000_000_000, integer: true });
    backupNumber(activity.bankDelta, "爸媽銀行變動", { min: -1_000_000_000_000, max: 1_000_000_000_000, integer: true });
    backupNumber(activity.marketDelta, "投資市值變動", { min: -1_000_000_000_000, max: 1_000_000_000_000, integer: true });
    backupString(activity.note, "紀錄備註", 0, 1_000);
    backupDate(activity.entryDate, "紀錄日期");
    backupString(activity.source, "紀錄來源", 1, 40);
    if (activity.operationId !== undefined && activity.operationId !== null) {
      backupString(activity.operationId, "紀錄操作 ID", 8, 120);
    }
    backupTimestamp(activity.createdAt, "紀錄建立時間");
  }

  const projectIds = new Set<string>();
  for (const project of projects) {
    addBackupUnique(projectIds, backupId(project.id, "專案 ID"), "專案 ID");
    backupString(project.title, "專案名稱", 1, 80);
    backupString(project.description, "專案說明", 0, 1_000);
    backupNumber(project.reward, "專案獎勵", { min: 0, max: 10_000_000, integer: true });
    const status = backupEnum(project.status, "專案狀態", ["open", "claimed", "waiting", "completed"]);
    const assignedProfileId = backupNullableString(project.assignedProfileId, "專案孩子 ID", 128);
    if (assignedProfileId && !profileIds.has(assignedProfileId)) invalidBackup("專案連到不存在的孩子");
    if (status !== "open" && !assignedProfileId) invalidBackup("已接下的專案缺少孩子資料");
    backupTimestamp(project.createdAt, "專案建立時間");
    backupTimestamp(project.updatedAt, "專案更新時間");
    const completedAt = backupTimestamp(project.completedAt, "專案完成時間", true);
    if (status === "completed" && !completedAt) invalidBackup("已完成專案缺少完成時間");
  }

  const holdingIds = new Set<string>();
  const holdingKeys = new Set<string>();
  const holdingRefs = new Map<string, { profileId: string; symbol: string }>();
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
    backupNumber(holding.units, "持股股數", { min: 0, max: 1_000_000_000_000 });
    backupNumber(holding.costBasis, "持股成本", { min: 0, max: 1_000_000_000_000, integer: true });
    backupNumber(holding.marketValue, "持股市值", { min: 0, max: 1_000_000_000_000, integer: true });
    backupString(holding.currency, "持股幣別", 1, 8);
    if (holding.quotePrice !== undefined && holding.quotePrice !== null) backupNumber(holding.quotePrice, "收盤價", { min: 0, max: 1_000_000_000 });
    if (holding.quoteAsOf !== undefined && holding.quoteAsOf !== null) backupDate(holding.quoteAsOf, "收盤價日期");
    backupNullableString(holding.quoteSource, "報價來源", 120);
    backupTimestamp(holding.priceUpdatedAt, "報價更新時間", true);
    backupTimestamp(holding.createdAt, "持股建立時間");
    backupTimestamp(holding.updatedAt, "持股更新時間");
  }

  const purchaseIds = new Set<string>();
  const operationIds = new Set<string>();
  for (const purchase of purchases) {
    addBackupUnique(purchaseIds, backupId(purchase.id, "買入 ID"), "買入 ID");
    const profileId = backupId(purchase.profileId, "買入孩子 ID");
    const holdingId = backupId(purchase.holdingId, "買入持股 ID");
    const holding = holdingRefs.get(holdingId);
    if (!holding || holding.profileId !== profileId || !profileIds.has(profileId)) invalidBackup("買入紀錄的孩子或持股關聯錯誤");
    const symbol = backupString(purchase.symbol, "買入代號", 2, 12).toUpperCase();
    if (holding.symbol !== symbol) invalidBackup("買入紀錄與持股代號不一致");
    backupString(purchase.name, "買入名稱", 1, 80);
    backupNumber(purchase.units, "買入股數", { min: Number.EPSILON, max: 1_000_000_000_000 });
    backupNumber(purchase.totalCost, "買入成本", { min: 1, max: 1_000_000_000_000, integer: true });
    backupDate(purchase.purchaseDate, "買入日期");
    backupString(purchase.note, "買入備註", 0, 1_000);
    const operationId = backupNullableString(purchase.operationId, "買入操作 ID", 128);
    if (operationId) addBackupUnique(operationIds, operationId, "買入操作 ID");
    backupTimestamp(purchase.createdAt, "買入建立時間");
  }

  const presetIds = new Set<string>();
  const presetSymbols = new Set<string>();
  for (const preset of presets) {
    addBackupUnique(presetIds, backupId(preset.id, "常用標的 ID"), "常用標的 ID");
    const symbol = backupString(preset.symbol, "常用標的代號", 2, 12).toUpperCase();
    if (!/^[0-9A-Z.\-]{2,12}$/.test(symbol)) invalidBackup("常用標的代號格式錯誤");
    addBackupUnique(presetSymbols, symbol, "常用標的代號");
    backupString(preset.name, "常用標的名稱", 1, 80);
    backupEnum(preset.category, "常用標的類型", ["ETF", "股票"]);
    backupNumber(preset.sortOrder, "常用標的順序", { min: 0, max: 10_000, integer: true });
    if (typeof preset.active !== "boolean") invalidBackup("常用標的啟用狀態格式錯誤");
    backupTimestamp(preset.createdAt, "常用標的建立時間");
    backupTimestamp(preset.updatedAt, "常用標的更新時間");
  }

  const dreamIds = new Set<string>();
  const dreamRefs = new Map<string, { profileId: string; kind: string }>();
  const activeDreamKeys = new Set<string>();
  for (const dream of dreams) {
    const id = backupId(dream.id, "夢想 ID");
    addBackupUnique(dreamIds, id, "夢想 ID");
    const profileId = backupId(dream.profileId, "夢想孩子 ID");
    if (!profileIds.has(profileId)) invalidBackup("夢想連到不存在的孩子");
    backupString(dream.title, "夢想名稱", 1, 80);
    const kind = backupEnum(dream.kind, "夢想類型", ["short", "long"]);
    const status = backupEnum(dream.status, "夢想狀態", ["active", "queued", "completed"]);
    if (status === "active") addBackupUnique(activeDreamKeys, `${profileId}\n${kind}`, "同類型進行中的夢想");
    backupNumber(dream.targetAmount, "夢想目標", { min: 0, max: 1_000_000_000_000, integer: true });
    backupNumber(dream.balance, "夢想金額", { min: 0, max: 1_000_000_000_000, integer: true });
    backupTimestamp(dream.createdAt, "夢想建立時間");
    backupTimestamp(dream.updatedAt, "夢想更新時間");
    const completedAt = backupTimestamp(dream.completedAt, "夢想完成時間", true);
    const completedAmount = dream.completedAmount === null || dream.completedAmount === undefined
      ? null
      : backupNumber(dream.completedAmount, "夢想完成金額", { min: 0, max: 1_000_000_000_000, integer: true });
    if (status === "completed" && (!completedAt || completedAmount === null)) invalidBackup("已完成夢想缺少完成資料");
    dreamRefs.set(id, { profileId, kind });
  }

  const reflectionIds = new Set<string>();
  const reflectionKeys = new Set<string>();
  for (const reflection of reflections) {
    addBackupUnique(reflectionIds, backupId(reflection.id, "回顧 ID"), "回顧 ID");
    const profileId = backupId(reflection.profileId, "回顧孩子 ID");
    if (!profileIds.has(profileId)) invalidBackup("回顧連到不存在的孩子");
    const month = backupMonth(reflection.month, "回顧月份");
    addBackupUnique(reflectionKeys, `${profileId}\n${month}`, "同月份回顧");
    backupString(reflection.proudText, "回顧內容", 0, 2_000);
    backupString(reflection.changeText, "回顧內容", 0, 2_000);
    backupString(reflection.planText, "回顧內容", 0, 2_000);
    backupTimestamp(reflection.updatedAt, "回顧更新時間");
  }

  const harvestIds = new Set<string>();
  const harvestKeys = new Set<string>();
  for (const harvest of harvests) {
    addBackupUnique(harvestIds, backupId(harvest.id, "收成 ID"), "收成 ID");
    const profileId = backupId(harvest.profileId, "收成孩子 ID");
    const holdingId = backupId(harvest.holdingId, "收成持股 ID");
    const holding = holdingRefs.get(holdingId);
    if (!holding || holding.profileId !== profileId || !profileIds.has(profileId)) invalidBackup("收成紀錄的孩子或持股關聯錯誤");
    const year = backupNumber(harvest.year, "收成年份", { min: 1900, max: 2200, integer: true });
    addBackupUnique(harvestKeys, `${profileId}\n${year}`, "同年度收成");
    backupNumber(harvest.percentage, "收成比例", { min: 0, max: 100 });
    backupNumber(harvest.soldUnits, "收成賣出股數", { min: Number.EPSILON, max: 1_000_000_000_000 });
    backupNumber(harvest.referenceMarketValue, "收成參考市值", { min: 0, max: 1_000_000_000_000, integer: true });
    backupNumber(harvest.netProceeds, "收成淨入帳", { min: 1, max: 1_000_000_000_000, integer: true });
    if (harvest.marketValueReduction !== undefined) backupNumber(harvest.marketValueReduction, "收成扣除市值", { min: 0, max: 1_000_000_000_000, integer: true });
    if (harvest.costBasisReduction !== undefined) backupNumber(harvest.costBasisReduction, "收成扣除成本", { min: 0, max: 1_000_000_000_000, integer: true });
    const destinationDreamId = backupNullableString(harvest.destinationDreamId, "收成夢想 ID", 128);
    if (destinationDreamId) {
      const dream = dreamRefs.get(destinationDreamId);
      if (!dream || dream.profileId !== profileId || dream.kind !== "short") invalidBackup("收成目的夢想關聯錯誤");
    }
    const saleDate = backupDate(harvest.saleDate, "收成日期");
    if (Number(saleDate.slice(0, 4)) !== year) invalidBackup("收成年份與日期不一致");
    backupString(harvest.note, "收成備註", 0, 1_000);
    backupTimestamp(harvest.createdAt, "收成建立時間");
  }

  const savingsIds = new Set<string>();
  for (const transfer of savingsTransfers) {
    addBackupUnique(savingsIds, backupId(transfer.id, "自主存錢 ID"), "自主存錢 ID");
    const profileId = backupId(transfer.profileId, "自主存錢孩子 ID");
    if (!profileIds.has(profileId)) invalidBackup("自主存錢連到不存在的孩子");
    backupNumber(transfer.amount, "自主存錢金額", { min: 1, max: 1_000_000_000_000, integer: true });
    backupString(transfer.note, "自主存錢備註", 0, 1_000);
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
}

function validatePortableBackupEnvelope(value: unknown): asserts value is MoneyPortableBackupEnvelope {
  const root = backupRecord(value, "完整可攜備份");
  if (root.format !== "money-island-portable-backup" || root.version !== 1) {
    throw new Error("完整可攜備份版本不支援，請使用網站最新下載的 JSON 檔案");
  }
  const standardEnvelope = {
    format: "money-island-backup" as const,
    version: 1 as const,
    exportedAt: root.exportedAt,
    family: root.family,
    state: root.state,
  };
  validateBackupEnvelope(standardEnvelope);
  if (!Array.isArray(root.photos) || root.photos.length > standardEnvelope.state.profiles.length) {
    invalidBackup("照片清單格式錯誤");
  }
  const profileIds = new Set(standardEnvelope.state.profiles.map((profile) => profile.id));
  const photoProfiles = new Set<string>();
  let totalPhotoBytes = 0;
  for (const rawPhoto of root.photos) {
    const photo = backupRecord(rawPhoto, "孩子照片");
    const profileId = backupId(photo.profileId, "照片孩子 ID");
    if (!profileIds.has(profileId)) invalidBackup("照片連到不存在的孩子");
    addBackupUnique(photoProfiles, profileId, "孩子照片");
    const contentType = backupEnum(photo.contentType, "照片格式", [...PORTABLE_PHOTO_TYPES]);
    const base64 = backupString(photo.base64, "照片內容", 4, Math.ceil(MAX_PORTABLE_PHOTO_BYTES * 4 / 3) + 8);
    const bytes = base64ToBytes(base64);
    if (!bytes.length || bytes.length > MAX_PORTABLE_PHOTO_BYTES) invalidBackup("照片大小不符合限制");
    totalPhotoBytes += bytes.length;
    if (totalPhotoBytes > MAX_PORTABLE_PHOTO_TOTAL_BYTES) invalidBackup("照片總容量超過限制");
    if (!PORTABLE_PHOTO_TYPES.has(contentType as "image/jpeg" | "image/png" | "image/webp")) invalidBackup("照片格式不支援");
  }
  for (const profile of standardEnvelope.state.profiles) {
    if (profile.avatar.startsWith("/api/profile-photo") && !photoProfiles.has(profile.id)) {
      invalidBackup(`${profile.name}缺少照片內容`);
    }
  }
}

export function inspectBackupEnvelope(value: unknown): {
  family: { id: string; code: string; name: string };
  exportedAt: string;
  counts: { profiles: number; activities: number; dreams: number; holdings: number; reflections: number };
  portable: boolean;
  photoCount: number;
} {
  const portable = Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as { format?: unknown }).format === "money-island-portable-backup");
  if (portable) validatePortableBackupEnvelope(value);
  else validateBackupEnvelope(value);
  const backup = value as MoneyBackupEnvelope | MoneyPortableBackupEnvelope;
  return {
    family: backup.family,
    exportedAt: backup.exportedAt,
    counts: {
      profiles: backup.state.profiles.length,
      activities: backup.state.activities.length,
      dreams: backup.state.dreamJars.length,
      holdings: backup.state.holdings.length,
      reflections: backup.state.reflections.length,
    },
    portable,
    photoCount: portable ? (backup as MoneyPortableBackupEnvelope).photos.length : 0,
  };
}

function remapPortableState(
  source: MoneyPortableBackupEnvelope,
  family: { id: string; code: string; name: string },
): { state: MoneyState; photoProfileIds: Map<string, string> } {
  const profileIds = new Map(source.state.profiles.map((profile) => [profile.id, crypto.randomUUID()]));
  const activityIds = new Map(source.state.activities.map((activity) => [activity.id, crypto.randomUUID()]));
  const projectIds = new Map(source.state.projects.map((project) => [project.id, crypto.randomUUID()]));
  const holdingIds = new Map(source.state.holdings.map((holding) => [holding.id, crypto.randomUUID()]));
  const presetIds = new Map(source.state.investmentPresets.map((preset) => [preset.id, crypto.randomUUID()]));
  const dreamIds = new Map(source.state.dreamJars.map((dream) => [dream.id, crypto.randomUUID()]));
  const reflectionIds = new Map(source.state.reflections.map((reflection) => [reflection.id, crypto.randomUUID()]));
  const harvestIds = new Map(source.state.harvests.map((harvest) => [harvest.id, crypto.randomUUID()]));
  const transferIds = new Map(source.state.savingsTransfers.map((transfer) => [transfer.id, crypto.randomUUID()]));
  const purchaseIds = new Map(source.state.purchases.map((purchase) => [purchase.id, crypto.randomUUID()]));
  const photoProfileIds = new Map(source.photos.map((photo) => [photo.profileId, profileIds.get(photo.profileId)!]));
  const required = (mapping: Map<string, string>, id: string, label: string) => {
    const mapped = mapping.get(id);
    if (!mapped) invalidBackup(`${label}連結遺失`);
    return mapped;
  };

  const state: MoneyState = {
    family,
    profiles: source.state.profiles.map((profile) => {
      const id = required(profileIds, profile.id, "孩子");
      return {
        ...profile,
        id,
        avatar: photoProfileIds.has(profile.id) ? `/api/profile-photo?profileId=${id}&v=${Date.now()}` : profile.avatar,
      };
    }),
    activities: source.state.activities.map((activity) => ({
      ...activity,
      id: required(activityIds, activity.id, "紀錄"),
      profileId: required(profileIds, activity.profileId, "紀錄孩子"),
      operationId: activity.operationId ? crypto.randomUUID() : activity.operationId,
    })),
    projects: source.state.projects.map((project) => ({
      ...project,
      id: required(projectIds, project.id, "家庭小專案"),
      assignedProfileId: project.assignedProfileId
        ? required(profileIds, project.assignedProfileId, "家庭小專案孩子")
        : null,
    })),
    holdings: source.state.holdings.map((holding) => ({
      ...holding,
      id: required(holdingIds, holding.id, "投資標的"),
      profileId: required(profileIds, holding.profileId, "投資標的孩子"),
    })),
    purchases: source.state.purchases.map((purchase) => ({
      ...purchase,
      id: required(purchaseIds, purchase.id, "買入紀錄"),
      profileId: required(profileIds, purchase.profileId, "買入紀錄孩子"),
      holdingId: required(holdingIds, purchase.holdingId, "買入紀錄標的"),
      operationId: purchase.operationId ? crypto.randomUUID() : purchase.operationId,
    })),
    investmentPresets: source.state.investmentPresets.map((preset) => ({
      ...preset,
      id: required(presetIds, preset.id, "常用標的"),
    })),
    dreamJars: source.state.dreamJars.map((dream) => ({
      ...dream,
      id: required(dreamIds, dream.id, "夢想罐"),
      profileId: required(profileIds, dream.profileId, "夢想罐孩子"),
    })),
    reflections: source.state.reflections.map((reflection) => ({
      ...reflection,
      id: required(reflectionIds, reflection.id, "每月回顧"),
      profileId: required(profileIds, reflection.profileId, "每月回顧孩子"),
    })),
    harvests: source.state.harvests.map((harvest) => ({
      ...harvest,
      id: required(harvestIds, harvest.id, "過年收成"),
      profileId: required(profileIds, harvest.profileId, "過年收成孩子"),
      holdingId: required(holdingIds, harvest.holdingId, "過年收成標的"),
      destinationDreamId: harvest.destinationDreamId
        ? required(dreamIds, harvest.destinationDreamId, "過年收成夢想罐")
        : null,
    })),
    savingsTransfers: source.state.savingsTransfers.map((transfer) => ({
      ...transfer,
      id: required(transferIds, transfer.id, "自主存錢"),
      profileId: required(profileIds, transfer.profileId, "自主存錢孩子"),
      activityId: transfer.activityId
        ? required(activityIds, transfer.activityId, "自主存錢紀錄")
        : transfer.activityId,
      operationId: transfer.operationId ? crypto.randomUUID() : transfer.operationId,
    })),
    savingsRate: source.state.savingsRate,
    latestBackup: null,
    backupHealth: { status: "pending", message: "等待還原後建立新的雲端備份" },
  };
  return { state, photoProfileIds };
}

export async function restorePortableBackupEnvelope(
  familyId: string,
  parentPin: string | undefined,
  value: unknown,
): Promise<MoneyState> {
  await assertParentPin(familyId, parentPin);
  validatePortableBackupEnvelope(value);
  const family = await db().prepare("SELECT id, code, name FROM families WHERE id = ?")
    .bind(familyId)
    .first<{ id: string; code: string; name: string }>();
  if (!family) throw new Error("找不到目前的家庭帳本");
  if (value.photos.length && !env.PROFILE_PHOTOS) throw new Error("照片儲存空間尚未連線，無法還原完整備份");

  const { state, photoProfileIds } = remapPortableState(value, family);
  const stagedPhotoKeys: string[] = [];
  try {
    for (const photo of value.photos) {
      const profileId = photoProfileIds.get(photo.profileId);
      if (!profileId || !env.PROFILE_PHOTOS) invalidBackup("照片與孩子的連結遺失");
      const key = `profile-photos/${familyId}/${profileId}`;
      await env.PROFILE_PHOTOS.put(key, base64ToBytes(photo.base64), {
        httpMetadata: { contentType: photo.contentType, cacheControl: "private, no-store, max-age=0" },
      });
      stagedPhotoKeys.push(key);
    }
    const envelope: MoneyBackupEnvelope = {
      format: "money-island-backup",
      version: 1,
      exportedAt: value.exportedAt,
      family,
      state,
    };
    return await restoreBackupEnvelope(familyId, parentPin, envelope);
  } catch (error) {
    if (env.PROFILE_PHOTOS) {
      for (const key of stagedPhotoKeys) await env.PROFILE_PHOTOS.delete(key).catch(() => undefined);
    }
    throw error;
  }
}

function backupJsonChunks<T>(records: T[], maximumCharacters = 350_000): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 2;
  for (const record of records) {
    const encoded = JSON.stringify(record);
    if (current.length && currentLength + encoded.length + 1 > maximumCharacters) {
      chunks.push(`[${current.join(",")}]`);
      current = [];
      currentLength = 2;
    }
    current.push(encoded);
    currentLength += encoded.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length) chunks.push(`[${current.join(",")}]`);
  return chunks;
}

export async function restoreBackupEnvelope(familyId: string, parentPin: string | undefined, value: unknown): Promise<MoneyState> {
  await assertParentPin(familyId, parentPin);
  validateBackupEnvelope(value);
  if (value.family.id !== familyId) throw new Error("這份備份屬於另一個家庭，不能覆蓋目前帳本");
  const current = await getMoneyState(familyId);
  await writeBackup(familyId, "上傳還原前自動備份", current);

  const state = value.state;
  const stamp = nowIso();
  const d1 = db();
  const settingId = familyId === LEGACY_FAMILY_ID ? "savings_rate" : `${familyId}:savings_rate`;
  const recoveryLookupHash = await hashRecoveryNames(state.profiles.map((profile) => profile.name));
  const statements: D1PreparedStatement[] = [
    d1.prepare("DELETE FROM activity_changes WHERE family_id = ?").bind(familyId),
    d1.prepare("DELETE FROM activities WHERE family_id = ?").bind(familyId),
    d1.prepare("DELETE FROM investment_purchases WHERE family_id = ?").bind(familyId),
    d1.prepare("DELETE FROM annual_harvests WHERE family_id = ?").bind(familyId),
    d1.prepare("DELETE FROM investment_holdings WHERE family_id = ?").bind(familyId),
    d1.prepare("DELETE FROM monthly_reflections WHERE family_id = ?").bind(familyId),
    d1.prepare("DELETE FROM savings_transfers WHERE family_id = ?").bind(familyId),
    d1.prepare("DELETE FROM dream_jars WHERE family_id = ?").bind(familyId),
    d1.prepare("DELETE FROM family_projects WHERE family_id = ?").bind(familyId),
    d1.prepare("DELETE FROM investment_presets WHERE family_id = ?").bind(familyId),
    d1.prepare("DELETE FROM profile_preferences WHERE family_id = ?").bind(familyId),
    d1.prepare("DELETE FROM profiles WHERE family_id = ?").bind(familyId),
  ];

  for (const json of backupJsonChunks(state.profiles)) {
    statements.push(d1.prepare(`INSERT INTO profiles (
      id, family_id, name, avatar, accent, spending_balance, bank_balance, market_value,
      stock_code, stock_units, stock_cost, last_synced_at, created_at, updated_at
    ) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.name'),
      json_extract(value, '$.avatar'), json_extract(value, '$.accent'),
      CAST(json_extract(value, '$.spendingBalance') AS INTEGER),
      CAST(json_extract(value, '$.bankBalance') AS INTEGER), 0, NULL, 0, 0, NULL,
      json_extract(value, '$.updatedAt'), json_extract(value, '$.updatedAt')
      FROM json_each(?)`).bind(familyId, json));
    statements.push(d1.prepare(`INSERT INTO profile_preferences (profile_id, family_id, garden_species, updated_at)
      SELECT json_extract(value, '$.id'), ?, COALESCE(json_extract(value, '$.gardenSpecies'), 'tree'), ?
      FROM json_each(?)`).bind(familyId, stamp, json));
  }
  for (const json of backupJsonChunks(state.activities)) statements.push(d1.prepare(`INSERT INTO activities (
    id, family_id, profile_id, kind, label, amount, spend_delta, bank_delta, market_delta,
    note, entry_date, source, operation_id, created_at
  ) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.profileId'),
    json_extract(value, '$.kind'), json_extract(value, '$.label'),
    CAST(json_extract(value, '$.amount') AS INTEGER), CAST(json_extract(value, '$.spendDelta') AS INTEGER),
    CAST(json_extract(value, '$.bankDelta') AS INTEGER), CAST(json_extract(value, '$.marketDelta') AS INTEGER),
    COALESCE(json_extract(value, '$.note'), ''), json_extract(value, '$.entryDate'),
    COALESCE(json_extract(value, '$.source'), 'restore'), json_extract(value, '$.operationId'),
    COALESCE(json_extract(value, '$.createdAt'), ?) FROM json_each(?)`).bind(familyId, stamp, json));
  for (const json of backupJsonChunks(state.projects)) statements.push(d1.prepare(`INSERT INTO family_projects (
    id, family_id, title, description, reward, status, assigned_profile_id, created_at, updated_at, completed_at
  ) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.title'),
    COALESCE(json_extract(value, '$.description'), ''), CAST(json_extract(value, '$.reward') AS INTEGER),
    json_extract(value, '$.status'), json_extract(value, '$.assignedProfileId'),
    json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt'), json_extract(value, '$.completedAt')
    FROM json_each(?)`).bind(familyId, json));
  for (const json of backupJsonChunks(state.holdings)) statements.push(d1.prepare(`INSERT INTO investment_holdings (
    id, family_id, profile_id, symbol, name, category, units, cost_basis, market_value, currency,
    quote_price, quote_as_of, quote_source, price_updated_at, created_at, updated_at
  ) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.profileId'), json_extract(value, '$.symbol'),
    json_extract(value, '$.name'), json_extract(value, '$.category'), CAST(json_extract(value, '$.units') AS REAL),
    CAST(json_extract(value, '$.costBasis') AS INTEGER), CAST(json_extract(value, '$.marketValue') AS INTEGER),
    COALESCE(json_extract(value, '$.currency'), 'TWD'), json_extract(value, '$.quotePrice'),
    json_extract(value, '$.quoteAsOf'), json_extract(value, '$.quoteSource'), json_extract(value, '$.priceUpdatedAt'),
    json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt') FROM json_each(?)`).bind(familyId, json));
  for (const json of backupJsonChunks(state.purchases)) statements.push(d1.prepare(`INSERT INTO investment_purchases (
    id, family_id, profile_id, holding_id, symbol, name, units, total_cost, purchase_date, note, operation_id, created_at
  ) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.profileId'), json_extract(value, '$.holdingId'),
    json_extract(value, '$.symbol'), json_extract(value, '$.name'), CAST(json_extract(value, '$.units') AS REAL),
    CAST(json_extract(value, '$.totalCost') AS INTEGER), json_extract(value, '$.purchaseDate'),
    COALESCE(json_extract(value, '$.note'), ''), json_extract(value, '$.operationId'), json_extract(value, '$.createdAt')
    FROM json_each(?)`).bind(familyId, json));
  for (const json of backupJsonChunks(state.investmentPresets)) statements.push(d1.prepare(`INSERT INTO investment_presets (
    id, family_id, symbol, name, category, sort_order, active, created_at, updated_at
  ) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.symbol'), json_extract(value, '$.name'),
    json_extract(value, '$.category'), CAST(json_extract(value, '$.sortOrder') AS INTEGER),
    CAST(json_extract(value, '$.active') AS INTEGER), json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt')
    FROM json_each(?)`).bind(familyId, json));
  for (const json of backupJsonChunks(state.dreamJars)) statements.push(d1.prepare(`INSERT INTO dream_jars (
    id, family_id, profile_id, title, kind, target_amount, balance, status, created_at, updated_at, completed_at, completed_amount
  ) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.profileId'), json_extract(value, '$.title'),
    json_extract(value, '$.kind'), CAST(json_extract(value, '$.targetAmount') AS INTEGER),
    CAST(json_extract(value, '$.balance') AS INTEGER), json_extract(value, '$.status'),
    json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt'), json_extract(value, '$.completedAt'),
    json_extract(value, '$.completedAmount') FROM json_each(?)`).bind(familyId, json));
  for (const json of backupJsonChunks(state.reflections)) statements.push(d1.prepare(`INSERT INTO monthly_reflections (
    id, family_id, profile_id, month, proud_text, change_text, plan_text, updated_at
  ) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.profileId'), json_extract(value, '$.month'),
    COALESCE(json_extract(value, '$.proudText'), ''), COALESCE(json_extract(value, '$.changeText'), ''),
    COALESCE(json_extract(value, '$.planText'), ''), json_extract(value, '$.updatedAt') FROM json_each(?)`).bind(familyId, json));
  for (const json of backupJsonChunks(state.harvests)) statements.push(d1.prepare(`INSERT INTO annual_harvests (
    id, family_id, profile_id, holding_id, year, percentage, sold_units, reference_market_value,
    net_proceeds, market_value_reduction, cost_basis_reduction, destination_dream_id, sale_date, note, created_at
  ) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.profileId'), json_extract(value, '$.holdingId'),
    CAST(json_extract(value, '$.year') AS INTEGER), CAST(json_extract(value, '$.percentage') AS REAL),
    CAST(json_extract(value, '$.soldUnits') AS REAL), CAST(json_extract(value, '$.referenceMarketValue') AS INTEGER),
    CAST(json_extract(value, '$.netProceeds') AS INTEGER), COALESCE(CAST(json_extract(value, '$.marketValueReduction') AS INTEGER), 0),
    COALESCE(CAST(json_extract(value, '$.costBasisReduction') AS INTEGER), 0), json_extract(value, '$.destinationDreamId'),
    json_extract(value, '$.saleDate'), COALESCE(json_extract(value, '$.note'), ''), json_extract(value, '$.createdAt')
    FROM json_each(?)`).bind(familyId, json));
  for (const json of backupJsonChunks(state.savingsTransfers)) statements.push(d1.prepare(`INSERT INTO savings_transfers (
    id, family_id, profile_id, amount, note, status, activity_id, operation_id, created_at, updated_at, resolved_at
  ) SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.profileId'),
    CAST(json_extract(value, '$.amount') AS INTEGER), COALESCE(json_extract(value, '$.note'), ''),
    json_extract(value, '$.status'), json_extract(value, '$.activityId'), json_extract(value, '$.operationId'),
    json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt'), json_extract(value, '$.resolvedAt')
    FROM json_each(?)`).bind(familyId, json));
  statements.push(d1.prepare(`INSERT INTO family_settings (id, family_id, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET family_id = excluded.family_id,
      value = excluded.value, updated_at = excluded.updated_at`)
    .bind(settingId, familyId, String(Math.round(state.savingsRate)), stamp));
  // Holdings are the canonical source for investment aggregates. Never trust
  // duplicated profile totals from an uploaded snapshot.
  statements.push(d1.prepare(`UPDATE profiles SET
    market_value = COALESCE((SELECT SUM(h.market_value) FROM investment_holdings h
      WHERE h.family_id = profiles.family_id AND h.profile_id = profiles.id), 0),
    stock_cost = COALESCE((SELECT SUM(h.cost_basis) FROM investment_holdings h
      WHERE h.family_id = profiles.family_id AND h.profile_id = profiles.id), 0),
    stock_units = COALESCE((SELECT SUM(h.units) FROM investment_holdings h
      WHERE h.family_id = profiles.family_id AND h.profile_id = profiles.id), 0),
    stock_code = (SELECT h.symbol FROM investment_holdings h
      WHERE h.family_id = profiles.family_id AND h.profile_id = profiles.id
      ORDER BY h.created_at, h.id LIMIT 1),
    last_synced_at = (SELECT MAX(COALESCE(h.price_updated_at, h.updated_at)) FROM investment_holdings h
      WHERE h.family_id = profiles.family_id AND h.profile_id = profiles.id),
    updated_at = ? WHERE family_id = ?`).bind(stamp, familyId));
  statements.push(d1.prepare("UPDATE family_security SET recovery_lookup_hash = ?, updated_at = ? WHERE family_id = ?")
    .bind(recoveryLookupHash || null, stamp, familyId));
  await d1.batch(statements);
  const restored = await getMoneyState(familyId);
  await writeBackup(familyId, "已由上傳檔案還原", restored);
  return getMoneyState(familyId);
}
