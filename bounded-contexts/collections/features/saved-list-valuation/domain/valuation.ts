import {
  classifyMarketEstimateForDisplay,
  multiplyMarketValueAmount,
  sumMarketValueAmounts,
  type MarketEstimateAudience,
  type MarketEstimateBand,
} from "@chase-sets/market-estimate-display";
import type {
  SavedListLineValuation,
  SavedListMarketEstimate,
  SavedListValuationCoverage,
  SavedListValuationInputLine,
  SavedListValuationSummary,
} from "./contracts";

export function calculateSavedListValuation(
  input: Readonly<{
    lines: readonly SavedListValuationInputLine[];
    estimates: readonly SavedListMarketEstimate[];
    audience: MarketEstimateAudience;
    currencyCode: string;
    valuedAt: string;
  }>,
): Readonly<{ summary: SavedListValuationSummary; lines: readonly SavedListLineValuation[] }> {
  const estimatesByProduct = newestEstimatesByProduct(input.estimates);
  const lines = input.lines.map((line) => {
    const estimate = estimatesByProduct.get(productKey(line.catalogItemId, line.productId)) ?? null;
    const decision = classifyMarketEstimateForDisplay(estimate, {
      audience: input.audience,
      currencyCode: input.currencyCode,
      asOf: input.valuedAt,
    });

    if (decision.status !== "current" || !estimate) {
      const staleEstimate = decision.status === "stale" ? estimate : null;
      return {
        ...line,
        status: staleEstimate ? "stale" : "missing",
        unitEstimateAmount: null,
        estimatedValueAmount: null,
        estimatedValueBand: null,
        currencyCode: null,
        confidence: staleEstimate?.confidence ?? null,
        estimatedAt: staleEstimate?.estimatedAt ?? null,
        freshUntil: staleEstimate?.freshUntil ?? null,
        estimateVersion: staleEstimate?.estimateVersion ?? null,
      } satisfies SavedListLineValuation;
    }

    return {
      ...line,
      status: "priced",
      unitEstimateAmount: estimate.amount,
      estimatedValueAmount: multiplyMarketValueAmount(estimate.amount, line.trackedQuantity),
      estimatedValueBand: multiplyBand(estimate.band, line.trackedQuantity),
      currencyCode: estimate.currencyCode.toLowerCase(),
      confidence: estimate.confidence,
      estimatedAt: estimate.estimatedAt,
      freshUntil: estimate.freshUntil,
      estimateVersion: estimate.estimateVersion,
    } satisfies SavedListLineValuation;
  });

  const pricedLines = lines.filter((line) => line.status === "priced");
  const missingLines = lines.filter((line) => line.status === "missing");
  const staleLines = lines.filter((line) => line.status === "stale");
  const lowConfidenceLines = pricedLines.filter((line) => line.confidence === "low");
  const coverage: SavedListValuationCoverage = {
    priced: count(pricedLines),
    total: count(lines),
    missing: count(missingLines),
    stale: count(staleLines),
    lowConfidence: count(lowConfidenceLines),
  };
  const values = pricedLines.flatMap((line) => (line.estimatedValueAmount ? [line.estimatedValueAmount] : []));
  const bands = pricedLines.flatMap((line) => (line.estimatedValueBand ? [line.estimatedValueBand] : []));
  const estimatedTotalBand =
    pricedLines.length > 0 && bands.length === pricedLines.length
      ? {
          lowAmount: sumMarketValueAmounts(bands.map((band) => band.lowAmount)),
          highAmount: sumMarketValueAmounts(bands.map((band) => band.highAmount)),
        }
      : null;

  return {
    summary: {
      estimatedTotalAmount: values.length > 0 ? sumMarketValueAmounts(values) : null,
      estimatedTotalBand,
      currencyCode: input.currencyCode.toLowerCase(),
      coverage,
      estimateAsOf: earliestTimestamp(pricedLines.flatMap((line) => (line.estimatedAt ? [line.estimatedAt] : []))),
      valuedAt: input.valuedAt,
    },
    lines,
  };
}

function newestEstimatesByProduct(estimates: readonly SavedListMarketEstimate[]): Map<string, SavedListMarketEstimate> {
  const result = new Map<string, SavedListMarketEstimate>();
  for (const estimate of estimates) {
    const key = productKey(estimate.catalogItemId, estimate.productId);
    const current = result.get(key);
    if (
      !current ||
      Date.parse(estimate.estimatedAt) > Date.parse(current.estimatedAt) ||
      (estimate.estimatedAt === current.estimatedAt &&
        estimate.estimateVersion.localeCompare(current.estimateVersion) > 0)
    ) {
      result.set(key, estimate);
    }
  }
  return result;
}

function productKey(catalogItemId: string, productId: string): string {
  return `${catalogItemId}\u0000${productId}`;
}

function multiplyBand(band: MarketEstimateBand | null, quantity: number): MarketEstimateBand | null {
  return band
    ? {
        lowAmount: multiplyMarketValueAmount(band.lowAmount, quantity),
        highAmount: multiplyMarketValueAmount(band.highAmount, quantity),
      }
    : null;
}

function count(lines: readonly Pick<SavedListLineValuation, "trackedQuantity">[]) {
  return {
    lines: lines.length,
    units: lines.reduce((sum, line) => sum + line.trackedQuantity, 0),
  };
}

function earliestTimestamp(values: readonly string[]): string | null {
  return values.length > 0
    ? values.reduce((earliest, value) => (Date.parse(value) < Date.parse(earliest) ? value : earliest))
    : null;
}
