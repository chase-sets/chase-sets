import {
  centsToMoneyAmount,
  centsToSignedMoneyAmount,
  moneyToCents,
  type MoneyAmount,
  type SignedMoneyAmount,
} from "@chase-sets/primitives/money";
import type { SellerOverheadTerms } from "../../../economics/domain/overhead";
import type { CurvePoint } from "../../../market-estimates/domain/demand-curve/curve";

/**
 * Arithmetic shared by Pricing Goals, ported from the parity app's
 * `pricingPolicy.ts` (tcgplayer-automation-app at bdeffa01). Each function keeps
 * the app's operation order so goal decisions reproduce the app's on one curve.
 */

type GoalForecastStatus = "interpolated" | "lower-bound" | "upper-bound" | "unavailable";
export type GoalForecast = Readonly<{ medianSellDays: number | null; status: GoalForecastStatus }>;

/** A curve point in goal arithmetic: price as a number, absent or non-positive features as null. */
export type GoalCurvePoint = Readonly<{
  percentile: number;
  price: number;
  buyerArrivalIntervalDays: number | null;
  storeWinShare: number | null;
  medianSellDays: number | null;
  supplyStatus: CurvePoint["supplyStatus"] | null;
}>;
type SellTimePoint = GoalCurvePoint & Readonly<{ medianSellDays: number }>;

/** Sorted views of one curve that has at least one point with a positive price. */
export type GoalCurveViews = Readonly<{
  byPercentile: readonly GoalCurvePoint[];
  byPrice: readonly GoalCurvePoint[];
  /** Points with an observed sell time, fastest to slowest; may be empty. */
  bySellTime: readonly SellTimePoint[];
  minimumPrice: number;
  maximumPrice: number;
}>;

const roundCurrency = (value: number): number => Math.round(value * 100) / 100;

export const toMoneyAmount = (value: number): MoneyAmount => centsToMoneyAmount(Math.round(value * 100));

export const toSignedMoneyAmount = (value: number): SignedMoneyAmount =>
  centsToSignedMoneyAmount(Math.round(value * 100));

/** Basis points in a whole; cents times this are sub-cent basis-point units. */
const BASIS_POINTS = 10_000n;

/**
 * Net Proceeds per unit at a cent-valued price: the price less each overhead
 * term's relative part, capped, plus its fixed part. It is signed, so a loss
 * stays visible, and continuous, like the app's objective; with no caps it equals
 * the app's `price x (1 - relative) - static`. Terms add exactly in sub-cent
 * basis-point units (a cent x 10,000, a million to the currency unit) and only
 * the total becomes a number, so break-even is exactly zero and a sub-cent profit
 * or loss keeps its sign. Economics' order quote rounds each fee up to the cent
 * and floors its `netProceedsAmount` at zero, so it is not used here.
 */
export function netProceedsAtPrice(price: number, terms: SellerOverheadTerms): number {
  const priceCents = BigInt(Math.round(price * 100));
  const net =
    priceCents * BASIS_POINTS -
    unitOverhead(
      priceCents,
      terms.platformFeeRelativeBps,
      terms.platformFeeFixedPerUnitAmount,
      terms.platformFeeCapPerUnitAmount,
    ) -
    unitOverhead(
      priceCents,
      terms.sellerHandlingRelativeBps,
      terms.sellerHandlingFixedPerUnitAmount,
      terms.sellerHandlingCapPerUnitAmount,
    );
  return Number(net) / 1_000_000;
}

/** One overhead term in sub-cent basis-point units; Economics admits only integer basis points. */
function unitOverhead(
  priceCents: bigint,
  relativeBps: number,
  fixed: SellerOverheadTerms["platformFeeFixedPerUnitAmount"],
  relativeCap: SellerOverheadTerms["platformFeeCapPerUnitAmount"],
): bigint {
  const relative = priceCents * BigInt(relativeBps);
  const cap = relativeCap === null ? null : moneyToCents(relativeCap.amount) * BASIS_POINTS;
  return (cap === null || relative < cap ? relative : cap) + moneyToCents(fixed.amount) * BASIS_POINTS;
}

function isPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** Median wait for a buyer interval when the store wins the given share of buyers. */
function medianSellDays(
  buyerArrivalIntervalDays: number | null,
  storeWinShare: number | null,
  fallback: number | null,
): number | null {
  return isPositive(buyerArrivalIntervalDays) && isPositive(storeWinShare)
    ? (Math.LN2 * buyerArrivalIntervalDays) / storeWinShare
    : fallback;
}

function mixOptional(left: number | null, right: number | null, ratio: number): number | null {
  if (ratio <= 0) return left;
  if (ratio >= 1) return right;
  return left === null || right === null ? null : left + (right - left) * ratio;
}

function interpolate(lower: GoalCurvePoint, upper: GoalCurvePoint, ratio: number): GoalCurvePoint {
  const buyerArrivalIntervalDays = mixOptional(lower.buyerArrivalIntervalDays, upper.buyerArrivalIntervalDays, ratio);
  const storeWinShare = mixOptional(lower.storeWinShare, upper.storeWinShare, ratio);
  return {
    percentile: Math.max(0, Math.min(100, lower.percentile + (upper.percentile - lower.percentile) * ratio)),
    price: roundCurrency(lower.price + (upper.price - lower.price) * ratio),
    buyerArrivalIntervalDays,
    storeWinShare,
    medianSellDays: medianSellDays(
      buyerArrivalIntervalDays,
      storeWinShare,
      mixOptional(lower.medianSellDays, upper.medianSellDays, ratio),
    ),
    supplyStatus: lower.supplyStatus === upper.supplyStatus ? lower.supplyStatus : null,
  };
}

/** The app's `toPricingCurve` and `PreparedCurve`; null when no point has a positive price. */
export function toGoalCurveViews(points: readonly CurvePoint[]): GoalCurveViews | null {
  const byPercentile = points
    .filter((point) => Number.isFinite(point.percentile) && Number(point.priceAmount) > 0)
    .map((point): GoalCurvePoint => {
      const buyerArrivalIntervalDays = isPositive(point.buyerArrivalIntervalDays)
        ? point.buyerArrivalIntervalDays
        : null;
      const storeWinShare = isPositive(point.storeWinShare) ? point.storeWinShare : null;
      return {
        percentile: point.percentile,
        price: Number(point.priceAmount),
        buyerArrivalIntervalDays,
        storeWinShare,
        medianSellDays: medianSellDays(buyerArrivalIntervalDays, storeWinShare, point.medianSellDays),
        supplyStatus: point.supplyStatus,
      };
    })
    .sort((left, right) => left.percentile - right.percentile);
  if (byPercentile.length === 0) return null;
  const byPrice = [...byPercentile].sort(
    (left, right) => left.price - right.price || left.percentile - right.percentile,
  );
  const bySellTime = byPercentile
    .map((point) => ({
      ...point,
      medianSellDays: medianSellDays(point.buyerArrivalIntervalDays, point.storeWinShare, point.medianSellDays),
    }))
    .filter((point): point is SellTimePoint => point.supplyStatus === "observed" && isPositive(point.medianSellDays))
    .sort((left, right) => left.medianSellDays - right.medianSellDays);
  return { byPercentile, byPrice, bySellTime, minimumPrice: byPrice[0]!.price, maximumPrice: byPrice.at(-1)!.price };
}

export function pointAtPercentile(curve: GoalCurveViews, percentile: number): GoalCurvePoint {
  const points = curve.byPercentile;
  if (percentile <= points[0]!.percentile) return points[0]!;
  if (percentile >= points.at(-1)!.percentile) return points.at(-1)!;
  const upperIndex = points.findIndex((point) => point.percentile >= percentile);
  const upper = points[upperIndex]!;
  const lower = points[upperIndex - 1]!;
  const span = upper.percentile - lower.percentile;
  return interpolate(lower, upper, span === 0 ? 0 : (percentile - lower.percentile) / span);
}

