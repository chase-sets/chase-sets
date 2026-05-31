import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_SUPPORT_OPERATIONS_EVIDENCE_VERSION,
  REQUIRED_SUPPORT_OPERATION_PROOFS,
  REQUIRED_SUPPORT_REHEARSAL_IDENTIFIER_SPECS,
  REQUIRED_SUPPORT_REHEARSAL_REFERENCES,
  buildSupportOperationsEvidence,
  parseSupportOperationsEvidenceArgs,
} from "./marketplace-support-operations-evidence.mjs";

function rehearsal(overrides = {}) {
  return {
    rehearsalReference: "SUPPORT-REHEARSAL-2026-05-30",
    rehearsalCompletedAt: "2026-05-30T12:30:00.000Z",
    environment: "staging",
    releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
    buyerSupportRequestId: "sup_buyer_rehearsal_20260530",
    sellerSupportRequestId: "sup_seller_rehearsal_20260530",
    operationsQueueReviewReference: "SUPPORT-QUEUE-REVIEW-2026-05-30",
    overdueEscalationResultReference: "SUPPORT-OVERDUE-ESCALATION-2026-05-30",
    lifecycleEndpointResultReference: "SUPPORT-LIFECYCLE-ENDPOINTS-2026-05-30",
    refundResolutionSupportRequestId: "sup_buyer_rehearsal_20260530",
    refundEffectId: "sre_buyer_rehearsal_20260530",
    refundId: "rfd_support_rehearsal_20260530",
    refundEffectReference: "PAYMENTS-SUPPORT-REFUND-EFFECT-2026-05-30",
    settlementHoldId: "hold_support_rehearsal_20260530",
    settlementHoldReference: "SETTLEMENT-SUPPORT-HOLD-2026-05-30",
    settlementHoldReleaseReference: "SETTLEMENT-SUPPORT-HOLD-RELEASE-2026-05-30",
    supportNotificationReference: "NOTIFICATIONS-SUPPORT-2026-05-30",
    buyerIssueOpeningProven: true,
    sellerIssueOpeningProven: true,
    operationsQueueReviewProven: true,
    overdueEscalationProven: true,
    lifecycleEndpointsProven: true,
    refundProducingResolutionProven: true,
    settlementHoldCoordinationProven: true,
    supportNotificationsProven: true,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    rehearsal: rehearsal(),
    reference: "SUPPORT-OPS-2026-05-30",
    owner: "Support",
    checkedAt: "2026-05-30T13:00:00.000Z",
    ...overrides,
  };
}

