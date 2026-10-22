import { describe, expect, it } from "vitest";
import { decodeBulkRepriceSunsetPolicyValue, evaluateBulkRepriceSunset } from "./sunset";
import type { RepricingSourceShareWeek } from "../read-model/source-share";

function week(overrides: Partial<RepricingSourceShareWeek> = {}): RepricingSourceShareWeek {
  return {
    weekStart: "2026-10-05",
    status: "complete",
    reason: null,
    eventCount: 10,
    counts: { bulk: 2, policy: 4, manual: 4, unattributed: 0 },
    shares: { bulk: 0.2, policy: 0.4, manual: 0.4 },
    topSellers: [
      { accountId: "acc_1", bulkShare: 0.4, bulkListingCount: 2, bulkCount: 2, policyCount: 4, manualCount: 4 },
    ],
    ...overrides,
  };
}

describe("bulk reprice sunset policy", () => {
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
