import { describe, expect, it } from "vitest";
import {
  normalizeSupportRequestRemedyAuthorizedV1,
  type SupportRequestRemedyAuthorizedV1Payload,
} from "@chase-sets/event-core/platform-coverage-facts";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import {
  decideDirectionalReviewDisposition,
  type ResolvedResponsibility,
  type ReviewRemedyReference,
  type ReviewSupportRequestFact,
} from "./directional-review-disposition";

const DELIVERED_AT = "2026-04-03T00:00:00.000Z";
const CANCELLED_AT = "2026-04-04T00:00:00.000Z";
const RESOLVED_AT = "2026-04-06T00:00:00.000Z";
const EVALUATED_AT = "2026-04-07T00:00:00.000Z";

function resolved(
  responsibility: unknown,
  options: Readonly<{ resolutionType?: string; remedy?: ReviewRemedyReference | null }> = {},
): ReviewSupportRequestFact {
  return {
    status: "resolved",
    responsibility,
    resolvedAt: RESOLVED_AT,
    resolutionType: options.resolutionType ?? "support-reviewed",
    remedy: options.remedy ?? null,
  };
}

function remedyFact(kind: "full-refund" | "partial-refund"): SupportRequestRemedyAuthorizedV1Payload {
  return normalizeSupportRequestRemedyAuthorizedV1({
    factSchemaVersion: 1,
    supportRequestId: "sup_1",
    remedyId: "rmd_1",
    coverageId: "cov_1",
    idempotencyKey: `remedy:${kind}`,
    causationId: null,
    policyVersion: "2026-07-14",
    occurredAt: RESOLVED_AT,
    remedy: { kind, amount: "100.00", currencyCode: "usd" },
    allocation: {
      sellerFundedAmount: "0.00",
      platformFundedAmount: "100.00",
      currencyCode: "usd",
      fundingKind: "platform-funded",
    },
    returnDirective: "no-return",
    refundTrigger: "immediate",
    reasonCode: "support-resolution",
  });
}

function remedyReference(fact: SupportRequestRemedyAuthorizedV1Payload): ReviewRemedyReference {
  return {
    remedyId: parseTypedId(fact.remedyId, "rmd"),
    coverageId: fact.coverageId === null ? null : parseTypedId(fact.coverageId, "cov"),
    kind: fact.remedy.kind,
  };
}

