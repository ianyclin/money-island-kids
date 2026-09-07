import assert from "node:assert/strict";
import test from "node:test";

import { calculateProportionalReduction, roundUnits } from "../lib/investment-math.ts";
import {
  isTwseSymbol,
  parseTwseClosingQuotes,
  rocDateToIso,
  TWSE_QUOTE_SOURCE,
} from "../lib/market-quotes.ts";

test("a partial sale reduces cost and market value by units sold, not by proceeds", () => {
  const reduction = calculateProportionalReduction({
    holdingUnits: 100,
    soldUnits: 25,
    costBasis: 10_000,
    marketValue: 12_500,
  });

  assert.deepEqual(reduction, {
    ratio: 0.25,
    costReduction: 2_500,
    marketReduction: 3_125,
  });

  const netProceeds = 3_300;
  const realizedProfitSinceLastValuation = netProceeds - reduction.marketReduction;
  assert.equal(realizedProfitSinceLastValuation, 175);
  assert.notEqual(reduction.marketReduction, netProceeds);
});

test("realized P/L can be negative while proportional book reductions remain unchanged", () => {
  const reduction = calculateProportionalReduction({
    holdingUnits: 8,
    soldUnits: 2,
    costBasis: 8_001,
    marketValue: 9_999,
  });

  assert.equal(reduction.costReduction, 2_000);
  assert.equal(reduction.marketReduction, 2_500);
  assert.equal(2_425 - reduction.marketReduction, -75);
});

test("a full sale removes the complete rounded cost and market value", () => {
  assert.deepEqual(
    calculateProportionalReduction({
      holdingUnits: 12.3456,
      soldUnits: 12.3456,
      costBasis: 12_345.49,
      marketValue: 15_678.51,
    }),
    {
      ratio: 1,
      costReduction: 12_345,
      marketReduction: 15_679,
    },
  );
});

test("invalid sale quantities and non-finite accounting values are rejected", () => {
  assert.throws(
    () => calculateProportionalReduction({ holdingUnits: 10, soldUnits: 0, costBasis: 100, marketValue: 100 }),
    /賣出股數必須大於零且不能超過持有股數/,
  );
  assert.throws(
    () => calculateProportionalReduction({ holdingUnits: 10, soldUnits: 11, costBasis: 100, marketValue: 100 }),
    /賣出股數必須大於零且不能超過持有股數/,
  );
  assert.throws(
    () => calculateProportionalReduction({ holdingUnits: 10, soldUnits: 1, costBasis: Number.NaN, marketValue: 100 }),
    /投入成本必須是有效的非負數/,
  );
});

test("unit quantities are rounded to four decimal places", () => {
  assert.equal(roundUnits(1.23456), 1.2346);
  assert.equal(roundUnits(1.23454), 1.2345);
  assert.equal(roundUnits(0.00004), 0);
  assert.throws(() => roundUnits(Number.POSITIVE_INFINITY), /股數必須是有效數字/);
});

test("TWSE ROC dates become validated ISO dates", () => {
  assert.equal(rocDateToIso("1150807"), "2026-08-07");
  assert.equal(rocDateToIso("1130229"), "2024-02-29");
  assert.equal(rocDateToIso("1140229"), null);
  assert.equal(rocDateToIso("1151332"), null);
  assert.equal(rocDateToIso("20260807"), null);
  assert.equal(rocDateToIso("not-a-date"), null);
});

test("TWSE closing quote parsing filters requested symbols and invalid or unavailable rows", () => {
  const quotes = parseTwseClosingQuotes(
    [
      { Date: "1150807", Code: "0050", Name: "元大台灣50", ClosingPrice: "102.85" },
      { Date: "1150807", Code: "00646", Name: "元大 S&P 500", ClosingPrice: "78.25" },
      { Date: "1150807", Code: "00878", Name: "國泰永續高股息", ClosingPrice: "1,234.50" },
      { Date: "1140229", Code: "00999", Name: "日期錯誤", ClosingPrice: "50" },
      { Date: "1150807", Code: "00692", Name: "價格錯誤", ClosingPrice: "--" },
    ],
    [" 0050 ", "00878", "00692", "00999", "00757"],
  );

  assert.deepEqual(quotes, [
    {
      symbol: "0050",
      name: "元大台灣50",
      price: 102.85,
      asOf: "2026-08-07",
      source: TWSE_QUOTE_SOURCE,
      exchange: "TWSE",
      currency: "TWD",
    },
    {
      symbol: "00878",
      name: "國泰永續高股息",
      price: 1_234.5,
      asOf: "2026-08-07",
      source: TWSE_QUOTE_SOURCE,
      exchange: "TWSE",
      currency: "TWD",
    },
  ]);

  assert.equal(quotes.some((quote) => quote.symbol === "00757"), false, "an unavailable requested symbol stays absent");
});

test("TWSE parser rejects non-array payloads and recognizes supported symbol shapes", () => {
  assert.throws(() => parseTwseClosingQuotes({ error: "temporarily unavailable" }), /證交所行情格式不正確/);
  assert.equal(isTwseSymbol("00646"), true);
  assert.equal(isTwseSymbol(" 0050 "), true);
  assert.equal(isTwseSymbol("1234A"), true);
  assert.equal(isTwseSymbol("AAPL"), false);
  assert.equal(isTwseSymbol("00646.TW"), false);
  assert.equal(isTwseSymbol("123"), false);
});
