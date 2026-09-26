import { hasTranslation, t } from "@chase-sets/localization";
import { describe, expect, it } from "vitest";
import { repricingActivityFilters } from "../../repricing-engine/api/activity";
import type { RepricingPolicyListingTrace } from "../../repricing-engine/domain/fact";
import {
  repricingActivityFilterCopyKeys,
  repricingActivityFilterOrder,
  repricingAlwaysVisibleFilters,
  repricingAnchorWordingCopyKeys,
  repricingClampCopyKeys,
  repricingOutcomeCopyKeys,
  repricingResultCopyKey,
  repricingSkipReasonCopyKeys,
  resolveRepricingAnchorWording,
} from "./activity-copy";

const everySkipReason = [
  "within-tolerance",
  "anchor-chain-exhausted",
  "terminal-hold",
  "terminal-pause",
  "terminal-notify-only",
  "currency-input-incomplete-or-mismatched",
  "budget-exhausted",
  "manual-edit-conflict",
  "domain-no-op",
  "policy-precondition-failed",
  "spiral-breaker-frozen",
  "resume-hysteresis",
  "repause-cooldown",
  "command-error",
];

const copyMaps = {
  outcome: repricingOutcomeCopyKeys,
  skipReason: repricingSkipReasonCopyKeys,
  filter: repricingActivityFilterCopyKeys,
  clamp: repricingClampCopyKeys,
  anchorWording: repricingAnchorWordingCopyKeys,
};

function trace(overrides: Partial<RepricingPolicyListingTrace>): RepricingPolicyListingTrace {
  return {
    listingId: "lst_1",
    currentPriceAmount: "10.00",
    targetPriceAmount: "9.50",
    ruleIndex: 0,
    anchor: null,
    exhaustedAnchors: [],
    clamps: { floor: false, ceiling: false, maxMove: false },
    flags: [],
    outcome: "changed",
    skipReason: null,
    ...overrides,
  };
}

describe("repricing activity copy", () => {
  it.each(Object.entries(copyMaps))("has an English string for every %s key", (_name, map) => {
    const missing = Object.entries(map).filter(([, key]) => !hasTranslation(key));
    expect(missing).toEqual([]);
  });

  it("covers every skip reason the engine can record", () => {
    expect(Object.keys(repricingSkipReasonCopyKeys).sort()).toEqual([...everySkipReason].sort());
  });

  it("covers every activity filter, in the API's filter order", () => {
    expect(repricingActivityFilterOrder).toEqual(repricingActivityFilters);
  });

  it("keeps the always-visible counts to the ruled filters", () => {
    expect(repricingAlwaysVisibleFilters).toEqual(["paused-for-missing-input", "floor-binding", "budget-exhausted"]);
    expect(repricingAlwaysVisibleFilters.map((filter) => t(repricingActivityFilterCopyKeys[filter]))).toEqual([
      "Paused for missing input",
      "Floor-binding",
      "Budget-exhausted",
    ]);
  });

  it("names each anchor stratum with the ruled wording", () => {
    const manual = { source: "lowest-competing-ask", amount: "9.00", contributingListingCount: 3 } as const;
    const cases: [RepricingPolicyListingTrace, string][] = [
      [trace({ anchor: { ...manual, stratum: "hard-ask" } }), "Anchored to the lowest manual listing"],
      [
        trace({ anchor: { ...manual, source: "comp-percentile", stratum: "hard-ask" } }),
        "Anchored to a percentile of manual listings",
      ],
      [trace({ anchor: { ...manual, stratum: "any-ask" } }), "Anchored to the lowest listing of any kind"],
      [
        trace({ anchor: { ...manual, stratum: "any-ask" }, flags: ["band-binding"] }),
        "Anchored to the lowest listing of any kind, held at the band floor",
      ],
      [
        trace({
          anchor: { source: "market-estimate", amount: "9.00", stratum: "market-estimate", contributingListingCount: 0 },
          exhaustedAnchors: [{ source: "lowest-competing-ask", state: "absent" }],
        }),
        "No manual listings — using the market estimate",
      ],
      [
        trace({
          anchor: { source: "market-estimate", amount: "9.00", stratum: "market-estimate", contributingListingCount: 0 },
        }),
        "Anchored to the market estimate",
      ],
      [
        trace({ anchor: { source: "last-sold", amount: "9.00", stratum: "last-sold", contributingListingCount: 1 } }),
        "Anchored to the last sold price",
      ],
    ];
    for (const [row, wording] of cases) {
      const resolved = resolveRepricingAnchorWording(row);
      expect(resolved && t(repricingAnchorWordingCopyKeys[resolved])).toBe(wording);
    }
    expect(resolveRepricingAnchorWording(trace({ anchor: null }))).toBeNull();
  });

  it("labels a skipped row by its skip reason and any other row by its outcome", () => {
    expect(t(repricingResultCopyKey(trace({ outcome: "skipped", skipReason: "budget-exhausted" })))).toBe(
      "Budget-exhausted",
    );
    expect(t(repricingResultCopyKey(trace({ outcome: "changed" })))).toBe("Price changed");
    expect(t(repricingResultCopyKey(trace({ outcome: "pause-requested" })))).toBe("Pause requested");
  });
});
