import { describe, expect, it } from "vitest";
import { isReviewOpportunityChangedV1, type ReviewOpportunityChangedV1 } from "./review-opportunity-facts";

const slot = {
  authorRole: "buyer",
  eligibleAt: "2026-04-01T00:00:00.000Z",
  effectiveDeadlineAt: "2026-06-01T00:00:00.000Z",
  submissionState: "allowed",
  held: false,
  activeReviewId: null,
  activeReviewRevealedAt: null,
} as const;
const fact: ReviewOpportunityChangedV1 = {
  factSchemaVersion: 1,
  orderId: "ord_1",
  buyerAccountId: "acc_b",
  sellerAccountId: "acc_s",
  generation: "1",
  sourceGeneration: "1:1",
  provenance: { ordering: "1", fulfillment: "2", support: "0", marketplace: "0" },
  generatedAt: "2026-04-01T00:00:00.000Z",
  buyerToSeller: slot,
  sellerToBuyer: null,
};

describe("closed review opportunity fact", () => {
  it("accepts both directions and explicit absence without content", () => {
    expect(isReviewOpportunityChangedV1(fact)).toBe(true);
    expect(
      isReviewOpportunityChangedV1({ ...fact, buyerToSeller: null, sellerToBuyer: { ...slot, authorRole: "seller" } }),
    ).toBe(true);
  });
  it.each([0, "0", "-1", "01", "9223372036854775808", "1.5", null])("rejects generation %s", (generation) => {
    expect(isReviewOpportunityChangedV1({ ...fact, generation })).toBe(false);
  });
  it.each([
    { ...fact, factSchemaVersion: 2 },
    { ...fact, rating: 5 },
    { ...fact, buyerToSeller: { ...slot, feedback: "private" } },
    { ...fact, buyerToSeller: { ...slot, eligibleAt: "2026-04-01T00:00:00" } },
    { ...fact, buyerToSeller: { ...slot, activeReviewRevealedAt: "2026-04-01T00:00:00Z" } },
    { ...fact, provenance: { ...fact.provenance, extra: "0" } },
    { ...fact, sellerToBuyer: undefined },
  ])("rejects unknown, malformed and content-bearing nested fields", (value) => {
    expect(isReviewOpportunityChangedV1(value)).toBe(false);
  });
});
