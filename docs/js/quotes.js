// 小小理財島 PWA：臺灣證券交易所收盤價。
// 規則來源：lib/market-quotes.ts（isTwseSymbol、rocDateToIso、逾時與錯誤文案）。
// 單機版差異：OpenAPI 的 STOCK_DAY_AVG_ALL 沒有 CORS 標頭，瀏覽器不能直接打；
// 改用有 access-control-allow-origin: * 的逐檔 rwd 端點，每檔一個請求。

import { taipeiDate } from "./util.js";

const TWSE_STOCK_DAY_AVG_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_AVG";
export const TWSE_QUOTE_SOURCE = "臺灣證券交易所 · STOCK_DAY_AVG";
const REQUEST_TIMEOUT_MS = 12000;      // lib/market-quotes.ts L66

// lib/market-quotes.ts isTwseSymbol L21–23
export function isTwseSymbol(symbol) {
  return /^\d{4,6}[A-Z]?$/.test(String(symbol).trim().toUpperCase());
}

// lib/market-quotes.ts rocDateToIso L25–34，改吃 rwd 端點的「115/09/01」格式。
export function rocDateToIso(value) {
  const match = /^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const year = Number(match[1]) + 1911;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1912 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthParam(date) {
  return `${date.slice(0, 4)}${date.slice(5, 7)}01`;
}

function previousMonthParam(param) {
  const year = Number(param.slice(0, 4));
  const month = Number(param.slice(4, 6));
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${previous.year}${String(previous.month).padStart(2, "0")}01`;
}

// title 形如「115年09月 0050 元大台灣50 日收盤價及月平均收盤價」；抓不到名稱就退回代號。
function quoteNameFromTitle(title, symbol) {
  const text = String(title ?? "").replace(/\s+/g, " ").trim();
  const match = new RegExp(`${symbol}\\s+(.+?)\\s*(?:日收盤價及月平均收盤價|日均價|個股日均價|$)`).exec(text);
  const name = match?.[1]?.trim();
  return name || symbol;
}

// 取 data 中最後一列日期格式為 ROC/MM/DD 的資料（最後一列是「月平均收盤價」，要略過）。
export function parseStockDayAvg(payload, symbol) {
  if (!payload || typeof payload !== "object") throw new Error("證交所行情格式不正確");
  if (payload.stat && payload.stat !== "OK") return null;
  if (!Array.isArray(payload.data)) return null;
  for (let index = payload.data.length - 1; index >= 0; index -= 1) {
    const row = payload.data[index];
    if (!Array.isArray(row) || row.length < 2) continue;
    const asOf = rocDateToIso(row[0]);
    if (!asOf) continue;
    const price = Number(String(row[1] ?? "").replaceAll(",", "").trim());
    if (!Number.isFinite(price) || price <= 0) continue;
    return {
      symbol,
      name: quoteNameFromTitle(payload.title, symbol),
      price,
      asOf,
      source: TWSE_QUOTE_SOURCE,
      exchange: "TWSE",
      currency: "TWD",
    };
  }
  return null;
}

async function fetchMonth(symbol, date) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${TWSE_STOCK_DAY_AVG_URL}?date=${date}&stockNo=${encodeURIComponent(symbol)}&response=json`;
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    // lib/market-quotes.ts L72
    if (!response.ok) throw new Error(`證交所行情暫時無法取得（${response.status}）`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("證交所行情格式不正確");
    }
    return parseStockDayAvg(payload, symbol);
  } catch (error) {
    // lib/market-quotes.ts L75
    if (error instanceof Error && error.name === "AbortError") throw new Error("證交所行情讀取逾時，已保留原本市值");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// 當月沒有資料（月初尚未開盤）就再查上個月。
export async function fetchClosingQuote(symbol) {
  const code = String(symbol).trim().toUpperCase();
  if (!isTwseSymbol(code)) return null;
  const thisMonth = monthParam(taipeiDate());
  const current = await fetchMonth(code, thisMonth);
  if (current) return current;
  return fetchMonth(code, previousMonthParam(thisMonth));
}

// lib/market-quotes.ts fetchTwseClosingQuotes L62–80。
// 全部標的都失敗時丟出第一個錯誤（文案照原本）；部分成功就回傳拿到的那些。
export async function fetchTwseClosingQuotes(symbols) {
  const requested = [...new Set(Array.from(symbols, (symbol) => String(symbol).trim().toUpperCase()).filter(isTwseSymbol))];
  if (!requested.length) return [];
  const settled = await Promise.all(requested.map(async (symbol) => {
    try {
      return { quote: await fetchClosingQuote(symbol), error: null };
    } catch (error) {
      return { quote: null, error };
    }
  }));
  const quotes = settled.flatMap((item) => (item.quote ? [item.quote] : []));
  const firstError = settled.find((item) => item.error)?.error;
  if (!quotes.length && firstError) throw firstError;
  return quotes;
}
