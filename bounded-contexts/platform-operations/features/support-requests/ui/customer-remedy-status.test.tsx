import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRemedyEffectFact,
  createRemedyExecution,
  type RemedyEffectFact,
  type RemedyEffectKind,
} from "../domain/remedy";
import { createRemedyApprovalWorkflow } from "../domain/remedy-approval";
import type { SupportRequestListItem } from "./contracts";
import { CustomerRemedyStatus, deriveCustomerRemedyStatus } from "./customer-remedy-status";

const authorizedTerms = {
  factSchemaVersion: 1 as const,
  supportRequestId: "sup_1",
  remedyId: "rmd_1",
  coverageId: "cov_1",
  remedy: { kind: "full-refund" as const, amount: "125.00", currencyCode: "usd" },
  allocation: {
    sellerFundedAmount: "0.00",
    platformFundedAmount: "125.00",
    currencyCode: "usd",
    fundingKind: "platform-funded" as const,
  },
  returnDirective: "return-to-platform" as const,
  refundTrigger: "facility-intake" as const,
  reasonCode: "insufficient-evidence",
  idempotencyKey: "rmd_1:authorized",
  causationId: null,
  policyVersion: "platform-remedy-2026-07",
  occurredAt: "2026-07-14T12:00:00.000Z",
};

function request(
  overrides: Partial<Pick<SupportRequestListItem, "remedy" | "remedy_approval">> = {},
): SupportRequestListItem {
  return {
    support_request_id: "sup_1",
    display_reference: "SUP-00000001",
    order_id: "ord_1",
    buyer_account_id: "acct_buyer",
    seller_account_id: "acct_seller",
    flow_type: "product-not-as-described",
    status: "resolved",
    priority: "normal",
    opened_by_account_id: "acct_buyer",
    opened_by_role: "buyer",
    opened_at: "2026-07-14T10:00:00.000Z",
    updated_at: "2026-07-14T12:00:00.000Z",
    seller_response_due_at: null,
    support_review_due_at: null,
    seller_condition_attestation_due_at: null,
    order_return_context: null,
    return_investigation: null,
    checklist: [],
    pending_offer: null,
    resolution: null,
    closed_at: null,
    cancellation_reason: null,
    escalated_at: null,
    escalated_by_account_id: null,
    escalated_by_role: null,
    escalation_reason: null,
    return_refund_gate_status: null,
    return_delivered_at: null,
    return_refund_release_due_at: null,
    return_condition_disputed_at: null,
    remedy: createRemedyExecution(authorizedTerms),
    remedy_approval: null,
    case_presentation: "remedy-in-progress",
    closure_eligible: false,
    closure_blocking_reasons: [],
    next_remedy_action: null,
    remedy_repair_guidance: [],
    contested: false,
    ...overrides,
  };
}

function fact(effect: RemedyEffectKind, outcome: RemedyEffectFact["outcome"] = "satisfied"): RemedyEffectFact {
  return {
    effect,
    outcome,
    sourceFactType: `test.${effect}`,
    sourceFactId: `${effect}:${outcome}`,
    idempotencyKey: `${effect}:${outcome}`,
    occurredAt: "2026-07-14T13:00:00.000Z",
    reasonCode: outcome === "satisfied" ? "confirmed" : "provider-exception",
    refundId: effect === "refund-completion" ? "rfd_1" : null,
    amount: effect === "refund-completion" ? "125.00" : null,
    currencyCode: effect === "refund-completion" ? "usd" : null,
    allocation: null,
  };
}

function withFacts(...facts: readonly RemedyEffectFact[]) {
  return facts.reduce((remedy, entry) => applyRemedyEffectFact(remedy, entry), createRemedyExecution(authorizedTerms));
}

