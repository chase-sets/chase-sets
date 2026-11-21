import { describe, expect, it } from "vitest";
import type { AccountId, CoverageId, RemedyId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import { normalizeSupportRequestRemedyAuthorizedV1 } from "@chase-sets/event-core/platform-coverage-facts";
import { SupportDomainError } from "./common";
import {
  applyRemedyApproval,
  applyRemedyReservationFact,
  createRemedyApproval,
  createRemedyApprovalWorkflow,
} from "./remedy-approval";

const proposer = "acc_proposer" as AccountId;
const approver = "acc_approver" as AccountId;
const elevated = "acc_elevated" as AccountId;

function workflow(options: Readonly<{ returnOverrideUsed?: boolean }> = {}) {
  return createRemedyApprovalWorkflow({
    type: "ProposeSupportRemedy",
    terms: normalizeSupportRequestRemedyAuthorizedV1({
      factSchemaVersion: 1,
      supportRequestId: "sup_case" as SupportRequestId,
      remedyId: "rmd_remedy" as RemedyId,
      coverageId: "cov_coverage" as CoverageId,
      remedy: { kind: "full-refund", amount: "600.00", currencyCode: "usd" },
      allocation: {
        sellerFundedAmount: "100.00",
        platformFundedAmount: "500.00",
        currencyCode: "usd",
        fundingKind: "split",
      },
      returnDirective: "return-to-platform",
      refundTrigger: "facility-intake",
      reasonCode: "customer-protection",
      idempotencyKey: "proposal-1",
      causationId: null,
      policyVersion: "platform-operations.platform-remedies:compiled-v1",
      occurredAt: "2026-07-14T00:00:00.000Z",
    }),
    proposedByAccountId: proposer,
    permissionUsed: "support.remedies.propose",
    rationale: "The evidence supports a split-funded customer remedy.",
    evidenceReferences: ["evidence-1"],
    reservationExpiresAt: "2026-07-15T00:00:00.000Z",
    requiredApprovalCount: 2,
    requiresElevatedApproval: true,
    returnOverrideUsed: options.returnOverrideUsed ?? false,
    returnExceptionReasonCode: options.returnOverrideUsed ? "documented-exception" : null,
  });
}

function approval(accountId: AccountId, elevatedApproval = false, approvedAt = "2026-07-14T02:00:00.000Z") {
  return {
    type: "ApproveSupportRemedy" as const,
    approvedByAccountId: accountId,
    permissionUsed: elevatedApproval
      ? ("support.remedies.approve-elevated" as const)
      : ("support.remedies.approve" as const),
    reasonCode: "policy-approved",
    rationale: "Approval evidence reviewed.",
    evidenceReferences: ["evidence-1"],
    idempotencyKey: `approval:${accountId}`,
    approvedAt,
  };
}

describe("remedy approval workflow", () => {
  it("audits a return override under its purpose-specific permission", () => {
    const override = workflow({ returnOverrideUsed: true }).auditTrail.find(
      (entry) => entry.action === "return-override",
    );
    expect(override).toMatchObject({
      actorType: "human",
      permissionUsed: "support.remedies.override-return",
      reasonCode: "documented-exception",
    });
  });

  it("requires reservation, distinct dual control, and an elevated approval before authorization", () => {
    let state = workflow();
    expect(() => createRemedyApproval(state, approval(approver))).toThrow("must be reserved before approval");
    state = applyRemedyReservationFact(state, {
      effect: "coverage-reservation",
      outcome: "satisfied",
      sourceFactType: "settlement.protection-coverage.reserved.v1",
      sourceFactId: "evt_reserved",
      idempotencyKey: "coverage-reserved",
      occurredAt: "2026-07-14T01:00:00.000Z",
      reasonCode: "coverage-reserved",
      refundId: null,
      amount: "500.00",
      currencyCode: "usd",
      allocation: null,
    });
    expect(() => createRemedyApproval(state, approval(proposer))).toThrow("distinct from the proposer");
    state = applyRemedyApproval(state, createRemedyApproval(state, approval(approver)));
    expect(state.status).toBe("approval-pending");
    state = applyRemedyApproval(state, createRemedyApproval(state, approval(elevated, true)));
    expect(state.status).toBe("approved");
  });

  it("rejects approval after the stamped reservation expiry", () => {
    const state = applyRemedyReservationFact(workflow(), {
      effect: "coverage-reservation",
      outcome: "satisfied",
      sourceFactType: "settlement.protection-coverage.reserved.v1",
      sourceFactId: "evt_reserved",
      idempotencyKey: "coverage-reserved",
      occurredAt: "2026-07-14T01:00:00.000Z",
      reasonCode: "coverage-reserved",
      refundId: null,
      amount: "500.00",
      currencyCode: "usd",
      allocation: null,
    });
    expect(() => createRemedyApproval(state, approval(approver, false, "2026-07-15T00:00:00.000Z"))).toThrow(
      "reservation expired",
    );
  });

  describe("workflow status guard", () => {
    function reservedWorkflow() {
      return applyRemedyReservationFact(workflow(), {
        effect: "coverage-reservation",
        outcome: "satisfied",
        sourceFactType: "settlement.protection-coverage.reserved.v1",
        sourceFactId: "evt_reserved",
        idempotencyKey: "coverage-reserved",
        occurredAt: "2026-07-14T01:00:00.000Z",
        reasonCode: "coverage-reserved",
        refundId: null,
        amount: "500.00",
        currencyCode: "usd",
        allocation: null,
      });
    }

    it("accepts an approval while the workflow is approval-pending", () => {
      const state = reservedWorkflow();
      expect(state.status).toBe("approval-pending");
      expect(createRemedyApproval(state, approval(approver))).toMatchObject({
        approvedByAccountId: approver,
        idempotencyKey: `approval:${approver}`,
      });
    });

    it.each(["correction-requested", "approved", "authorized", "expired"] as const)(
      "refuses a new approval while the workflow is %s",
      (status) => {
        const state = { ...reservedWorkflow(), status };
        expect(() => createRemedyApproval(state, approval(approver))).toThrow(SupportDomainError);
        expect(() => createRemedyApproval(state, approval(approver))).toThrow(
          `A remedy can only be approved while its workflow is approval-pending; this workflow is ${status}.`,
        );
      },
    );

    it("keeps refusing reservation-pending and reservation-rejected workflows through the reservation checks", () => {
      const pending = workflow();
      expect(pending.status).toBe("reservation-pending");
      expect(() => createRemedyApproval(pending, approval(approver))).toThrow("must be reserved before approval");
      const rejected = applyRemedyReservationFact(pending, {
        effect: "coverage-reservation",
        outcome: "failed-terminal",
        sourceFactType: "settlement.protection-coverage.rejected.v1",
        sourceFactId: "evt_rejected",
        idempotencyKey: "coverage-rejected",
        occurredAt: "2026-07-14T01:00:00.000Z",
        reasonCode: "coverage-exhausted",
        refundId: null,
        amount: null,
        currencyCode: null,
        allocation: null,
      });
      expect(rejected.status).toBe("reservation-rejected");
      expect(() => createRemedyApproval(rejected, approval(approver))).toThrow(
        "Protection coverage was rejected: coverage-exhausted.",
      );
    });

    it("still returns an already recorded approval when replayed after the workflow left approval-pending", () => {
      const pending = reservedWorkflow();
      const recorded = createRemedyApproval(pending, approval(approver));
      const state = { ...applyRemedyApproval(pending, recorded), status: "correction-requested" as const };
      expect(createRemedyApproval(state, approval(approver))).toBe(recorded);
    });
  });
});
