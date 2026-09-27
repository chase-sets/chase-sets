// Seller-facing wording for repricing activity. Every map is keyed by the union
// it describes (`satisfies Record<Union, …>`), so a new outcome, skip reason,
// activity filter, clamp or anchor wording fails to compile until it has copy,
// and activity-copy.test.ts fails if any mapped key lacks an English string.
// Wording never names a competing listing or how it was priced: the anchor copy
// speaks only in strata ("manual listing", "listing of any kind").

import type { RepricingActivityFilter } from "../../repricing-engine/api/activity";
import type { RepricingClampTrace } from "../../repricing-engine/domain/evaluate";
import type { RepricingEvaluationSkipReason, RepricingPolicyListingTrace } from "../../repricing-engine/domain/fact";

export const repricingOutcomeCopyKeys = {
  changed: "pricing.features.repricingPolicies.ui.activity.outcome.changed",
  skipped: "pricing.features.repricingPolicies.ui.activity.outcome.skipped",
  "pause-requested": "pricing.features.repricingPolicies.ui.activity.outcome.pauseRequested",
  "notify-only": "pricing.features.repricingPolicies.ui.activity.outcome.notifyOnly",
} as const satisfies Record<RepricingPolicyListingTrace["outcome"], string>;

export const repricingSkipReasonCopyKeys = {
  "within-tolerance": "pricing.features.repricingPolicies.ui.activity.skip.withinTolerance",
  "anchor-chain-exhausted": "pricing.features.repricingPolicies.ui.activity.skip.anchorChainExhausted",
  "terminal-hold": "pricing.features.repricingPolicies.ui.activity.skip.terminalHold",
  "terminal-pause": "pricing.features.repricingPolicies.ui.activity.skip.terminalPause",
  "terminal-notify-only": "pricing.features.repricingPolicies.ui.activity.skip.terminalNotifyOnly",
  "currency-input-incomplete-or-mismatched":
    "pricing.features.repricingPolicies.ui.activity.skip.currencyInputIncompleteOrMismatched",
  "budget-exhausted": "pricing.features.repricingPolicies.ui.activity.skip.budgetExhausted",
  "manual-edit-conflict": "pricing.features.repricingPolicies.ui.activity.skip.manualEditConflict",
  "domain-no-op": "pricing.features.repricingPolicies.ui.activity.skip.domainNoOp",
  "policy-precondition-failed": "pricing.features.repricingPolicies.ui.activity.skip.policyPreconditionFailed",
  "spiral-breaker-frozen": "pricing.features.repricingPolicies.ui.activity.skip.spiralBreakerFrozen",
  "resume-hysteresis": "pricing.features.repricingPolicies.ui.activity.skip.resumeHysteresis",
  "repause-cooldown": "pricing.features.repricingPolicies.ui.activity.skip.repauseCooldown",
  "command-error": "pricing.features.repricingPolicies.ui.activity.skip.commandError",
} as const satisfies Record<RepricingEvaluationSkipReason, string>;

// Key order is the filter strip order; it mirrors the activity API's
// `repricingActivityFilters` (pinned by the copy test), so the UI never imports
// the SQL-bearing API module at runtime.
export const repricingActivityFilterCopyKeys = {
  changed: "pricing.features.repricingPolicies.ui.activity.filterName.changed",
  ...repricingSkipReasonCopyKeys,
  "paused-for-missing-input": "pricing.features.repricingPolicies.ui.activity.filterName.pausedForMissingInput",
  "floor-binding": "pricing.features.repricingPolicies.ui.activity.filterName.floorBinding",
  "spiral-breaker": "pricing.features.repricingPolicies.ui.activity.filterName.spiralBreaker",
} as const satisfies Record<RepricingActivityFilter, string>;

export const repricingActivityFilterOrder = Object.keys(repricingActivityFilterCopyKeys) as RepricingActivityFilter[];

// The three counts the seller always sees, whatever filter is selected.
export const repricingAlwaysVisibleFilters = [
  "paused-for-missing-input",
  "floor-binding",
  "budget-exhausted",
] as const satisfies readonly RepricingActivityFilter[];

export const repricingClampCopyKeys = {
  floor: "pricing.features.repricingPolicies.ui.activity.clamp.floor",
  ceiling: "pricing.features.repricingPolicies.ui.activity.clamp.ceiling",
  maxMove: "pricing.features.repricingPolicies.ui.activity.clamp.maxMove",
} as const satisfies Record<keyof RepricingClampTrace, string>;

export type RepricingAnchorWording =
  | "lowest-manual-listing"
  | "manual-listing-percentile"
  | "lowest-any-listing"
  | "lowest-any-listing-band-floor"
  | "market-estimate-no-manual-listings"
  | "market-estimate"
  | "last-sold";

export const repricingAnchorWordingCopyKeys = {
  "lowest-manual-listing": "pricing.features.repricingPolicies.ui.activity.stratum.lowestManualListing",
  "manual-listing-percentile": "pricing.features.repricingPolicies.ui.activity.stratum.manualListingPercentile",
  "lowest-any-listing": "pricing.features.repricingPolicies.ui.activity.stratum.lowestAnyListing",
  "lowest-any-listing-band-floor": "pricing.features.repricingPolicies.ui.activity.stratum.lowestAnyListingBandFloor",
  "market-estimate-no-manual-listings":
    "pricing.features.repricingPolicies.ui.activity.stratum.marketEstimateNoManualListings",
  "market-estimate": "pricing.features.repricingPolicies.ui.activity.stratum.marketEstimate",
  "last-sold": "pricing.features.repricingPolicies.ui.activity.stratum.lastSold",
} as const satisfies Record<RepricingAnchorWording, string>;

const askAnchorSources = new Set(["lowest-competing-ask", "comp-percentile"]);

// Name the stratum the evaluation anchored to. A market-estimate anchor reached
// after an ask-based anchor ran dry reads as "no manual listings"; an any-kind
// ask that the band floor lifted reads as "held at the band floor".
export function resolveRepricingAnchorWording(
  trace: Pick<RepricingPolicyListingTrace, "anchor" | "exhaustedAnchors" | "flags">,
): RepricingAnchorWording | null {
  const anchor = trace.anchor;
  if (!anchor) return null;
  switch (anchor.stratum) {
    case "hard-ask":
      return anchor.source === "comp-percentile" ? "manual-listing-percentile" : "lowest-manual-listing";
    case "any-ask":
      return trace.flags.includes("band-binding") ? "lowest-any-listing-band-floor" : "lowest-any-listing";
    case "market-estimate":
      return trace.exhaustedAnchors.some((exhausted) => askAnchorSources.has(exhausted.source))
        ? "market-estimate-no-manual-listings"
        : "market-estimate";
    case "last-sold":
      return "last-sold";
  }
}

// The row's result label: the skip reason when the evaluation skipped,
// otherwise the outcome.
export function repricingResultCopyKey(trace: Pick<RepricingPolicyListingTrace, "outcome" | "skipReason">): string {
  return trace.outcome === "skipped" && trace.skipReason
    ? repricingSkipReasonCopyKeys[trace.skipReason]
    : repricingOutcomeCopyKeys[trace.outcome];
}
