import { describe, expect, it } from "vitest";
import { currentAttentionValues, recommendGoalChange, type CandidateMetrics } from "../api/goal-comparison";
import type { RepricingDryRunTrace } from "../../repricing-engine/api/dry-run";

const current = {
  profitPerDay: { value: 2 },
  coverage: { listingRatio: 1 },
  valueAtRisk: { hopeless: { valueAmount: "0" }, slow: { valueAmount: "0" } },
  curveAge: { staleCount: 0 },
  expectedWait: { medianDays: 5 },
};
const candidate: CandidateMetrics = {
  goalId: "fixed-percentile",
  goalVersion: 1,
  dryRunId: "synthetic",
  status: "completed",
  requestedAt: "2026-10-20T00:00:00Z",
  completedAt: "2026-10-20T00:00:01Z",
  bodyHash: "synthetic",
  targetPolicyId: "rpp_synthetic",
  scopeLabel: "Entire selected policy candidate scope",
  listingCount: 3,
  raised: 1,
  lowered: 1,
  held: 1,
  value: { USD: "100.00" },
  medianWaitDays: { USD: 3 },
  p90WaitDays: { USD: 7 },
  coverage: { USD: 1 },
  profitPerDay: { USD: 3 },
  economicsListingIds: ["a", "b"],
  affectedListedValue: 0,
  flags: {},
};
const input = {
  currentHealth: { currencies: { USD: current } },
  currentEconomicsListingIds: ["a", "b"],
  candidates: [candidate],
  haltEngaged: false,
};

describe("Pricing Health S12 recommendation", () => {
  it("ranks current attention by quantity-weighted listed value and the specified tie order", () => {
    const trace: RepricingDryRunTrace = {
      listingId: "a",
      currentPriceAmount: "10.00",
      targetPriceAmount: "12.00",
      ruleIndex: 0,
      anchor: null,
      exhaustedAnchors: [],
      clamps: { floor: true, ceiling: false, maxMove: false },
      flags: [],
      outcome: "changed",
      skipReason: null,
      health: {
        listingId: "a",
        quantity: 3,
        currentPriceAmount: "10.00",
        effectivePriceAmount: "12.00",
        currencyCode: "USD",
        modeled: {
          medianDays: 5,
          curveVersion: 1,
          builtAt: "2026-10-20",
          policyRevisionId: "synthetic",
          forecastStatus: "interpolated",
        },
        modeledReason: null,
        economics: null,
        economicsReason: "inventory-item-missing",
        risk: "slow",
      },
    };
    expect(currentAttentionValues([trace])).toEqual({
      economics: 3000,
      "value-at-risk": 3000,
      "floor-binding": 3000,
      "stale-curve": 0,
    });
    const candidates = [{ ...candidate, profitPerDay: { USD: 2 } }];
    const tied = { economics: 3000, "value-at-risk": 3000, "floor-binding": 3000, "stale-curve": 3000 };
    expect(recommendGoalChange({ ...input, candidates, attentionValues: tied })).toMatchObject({
      kind: "attention",
      reason: "economics",
    });
    expect(recommendGoalChange({ ...input, candidates, attentionValues: { ...tied, economics: 0 } }).reason).toBe(
      "value-at-risk",
    );
    expect(
      recommendGoalChange({ ...input, candidates, attentionValues: { ...tied, economics: 0, "value-at-risk": 0 } })
        .reason,
    ).toBe("floor-binding");
    expect(
      recommendGoalChange({ ...input, candidates, attentionValues: { ...tied, "stale-curve": 3001 } }).reason,
    ).toBe("stale-curve");
    expect(recommendGoalChange({ ...input, attentionValues: tied }).kind).toBe("switch");
    expect(recommendGoalChange({ ...input, candidates: [], attentionValues: tied }).kind).toBe("attention");
  });
  it("checks no basis before halt, and halt before a more profitable candidate", () => {
    expect(recommendGoalChange({ ...input, currentHealth: null, haltEngaged: true }).kind).toBe("compute-verdict");
    expect(recommendGoalChange({ ...input, haltEngaged: true }).kind).toBe("halted");
  });
  it("requires equal Economics listing sets, not merely equal counts", () => {
    expect(recommendGoalChange({ ...input, currentEconomicsListingIds: ["a", "c"] }).kind).toBe("refresh");
  });
  it("refuses a switch when the current basis has multiple currencies", () => {
    expect(
      recommendGoalChange({ ...input, currentHealth: { currencies: { USD: current, EUR: current } } }).kind,
    ).not.toBe("switch");
  });
  it("refuses a switch when current S8 is unavailable", () => {
    expect(
      recommendGoalChange({
        ...input,
        currentHealth: {
          currencies: {
            USD: { ...current, profitPerDay: { value: null } },
          },
        },
      }).kind,
    ).not.toBe("switch");
  });
  it("requires a strictly higher S8 after rounding, and discloses wait and movement deltas", () => {
    expect(recommendGoalChange({ ...input, candidates: [{ ...candidate, profitPerDay: { USD: 2.004 } }] }).kind).toBe(
      "no-change",
    );
    expect(recommendGoalChange(input)).toMatchObject({
      kind: "switch",
      delta: 1,
      waitDelta: -2,
      raised: 1,
      lowered: 1,
      held: 1,
    });
  });
  it("does not treat the amount of candidate price movement as a current attention reason", () => {
    expect(
      recommendGoalChange({
        ...input,
        candidates: [{ ...candidate, profitPerDay: { USD: 2 }, affectedListedValue: 100 }],
      }).kind,
    ).toBe("no-change");
  });
  it("distinguishes an incomplete comparison from a completed current-goal lead", () => {
    expect(
      recommendGoalChange({
        ...input,
        candidates: [{ ...candidate, profitPerDay: { USD: 1 } }],
        expectedCandidateCount: 2,
      }).kind,
    ).toBe("compare-goals");
    expect(recommendGoalChange({ ...input, candidates: [] }).kind).toBe("compare-goals");
    expect(recommendGoalChange({ ...input, candidates: [{ ...candidate, status: "running" }] }).kind).toBe(
      "compare-goals",
    );
    expect(recommendGoalChange({ ...input, candidates: [{ ...candidate, profitPerDay: { USD: 1 } }] }).kind).toBe(
      "no-change",
    );
  });
});
