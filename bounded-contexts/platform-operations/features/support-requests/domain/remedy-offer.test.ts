import { describe, expect, it } from "vitest";
import type { AccountId, CoverageId, RemedyId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import { normalizeSupportRequestRemedyAuthorizedV1 } from "@chase-sets/event-core/platform-coverage-facts";
import { PLATFORM_REMEDY_LAUNCH_POLICY_VALUE, type PlatformRemedyPolicyValue } from "./platform-remedy-policy";
import { applyRemedyReservationFact, createRemedyApprovalWorkflow } from "./remedy-approval";
import type { RemedyEffect, RemedyExecution } from "./remedy";
import { describeSupportRemedyOffer, type SupportRemedyOfferRequest } from "./remedy-offer";

const now = "2026-07-14T02:00:00.000Z";
const version = "platform-operations.platform-remedies:compiled-v1";

function proposal(amount = "600.00") {
  return createRemedyApprovalWorkflow({
    type: "ProposeSupportRemedy",
    terms: normalizeSupportRequestRemedyAuthorizedV1({
      factSchemaVersion: 1,
      supportRequestId: "sup_case" as SupportRequestId,
      remedyId: "rmd_remedy" as RemedyId,
      coverageId: "cov_coverage" as CoverageId,
      remedy: { kind: "full-refund", amount, currencyCode: "usd" },
      allocation: {
        sellerFundedAmount: "0.00",
        platformFundedAmount: amount,
        currencyCode: "usd",
        fundingKind: "platform-funded",
      },
      returnDirective: "return-to-platform",
      refundTrigger: "facility-intake",
      reasonCode: "customer-protection",
      idempotencyKey: "proposal-1",
      causationId: null,
      policyVersion: version,
      occurredAt: "2026-07-14T00:00:00.000Z",
    }),
    proposedByAccountId: "acc_proposer" as AccountId,
    permissionUsed: "support.remedies.propose",
    rationale: "The evidence supports a customer remedy.",
    evidenceReferences: ["evidence-1"],
    reservationExpiresAt: "2026-07-15T00:00:00.000Z",
    requiredApprovalCount: 2,
    requiresElevatedApproval: true,
    returnOverrideUsed: false,
    returnExceptionReasonCode: null,
  });
}

function reserved(amount = "600.00") {
  return applyRemedyReservationFact(proposal(amount), {
    effect: "coverage-reservation",
    outcome: "satisfied",
    sourceFactType: "settlement.protection-coverage.reserved.v1",
    sourceFactId: "evt_reserved",
    idempotencyKey: "coverage-reserved",
    occurredAt: "2026-07-14T01:00:00.000Z",
    reasonCode: "coverage-reserved",
    refundId: null,
    amount: null,
    currencyCode: null,
    allocation: null,
  });
}

function request(overrides: Partial<SupportRemedyOfferRequest> = {}): SupportRemedyOfferRequest {
  return {
    support_request_id: "sup_case",
    status: "resolved",
    resolution: { refundAmount: "600.00" },
    affected_line_items: [{ lineId: "line_1", currencyCode: "EUR" }],
    remedy: null,
    remedy_approval: null,
    ...overrides,
  };
}

function offer(
  overrides: Partial<SupportRemedyOfferRequest>,
  permissions: readonly string[],
  accountId = "acc_operator",
  policy: PlatformRemedyPolicyValue = PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
) {
  return describeSupportRemedyOffer({
    request: request(overrides),
    policy,
    policyVersion: version,
    actor: { accountId, permissions },
    now,
  });
}

function effect(name: RemedyEffect["effect"], status: RemedyEffect["status"]): RemedyEffect {
  return {
    effect: name,
    required: true,
    status,
    facts: status === "pending" ? [] : [{ idempotencyKey: `fact-${name}` } as never],
    waiver: null,
  };
}

function execution(effects: readonly RemedyEffect[]): RemedyExecution {
  return { remedyId: "rmd_remedy" as RemedyId, effects } as unknown as RemedyExecution;
}

describe("support remedy offer", () => {
  it("offers the choices of the policy it is given and names its version", () => {
    const published: PlatformRemedyPolicyValue = {
      ...PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
      eligibleReasonCodes: ["published-goodwill"],
      allowableRefundTriggers: ["delivered"],
      returnExceptionReasonCodes: ["published-exception"],
      escalationReasonCodes: ["published-escalation"],
      splitFundingAllowed: false,
    };

    expect(offer({}, [], "acc_operator", published)).toMatchObject({
      policyVersion: version,
      choices: {
        refundTriggers: ["delivered"],
        eligibleReasonCodes: ["published-goodwill"],
        returnExceptionReasonCodes: ["published-exception"],
        escalationReasonCodes: ["published-escalation"],
        splitFundingAllowed: false,
      },
      currencyCode: "eur",
    });
  });

  it("offers a proposal on a resolved refund decision, allowed only within the proposer's limit", () => {
    expect(offer({}, ["support.remedies.propose"]).propose).toEqual({
      idempotencyKey: "sup_case:platform-remedy-proposal",
      allowed: true,
    });
    expect(offer({}, []).propose?.allowed).toBe(false);
    expect(offer({ resolution: { refundAmount: "1500.00" } }, ["support.remedies.propose"]).propose?.allowed).toBe(
      false,
    );
    expect(offer({ resolution: null }, ["support.remedies.propose"]).propose).toBeNull();
    expect(offer({ status: "ready-for-support" }, ["support.remedies.propose"]).propose).toBeNull();
    expect(offer({ remedy_approval: reserved() }, ["support.remedies.propose"]).propose).toBeNull();
  });

  it("offers approval only to an operator the API would take it from", () => {
    const pending = { remedy_approval: reserved() };
    expect(offer(pending, ["support.remedies.approve-elevated"]).approve).toEqual({
      idempotencyKey: "rmd_remedy:approval",
      allowed: true,
    });
    // Above the plain approver's amount limit.
    expect(offer(pending, ["support.remedies.approve"]).approve?.allowed).toBe(false);
    // Dual control needs an approver other than the proposer.
    expect(offer(pending, ["support.remedies.approve-elevated"], "acc_proposer").approve?.allowed).toBe(false);
    // Coverage is not reserved yet, so the proposal is not waiting on approval.
    expect(offer({ remedy_approval: proposal() }, ["support.remedies.approve-elevated"]).approve).toBeNull();
    expect(offer({}, ["support.remedies.approve-elevated"]).approve).toBeNull();
  });

  it("offers a correction on any proposed remedy to an operator who may correct", () => {
    expect(offer({ remedy_approval: reserved() }, ["support.remedies.correct"]).correct).toEqual({
      idempotencyKey: "rmd_remedy:correction",
      allowed: true,
    });
    expect(offer({ remedy_approval: reserved() }, []).correct?.allowed).toBe(false);
    expect(offer({}, ["support.remedies.correct"]).correct).toBeNull();
  });

  it("offers retry, waiver and release per effect, never a waiver of a financial effect", () => {
    const remedy = execution([
      effect("return-delivered", "failed-retryable"),
      effect("facility-intake", "failed-terminal"),
      effect("refund-completion", "failed-terminal"),
      effect("operator-release", "pending"),
    ]);
    const effects = offer({ remedy, remedy_approval: reserved() }, [
      "support.remedies.retry",
      "support.remedies.waive",
    ]).effects;

    expect(effects).toEqual([
      {
        effect: "return-delivered",
        retry: { idempotencyKey: "rmd_remedy:return-delivered:fact-return-delivered:retry", allowed: true },
        waive: null,
        release: null,
      },
      {
        effect: "facility-intake",
        retry: null,
        waive: { idempotencyKey: "rmd_remedy:facility-intake:fact-facility-intake:waive", allowed: true },
        release: null,
      },
      { effect: "refund-completion", retry: null, waive: null, release: null },
      {
        effect: "operator-release",
        retry: null,
        waive: null,
        release: { idempotencyKey: "rmd_remedy:operator-release", allowed: false },
      },
    ]);
  });
});
