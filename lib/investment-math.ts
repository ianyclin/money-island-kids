export type ProportionalReduction = {
  ratio: number;
  costReduction: number;
  marketReduction: number;
};

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label}必須是有效的非負數`);
  return value;
}

/**
 * Removes the same fraction of book cost and last-known market value as the
 * fraction of units sold. Net sale proceeds are deliberately not used here:
 * their difference from marketReduction is the realised gain/loss since the
 * last valuation (including fees).
 */
export function calculateProportionalReduction(input: {
  holdingUnits: number;
  soldUnits: number;
  costBasis: number;
  marketValue: number;
}): ProportionalReduction {
  const holdingUnits = finiteNonNegative(input.holdingUnits, "持有股數");
  const soldUnits = finiteNonNegative(input.soldUnits, "賣出股數");
  const costBasis = finiteNonNegative(input.costBasis, "投入成本");
  const marketValue = finiteNonNegative(input.marketValue, "持有市值");
  if (holdingUnits <= 0 || soldUnits <= 0 || soldUnits > holdingUnits) {
    throw new Error("賣出股數必須大於零且不能超過持有股數");
  }
  const ratio = soldUnits / holdingUnits;
  return {
    ratio,
    costReduction: Math.min(Math.round(costBasis), Math.round(costBasis * ratio)),
    marketReduction: Math.min(Math.round(marketValue), Math.round(marketValue * ratio)),
  };
}

export function roundUnits(value: number): number {
  if (!Number.isFinite(value)) throw new Error("股數必須是有效數字");
  return Math.round(value * 10000) / 10000;
}
