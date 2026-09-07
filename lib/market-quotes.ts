export const TWSE_DAILY_CLOSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL";
export const TWSE_QUOTE_SOURCE = "臺灣證券交易所 OpenAPI · STOCK_DAY_AVG_ALL";

type TwseDailyRow = {
  Date?: unknown;
  Code?: unknown;
  Name?: unknown;
  ClosingPrice?: unknown;
};

export type ClosingQuote = {
  symbol: string;
  name: string;
  price: number;
  asOf: string;
  source: string;
  exchange: "TWSE";
  currency: "TWD";
};

export function isTwseSymbol(symbol: string): boolean {
  return /^\d{4,6}[A-Z]?$/.test(symbol.trim().toUpperCase());
}

export function rocDateToIso(value: string): string | null {
  if (!/^\d{7}$/.test(value)) return null;
  const year = Number(value.slice(0, 3)) + 1911;
  const month = Number(value.slice(3, 5));
  const day = Number(value.slice(5, 7));
  if (year < 1912 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseTwseClosingQuotes(value: unknown, requestedSymbols?: Iterable<string>): ClosingQuote[] {
  if (!Array.isArray(value)) throw new Error("證交所行情格式不正確");
  const requested = requestedSymbols
    ? new Set(Array.from(requestedSymbols, (symbol) => symbol.trim().toUpperCase()))
    : null;
  const quotes: ClosingQuote[] = [];
  for (const raw of value) {
    const row = raw as TwseDailyRow;
    const symbol = String(row.Code ?? "").trim().toUpperCase();
    if (!symbol || (requested && !requested.has(symbol))) continue;
    const asOf = rocDateToIso(String(row.Date ?? "").trim());
    const price = Number(String(row.ClosingPrice ?? "").replaceAll(",", "").trim());
    if (!asOf || !Number.isFinite(price) || price <= 0) continue;
    quotes.push({
      symbol,
      name: String(row.Name ?? symbol).trim() || symbol,
      price,
      asOf,
      source: TWSE_QUOTE_SOURCE,
      exchange: "TWSE",
      currency: "TWD",
    });
  }
  return quotes;
}

export async function fetchTwseClosingQuotes(symbols: Iterable<string>): Promise<ClosingQuote[]> {
  const requested = new Set(Array.from(symbols, (symbol) => symbol.trim().toUpperCase()).filter(isTwseSymbol));
  if (!requested.size) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(TWSE_DAILY_CLOSE_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`證交所行情暫時無法取得（${response.status}）`);
    return parseTwseClosingQuotes(await response.json(), requested);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("證交所行情讀取逾時，已保留原本市值");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
