import { describe, expect, it } from "vitest";
import {
  normalizeProtectionCoverageRejectedV1,
  normalizeProtectionCoverageReservedV1,
  normalizeProtectionCoverageSettledV1,
  normalizeSupportRequestPlatformCoverageRequestedV1,
  normalizeSupportRequestRefundReleasedV1,
  normalizeSupportRequestRemedyAuthorizedV1,
  normalizeSupportRequestRemedyCompletedV1,
  platformCoverageFactTypes,
} from "./platform-coverage-facts";

const envelope = {
  factSchemaVersion: 1 as const,
  supportRequestId: "sup_123",
  remedyId: "rmd_123",
  idempotencyKey: "rmd_123:authorized",
  causationId: null,
  policyVersion: "coverage-policy-2026-07",
  occurredAt: "2026-07-14T00:00:00.000Z",
};

describe("platform-coverage fact type names", () => {
  it("pins the ratified v1 fact names", () => {
    expect(platformCoverageFactTypes).toStrictEqual({
      remedyAuthorized: "support.support-request.remedy-authorized.v1",
      platformCoverageRequested: "support.support-request.platform-coverage-requested.v1",
      refundReleased: "support.support-request.refund-released.v1",
      remedyCompleted: "support.support-request.remedy-completed.v1",
      protectionCoverageReserved: "settlement.protection-coverage.reserved.v1",
      protectionCoverageRejected: "settlement.protection-coverage.rejected.v1",
      protectionCoverageSettled: "settlement.protection-coverage.settled.v1",
    });
  });
});

describe("normalizeSupportRequestRemedyAuthorizedV1", () => {
  it("validates a fully platform-funded remedy and requires a coverage id", () => {
    const fact = normalizeSupportRequestRemedyAuthorizedV1({
      ...envelope,
      coverageId: "cov_1",
      remedy: { kind: "full-refund", amount: "10", currencyCode: "USD" },
      allocation: {
        sellerFundedAmount: "0",
        platformFundedAmount: "10",
        currencyCode: "usd",
        fundingKind: "platform-funded",
      },
      returnDirective: "no-return",
      refundTrigger: "immediate",
      reasonCode: "cannot-determine-fault",
    });
    expect(fact.allocation.fundingKind).toBe("platform-funded");
    expect(fact.remedy.amount).toBe("10.00");
    expect(fact.coverageId).toBe("cov_1");
  });

  it("rejects a platform-funded remedy missing its coverage id", () => {
    expect(() =>
      normalizeSupportRequestRemedyAuthorizedV1({
        ...envelope,
        coverageId: null,
        remedy: { kind: "full-refund", amount: "10.00", currencyCode: "usd" },
        allocation: {
          sellerFundedAmount: "0.00",
          platformFundedAmount: "10.00",
          currencyCode: "usd",
          fundingKind: "platform-funded",
        },
        returnDirective: "no-return",
        refundTrigger: "immediate",
        reasonCode: "cannot-determine-fault",
      }),
    ).toThrow(/coverageId/);
  });

  it("rejects a coverage id on a seller-funded remedy", () => {
    expect(() =>
      normalizeSupportRequestRemedyAuthorizedV1({
        ...envelope,
        coverageId: "cov_1",
        remedy: { kind: "full-refund", amount: "10.00", currencyCode: "usd" },
        allocation: {
          sellerFundedAmount: "10.00",
          platformFundedAmount: "0.00",
          currencyCode: "usd",
          fundingKind: "seller-funded",
        },
        returnDirective: "return-to-seller",
        refundTrigger: "delivered",
        reasonCode: "seller-fault",
      }),
    ).toThrow(/must not carry a coverageId/);
  });

  it("rejects an allocation that disagrees with its stated funding kind", () => {
    expect(() =>
      normalizeSupportRequestRemedyAuthorizedV1({
        ...envelope,
        coverageId: null,
        remedy: { kind: "full-refund", amount: "10.00", currencyCode: "usd" },
        allocation: {
          sellerFundedAmount: "10.00",
          platformFundedAmount: "0.00",
          currencyCode: "usd",
          fundingKind: "split",
        },
        returnDirective: "return-to-seller",
        refundTrigger: "delivered",
        reasonCode: "seller-fault",
      }),
    ).toThrow(/disagrees/);
  });

  it("rejects an unsupported schema version", () => {
    expect(() =>
      normalizeSupportRequestRemedyAuthorizedV1({
        ...envelope,
        factSchemaVersion: 2 as never,
        coverageId: null,
        remedy: { kind: "full-refund", amount: "10.00", currencyCode: "usd" },
        allocation: {
          sellerFundedAmount: "10.00",
          platformFundedAmount: "0.00",
          currencyCode: "usd",
          fundingKind: "seller-funded",
        },
        returnDirective: "return-to-seller",
        refundTrigger: "delivered",
        reasonCode: "seller-fault",
      }),
    ).toThrow(/schema version/);
  });

  it("round-trips through JSON without loss", () => {
    const fact = normalizeSupportRequestRemedyAuthorizedV1({
      ...envelope,
      coverageId: "cov_1",
      remedy: { kind: "partial-refund", amount: "7.50", currencyCode: "usd" },
      allocation: {
        sellerFundedAmount: "2.50",
        platformFundedAmount: "5.00",
        currencyCode: "usd",
        fundingKind: "split",
      },
      returnDirective: "return-to-platform",
      refundTrigger: "facility-intake",
      reasonCode: "split-fault",
    });
    expect(JSON.parse(JSON.stringify(fact))).toStrictEqual(fact);
  });
});

