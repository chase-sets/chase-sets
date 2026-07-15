import { describe, expect, it } from "vitest";
import type { AccountId, CoverageId, OrderId, RemedyId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import {
  decideSupportRequest,
  evolveSupportRequest,
  initialSupportRequestState,
  type SupportRequestCommand,
  type SupportRequestEvent,
  type SupportRequestState,
} from "./domain";
import {
  normalizeRemedyAuthorization,
  type AuthorizeSupportRemedyCommand,
  type RecordSupportRemedyEffectCommand,
} from "./remedy";

const supportRequestId = "sup_01J00000000000000000000000" as SupportRequestId;
const remedyId = "rmd_01J00000000000000000000000" as RemedyId;
const coverageId = "cov_01J00000000000000000000000" as CoverageId;
const accountId = "acc_01J00000000000000000000000" as AccountId;

function resolvedState(): SupportRequestState {
  return {
    ...initialSupportRequestState,
    supportRequestId,
    orderId: "ord_01J00000000000000000000000" as OrderId,
    buyerAccountId: accountId,
    sellerAccountId: "acc_01J00000000000000000000001" as AccountId,
    flowType: "product-not-received",
    status: "resolved",
    openedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    autoCloseDueAt: "2026-07-09T00:00:00.000Z",
    resolution: {
      resolutionType: "full-refund",
      summary: "Buyer is made whole.",
      refundAmount: "10.00",
      resolvedByAccountId: accountId,
      resolvedByRole: "support",
      resolvedAt: "2026-07-02T00:00:00.000Z",
      responsibility: "undetermined",
      evidenceBasis: { type: "insufficient-evidence", reference: "review-1" },
      responsibilityReasonCode: "product-not-received.insufficient-evidence",
    },
  };
}

function apply(state: SupportRequestState, events: readonly SupportRequestEvent[]): SupportRequestState {
  return events.reduce(evolveSupportRequest, state);
}

function platformAuthorization(): AuthorizeSupportRemedyCommand {
  return {
    type: "AuthorizeSupportRemedy",
    remedyId,
    coverageId,
    remedy: { kind: "full-refund", amount: "10.00", currencyCode: "usd" },
    allocation: {
      sellerFundedAmount: "0.00",
      platformFundedAmount: "10.00",
      currencyCode: "usd",
      fundingKind: "platform-funded",
    },
    returnDirective: "no-return",
    refundTrigger: "immediate",
    policyVersion: "coverage-2026-07",
    reasonCode: "ambiguous-carrier-loss",
    idempotencyKey: "authorize-1",
    authorizedAt: "2026-07-03T00:00:00.000Z",
  };
}

function proposalCommand(authorization = platformAuthorization()): SupportRequestCommand {
  return {
    type: "ProposeSupportRemedy",
    terms: normalizeRemedyAuthorization(supportRequestId, authorization),
    proposedByAccountId: accountId,
    permissionUsed: "support.remedies.propose",
    rationale: "Evidence does not establish seller fault.",
    evidenceReferences: ["evidence-1"],
    reservationExpiresAt: authorization.coverageId ? "2026-07-04T00:00:00.000Z" : null,
    requiredApprovalCount: 1,
    requiresElevatedApproval: false,
    returnOverrideUsed: false,
    returnExceptionReasonCode: null,
  };
}

function approvalCommand(): SupportRequestCommand {
  return {
    type: "ApproveSupportRemedy",
    approvedByAccountId: accountId,
    permissionUsed: "support.remedies.approve",
    reasonCode: "policy-approved",
    rationale: "The proposal is within policy.",
    evidenceReferences: ["evidence-1"],
    idempotencyKey: "approve-1",
    approvedAt: "2026-07-03T12:00:00.000Z",
  };
}

function authorizedState(authorization = platformAuthorization()): SupportRequestState {
  let state = resolvedState();
  state = apply(state, decideSupportRequest(state, proposalCommand(authorization)));
  if (authorization.coverageId) {
    state = apply(state, decideSupportRequest(state, effect("coverage-reservation", "2026-07-03T06:00:00.000Z")));
  }
  return apply(state, decideSupportRequest(state, approvalCommand()));
}

function effect(
  effectName:
    | "coverage-reservation"
    | "refund-completion"
    | "settlement-reconciliation"
    | "facility-intake"
    | "return-label-available",
  occurredAt: string,
  options: Readonly<{
    outcome?: "satisfied" | "failed-retryable" | "failed-terminal";
    refundId?: string | null;
    key?: string;
  }> = {},
): RecordSupportRemedyEffectCommand {
  return {
    type: "RecordSupportRemedyEffect",
    remedyId,
    coverageId,
    effect: effectName,
    outcome: options.outcome ?? "satisfied",
    sourceFactType: `test.${effectName}`,
    sourceFactId: `fact-${options.key ?? effectName}`,
    idempotencyKey: options.key ?? effectName,
    occurredAt,
    reasonCode: options.outcome?.startsWith("failed") ? "provider-timeout" : `${effectName}-confirmed`,
    refundId: options.refundId ?? null,
    amount: effectName === "coverage-reservation" || effectName === "refund-completion" ? "10.00" : null,
    currencyCode: effectName === "coverage-reservation" || effectName === "refund-completion" ? "usd" : null,
    allocation:
      effectName === "settlement-reconciliation"
        ? {
            sellerFundedAmount: "0.00",
            platformFundedAmount: "10.00",
            currencyCode: "usd",
            fundingKind: "platform-funded",
          }
        : null,
  };
}

describe("support remedy execution", () => {
  it("waits for coverage before releasing a fully platform-funded refund and cancels the decision timer", () => {
    let state = resolvedState();
    const events = decideSupportRequest(state, proposalCommand());
    expect(events.map((event) => event.type)).toEqual([
      "support.support-request.remedy-proposed",
      "support.support-request.platform-coverage-requested.v1",
    ]);
    state = apply(state, events);
    expect(() => decideSupportRequest(state, approvalCommand())).toThrow("must be reserved before approval");
    state = apply(state, decideSupportRequest(state, effect("coverage-reservation", "2026-07-03T06:00:00.000Z")));
    const approvalEvents = decideSupportRequest(state, approvalCommand());
    expect(approvalEvents.map((event) => event.type)).toEqual([
      "support.support-request.remedy-approved",
      "support.support-request.remedy-authorized.v1",
      "support.support-request.refund-released.v1",
    ]);
    const authorized = apply(state, approvalEvents);
    expect(authorized.autoCloseDueAt).toBeNull();
    expect(authorized.remedy?.effects.map((candidate) => candidate.effect)).toEqual([
      "coverage-reservation",
      "refund-completion",
      "settlement-reconciliation",
    ]);
    expect(() =>
      decideSupportRequest(authorized, { type: "CloseSupportRequest", closedAt: "2026-07-04T00:00:00.000Z" }),
    ).toThrow("cannot close until every required remedy effect is complete");
    expect(() =>
      decideSupportRequest(authorized, {
        ...effect("coverage-reservation", "2026-07-04T00:00:00.000Z", { key: "wrong-coverage" }),
        coverageId: null,
      }),
    ).toThrow("requires the matching coverage id");

    expect(authorized.remedy?.refundReleasedAt).toBe("2026-07-03T12:00:00.000Z");
  });

  it("does not confuse refund completion with Settlement reconciliation", () => {
    let state = authorizedState();
    const refundEvents = decideSupportRequest(
      state,
      effect("refund-completion", "2026-07-05T00:00:00.000Z", { refundId: "rfd_1" }),
    );
    expect(refundEvents.map((event) => event.type)).toEqual(["support.support-request.remedy-effect-recorded"]);
    state = apply(state, refundEvents);
    expect(state.remedy?.status).toBe("in-progress");

    const reconciled = decideSupportRequest(
      state,
      effect("settlement-reconciliation", "2026-07-06T00:00:00.000Z", { refundId: "rfd_1" }),
    );
    expect(reconciled.map((event) => event.type)).toEqual([
      "support.support-request.remedy-effect-recorded",
      "support.support-request.remedy-completed.v1",
    ]);
    state = apply(state, reconciled);
    expect(state.remedy?.status).toBe("completed");
    expect(state.autoCloseDueAt).toBe("2026-07-13T00:00:00.000Z");
    expect(
      decideSupportRequest(state, { type: "CloseSupportRequest", closedAt: "2026-07-14T00:00:00.000Z" }),
    ).toHaveLength(1);
  });

  it("applies a correlated fact once and converges when valid facts precede authorization", () => {
    let state = resolvedState();
    const facts = [
      effect("settlement-reconciliation", "2026-07-06T00:00:00.000Z", { refundId: "rfd_1" }),
      effect("refund-completion", "2026-07-05T00:00:00.000Z", { refundId: "rfd_1" }),
      effect("coverage-reservation", "2026-07-04T00:00:00.000Z"),
    ];
    for (const command of facts) {
      state = apply(state, decideSupportRequest(state, command));
    }
    expect(state.remedy).toBeNull();
    expect(state.deferredRemedyEffectFacts).toHaveLength(3);

    state = apply(state, decideSupportRequest(state, proposalCommand()));
    const authorizationEvents = decideSupportRequest(state, approvalCommand());
    expect(authorizationEvents.map((event) => event.type)).toContain("support.support-request.remedy-completed.v1");
    state = apply(state, authorizationEvents);
    expect(state.remedy?.status).toBe("completed");

    expect(decideSupportRequest(state, facts[0]!)).toEqual([]);
  });

  it("keeps rejection and retryable provider failures visible and actionable", () => {
    let state = resolvedState();
    state = apply(state, decideSupportRequest(state, proposalCommand()));
    state = apply(
      state,
      decideSupportRequest(
        state,
        effect("coverage-reservation", "2026-07-04T00:00:00.000Z", {
          outcome: "failed-terminal",
          key: "coverage-rejected",
        }),
      ),
    );
    expect(state.remedy).toBeNull();
    expect(state.remedyApproval?.status).toBe("reservation-rejected");
    expect(state.remedyApproval?.reservationReasonCode).toBe("provider-timeout");
  });

  it("records one idempotent retry intent without replacing the failed owning-context fact", () => {
    let state = authorizedState();
    state = apply(
      state,
      decideSupportRequest(
        state,
        effect("refund-completion", "2026-07-04T00:00:00.000Z", {
          outcome: "failed-retryable",
          key: "refund-provider-timeout",
        }),
      ),
    );
    const retry: SupportRequestCommand = {
      type: "RetrySupportRemedyEffect",
      remedyId,
      effect: "refund-completion",
      requestedByAccountId: accountId,
      permissionUsed: "support.remedies.retry",
      reasonCode: "provider-timeout",
      rationale: "Repeat the same refund intent after the provider timeout.",
      idempotencyKey: "retry-refund-1",
      requestedAt: "2026-07-04T01:00:00.000Z",
    };

    const retryEvents = decideSupportRequest(state, retry);
    expect(retryEvents.map((event) => event.type)).toEqual(["support.support-request.remedy-effect-retry-requested"]);
    state = apply(state, retryEvents);
    expect(state.remedy?.effects.find((candidate) => candidate.effect === "refund-completion")?.status).toBe(
      "failed-retryable",
    );
    expect(decideSupportRequest(state, retry)).toEqual([]);
  });

  it("waits for configured facility intake and permits only non-financial reasoned overrides", () => {
    const authorization = {
      ...platformAuthorization(),
      coverageId: null,
      allocation: {
        sellerFundedAmount: "10.00",
        platformFundedAmount: "0.00",
        currencyCode: "usd",
        fundingKind: "seller-funded" as const,
      },
      returnDirective: "return-to-platform" as const,
      refundTrigger: "facility-intake" as const,
    };
    let state = authorizedState(authorization);
    expect(state.remedy?.refundReleasedAt).toBeNull();
    expect(state.remedy?.effects.map((candidate) => candidate.effect)).toContain("facility-intake");

    const intake = decideSupportRequest(state, {
      ...effect("facility-intake", "2026-07-04T00:00:00.000Z"),
      coverageId: null,
    });
    expect(intake.map((event) => event.type)).toContain("support.support-request.refund-released.v1");
    state = apply(state, intake);

    const override = decideSupportRequest(state, {
      type: "OverrideSupportRemedyEffect",
      remedyId,
      effect: "return-label-available",
      actorAccountId: accountId,
      permissionUsed: "support.remedies.waive",
      reasonCode: "label-not-required-after-facility-dropoff",
      rationale: "Facility accepted the handoff without a label.",
      evidenceReferences: ["facility-intake-1"],
      idempotencyKey: "override-label-1",
      overriddenAt: "2026-07-05T00:00:00.000Z",
    });
    expect(override[0]?.type).toBe("support.support-request.remedy-effect-waived");
    expect(() =>
      decideSupportRequest(state, {
        type: "OverrideSupportRemedyEffect",
        remedyId,
        effect: "settlement-reconciliation",
        actorAccountId: accountId,
        permissionUsed: "support.remedies.waive",
        reasonCode: "pretend-reconciled",
        rationale: "Invalid financial override.",
        evidenceReferences: ["bad-override-1"],
        idempotencyKey: "override-finance-1",
        overriddenAt: "2026-07-05T00:00:00.000Z",
      }),
    ).toThrow("requires an owning-context fact and cannot be waived");
  });

  it("replays legacy decided cases with their explicit legacy auto-close default", () => {
    const state = resolvedState();
    expect(state.remedy).toBeNull();
    expect(state.autoCloseDueAt).toBe("2026-07-09T00:00:00.000Z");
    expect(
      decideSupportRequest(state, { type: "CloseSupportRequest", closedAt: "2026-07-10T00:00:00.000Z" }),
    ).toHaveLength(1);
  });
});