describe("marketplace support operations evidence", () => {
  it("builds the launch packet gate from a complete staging rehearsal record", () => {
    expect(buildSupportOperationsEvidence(input())).toEqual({
      schemaVersion: MARKETPLACE_SUPPORT_OPERATIONS_EVIDENCE_VERSION,
      approved: true,
      reference: "SUPPORT-OPS-2026-05-30",
      owner: "Support",
      checkedAt: "2026-05-30T13:00:00.000Z",
      rehearsalReference: "SUPPORT-REHEARSAL-2026-05-30",
      rehearsalCompletedAt: "2026-05-30T12:30:00.000Z",
      environment: "staging",
      releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
      buyerSupportRequestId: "sup_buyer_rehearsal_20260530",
      sellerSupportRequestId: "sup_seller_rehearsal_20260530",
      operationsQueueReviewReference: "SUPPORT-QUEUE-REVIEW-2026-05-30",
      overdueEscalationResultReference: "SUPPORT-OVERDUE-ESCALATION-2026-05-30",
      lifecycleEndpointResultReference: "SUPPORT-LIFECYCLE-ENDPOINTS-2026-05-30",
      refundResolutionSupportRequestId: "sup_buyer_rehearsal_20260530",
      refundEffectId: "sre_buyer_rehearsal_20260530",
      refundId: "rfd_support_rehearsal_20260530",
      refundEffectReference: "PAYMENTS-SUPPORT-REFUND-EFFECT-2026-05-30",
      settlementHoldId: "hold_support_rehearsal_20260530",
      settlementHoldReference: "SETTLEMENT-SUPPORT-HOLD-2026-05-30",
      settlementHoldReleaseReference: "SETTLEMENT-SUPPORT-HOLD-RELEASE-2026-05-30",
      supportNotificationReference: "NOTIFICATIONS-SUPPORT-2026-05-30",
      buyerIssueOpeningProven: true,
      sellerIssueOpeningProven: true,
      operationsQueueReviewProven: true,
      overdueEscalationProven: true,
      lifecycleEndpointsProven: true,
      refundProducingResolutionProven: true,
      settlementHoldCoordinationProven: true,
      supportNotificationsProven: true,
      passesSupportOperationsGate: true,
    });
  });

  it("fails when any required rehearsal proof is missing", () => {
    const evidence = buildSupportOperationsEvidence(
      input({
        rehearsal: rehearsal({
          refundProducingResolutionProven: false,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Support operations rehearsal must prove refundProducingResolutionProven=true.");
  });

  it("fails when the rehearsal did not run against staging", () => {
    const evidence = buildSupportOperationsEvidence(
      input({
        rehearsal: rehearsal({
          environment: "local",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Support operations rehearsal must run against staging before production marketplace launch.",
    );
  });

  it("fails when concrete support request and cross-context references are missing", () => {
    expect(() =>
      buildSupportOperationsEvidence(
        input({
          rehearsal: {
            ...rehearsal(),
            refundEffectReference: "",
          },
        }),
      ),
    ).toThrow("Support rehearsal refundEffectReference must be a non-empty string.");
  });

  it("fails when cross-context references are placeholders", () => {
    const evidence = buildSupportOperationsEvidence(
      input({
        rehearsal: rehearsal({
          settlementHoldReference: "ticket",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Support rehearsal settlementHoldReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("fails when downstream support, Payments, or Settlement ids are placeholders", () => {
    const evidence = buildSupportOperationsEvidence(
      input({
        rehearsal: rehearsal({
          buyerSupportRequestId: "todo",
          refundResolutionSupportRequestId: "todo",
          refundId: "record",
          settlementHoldId: "ticket",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Support rehearsal buyerSupportRequestId must be a concrete identifier, not a placeholder.",
    );
    expect(evidence.errors).toContain(
      "Support rehearsal refundResolutionSupportRequestId must be a concrete identifier, not a placeholder.",
    );
    expect(evidence.errors).toContain("Support rehearsal refundId must be a concrete identifier, not a placeholder.");
    expect(evidence.errors).toContain(
      "Support rehearsal settlementHoldId must be a concrete identifier, not a placeholder.",
    );
  });

  it("fails when downstream support, Payments, or Settlement ids use the wrong bounded-context prefix", () => {
    const evidence = buildSupportOperationsEvidence(
      input({
        rehearsal: rehearsal({
          buyerSupportRequestId: "req_buyer_rehearsal_20260530",
          refundResolutionSupportRequestId: "req_buyer_rehearsal_20260530",
          refundEffectId: "refund_effect_rehearsal_20260530",
          refundId: "refund_rehearsal_20260530",
          settlementHoldId: "settlement_hold_rehearsal_20260530",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Support rehearsal buyerSupportRequestId must start with sup_.");
    expect(evidence.errors).toContain("Support rehearsal refundResolutionSupportRequestId must start with sup_.");
    expect(evidence.errors).toContain("Support rehearsal refundEffectId must start with sre_.");
    expect(evidence.errors).toContain("Support rehearsal refundId must start with rfd_.");
    expect(evidence.errors).toContain("Support rehearsal settlementHoldId must start with hold_.");
  });

  it("fails when releaseCommit is not a 40-character Git commit SHA", () => {
    const evidence = buildSupportOperationsEvidence(
      input({
        rehearsal: rehearsal({
          releaseCommit: "support-rehearsal",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Support operations releaseCommit must be a 40-character Git commit SHA.");
  });

  it("fails when the staging rehearsal is stale or after checkedAt", () => {
    const staleEvidence = buildSupportOperationsEvidence(
      input({
        rehearsal: rehearsal({
          rehearsalCompletedAt: "2026-04-15T12:30:00.000Z",
        }),
      }),
    );
    const futureEvidence = buildSupportOperationsEvidence(
      input({
        rehearsal: rehearsal({
          rehearsalCompletedAt: "2026-05-30T13:05:00.000Z",
        }),
      }),
    );

    expect(staleEvidence.approved).toBe(false);
    expect(staleEvidence.errors).toContain("Support operations rehearsalCompletedAt cannot be older than 30 days.");
    expect(futureEvidence.approved).toBe(false);
    expect(futureEvidence.errors).toContain("Support operations rehearsalCompletedAt cannot be after checkedAt.");
  });

  it("fails when support rehearsal timestamps are date-only values", () => {
    const rehearsalCompletedOnly = buildSupportOperationsEvidence(
      input({
        rehearsal: rehearsal({
          rehearsalCompletedAt: "2026-05-30",
        }),
      }),
    );
    const checkedOnly = buildSupportOperationsEvidence(input({ checkedAt: "2026-05-30" }));

    expect(rehearsalCompletedOnly.approved).toBe(false);
    expect(rehearsalCompletedOnly.errors).toContain(
      "Support operations rehearsalCompletedAt must be an ISO timestamp.",
    );
    expect(checkedOnly.approved).toBe(false);
    expect(checkedOnly.errors).toContain("Support operations evidence checkedAt must be an ISO timestamp.");
  });

  it("fails when refund and participant request ids do not prove the expected lifecycle", () => {
    const evidence = buildSupportOperationsEvidence(
      input({
        rehearsal: rehearsal({
          sellerSupportRequestId: "sup_buyer_rehearsal_20260530",
          refundResolutionSupportRequestId: "sup_different_refund_rehearsal_20260530",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Support operations rehearsal must use separate buyer and seller support request ids.",
    );
    expect(evidence.errors).toContain(
      "Support operations rehearsal refund resolution must be tied to the buyer support request id.",
    );
  });

  it("fails when settlement hold release evidence reuses the hold evidence", () => {
    const evidence = buildSupportOperationsEvidence(
      input({
        rehearsal: rehearsal({
          settlementHoldReleaseReference: "SETTLEMENT-SUPPORT-HOLD-2026-05-30",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Support operations rehearsal must include separate hold and hold-release evidence references.",
    );
  });

  it("keeps the required proof list aligned with the launch evidence verifier", () => {
    expect(REQUIRED_SUPPORT_OPERATION_PROOFS).toEqual([
      "buyerIssueOpeningProven",
      "sellerIssueOpeningProven",
      "operationsQueueReviewProven",
      "overdueEscalationProven",
      "lifecycleEndpointsProven",
      "refundProducingResolutionProven",
      "settlementHoldCoordinationProven",
      "supportNotificationsProven",
    ]);
    expect(REQUIRED_SUPPORT_REHEARSAL_REFERENCES).toEqual([
      "buyerSupportRequestId",
      "sellerSupportRequestId",
      "operationsQueueReviewReference",
      "overdueEscalationResultReference",
      "lifecycleEndpointResultReference",
      "refundResolutionSupportRequestId",
      "refundEffectId",
      "refundId",
      "refundEffectReference",
      "settlementHoldId",
      "settlementHoldReleaseReference",
      "settlementHoldReference",
      "supportNotificationReference",
    ]);
    expect(REQUIRED_SUPPORT_REHEARSAL_IDENTIFIER_SPECS).toEqual([
      { key: "buyerSupportRequestId", prefix: "sup_" },
      { key: "sellerSupportRequestId", prefix: "sup_" },
      { key: "refundResolutionSupportRequestId", prefix: "sup_" },
      { key: "refundEffectId", prefix: "sre_" },
      { key: "refundId", prefix: "rfd_" },
      { key: "settlementHoldId", prefix: "hold_" },
    ]);
  });

  it("parses operator arguments from flags and environment", () => {
    expect(
      parseSupportOperationsEvidenceArgs(
        [
          "--rehearsal",
          "secure/support-rehearsal.json",
          "--reference",
          "SUPPORT-OPS-2026-05-30",
          "--owner",
          "Support Ops",
          "--checked-at",
          "2026-05-30T13:00:00.000Z",
        ],
        {},
      ),
    ).toMatchObject({
      rehearsalPath: "secure/support-rehearsal.json",
      reference: "SUPPORT-OPS-2026-05-30",
      owner: "Support Ops",
      checkedAt: "2026-05-30T13:00:00.000Z",
    });

    expect(
      parseSupportOperationsEvidenceArgs([], {
        SUPPORT_OPERATIONS_REHEARSAL_RECORD: "secure/support-rehearsal.json",
        PRODUCTION_SUPPORT_OPERATIONS_REFERENCE: "SUPPORT-OPS-2026-05-30",
      }),
    ).toMatchObject({
      rehearsalPath: "secure/support-rehearsal.json",
      reference: "SUPPORT-OPS-2026-05-30",
      owner: "Support",
    });
  });
});
