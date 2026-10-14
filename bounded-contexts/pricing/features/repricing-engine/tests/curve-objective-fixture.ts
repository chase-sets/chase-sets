import { readFileSync } from "node:fs";
import type { CurvePoint } from "../../market-estimates/domain/demand-curve/curve";
import type { RepricingAnchor, RepricingRuleDirective } from "../../repricing-policies/domain/domain";
import type { GoalFeeTerms } from "../../repricing-policies/tests/fixtures/goal-economics";
import type { RepricingListingEvaluationInput, RepricingMarketInputSnapshot } from "../domain/evaluate";

const fixtures = new URL("../../repricing-policies/tests/fixtures/", import.meta.url);

type ParityCurve = Readonly<{ currencyCode: string; version: number; points: readonly CurvePoint[] }>;
type RecordedDecision = Readonly<{
  selectedPrice: number;
  equivalentPercentile: number;
  forecastStatus: string;
  unprofitable: boolean;
  estimatedMedianSellDays: number | null;
}>;
type RecordedEconomics = Readonly<{ dailyReturnHurdle: number; feeTerms: string }>;

/** The synthetic #9307 parity curve the pinned app's goal decisions were recorded on. */
export const parityCurve = (
  JSON.parse(readFileSync(new URL("goal-parity-curve.json", fixtures), "utf8")) as {
    curves: Readonly<Record<string, ParityCurve>>;
  }
).curves.observed!;

const oracle = JSON.parse(readFileSync(new URL("app-recorded-goal-oracle.json", fixtures), "utf8")) as Readonly<{
  feeTermSets: Readonly<Record<string, GoalFeeTerms>>;
  cases: readonly Readonly<{
    curve: string;
    goalId: string;
    parameters: Readonly<Record<string, number>>;
    economics: RecordedEconomics | null;
    decision: RecordedDecision | null;
  }>[];
}>;

export const typicalFeeTerms = oracle.feeTermSets.typical!;

/** The pinned app's recorded decision on the parity curve: an independent expectation, not engine output. */
export function recordedDecision(
  goalId: string,
  parameters: Readonly<Record<string, number>>,
  economics: RecordedEconomics | null,
): RecordedDecision {
  const entry = oracle.cases.find(
    (candidate) =>
      candidate.curve === "observed" &&
      candidate.goalId === goalId &&
      JSON.stringify(candidate.parameters) === JSON.stringify(parameters) &&
      JSON.stringify(candidate.economics) === JSON.stringify(economics),
  );
  if (!entry?.decision) throw new Error(`No recorded app decision for ${goalId}.`);
  return entry.decision;
}

export const capturedAt = "2026-10-13T12:00:00.000Z";
export const freshUntil = "2026-10-14T00:00:00.000Z";

export const goalAnchor = (
  goalId = "fixed-percentile",
  parameters: Readonly<Record<string, number>> = { percentile: 65 },
): Extract<RepricingAnchor, { source: "curve-objective" }> => ({
  source: "curve-objective",
  goalId,
  goalVersion: 1,
  parameters: { ...parameters },
});

export function goalDirective(overrides: Partial<RepricingRuleDirective> = {}): RepricingRuleDirective {
  return {
    currencyCode: "USD",
    anchorChain: [goalAnchor()],
    offset: { mode: "absolute", amount: "0" },
    floor: { mode: "absolute", amount: "1.00" },
    ceiling: null,
    tolerance: { mode: "absolute", amount: "0.01" },
    rounding: { mode: "none" },
    maxMovePercent: null,
    terminal: { kind: "hold" },
    ...overrides,
  };
}

export function goalListing(
  directive: RepricingRuleDirective = goalDirective(),
  overrides: Partial<RepricingListingEvaluationInput> = {},
): RepricingListingEvaluationInput {
  return {
    listingId: "lst_goal",
    sellerAccountId: "acc_goal",
    currentPriceAmount: "10.00",
    currentPriceCurrencyCode: "USD",
    currentPriceSourceVersion: 1,
    quantityCap: 1,
    categoryIds: [],
    grading: "raw",
    createdAt: "2026-07-01T00:00:00.000Z",
    costBasisAmount: null,
    costBasisCurrencyCode: null,
    rules: [{ conditions: [], directive }],
    ...overrides,
  };
}

export function goalSnapshot(overrides: Partial<RepricingMarketInputSnapshot> = {}): RepricingMarketInputSnapshot {
  return {
    catalogItemId: "cat_goal",
    productId: "cat_goal::",
    capturedAt,
    hardAskOutlierPriceRatio: 10,
    marketEstimate: { amount: "10.00", currencyCode: "USD", freshUntil },
    lastSold: null,
    competingAsks: [],
    demandCurve: { ...parityCurve, freshUntil },
    economics: null,
    ...overrides,
  };
}

export const otherSellerHardAsk = (amount: string, listingId = `lst_ask_${amount}`) => ({
  listingId,
  sellerAccountId: "acc_other",
  amount,
  currencyCode: "USD",
  pricingMode: "hard" as const,
});
