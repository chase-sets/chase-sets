import { describe, expect, it } from "vitest";
import {
  marketplaceReviewScoringPolicyVersion,
  normalizeMarketplaceReviewScoringFact,
  normalizeMarketplaceReviewSubmittedScoring,
} from "./review-scoring-facts";

describe("review scoring facts", () => {
  it("preserves ordinary historical review impact and excludes legacy unattributed resolutions", () => {
    expect(normalizeMarketplaceReviewSubmittedScoring({}).scoringDisposition).toBe("included");
    expect(normalizeMarketplaceReviewSubmittedScoring({ resolutionContext: "resolved-via-refund" })).toMatchObject({
      scoringDisposition: "context-only",
      operationalSignal: "responsibility-missing",
    });
  });

  it("fails unknown producer policy versions safe to no contribution", () => {
    expect(
      normalizeMarketplaceReviewSubmittedScoring({
        scoringDisposition: "included",
        scoringReasonCode: "normal-completion",
        scoringPolicyVersion: "future-policy",
      }),
    ).toMatchObject({ scoringDisposition: "context-only", operationalSignal: "policy-version-unrecognized" });
  });

  it("normalizes the directional published fact", () => {
    expect(
      normalizeMarketplaceReviewScoringFact({
        factSchemaVersion: 1,
        orderId: "ord_1",
        policyVersion: marketplaceReviewScoringPolicyVersion,
        sourceFactVersions: [{ supportRequestId: "sup_1", sourceStreamVersion: 3, status: "resolved" }],
        buyerToSeller: { scoringDisposition: "included", reasonCode: "subject-responsible" },
        sellerToBuyer: { scoringDisposition: "context-only", reasonCode: "reviewer-responsible" },
        operationalSignal: null,
        projectedAt: "2026-07-01T00:00:00.000Z",
      }).sellerToBuyer,
    ).toMatchObject({ scoringDisposition: "context-only", policyVersion: marketplaceReviewScoringPolicyVersion });
  });
});
