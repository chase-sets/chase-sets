import type { DemandCurvePolicyValue } from "../demand-curve-policy";
import { buildConditionLadder, type ConditionLadder } from "../condition-ladder/condition-ladder";
import type { CurveSale } from "./curve-builder-registry";
import { capParticipantWeights } from "../blended-estimate";

export type SupplyStatus = "observed" | "truncated" | "unavailable" | "disabled";
export type CurvePoint = Readonly<{
  percentile: number;
  priceAmount: string;
  buyerArrivalIntervalDays: number | null;
  competingSellerCount: number | null;
  storeWinShare: number | null;
  medianSellDays: number | null;
  qualifyingSaleCount: number;
  historyCapped: boolean;
  hopeless: boolean;
  supplyStatus: SupplyStatus;
}>;
export type CurveSupply = Readonly<{
  status: SupplyStatus;
  asks: readonly Readonly<{ condition: string; deliveredAmount: number; sellerOrdinal: number }>[];
  ownSellerExclusionApplied: boolean | null;
}>;

const DAY = 86_400_000;

function money(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("Curve amount must be finite and nonnegative.");
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

/** One card's price/arrival/supply curve, in the requested condition's terms. */
export function calculateDemandCurve(
  input: Readonly<{
    sales: readonly CurveSale[];
    siblingMarketPrices: ReadonlyMap<string, number>;
    targetCondition: string;
    asOf: string;
    availableSince?: string;
    supply: CurveSupply;
    policy: DemandCurvePolicyValue;
    sourceWeights: Readonly<{ platformVerifiedTrade: number; platformTrade: number; externalComp: number }>;
    minimumSample: number;
    minimumEffectiveSampleSize: number;
    maximumParticipantWeightShare: number;
    trimPercentile: number;
  }>,
): Readonly<{
  points: readonly CurvePoint[];
  ladder: ConditionLadder;
  exposureStartReason: string;
  salesCoverage: string;
}> | null {
  const asOf = Date.parse(input.asOf);
  const known = input.sales.filter(
    (sale) =>
      input.policy.conditionOrder.includes(sale.condition) &&
      sale.price > 0 &&
      Number.isFinite(Date.parse(sale.soldAt)) &&
      Date.parse(sale.soldAt) <= asOf &&
      Date.parse(sale.soldAt) >= asOf - input.policy.historyDays * DAY,
  );
  const ladder = buildConditionLadder({
    sales: known.map((sale) => ({ condition: sale.condition, price: sale.price, soldAt: sale.soldAt })),
    siblingMarketPrices: input.siblingMarketPrices,
    targetCondition: input.targetCondition,
    asOf: input.asOf,
    policy: input.policy,
  });
  const scaled = known.map((sale) => ({ ...sale, price: sale.price * ladder.multipliers.get(sale.condition)! }));
  // The stat-hygiene gate applies before interpolation and arrival alike.
  const sortedPrices = scaled.map((sale) => sale.price).sort((a, b) => a - b);
  const trim = (sortedPrices.length * input.trimPercentile) / 100 >= 1 ? input.trimPercentile / 100 : 0;
  const continuousPercentile = (fraction: number) => {
    const position = (sortedPrices.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sortedPrices[lower]! + (sortedPrices[upper]! - sortedPrices[lower]!) * (position - lower);
  };
  const low = sortedPrices.length ? continuousPercentile(trim) : -Infinity;
  const high = sortedPrices.length ? continuousPercentile(1 - trim) : Infinity;
  const sales = scaled
    .filter((sale) => sale.price >= low && sale.price <= high)
    .map((sale, index) => ({ sale, index }))
    .sort((a, b) => Date.parse(b.sale.soldAt) - Date.parse(a.sale.soldAt))
    .slice(0, input.policy.salesLimit)
    .sort((a, b) => a.index - b.index)
    .map(({ sale }) => sale);
  if (sales.length < input.minimumSample) return null;
  const halfLife = input.policy.decayHalfLifeDays;
  const weighted = [
    ...capParticipantWeights(
      sales.map((sale) => ({
        ...sale,
        participantId: sale.participantId ?? null,
        weight:
          Math.pow(0.5, (asOf - Date.parse(sale.soldAt)) / DAY / halfLife) *
          (sale.source === "platform-verified-trade"
            ? input.sourceWeights.platformVerifiedTrade
            : sale.source === "platform-trade"
              ? input.sourceWeights.platformTrade
              : input.sourceWeights.externalComp),
      })),
      input.maximumParticipantWeightShare,
    ),
  ].sort((a, b) => a.price - b.price);
  const totalWeight = weighted.reduce((sum, sale) => sum + sale.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return null;
  const sumOfSquares = weighted.reduce((sum, sale) => sum + sale.weight * sale.weight, 0);
  if (
    !Number.isFinite(sumOfSquares) ||
    sumOfSquares <= 0 ||
    (totalWeight * totalWeight) / sumOfSquares < input.minimumEffectiveSampleSize
  )
    return null;
  const cumulative: number[] = [];
  weighted.reduce((sum, sale, index) => {
    cumulative[index] = sum + sale.weight;
    return sum + sale.weight;
  }, 0);
  const historyCapped = sales.length === input.policy.salesLimit;
  const observedStart = historyCapped
    ? Math.min(...sales.map((sale) => Date.parse(sale.soldAt)))
    : asOf - input.policy.historyDays * DAY;
  const availability = input.availableSince
    ? Math.min(asOf, Date.parse(input.availableSince), ...sales.map((sale) => Date.parse(sale.soldAt)))
    : -Infinity;
  const start = Math.max(observedStart, availability);
  const exposureStartReason =
    availability > observedStart ? "availability" : historyCapped ? "sales-cap" : "history-window";
  const observationDays = Math.max(1 / 24, (asOf - start) / DAY);
  const decayRate = Math.LN2 / halfLife;
  const effectiveExposureDays = Math.max(1 / 24, (1 - Math.exp(-decayRate * observationDays)) / decayRate);
  const points = input.policy.percentiles.map((percentile): CurvePoint => {
    const target = (percentile / 100) * totalWeight;
    let index = cumulative.findIndex((sum) => sum >= target);
    if (index < 0) index = weighted.length - 1;
    const lower = Math.max(0, index - 1);
    const offset = index === lower ? 0 : (target - cumulative[lower]!) / (cumulative[index]! - cumulative[lower]!);
    const price = weighted[lower]!.price + (weighted[index]!.price - weighted[lower]!.price) * offset;
    const qualifying = sales.filter((sale) => Date.parse(sale.soldAt) >= start && sale.price >= price);
    const weightedCount = qualifying.reduce(
      (sum, sale) => sum + Math.exp((-decayRate * (asOf - Date.parse(sale.soldAt))) / DAY),
      0,
    );
    const interval = weightedCount > 0 ? effectiveExposureDays / weightedCount : null;
    const sellers =
      input.supply.status === "observed"
        ? new Set(
            input.supply.asks
              .filter(
                (ask) =>
                  input.policy.conditionOrder.includes(ask.condition) &&
                  ask.deliveredAmount * ladder.multipliers.get(ask.condition)! <= price,
              )
              .map((ask) => ask.sellerOrdinal),
          ).size
        : null;
    const winShare = sellers === null ? null : 1 / (sellers + 1);
    const median = interval === null || winShare === null ? null : (Math.LN2 * interval) / winShare;
    return {
      percentile,
      priceAmount: money(price),
      buyerArrivalIntervalDays: interval,
      competingSellerCount: sellers,
      storeWinShare: winShare,
      medianSellDays: median,
      qualifyingSaleCount: qualifying.length,
      historyCapped,
      hopeless: median !== null && median > input.policy.hopelessHorizonDays,
      supplyStatus: input.supply.status,
    };
  });
  return {
    points,
    ladder,
    exposureStartReason,
    salesCoverage: sales.every((sale) => sale.coverage === "complete") ? "complete" : "truncated",
  };
}