/** Requires a nonempty `bySellTime`; horizons beyond either end clamp to that end. */
export function pointAtSellTime(points: readonly SellTimePoint[], horizonDays: number): GoalCurvePoint {
  if (horizonDays <= points[0]!.medianSellDays) return points[0]!;
  if (horizonDays >= points.at(-1)!.medianSellDays) return points.at(-1)!;
  const upperIndex = points.findIndex((point) => point.medianSellDays >= horizonDays);
  const upper = points[upperIndex]!;
  const lower = points[upperIndex - 1]!;
  if (lower.medianSellDays === upper.medianSellDays) return lower;
  return interpolate(lower, upper, horizonRatio(lower, upper, horizonDays));
}

/**
 * Position of a horizon between two curve points. Interpolation mixes buyer
 * arrival interval and Store Win Share linearly, so the median
 * (ln 2 x interval / share) is a linear-fractional function of the ratio and
 * inverts in closed form; it is never interpolated linearly in the median.
 * When either input is missing the stored median mixes linearly instead.
 */
function horizonRatio(lower: SellTimePoint, upper: SellTimePoint, horizonDays: number): number {
  const ratio =
    isPositive(lower.buyerArrivalIntervalDays) &&
    isPositive(upper.buyerArrivalIntervalDays) &&
    isPositive(lower.storeWinShare) &&
    isPositive(upper.storeWinShare)
      ? (horizonDays * lower.storeWinShare - Math.LN2 * lower.buyerArrivalIntervalDays) /
        (Math.LN2 * (upper.buyerArrivalIntervalDays - lower.buyerArrivalIntervalDays) -
          horizonDays * (upper.storeWinShare - lower.storeWinShare))
      : (horizonDays - lower.medianSellDays) / (upper.medianSellDays - lower.medianSellDays);
  return Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
}

function pointAtPrice(curve: GoalCurveViews, price: number): GoalCurvePoint {
  const points = curve.byPrice;
  if (price <= points[0]!.price) return points[0]!;
  if (price >= points.at(-1)!.price) return points.at(-1)!;
  const upperIndex = points.findIndex((point) => point.price >= price);
  const upper = points[upperIndex]!;
  const lower = points[upperIndex - 1]!;
  const span = upper.price - lower.price;
  return interpolate(lower, upper, span === 0 ? 0 : (price - lower.price) / span);
}

/**
 * The app's `selectPricingDecision` with no constraint: the requested point's
 * price rounds to the cent, and the percentile and forecast are read back at
 * that price, so the forecast describes the price actually selected.
 */
export function decideAtPoint(
  curve: GoalCurveViews,
  requested: GoalCurvePoint,
): Readonly<{ selectedPrice: number; equivalentPercentile: number; forecast: GoalForecast }> {
  const selectedPrice = roundCurrency(requested.price);
  return { selectedPrice, ...readBackAtPrice(curve, selectedPrice) };
}

/** The equivalent percentile and forecast at a cent-valued price, read back as a Goal Decision reads them. */
export function readBackAtPrice(
  curve: GoalCurveViews,
  price: number,
): Readonly<{ equivalentPercentile: number; forecast: GoalForecast }> {
  const finalPoint = pointAtPrice(curve, price);
  return {
    equivalentPercentile: finalPoint.percentile,
    forecast: {
      medianSellDays: finalPoint.medianSellDays,
      status:
        finalPoint.supplyStatus !== "observed"
          ? "unavailable"
          : price < curve.minimumPrice
            ? "lower-bound"
            : price > curve.maximumPrice
              ? "upper-bound"
              : "interpolated",
    },
  };
}
