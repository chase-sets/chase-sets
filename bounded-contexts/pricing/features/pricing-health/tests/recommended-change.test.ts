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
  targetRevision: 1,
  listingCount: 3,
  raised: 1,
  lowered: 1,
  held: 1,
  value: { USD: "100.00" },
  medianWaitDays: { USD: 3 },
  p90WaitDays: { USD: 7 },
  coverage: { USD: 1 },
  profitPerDay: { USD: 3 },
  economicsSet: { digest: "synthetic-a-b", size: 2 },
  capitalTurn: { USD: 0.1 },
  boundStatusCount: { USD: 0 },
  heldReasons: {},
  flags: {},
};
const input = {
  currentHealth: { currencies: { USD: current } },
  currentEconomicsSet: { digest: "synthetic-a-b", size: 2 },
  candidates: [candidate],
  haltEngaged: false,
};

describe("Pricing Health S12 recommendation", () => {
  it("ranks current attention by quantity-weighted listed value and the specified tie order", () => {
    const candidates = [{ ...candidate, profitPerDay: { USD: 2 } }];
    const scores = { economics: 30, "value-at-risk": 30, "floor-binding": 30, "stale-curve": 30 };
    const values = (changes: Partial<typeof scores> = {}) => {
      const amounts = { ...scores, ...changes };
      return {
        USD: {
          economics: { value: amounts.economics, count: 1 },
          "value-at-risk": { value: amounts["value-at-risk"], count: 1 },
          "floor-binding": { value: amounts["floor-binding"], count: 1 },
          "stale-curve": { value: amounts["stale-curve"], count: 1 },
        },
      };
    };
    const tied = values();
    expect(recommendGoalChange({ ...input, candidates, attentionValues: tied })).toMatchObject({
      kind: "attention",
      reason: "economics",
    });
    expect(recommendGoalChange({ ...input, candidates, attentionValues: values({ economics: 0 }) }).reason).toBe(
      "value-at-risk",
    );
    expect(
      recommendGoalChange({ ...input, candidates, attentionValues: values({ economics: 0, "value-at-risk": 0 }) })
        .reason,
    ).toBe("floor-binding");
    expect(recommendGoalChange({ ...input, candidates, attentionValues: values({ "stale-curve": 31 }) }).reason).toBe(
      "stale-curve",
    );
    expect(recommendGoalChange({ ...input, attentionValues: tied }).kind).toBe("switch");
    expect(recommendGoalChange({ ...input, candidates: [], attentionValues: tied }).kind).toBe("attention");
  });
  it("checks no basis before halt, and halt before a more profitable candidate", () => {
    expect(recommendGoalChange({ ...input, currentHealth: null, haltEngaged: true }).kind).toBe("compute-verdict");
    expect(recommendGoalChange({ ...input, haltEngaged: true }).kind).toBe("halted");
  });
  it("requires equal Economics listing sets, not merely equal counts", () => {
    expect(recommendGoalChange({ ...input, currentEconomicsSet: { digest: "synthetic-a-c", size: 2 } }).kind).toBe(
      "refresh",
    );
  });
  it("breaks an otherwise equal goal tie by version ascending", () => {
    expect(recommendGoalChange({ ...input, candidates: [{ ...candidate, goalVersion: 2 }, candidate] })).toMatchObject({
      kind: "switch",
      goalVersion: 1,
    });
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
  it("uses S9 to break ties after rounding S8 to minor units", () => {
    const lowerS9 = {
      ...candidate,
      goalId: "a",
      profitPerDay: { USD: 3.004 },
      capitalTurn: { USD: 0.1 },
    };
    const higherS9 = {
      ...candidate,
      goalId: "b",
      profitPerDay: { USD: 3.003 },
      capitalTurn: { USD: 0.2 },
    };

    expect(
      recommendGoalChange({
        ...input,
        candidates: [lowerS9, higherS9],
      }),
    ).toMatchObject({
      kind: "switch",
      goalId: "b",
    });
  });
  it("does not treat the amount of candidate price movement as a current attention reason", () => {
    expect(
      recommendGoalChange({
        ...input,
        candidates: [{ ...candidate, profitPerDay: { USD: 2 }, raised: 100 }],
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
