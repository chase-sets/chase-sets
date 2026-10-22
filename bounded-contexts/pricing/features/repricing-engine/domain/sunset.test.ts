import { describe, expect, it } from "vitest";
import { decodeBulkRepriceSunsetPolicyValue, evaluateBulkRepriceSunset as evaluate } from "./sunset";
import type { RepricingSourceShareWeek } from "../read-model/source-share";

function week(overrides: Partial<RepricingSourceShareWeek> = {}): RepricingSourceShareWeek {
  return {
    weekStart: "2026-10-04",
    status: "complete",
    reason: null,
    eventCount: 10,
    counts: { bulk: 2, policy: 4, manual: 4, unattributed: 0 },
    shares: { bulk: 0.2, policy: 0.4, manual: 0.4 },
    topSellers: [
      { accountId: "acc_1", bulkShare: 0.4, bulkListingCount: 2, bulkCount: 2, policyCount: 4, manualCount: 4 },
    ],
    maxReliantBulkListingCount: 0,
    requestedSeller: null,
    ...overrides,
  };
}

function evaluateBulkRepriceSunset(weeks: Parameters<typeof evaluate>[0], policy: Parameters<typeof evaluate>[1]) {
  return evaluate(weeks, policy, true, "2026-10-11T00:00:00Z");
}

describe("bulk reprice sunset policy", () => {
  it.each([
    { maxBulkSharePercent: -1, consecutiveCompleteWeeks: 1, relianceListingThreshold: 0 },
    { maxBulkSharePercent: 101, consecutiveCompleteWeeks: 1, relianceListingThreshold: 0 },
    { maxBulkSharePercent: 0, consecutiveCompleteWeeks: 0, relianceListingThreshold: 0 },
    { maxBulkSharePercent: 0, consecutiveCompleteWeeks: 27, relianceListingThreshold: 0 },
    { maxBulkSharePercent: 0, consecutiveCompleteWeeks: 1.5, relianceListingThreshold: 0 },
    { maxBulkSharePercent: 0, consecutiveCompleteWeeks: 1, relianceListingThreshold: -1 },
    { maxBulkSharePercent: 0, consecutiveCompleteWeeks: 1, relianceListingThreshold: 0.5 },
  ])("rejects out-of-bounds values: %s", (value) => {
    expect(() => decodeBulkRepriceSunsetPolicyValue(value)).toThrow();
  });

  it("accepts fractional percentage limits and upper bounds", () => {
    expect(
      decodeBulkRepriceSunsetPolicyValue({
        maxBulkSharePercent: 0.5,
        consecutiveCompleteWeeks: 26,
        relianceListingThreshold: 0,
      }).maxBulkSharePercent,
    ).toBe(0.5);
  });

  it("keeps missing, stale, gapped, and unconfigured evidence unknown", () => {
    const policy = { maxBulkSharePercent: 100, consecutiveCompleteWeeks: 1, relianceListingThreshold: 1 };
    expect(evaluateBulkRepriceSunset([], policy).status).toBe("unknown");
    expect(evaluateBulkRepriceSunset([week({ weekStart: "2026-09-27" })], policy).status).toBe("unknown");
    expect(evaluate([week()], policy, false).status).toBe("unknown");
    expect(evaluateBulkRepriceSunset([week()], null).status).toBe("unknown");
  });

  it("uses strict reliance across all sellers, including a seller outside the displayed list", () => {
    const policy = { maxBulkSharePercent: 100, consecutiveCompleteWeeks: 1, relianceListingThreshold: 2 };
    expect(evaluateBulkRepriceSunset([week({ maxReliantBulkListingCount: 2 })], policy).status).toBe("eligible");
    expect(evaluateBulkRepriceSunset([week({ topSellers: [], maxReliantBulkListingCount: 3 })], policy).status).toBe(
      "ineligible",
    );
  });
  it.each([
    ["missing", {}],
    ["malformed", { maxBulkSharePercent: "20" }],
    ["mixed", { maxBulkSharePercent: 20, consecutiveCompleteWeeks: 1, relianceListingThreshold: 0, extra: true }],
  ])("rejects %s policy values", (_name, value) => {
    expect(() => decodeBulkRepriceSunsetPolicyValue(value as never)).toThrow();
  });

  it("accepts explicit zero bounds", () => {
    expect(
      decodeBulkRepriceSunsetPolicyValue({
        maxBulkSharePercent: 0,
        consecutiveCompleteWeeks: 1,
        relianceListingThreshold: 0,
      }),
    ).toEqual({ maxBulkSharePercent: 0, consecutiveCompleteWeeks: 1, relianceListingThreshold: 0 });
  });

  it("distinguishes eligible, ineligible, and unknown evidence", () => {
    expect(
      evaluateBulkRepriceSunset([week({ shares: { bulk: 0, policy: 0.5, manual: 0.5 } })], {
        maxBulkSharePercent: 10,
        consecutiveCompleteWeeks: 1,
        relianceListingThreshold: 2,
      }),
    ).toEqual({ status: "eligible", reasons: [] });
    expect(
      evaluateBulkRepriceSunset([week()], {
        maxBulkSharePercent: 10,
        consecutiveCompleteWeeks: 1,
        relianceListingThreshold: 0,
      }).status,
    ).toBe("ineligible");
    expect(
      evaluateBulkRepriceSunset([week({ status: "incomplete", reason: "checkpoint-lag" })], {
        maxBulkSharePercent: 100,
        consecutiveCompleteWeeks: 1,
        relianceListingThreshold: 0,
      }).status,
    ).toBe("unknown");
  });
});
