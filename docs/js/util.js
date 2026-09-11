// 小小理財島 PWA：共用工具。所有模組都只從這裡拿格式化、escape、日期與 id。

// ---------- HTML 樣板 ----------
// html`` 會 escape 每一個插值；陣列串接；null/undefined/false 變空字串；raw() 才原樣輸出。
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

class RawHtml {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
}

export function esc(value) {
  return String(value).replace(ESCAPE_RE, (char) => ESCAPE_MAP[char]);
}

export function raw(value) {
  return new RawHtml(value);
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof RawHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join("");
  return esc(value);
}

export function html(strings, ...values) {
  let out = "";
  for (let index = 0; index < strings.length; index += 1) {
    out += strings[index];
    if (index < values.length) out += renderValue(values[index]);
  }
  return new RawHtml(out);
}

export function classNames(...parts) {
  return parts.filter(Boolean).join(" ");
}

// ---------- 金額與數字 ----------
const moneyFormat = new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 });

export function money(value) {
  return moneyFormat.format(Number(value) || 0);
}

export function signedMoney(value) {
  const number = Number(value) || 0;
  return number > 0 ? `+${money(number)}` : money(number);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function splitBySavingsRate(amount, savingsRate) {
  const bankDelta = Math.round(amount * savingsRate / 100);
  return { bankDelta, spendDelta: amount - bankDelta };
}

export function roundUnits(value) {
  if (!Number.isFinite(value)) throw new Error("股數必須是有效數字");
  return Math.round(value * 10000) / 10000;
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label}必須是有效的非負數`);
  return value;
}

// 照 lib/investment-math.ts：賣出多少比例的股數，就移除同比例的帳面成本與最後市值。
export function calculateProportionalReduction({ holdingUnits, soldUnits, costBasis, marketValue }) {
  const units = finiteNonNegative(holdingUnits, "持有股數");
  const sold = finiteNonNegative(soldUnits, "賣出股數");
  const cost = finiteNonNegative(costBasis, "投入成本");
  const market = finiteNonNegative(marketValue, "持有市值");
  if (units <= 0 || sold <= 0 || sold > units) throw new Error("賣出股數必須大於零且不能超過持有股數");
  const ratio = sold / units;
  return {
    ratio,
    costReduction: Math.min(Math.round(cost), Math.round(cost * ratio)),
    marketReduction: Math.min(Math.round(market), Math.round(market * ratio)),
  };
}

// ---------- 日期 ----------
export function nowIso() {
  return new Date().toISOString();
}

// YYYY-MM-DD，以台北時間計（照 db/money-store.ts taipeiDate）。
export function taipeiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function taipeiMonth(date = new Date()) {
  return taipeiDate(date).slice(0, 7);
}

export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function isIsoMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

export function formatMonthLabel(value) {
  const [year, month] = value.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

export function formatShortDate(value) {
  return new Intl.DateTimeFormat("zh-TW", { month: "short", day: "numeric", timeZone: "Asia/Taipei" })
    .format(new Date(`${String(value).slice(0, 10)}T12:00:00+08:00`));
}

export function formatDateTime(value) {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

export function formatDate(value) {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "numeric", day: "numeric" }).format(new Date(value));
}

// ---------- id ----------
export function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const READABLE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomReadableCode(length = 6) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => READABLE_ALPHABET[byte % READABLE_ALPHABET.length]).join("");
}

export function familyCode() {
  return `MI-${randomReadableCode(6)}`;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

// ---------- 其他 ----------
export const reduceMotion = () => globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}
