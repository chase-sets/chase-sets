import type { GoalDeclarations } from "./goal-properties";

/**
 * Golden Decisions for every registered Goal Version, at default parameters on
 * each shared fixture curve. Each decided price matches the pinned app's
 * recorded decision in `app-recorded-goal-oracle.json`. These are reviewed
 * data, not snapshots: no test run rewrites them. A changed decision is a new
 * Goal Version with its own entry; an entry is removed only with its version.
 */
export const goalDeclarations: GoalDeclarations = {
  "fixed-percentile@1": {
    priceScalesWithCurve: true,
    golden: {
      observed: {
        kind: "decision",
        selectedPriceAmount: "8.75",
        unconstrainedPriceAmount: "8.75",
        equivalentPercentile: 65,
        forecast: { medianSellDays: 27.171369477949856, status: "interpolated" },
        unprofitable: false,
        rationale: { parameters: { percentile: 65 }, dailyReturnHurdle: null, netProceeds: null },
      },
      "truncated-supply": {
        kind: "decision",
        selectedPriceAmount: "8.75",
        unconstrainedPriceAmount: "8.75",
        equivalentPercentile: 65,
        forecast: { medianSellDays: null, status: "unavailable" },
        unprofitable: false,
        rationale: { parameters: { percentile: 65 }, dailyReturnHurdle: null, netProceeds: null },
      },
    },
  },
  "profit-per-day@1": {
    // Fixed overhead does not scale with the curve, so the best discounted return may move to a cheaper point.
    priceScalesWithCurve: false,
    golden: {
      observed: {
        kind: "decision",
        selectedPriceAmount: "8.79",
        unconstrainedPriceAmount: "8.79",
        equivalentPercentile: 65.26666666666667,
        forecast: { medianSellDays: 27.660601228640143, status: "interpolated" },
        unprofitable: false,
        rationale: { parameters: {}, dailyReturnHurdle: 0.01, netProceeds: "7.13" },
      },
      "truncated-supply": { kind: "unavailable", reason: "curve-feature-missing:storeWinShare" },
    },
  },
  "target-horizon@1": {
    priceScalesWithCurve: true,
    golden: {
      observed: {
        kind: "decision",
        selectedPriceAmount: "8.97",
        unconstrainedPriceAmount: "8.97",
        equivalentPercentile: 66.46666666666667,
        forecast: { medianSellDays: 29.93631553602421, status: "interpolated" },
        unprofitable: false,
        rationale: { parameters: { horizonDays: 30 }, dailyReturnHurdle: null, netProceeds: null },
      },
      "truncated-supply": { kind: "unavailable", reason: "curve-feature-missing:storeWinShare" },
    },
  },
};
