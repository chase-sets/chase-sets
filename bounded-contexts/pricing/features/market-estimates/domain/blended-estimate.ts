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
 * Participant hygiene is a domain rule owned HERE. Repeat platform trades
 * between the same buyer -> seller pair collapse to the latest print; the
 * minimum-input and confidence gates count distinct buyer accounts (plus
 * already-deduplicated external comps), not platform prints; and one buyer's
 * aggregate weight is capped at the policy share of the pre-cap blend
 * weight. Callers cannot bypass these rules because the aggregate decider
 * (./domain.ts) only receives this calculation's outcome.
 *
 * Two guards keep the blend honest against degenerate input mixes (the
 * "never a garbage number" acceptance criterion):
 *
 * - The EFFECTIVE-sample-size gate: raw input count is not enough when decay
 *   and source weights concentrate almost all weight in one comparable (two
 *   heavily-aged trades plus one fresh comp is really a one-input estimate).
 *   Effective sample size = (sum(w))^2 / sum(w^2) -- the standard
 *   normalized-weights measure, scale-invariant -- must clear the policy's
 *   `minimumEffectiveSampleSize` or there is NO estimate.
 * - The outlier guard: every price is winsorized (clamped, not dropped --
 *   the observation still counts, its magnitude cannot dominate) into
 *   [core / outlierPriceRatio, core * outlierPriceRatio], where core is the
 *   weighted median of the platform-trade core (verified + unverified;
 *   falling back to all usable inputs when no platform trade comps). A
 *   single extreme external comp can therefore never drag the estimate or
 *   its band orders of magnitude away from the trade core.
 *
 * Deterministic: same inputs + same `now` always produce the same estimate.
 * Skew-invariant within a day: ages are NOT clamped at zero -- a comparable
 * with a slightly-future `observedAt` (writer clock skew) gets weight
 * 0.5^(negative/halfLife) > 1, exactly like the source algorithm, so
 * advancing `now` rescales EVERY weight by the same factor and same-day
 * recomputes with unchanged inputs reproduce identical published values
 * (the aggregate decider's same-day dedupe depends on this).
 */

export type ComparableSaleSource = "platform-verified-trade" | "platform-trade" | "external-comp";

/** One Comparable Sale (GLOSSARY.md): a completed-transaction or provider comp input selected as relevant to a product's estimate. */
type ComparableSaleValue = Readonly<{
  priceAmount: number;
  observedAt: string;
}>;

export type PlatformComparableSale = ComparableSaleValue &
  Readonly<{
    source: "platform-verified-trade" | "platform-trade";
    /** The Market Participant whose demand this platform print represents. */
    buyerAccountId: string;
    /** Required with the buyer so repeat prints collapse per buyer -> seller pair. */
    sellerAccountId: string;
  }>;

export type ExternalComparableSale = ComparableSaleValue & Readonly<{ source: "external-comp" }>;

export type ComparableSale = PlatformComparableSale | ExternalComparableSale;

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
  /** The effective-sample-size gate: (sum(w))^2 / sum(w^2) must reach this or NO estimate is produced. */
  minimumEffectiveSampleSize: number;
  /** The outlier guard: prices are winsorized into [core / ratio, core * ratio] around the trade-core weighted median. */
  outlierPriceRatio: number;
  /** Maximum aggregate buyer weight as a share of the pre-cap blend weight. External comps are exempt. */
  maximumParticipantWeightShare: number;
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
      reason: "below-minimum-inputs" | "below-minimum-effective-inputs" | "no-usable-inputs";
      inputCounts: MarketEstimateInputCounts;
    }>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function calculateBlendedMarketValueEstimate(
  comparableSales: readonly ComparableSale[],
  params: BlendedEstimateParams,
): BlendedMarketValueEstimate {
  const usable = applyPairDeduplication(
    comparableSales.filter((sale) => Number.isFinite(sale.priceAmount) && sale.priceAmount > 0),
  );
  const inputCounts = countBySource(usable);
  const evidenceCount = countDistinctParticipants(usable) + inputCounts.externalCompCount;

  if (usable.length === 0) {
    return { status: "no-estimate", reason: "no-usable-inputs", inputCounts };
  }
  // Platform volume only adds evidence when it adds a distinct buyer. Each
  // external reference remains one independently deduplicated input.
  if (evidenceCount < params.minimumComparableSales) {
    return { status: "no-estimate", reason: "below-minimum-inputs", inputCounts };
  }

  const nowMs = timestampMs(params.now, "Estimate recompute time");
  const baseWeighted = usable
    .map((sale) => {
      // Age MAY be negative under writer clock skew -- deliberately NOT
      // clamped at zero (faithful to the source algorithm): clamping one
      // input's age while others decay would shift weight RATIOS as `now`
      // advances and break same-day recompute idempotency. A negative age
      // yields weight > 1, and every weight still rescales uniformly.
      const ageDays = (nowMs - timestampMs(sale.observedAt, "Comparable sale observation time")) / MS_PER_DAY;
      // Exponential time decay ported from getSuggestedPriceFromLatestSales:
      // weight = 0.5^(age/halfLife), multiplied by the source weight so
      // platform verified trades anchor the blend, unverified trades count
      // for less, and external comps least (Market-Estimate Policy dials).
      const timeWeight = Math.pow(0.5, ageDays / params.decayHalfLifeDays);
      return {
        price: sale.priceAmount,
        weight: timeWeight * sourceWeight(sale.source, params.sourceWeights),
        source: sale.source,
        participantId: sale.source === "external-comp" ? null : sale.buyerAccountId,
      };
    })
    // A garbage far-future timestamp would produce an unusably-infinite
    // weight; treat it as no input at all rather than letting it dominate.
    .filter((sale) => sale.weight > 0 && Number.isFinite(sale.weight));

  const weighted = capParticipantWeights(baseWeighted, params.maximumParticipantWeightShare);

  const totalWeight = weighted.reduce((sum, sale) => sum + sale.weight, 0);
  if (weighted.length === 0 || totalWeight <= 0 || !Number.isFinite(totalWeight)) {
    return { status: "no-estimate", reason: "no-usable-inputs", inputCounts };
  }

  // The effective-sample-size gate (see the module header): decay + source
  // weights concentrated in one comparable make the raw count a lie -- two
  // months-old trades plus one fresh comp is effectively ONE input, and one
  // input never publishes.
  const sumOfSquares = weighted.reduce((sum, sale) => sum + sale.weight * sale.weight, 0);
  const effectiveSampleSize = (totalWeight * totalWeight) / sumOfSquares;
  if (effectiveSampleSize < params.minimumEffectiveSampleSize) {
    return { status: "no-estimate", reason: "below-minimum-effective-inputs", inputCounts };
  }

  // The outlier guard (see the module header): winsorize every price around
  // the trade core's weighted median so one extreme comparable bounds the
  // estimate AND its band to within outlierPriceRatio of the core.
  const core = weighted.filter((sale) => sale.source !== "external-comp");
  const corePrice = weightedMedianPrice(core.length > 0 ? core : weighted);
  const winsorized = weighted
    .map((sale) => ({
      weight: sale.weight,
      price: Math.min(Math.max(sale.price, corePrice / params.outlierPriceRatio), corePrice * params.outlierPriceRatio),
    }))
    .sort((left, right) => left.price - right.price);

  let cumulative = 0;
  const cumulativeData = winsorized.map((sale) => {
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
    confidence: confidenceForSampleSize(evidenceCount, params.confidenceSampleSizes),
    inputCounts,
  };
}

/** Repeat prints from one buyer -> seller pair contribute only their latest platform trade. */
function applyPairDeduplication(sales: readonly ComparableSale[]): readonly ComparableSale[] {
  const externalComps: ExternalComparableSale[] = [];
  const latestByPair = new Map<string, PlatformComparableSale>();

  for (const sale of sales) {
    if (sale.source === "external-comp") {
      externalComps.push(sale);
      continue;
    }

    const buyerAccountId = requiredParticipantId(sale.buyerAccountId, "Buyer account id");
    const sellerAccountId = requiredParticipantId(sale.sellerAccountId, "Seller account id");
    const normalized = { ...sale, buyerAccountId, sellerAccountId };
    const pairKey = JSON.stringify([buyerAccountId, sellerAccountId]);
    const current = latestByPair.get(pairKey);
    if (!current || comparePlatformSales(normalized, current) > 0) {
      latestByPair.set(pairKey, normalized);
    }
  }

  return [...latestByPair.values(), ...externalComps];
}

/**
 * Caps each buyer's aggregate base weight without reallocating the removed
 * weight. The cap is deliberately measured against the pre-cap total: with
 * the launch 30% cap, measuring against the post-cap total would make the
 * approved three-participant platform-only publication gate impossible.
 */
function capParticipantWeights<T extends Readonly<{ participantId: string | null; weight: number }>>(
  sales: readonly T[],
  maximumShare: number,
): readonly T[] {
  const totalWeight = sales.reduce((sum, sale) => sum + sale.weight, 0);
  const maximumParticipantWeight = totalWeight * maximumShare;
  const weightByParticipant = new Map<string, number>();
  for (const sale of sales) {
    if (sale.participantId !== null) {
      weightByParticipant.set(sale.participantId, (weightByParticipant.get(sale.participantId) ?? 0) + sale.weight);
    }
  }

  return sales.map((sale) => {
    if (sale.participantId === null) return sale;
    const participantWeight = weightByParticipant.get(sale.participantId)!;
    if (participantWeight <= maximumParticipantWeight) return sale;
    return { ...sale, weight: sale.weight * (maximumParticipantWeight / participantWeight) };
  });
}

function countDistinctParticipants(sales: readonly ComparableSale[]): number {
  return new Set(sales.flatMap((sale) => (sale.source === "external-comp" ? [] : [sale.buyerAccountId]))).size;
}

function comparePlatformSales(left: PlatformComparableSale, right: PlatformComparableSale): number {
  const observedAtDifference =
    timestampMs(left.observedAt, "Comparable sale observation time") -
    timestampMs(right.observedAt, "Comparable sale observation time");
  if (observedAtDifference !== 0) return observedAtDifference;

  // Equal timestamps have no chronological winner. Keep the selection
  // deterministic across input order so replay/recompute stays stable.
  const sourceDifference = left.source.localeCompare(right.source);
  return sourceDifference !== 0 ? sourceDifference : left.priceAmount - right.priceAmount;
}

function requiredParticipantId(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required for a platform Comparable Sale.`);
  }
  return normalized;
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

/** The weighted median over already-weighted comparables -- the outlier guard's robust core reference. */
function weightedMedianPrice(sales: readonly Readonly<{ price: number; weight: number }>[]): number {
  const sorted = [...sales].sort((left, right) => left.price - right.price);
  let cumulative = 0;
  const cumulativeData = sorted.map((sale) => {
    cumulative += sale.weight;
    return { price: sale.price, cumulativeWeight: cumulative };
  });
  return weightedPercentilePrice(cumulativeData, cumulative, 50);
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