describe("deriveCustomerRemedyStatus", () => {
  it("covers the customer-visible approval, return, refund, reconciliation, and exception states", () => {
    const approval = createRemedyApprovalWorkflow({
      type: "ProposeSupportRemedy",
      terms: authorizedTerms,
      proposedByAccountId: "acc_operator",
      permissionUsed: "support.remedies.propose",
      rationale: "The available evidence does not establish responsibility.",
      evidenceReferences: ["evidence:1"],
      reservationExpiresAt: "2026-07-15T12:00:00.000Z",
      requiredApprovalCount: 1,
      requiresElevatedApproval: false,
      returnOverrideUsed: false,
      returnExceptionReasonCode: null,
    });

    expect(deriveCustomerRemedyStatus(request({ remedy: null, remedy_approval: approval }), "buyer")?.state).toBe(
      "awaiting-coverage-approval",
    );
    expect(
      deriveCustomerRemedyStatus(
        request({ remedy: withFacts(fact("coverage-reservation"), fact("return-label-available")) }),
        "buyer",
      )?.state,
    ).toBe("return-label-ready");
    expect(
      deriveCustomerRemedyStatus(
        request({ remedy: { ...withFacts(fact("coverage-reservation")), refundReleasedAt: "2026-07-14T14:00:00Z" } }),
        "buyer",
      )?.state,
    ).toBe("refund-submitted");
    expect(
      deriveCustomerRemedyStatus(
        request({
          remedy: {
            ...withFacts(fact("coverage-reservation"), fact("refund-completion")),
            refundReleasedAt: "2026-07-14T14:00:00Z",
          },
        }),
        "seller",
      )?.state,
    ).toBe("settlement-reconciliation-pending");
    expect(
      deriveCustomerRemedyStatus(
        request({
          remedy: withFacts(fact("coverage-reservation"), fact("return-label-available", "failed-retryable")),
        }),
        "buyer",
      )?.state,
    ).toBe("carrier-exception");
    expect(
      deriveCustomerRemedyStatus(
        request({ remedy: withFacts(fact("coverage-reservation"), fact("refund-completion", "failed-terminal")) }),
        "buyer",
      )?.state,
    ).toBe("refund-failure");

    const expiredApproval: typeof approval = {
      ...approval,
      status: "expired",
      reservationStatus: "expired",
    };
    expect(
      deriveCustomerRemedyStatus(request({ remedy: null, remedy_approval: expiredApproval }), "buyer")?.state,
    ).toBe("expired-deadline");

    const completedRemedy = {
      ...withFacts(
        fact("coverage-reservation"),
        fact("return-label-available"),
        fact("facility-intake"),
        fact("refund-completion"),
        fact("settlement-reconciliation"),
      ),
      status: "completed" as const,
      refundReleasedAt: "2026-07-14T14:00:00.000Z",
      refundId: "rfd_1",
      completedAt: "2026-07-14T15:00:00.000Z",
    };
    expect(deriveCustomerRemedyStatus(request({ remedy: completedRemedy }), "buyer")?.state).toBe("completed");
  });

  it("does not expose a remedy summary before a proposal exists", () => {
    expect(deriveCustomerRemedyStatus(request({ remedy: null, remedy_approval: null }), "buyer")).toBeNull();
  });
});

describe("CustomerRemedyStatus", () => {
  afterEach(cleanup);

  it("shows the buyer the approved remedy, coverage, return obligation, refund trigger, and next action", () => {
    render(<CustomerRemedyStatus request={request()} role="buyer" />);

    expect(screen.getByText("Full refund of $125.00 approved.")).toBeTruthy();
    expect(screen.getByText("Chase Sets is covering this resolution.")).toBeTruthy();
    expect(screen.getByText(/Return the item to Chase Sets/)).toBeTruthy();
    expect(screen.getByText(/after Chase Sets receives and checks the item/)).toBeTruthy();
    expect(screen.getByText("Wait for your return label and ship-by instructions.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "How platform-covered resolutions work" }).getAttribute("href")).toBe(
      "/help/buying/order-protection#platform-covered-resolutions",
    );
  });

  it("shows a fully platform-covered seller outcome as a zero allocation without implying fault", () => {
    render(<CustomerRemedyStatus request={request()} role="seller" />);

    expect(screen.getByText("Seller allocation: $0.00. Chase Sets is covering $125.00.")).toBeTruthy();
    expect(screen.getByText("Platform coverage does not by itself establish seller fault.")).toBeTruthy();
    expect(screen.queryByText(/reserve/i)).toBeNull();
    expect(screen.queryByText(/insurance/i)).toBeNull();
  });

  it("shows a completed fully platform-covered outcome as a zero seller charge", () => {
    const completed = {
      ...createRemedyExecution(authorizedTerms),
      status: "completed" as const,
      completedAt: "2026-07-14T15:00:00.000Z",
    };
    render(<CustomerRemedyStatus request={request({ remedy: completed })} role="seller" />);

    expect(screen.getByText("Seller charge: $0.00. Chase Sets covered $125.00.")).toBeTruthy();
    expect(screen.queryByText("Next action")).toBeNull();
  });

  it("formats split allocations in the remedy currency", () => {
    const splitTerms = {
      ...authorizedTerms,
      allocation: {
        sellerFundedAmount: "25.50",
        platformFundedAmount: "99.50",
        currencyCode: "usd",
        fundingKind: "split" as const,
      },
    };
    render(<CustomerRemedyStatus request={request({ remedy: createRemedyExecution(splitTerms) })} role="seller" />);

    expect(screen.getByText("Seller allocation: $25.50. Chase Sets is covering $99.50.")).toBeTruthy();
  });
});