describe("coverage reservation lifecycle facts", () => {
  it("requests, reserves, and rejects with machine-readable reasons", () => {
    const requested = normalizeSupportRequestPlatformCoverageRequestedV1({
      ...envelope,
      coverageId: "cov_1",
      requestedAmount: "10.00",
      currencyCode: "usd",
      reasonCode: "cannot-determine-fault",
    });
    expect(requested.requestedAmount).toBe("10.00");

    const reserved = normalizeProtectionCoverageReservedV1({
      ...envelope,
      causationId: "cov_1:requested",
      coverageId: "cov_1",
      reservedAmount: "10.00",
      currencyCode: "usd",
    });
    expect(reserved.reservedAmount).toBe("10.00");

    const rejected = normalizeProtectionCoverageRejectedV1({
      ...envelope,
      coverageId: "cov_1",
      requestedAmount: "10.00",
      currencyCode: "usd",
      reasonCode: "insufficient-reserve",
    });
    expect(rejected.reasonCode).toBe("insufficient-reserve");
  });

  it("rejects an unknown coverage rejection reason", () => {
    expect(() =>
      normalizeProtectionCoverageRejectedV1({
        ...envelope,
        coverageId: "cov_1",
        requestedAmount: "10.00",
        currencyCode: "usd",
        reasonCode: "vibes" as never,
      }),
    ).toThrow(/rejection reason/);
  });
});

describe("refund-released fact", () => {
  it("requires the allocation to sum to the released refund amount", () => {
    const fact = normalizeSupportRequestRefundReleasedV1({
      ...envelope,
      coverageId: "cov_1",
      refundAmount: "10.00",
      currencyCode: "usd",
      allocation: {
        sellerFundedAmount: "0.00",
        platformFundedAmount: "10.00",
        currencyCode: "usd",
        fundingKind: "platform-funded",
      },
      refundTrigger: "immediate",
    });
    expect(fact.allocation.fundingKind).toBe("platform-funded");

    expect(() =>
      normalizeSupportRequestRefundReleasedV1({
        ...envelope,
        coverageId: null,
        refundAmount: "10.00",
        currencyCode: "usd",
        allocation: {
          sellerFundedAmount: "4.00",
          platformFundedAmount: "5.00",
          currencyCode: "usd",
          fundingKind: "split",
        },
        refundTrigger: "immediate",
      }),
    ).toThrow(/sum exactly/);
  });
});

describe("settled and completed facts", () => {
  it("settles a positive platform consumption with a correlated refund", () => {
    const settled = normalizeProtectionCoverageSettledV1({
      ...envelope,
      coverageId: "cov_1",
      refundId: "rfd_1",
      allocation: {
        sellerFundedAmount: "0.00",
        platformFundedAmount: "10.00",
        currencyCode: "usd",
        fundingKind: "platform-funded",
      },
      currencyCode: "usd",
    });
    expect(settled.refundId).toBe("rfd_1");
  });

  it("rejects a settlement with no platform consumption", () => {
    expect(() =>
      normalizeProtectionCoverageSettledV1({
        ...envelope,
        coverageId: "cov_1",
        refundId: "rfd_1",
        allocation: {
          sellerFundedAmount: "10.00",
          platformFundedAmount: "0.00",
          currencyCode: "usd",
          fundingKind: "seller-funded",
        },
        currencyCode: "usd",
      }),
    ).toThrow(/positive platform-funded/);
  });

  it("completes a remedy and round-trips through JSON", () => {
    const completed = normalizeSupportRequestRemedyCompletedV1({
      ...envelope,
      coverageId: "cov_1",
      refundId: "rfd_1",
      allocation: {
        sellerFundedAmount: "0.00",
        platformFundedAmount: "10.00",
        currencyCode: "usd",
        fundingKind: "platform-funded",
      },
      returnDirective: "return-to-platform",
      completedAt: "2026-07-14T01:00:00.000Z",
    });
    expect(JSON.parse(JSON.stringify(completed))).toStrictEqual(completed);
    expect(completed.refundId).toBe("rfd_1");
  });
});

describe("backward compatibility / replay", () => {
  it("treats an omitted optional causationId as a null origin (additive-evolution rule)", () => {
    const { causationId: _omitted, ...withoutCausation } = envelope;
    const fact = normalizeProtectionCoverageReservedV1({
      ...withoutCausation,
      coverageId: "cov_1",
      reservedAmount: "10.00",
      currencyCode: "usd",
    });
    expect(fact.causationId).toBeNull();
  });

  it("re-canonicalizes wire amounts on decode so replayed events validate identically", () => {
    const fact = normalizeProtectionCoverageReservedV1({
      ...envelope,
      coverageId: "cov_1",
      reservedAmount: "10", // legacy un-canonicalized wire form
      currencyCode: "USD",
    });
    expect(fact.reservedAmount).toBe("10.00");
    expect(fact.currencyCode).toBe("usd");
  });
});
