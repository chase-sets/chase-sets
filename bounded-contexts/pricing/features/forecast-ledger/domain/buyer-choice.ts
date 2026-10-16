import type { CurvePoint } from "../../market-estimates/domain/demand-curve/curve";

/**
 * The parity app's buyer-choice sell-time forecast (`buyerChoiceSellTime.ts`,
 * tcgplayer-automation-app at bdeffa01), kept in its operation order. A
 * listing's daily sale rate is the card's sale rate at any price, softened by
 * how many sellers compete for it, and scaled by the card's share of what the
 * buyer pays once the fixed cost of a purchase is included:
 *
 *   rate = e^logDailyRate · interval^-demand · (sellers + 1)^-competition
 *          · (price / (price + purchaseFixedCost))^effectivePrice
 *
 * The model has no within-card price response, so it forecasts one listing at
 * its price and must not be read along a curve.
 */
export type BuyerChoiceCalibration = Readonly<{
  /** Identifies the fit, so forecasts from different fits are graded apart. */
  name: string;
  logDailyRate: number;
  demandElasticity: number;
  competitionElasticity: number;
  effectivePriceElasticity: number;
  /** Currency units a buyer pays beyond the card, as assumed by the fit. */
  purchaseFixedCost: number;
}>;

/**
 * Fitted by the app on 1,196 listings priced 2026-08-11 to 13 against their
 * sales over the following 21 days. Those curves counted competing sellers in
 * the listing's own condition; the Demand Curve counts sellers in every
 * condition of the product, so this fit reads a larger competitor count than
 * it was trained on until it is refit on pooled curves.
 */
export const BUYER_CHOICE_CALIBRATION: BuyerChoiceCalibration = {
  name: "2026-08-11-cohort",
  logDailyRate: -3.5172,
  demandElasticity: 0.4478,
  competitionElasticity: 0.1997,
  effectivePriceElasticity: 0.8246,
  purchaseFixedCost: 1.49,
};

/** The interval at the curve's lowest percentile with one, and the most competing sellers on the curve. */
export function buyerChoiceInputs(
  points: readonly CurvePoint[],
): Readonly<{ buyerIntervalDays: number; competingSellers: number }> | null {
  const bottom = [...points]
    .sort((left, right) => left.percentile - right.percentile)
    .find((point) => (point.buyerArrivalIntervalDays ?? 0) > 0);
  const sellerCounts = points
    .map((point) => point.competingSellerCount)
    .filter((count): count is number => count !== null);
  if (!bottom || sellerCounts.length === 0) return null;
  return { buyerIntervalDays: bottom.buyerArrivalIntervalDays!, competingSellers: Math.max(...sellerCounts) };
}

/** Median days for one listing to sell at its price, or null when an input is unusable. */
export function estimateBuyerChoiceSellDays(
  { buyerIntervalDays, competingSellers }: Readonly<{ buyerIntervalDays: number; competingSellers: number }>,
  listedPrice: number,
  calibration: BuyerChoiceCalibration = BUYER_CHOICE_CALIBRATION,
): number | null {
  if (
    !(Number.isFinite(buyerIntervalDays) && buyerIntervalDays > 0) ||
    !(Number.isFinite(competingSellers) && competingSellers >= 0) ||
    !(Number.isFinite(listedPrice) && listedPrice > 0)
  ) {
    return null;
  }
  const logRate =
    calibration.logDailyRate -
    calibration.demandElasticity * Math.log(buyerIntervalDays) -
    calibration.competitionElasticity * Math.log(competingSellers + 1) +
    calibration.effectivePriceElasticity * Math.log(listedPrice / (listedPrice + calibration.purchaseFixedCost));
  return Math.LN2 / Math.exp(logRate);
}
