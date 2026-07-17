/**
 * The blended Market-Value Estimate calculation (the m112 blended-estimate slice): one derived
 * fair-value answer per resolved Product, blended from Comparable Sales --
 * platform verified trades weighted highest, platform unverified trades next,
 * external comps by the Market-Estimate Policy's source weights -- all
 * time-decayed through the weighted-percentile algorithm ported from
 * `getSuggestedPriceFromLatestSales.ts` (see
 * ../../../docs/tcgplayer-price-signals.md "Algorithm Decisions": the
 * time-decayed percentile core is ported; TCGplayer fetching, category
 * filters, Zipf condition normalization, and supply analysis are not -- Chase
 * Sets products are already condition-resolved, so cross-condition
 * normalization has no input here).
 *
 * The minimum-input gate is a domain rule owned HERE: below the policy's
 * minimum Comparable Sale count the calculation refuses to produce a number
 * at all (`status: "no-estimate"`), never a garbage estimate. Callers cannot
 * publish what was never computed, and the aggregate decider
 * (./domain.ts) publishes nothing for a `no-estimate` recompute.
 *
 * Deterministic: same inputs + same `now` always produce the same estimate.
 */

export type ComparableSaleSource = "platform-verified-trade" | "platform-trade" | "external-comp";

/** One Comparable Sale (GLOSSARY.md): a completed-transaction or provider comp input selected as relevant to a product's estimate. */
export type ComparableSale = Readonly<{
  priceAmount: number;
  observedAt: string;
  source: ComparableSaleSource;
}>;

export type MarketEstimateSourceWeights = Readonly<{
  platformVerifiedTrade: number;
  platformTrade: number;
  externalComp: number;
}>;

export type BlendedEstimateParams = Readonly<{
  /** The deterministic recompute instant; weights decay relative to this. */
  now: string;
  decayHalfLifeDays: number;
  sourceWeights: MarketEstimateSourceWeights;
  estimatePercentile: number;
  bandLowPercentile: number;
  bandHighPercentile: number;
  minimumComparableSales: number;
  confidenceSampleSizes: Readonly<{ medium: number; high: number }>;
}>;

export type MarketEstimateInputCounts = Readonly<{
  platformVerifiedTradeCount: number;
  platformTradeCount: number;
  externalCompCount: number;
}>;

export type BlendedMarketValueEstimate =
  | Readonly<{
      status: "estimated";
      amount: string;
      bandLowAmount: string;
      bandHighAmount: string;
      confidence: "low" | "medium" | "high";
      inputCounts: MarketEstimateInputCounts;
    }>
  | Readonly<{
      status: "no-estimate";
      reason: "below-minimum-inputs" | "no-usable-inputs";
      inputCounts: MarketEstimateInputCounts;
    }>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function calculateBlendedMarketValueEstimate(
  comparableSales: readonly ComparableSale[],
  params: BlendedEstimateParams,
): BlendedMarketValueEstimate {
  const usable = comparableSales.filter((sale) => Number.isFinite(sale.priceAmount) && sale.priceAmount > 0);
  const inputCounts = countBySource(usable);
  const totalInputs =
    inputCounts.platformVerifiedTradeCount + inputCounts.platformTradeCount + inputCounts.externalCompCount;

  if (totalInputs === 0) {
    return { status: "no-estimate", reason: "no-usable-inputs", inputCounts };
  }
  // The minimum-input gate: below the threshold there is NO estimate --
  // never a garbage number derived from too little evidence.
  if (totalInputs < params.minimumComparableSales) {
    return { status: "no-estimate", reason: "below-minimum-inputs", inputCounts };
  }

  const nowMs = timestampMs(params.now, "Estimate recompute time");
  const weighted = usable
    .map((sale) => {
      const ageDays =
        Math.max(0, nowMs - timestampMs(sale.observedAt, "Comparable sale observation time")) / MS_PER_DAY;
      // Exponential time decay ported from getSuggestedPriceFromLatestSales:
      // weight = 0.5^(age/halfLife), multiplied by the source weight so
      // platform verified trades anchor the blend, unverified trades count
      // for less, and external comps least (Market-Estimate Policy dials).
      const timeWeight = Math.pow(0.5, ageDays / params.decayHalfLifeDays);
      return { price: sale.priceAmount, weight: timeWeight * sourceWeight(sale.source, params.sourceWeights) };
    })
    .filter((sale) => sale.weight > 0)
    .sort((left, right) => left.price - right.price);

  const totalWeight = weighted.reduce((sum, sale) => sum + sale.weight, 0);
  if (weighted.length === 0 || totalWeight <= 0) {
    return { status: "no-estimate", reason: "no-usable-inputs", inputCounts };
  }

  let cumulative = 0;
  const cumulativeData = weighted.map((sale) => {
    cumulative += sale.weight;
    return { price: sale.price, cumulativeWeight: cumulative };
  });

  const amount = weightedPercentilePrice(cumulativeData, totalWeight, params.estimatePercentile);
  const bandLow = weightedPercentilePrice(cumulativeData, totalWeight, params.bandLowPercentile);
  const bandHigh = weightedPercentilePrice(cumulativeData, totalWeight, params.bandHighPercentile);

  return {
    status: "estimated",
    amount: money(amount),
    // The Confidence Band always contains its estimate: percentile prices are
    // monotone in the percentile, and money() rounding preserves order.
    bandLowAmount: money(Math.min(bandLow, amount)),
    bandHighAmount: money(Math.max(bandHigh, amount)),
    confidence: confidenceForSampleSize(totalInputs, params.confidenceSampleSizes),
    inputCounts,
  };
}

