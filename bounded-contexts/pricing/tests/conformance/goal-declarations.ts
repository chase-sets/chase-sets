import type { GoalDeclarations } from "./goal-properties";

/**
 * Golden Decisions for every registered Goal Version, at default parameters on
 * each shared fixture curve. Each decided price of a goal the pinned app has
 * matches its recorded decision in `app-recorded-goal-oracle.json`, or for
 * hold-value its one-listing plan in `app-recorded-portfolio-oracle.json`;
 * cash-target has no app counterpart. These are reviewed data, not snapshots:
 * no test run rewrites them. A changed decision is a new Goal Version with its
 * own entry; an entry is removed only with its version.
 */
export const goalDeclarations: GoalDeclarations = {
  "cash-target@1": {
    // A fixed amount moves the horizon that meets it as the curve scales, so no monotone claim is made.
    priceScalesWithCurve: false,
    golden: {
      // $100 within 30 days is out of reach for one listing: it prices at the most reachable expected value.
      observed: {
        kind: "decision",
        selectedPriceAmount: "6.64",
        unconstrainedPriceAmount: "6.64",
        equivalentPercentile: 41.55555555555555,
        forecast: { medianSellDays: 6.964322382877173, status: "interpolated" },
        unprofitable: false,
        rationale: { parameters: { amount: 100, days: 30 }, dailyReturnHurdle: null, netProceeds: null },
      },
      "truncated-supply": { kind: "unavailable", reason: "curve-feature-missing:storeWinShare" },
    },
  },
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
  "hold-value@1": {
    // It holds the listing's current value, so its price follows the current price rather than the curve.
    priceScalesWithCurve: false,
    golden: {
      observed: {
        kind: "decision",
        selectedPriceAmount: "10.00",
        unconstrainedPriceAmount: "10.00",
        equivalentPercentile: 72.52525252525253,
        forecast: { medianSellDays: 46.071509667632526, status: "interpolated" },
        unprofitable: false,
        rationale: { parameters: {}, dailyReturnHurdle: null, netProceeds: null },
      },
      "truncated-supply": { kind: "unavailable", reason: "curve-feature-missing:storeWinShare" },
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
