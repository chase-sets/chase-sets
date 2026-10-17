import type { RepricingGoalTrace } from "../../../repricing-engine/domain/evaluate";
import type {
  RepricingPolicyEvaluatedEvent,
  RepricingPolicyListingTrace,
  ShadowGoalTrace,
} from "../../../repricing-engine/domain/fact";

export function goalTrace(overrides: Partial<RepricingGoalTrace> = {}): RepricingGoalTrace {
  return {
    goalId: "fixed-percentile",
    goalVersion: 1,
    curveVersion: 3,
    equivalentPercentile: 50,
    forecastMedianSellDays: 12,
    forecastStatus: "interpolated",
    unprofitable: false,
    ...overrides,
  };
}

export function listingTrace(
  overrides: Partial<RepricingPolicyListingTrace> & Pick<RepricingPolicyListingTrace, "listingId">,
): RepricingPolicyListingTrace {
  return {
    currentPriceAmount: "4.00",
    targetPriceAmount: "5.00",
    ruleIndex: 0,
    anchor: {
      source: "curve-objective",
      amount: "5.00",
      stratum: "curve-objective",
      contributingListingCount: 0,
      goal: goalTrace(),
    },
    exhaustedAnchors: [],
    clamps: { floor: false, ceiling: false, maxMove: false },
    flags: [],
    quantity: 1,
    outcome: "changed",
    skipReason: null,
    ...overrides,
  };
}

export function shadowTrace(overrides: Partial<ShadowGoalTrace> = {}): ShadowGoalTrace {
  return {
    goalId: "fixed-percentile",
    goalVersion: 2,
    anchorIndex: 0,
    curveVersion: 3,
    targetPriceAmount: "5.50",
    action: "update-price",
    skipReason: null,
    anchor: {
      source: "curve-objective",
      amount: "5.50",
      stratum: "curve-objective",
      contributingListingCount: 0,
      goal: goalTrace({ goalVersion: 2, forecastMedianSellDays: 15 }),
    },
    flags: [],
    skipped: null,
    ...overrides,
  } as ShadowGoalTrace;
}

export function evaluatedData(
  listings: readonly RepricingPolicyListingTrace[],
  overrides: Partial<RepricingPolicyEvaluatedEvent["data"]> = {},
): RepricingPolicyEvaluatedEvent["data"] {
  return {
    schemaVersion: 1,
    evaluationId: "evl_synthetic",
    policyId: "rpp_synthetic",
    policyRevision: "2026-08-01T00:00:00.000Z",
    sellerAccountId: "acc_seller",
    catalogItemId: "cat_synthetic",
    productId: "prd_synthetic",
    trigger: {
      kind: "daily-drift-sweep",
      eventId: "evt_synthetic",
      signalVersion: "1",
      occurredAt: "2026-08-01T00:00:00.000Z",
    },
    listingsEvaluated: listings.length,
    listingsChanged: listings.filter((listing) => listing.outcome === "changed").length,
    listingsSkipped: listings.filter((listing) => listing.outcome !== "changed").length,
    listings,
    signalToEvaluationLatencyMs: 0,
    evaluatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}
