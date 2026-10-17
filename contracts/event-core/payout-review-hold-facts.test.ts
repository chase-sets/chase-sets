import { describe, expect, it } from "vitest";
import { normalizePayoutReviewHoldPayload, payoutReviewHoldFactTypes } from "./payout-review-hold-facts";

const valid = {
  accountId: "acc_synthetic_seller",
  reason: "Synthetic operator risk note",
  source: "operator",
  sourceReference: null,
} as const;

describe("payout review hold facts", () => {
  it("pins the Settlement-owned event names", () => {
    expect(payoutReviewHoldFactTypes).toEqual({
      placed: "settlement.payout-review-hold.placed",
      released: "settlement.payout-review-hold.released",
    });
  });

  it("trims the reason and accepts 1-500 characters after trimming", () => {
    const fiveHundred = "r".repeat(500);
    expect(normalizePayoutReviewHoldPayload({ ...valid, reason: fiveHundred }).reason).toBe(fiveHundred);
    expect(normalizePayoutReviewHoldPayload({ ...valid, reason: `  ${fiveHundred}\n` }).reason).toBe(fiveHundred);
    expect(normalizePayoutReviewHoldPayload({ ...valid, reason: " x " }).reason).toBe("x");
    expect(() => normalizePayoutReviewHoldPayload({ ...valid, reason: "r".repeat(501) })).toThrow("1–500");
    expect(() => normalizePayoutReviewHoldPayload({ ...valid, reason: " \t\n" })).toThrow("1–500");
    expect(() => normalizePayoutReviewHoldPayload({ ...valid, reason: undefined })).toThrow("1–500");
  });

  it("records each source and an optional trimmed source reference", () => {
    for (const source of ["operator", "risk-alert", "badge-migration"] as const) {
      expect(normalizePayoutReviewHoldPayload({ ...valid, source, sourceReference: " ref_1 " })).toEqual({
        factSchemaVersion: 1,
        accountId: "acc_synthetic_seller",
        reason: "Synthetic operator risk note",
        source,
        sourceReference: "ref_1",
      });
    }
    expect(normalizePayoutReviewHoldPayload({ ...valid, sourceReference: undefined }).sourceReference).toBeNull();
    expect(() => normalizePayoutReviewHoldPayload({ ...valid, source: "identity" })).toThrow("source");
    expect(() => normalizePayoutReviewHoldPayload({ ...valid, sourceReference: "  " })).toThrow("sourceReference");
    expect(() => normalizePayoutReviewHoldPayload({ ...valid, sourceReference: 7 })).toThrow("sourceReference");
    expect(() => normalizePayoutReviewHoldPayload({ ...valid, accountId: " " })).toThrow("accountId");
    expect(() => normalizePayoutReviewHoldPayload(null)).toThrow("payload is required");
  });
});
