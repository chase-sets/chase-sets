import { describe, expect, it } from "vitest";
import { recommendGoalChange, type CandidateMetrics } from "../api/goal-comparison";

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
    expect(recommendGoalChange({ ...input, candidates: [] }).kind).toBe("compare-goals");
    expect(recommendGoalChange({ ...input, candidates: [{ ...candidate, status: "running" }] }).kind).toBe(
      "compare-goals",
    );
    expect(recommendGoalChange({ ...input, candidates: [{ ...candidate, profitPerDay: { USD: 1 } }] }).kind).toBe(
      "no-change",
    );
  });
});