describe("directional review disposition policy", () => {
  const matrix: readonly Readonly<{
    responsibility: ResolvedResponsibility;
    buyerToSeller: "included" | "context-only";
    sellerToBuyer: "included" | "context-only";
  }>[] = [
    { responsibility: "seller", buyerToSeller: "included", sellerToBuyer: "context-only" },
    { responsibility: "buyer", buyerToSeller: "context-only", sellerToBuyer: "included" },
    { responsibility: "carrier", buyerToSeller: "context-only", sellerToBuyer: "context-only" },
    { responsibility: "platform", buyerToSeller: "context-only", sellerToBuyer: "context-only" },
    { responsibility: "shared", buyerToSeller: "context-only", sellerToBuyer: "context-only" },
    { responsibility: "undetermined", buyerToSeller: "context-only", sellerToBuyer: "context-only" },
  ];

  for (const entry of matrix) {
    it(`maps ${entry.responsibility} responsibility in both directions`, () => {
      const decision = decideDirectionalReviewDisposition({
        deliveredAt: DELIVERED_AT,
        cancelledAt: null,
        evaluatedAt: EVALUATED_AT,
        supportRequests: [resolved(entry.responsibility)],
      });

      expect(decision.buyerToSeller).toMatchObject({
        transactionEligibility: "eligible",
        submissionState: "allowed",
        visibilityState: "double-blind-pending",
        scoringDisposition: entry.buyerToSeller,
      });
      expect(decision.sellerToBuyer).toMatchObject({
        transactionEligibility: "eligible",
        submissionState: "allowed",
        visibilityState: "double-blind-pending",
        scoringDisposition: entry.sellerToBuyer,
      });
    });
  }

  it("includes both directions for a normally completed order with no resolved case", () => {
    const decision = decideDirectionalReviewDisposition({
      deliveredAt: DELIVERED_AT,
      cancelledAt: null,
      evaluatedAt: EVALUATED_AT,
      supportRequests: [],
    });

    expect(decision.buyerToSeller).toMatchObject({ scoringDisposition: "included", reasonCode: "normal-completion" });
    expect(decision.sellerToBuyer).toMatchObject({ scoringDisposition: "included", reasonCode: "normal-completion" });
  });

  it.each([
    ["full-refund", "carrier"],
    ["partial-refund", "platform"],
  ] as const)("keeps a %s with %s responsibility context-only in both directions", (kind, responsibility) => {
    const decision = decideDirectionalReviewDisposition({
      deliveredAt: DELIVERED_AT,
      cancelledAt: null,
      evaluatedAt: EVALUATED_AT,
      supportRequests: [resolved(responsibility, { remedy: remedyReference(remedyFact(kind)) })],
    });

    expect(decision.buyerToSeller.scoringDisposition).toBe("context-only");
    expect(decision.sellerToBuyer.scoringDisposition).toBe("context-only");
  });

  it("does not let remedy or coverage change a seller-responsibility decision", () => {
    const withPlatformCoverage = decideDirectionalReviewDisposition({
      deliveredAt: DELIVERED_AT,
      cancelledAt: null,
      evaluatedAt: EVALUATED_AT,
      supportRequests: [resolved("seller", { remedy: remedyReference(remedyFact("full-refund")) })],
    });
    const withoutMonetaryRemedy = decideDirectionalReviewDisposition({
      deliveredAt: DELIVERED_AT,
      cancelledAt: null,
      evaluatedAt: EVALUATED_AT,
      supportRequests: [resolved("seller")],
    });

    expect(withPlatformCoverage.buyerToSeller.scoringDisposition).toBe("included");
    expect(withPlatformCoverage.buyerToSeller.scoringDisposition).toBe(
      withoutMonetaryRemedy.buyerToSeller.scoringDisposition,
    );
  });

  it("holds both otherwise-eligible directions while a review-affecting support request is open", () => {
    const decision = decideDirectionalReviewDisposition({
      deliveredAt: DELIVERED_AT,
      cancelledAt: null,
      evaluatedAt: EVALUATED_AT,
      supportRequests: [{ status: "open", resolvedAt: null }],
      visibilityStates: { buyerToSeller: "revealed", sellerToBuyer: "suppressed" },
    });

    expect(decision.buyerToSeller).toMatchObject({ submissionState: "held", visibilityState: "held" });
    expect(decision.sellerToBuyer).toMatchObject({ submissionState: "held", visibilityState: "suppressed" });
  });

  it("ignores a cancelled support request and preserves independent reveal and moderation visibility", () => {
    const decision = decideDirectionalReviewDisposition({
      deliveredAt: DELIVERED_AT,
      cancelledAt: null,
      evaluatedAt: EVALUATED_AT,
      supportRequests: [{ status: "cancelled", resolvedAt: null }],
      visibilityStates: { buyerToSeller: "revealed", sellerToBuyer: "suppressed" },
    });

    expect(decision.buyerToSeller).toMatchObject({ submissionState: "allowed", visibilityState: "revealed" });
    expect(decision.sellerToBuyer).toMatchObject({ submissionState: "allowed", visibilityState: "suppressed" });
  });

  it("creates buyer-to-seller eligibility without delivery only for an explicitly seller-responsible cancellation", () => {
    const decision = decideDirectionalReviewDisposition({
      deliveredAt: null,
      cancelledAt: CANCELLED_AT,
      evaluatedAt: EVALUATED_AT,
      supportRequests: [resolved("seller", { resolutionType: "cancel-order" })],
    });

    expect(decision.buyerToSeller).toMatchObject({
      submissionState: "allowed",
      scoringDisposition: "included",
      reasonCode: "seller-responsible-cancellation",
      eligibleAt: RESOLVED_AT,
    });
    expect(decision.sellerToBuyer).toMatchObject({
      transactionEligibility: "ineligible",
      scoringDisposition: "context-only",
    });
  });

  for (const responsibility of ["buyer", "carrier", "platform", "shared", "undetermined"] as const) {
    it(`does not create transaction eligibility for a ${responsibility}-responsible cancellation`, () => {
      const decision = decideDirectionalReviewDisposition({
        deliveredAt: null,
        cancelledAt: CANCELLED_AT,
        evaluatedAt: EVALUATED_AT,
        supportRequests: [resolved(responsibility, { resolutionType: "cancel-order" })],
      });

      expect(decision.buyerToSeller.transactionEligibility).toBe("ineligible");
      expect(decision.sellerToBuyer.transactionEligibility).toBe("ineligible");
    });
  }

  it("does not create transaction eligibility for a cancellation without a Support responsibility finding", () => {
    const decision = decideDirectionalReviewDisposition({
      deliveredAt: null,
      cancelledAt: CANCELLED_AT,
      evaluatedAt: EVALUATED_AT,
      supportRequests: [],
    });

    expect(decision.buyerToSeller).toMatchObject({
      transactionEligibility: "ineligible",
      reasonCode: "cancellation-not-reviewable",
    });
    expect(decision.sellerToBuyer.transactionEligibility).toBe("ineligible");
  });

  it.each([
    [undefined, "responsibility-undetermined", "allowed"],
    ["future-responsibility", "responsibility-unrecognized", "held"],
  ] as const)(
    "handles missing or unknown responsibility %s conservatively",
    (responsibility, reasonCode, submissionState) => {
      const decision = decideDirectionalReviewDisposition({
        deliveredAt: DELIVERED_AT,
        cancelledAt: null,
        evaluatedAt: EVALUATED_AT,
        supportRequests: [resolved(responsibility)],
      });

      expect(decision.buyerToSeller).toMatchObject({
        scoringDisposition: "context-only",
        reasonCode,
        submissionState,
      });
      expect(decision.sellerToBuyer).toMatchObject({
        scoringDisposition: "context-only",
        reasonCode,
        submissionState,
      });
    },
  );

  it("uses the conservative context-only result when multiple cases resolve to different responsibilities", () => {
    const decision = decideDirectionalReviewDisposition({
      deliveredAt: DELIVERED_AT,
      cancelledAt: null,
      evaluatedAt: EVALUATED_AT,
      supportRequests: [resolved("seller"), resolved("buyer")],
    });

    expect(decision.buyerToSeller).toMatchObject({
      scoringDisposition: "context-only",
      reasonCode: "multiple-responsibilities",
    });
    expect(decision.sellerToBuyer).toMatchObject({
      scoringDisposition: "context-only",
      reasonCode: "multiple-responsibilities",
    });
  });

  it("marks an otherwise-eligible direction expired at its effective deadline", () => {
    const decision = decideDirectionalReviewDisposition({
      deliveredAt: DELIVERED_AT,
      cancelledAt: null,
      evaluatedAt: "2026-06-02T00:00:00.000Z",
      supportRequests: [],
    });

    expect(decision.buyerToSeller).toMatchObject({
      transactionEligibility: "eligible",
      submissionState: "expired",
      effectiveDeadline: "2026-06-02T00:00:00.000Z",
      reasonCode: "submission-window-expired",
    });
  });
});