/**
 * Interpolated weighted percentile, ported verbatim in behavior from
 * getSuggestedPriceFromLatestSales.ts's getTimeDecayedPercentileWeightedSuggestedPrice:
 * cumulative weights over price-ascending sales, linear interpolation between
 * the two data points straddling the target weight.
 */
function weightedPercentilePrice(
  cumulativeData: readonly Readonly<{ price: number; cumulativeWeight: number }>[],
  totalWeight: number,
  percentile: number,
): number {
  if (percentile <= 0) {
    return cumulativeData[0]!.price;
  }
  if (percentile >= 100) {
    return cumulativeData[cumulativeData.length - 1]!.price;
  }

  const targetWeight = (percentile / 100) * totalWeight;
  let upperIndex = -1;
  for (let index = 0; index < cumulativeData.length; index += 1) {
    if (cumulativeData[index]!.cumulativeWeight >= targetWeight) {
      upperIndex = index;
      break;
    }
  }

  if (upperIndex === -1) {
    return cumulativeData[cumulativeData.length - 1]!.price;
  }
  if (upperIndex === 0) {
    return cumulativeData[0]!.price;
  }

  const lower = cumulativeData[upperIndex - 1]!;
  const upper = cumulativeData[upperIndex]!;
  const weightSpan = upper.cumulativeWeight - lower.cumulativeWeight;
  const ratio = weightSpan === 0 ? 0 : (targetWeight - lower.cumulativeWeight) / weightSpan;
  return lower.price + (upper.price - lower.price) * ratio;
}

function sourceWeight(source: ComparableSaleSource, weights: MarketEstimateSourceWeights): number {
  switch (source) {
    case "platform-verified-trade":
      return weights.platformVerifiedTrade;
    case "platform-trade":
      return weights.platformTrade;
    case "external-comp":
      return weights.externalComp;
  }
}

function confidenceForSampleSize(
  totalInputs: number,
  sampleSizes: Readonly<{ medium: number; high: number }>,
): "low" | "medium" | "high" {
  if (totalInputs >= sampleSizes.high) {
    return "high";
  }
  if (totalInputs >= sampleSizes.medium) {
    return "medium";
  }
  return "low";
}

function countBySource(sales: readonly ComparableSale[]): MarketEstimateInputCounts {
  let platformVerifiedTradeCount = 0;
  let platformTradeCount = 0;
  let externalCompCount = 0;
  for (const sale of sales) {
    if (sale.source === "platform-verified-trade") {
      platformVerifiedTradeCount += 1;
    } else if (sale.source === "platform-trade") {
      platformTradeCount += 1;
    } else {
      externalCompCount += 1;
    }
  }
  return { platformVerifiedTradeCount, platformTradeCount, externalCompCount };
}

function timestampMs(value: string, fieldName: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be an ISO timestamp.`);
  }
  return parsed;
}

function money(value: number): string {
  return value.toFixed(2);
}
