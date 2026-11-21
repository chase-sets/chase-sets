import type { RefundTrigger } from "@chase-sets/primitives/platform-coverage";
import {
  assertRemedyPolicyLimit,
  platformRemedyCapabilities,
  strongestRemedyPolicyAuthority,
  type PlatformRemedyPolicyValue,
  type RemedyPolicyAuthority,
} from "./platform-remedy-policy";
import type { RemedyApprovalWorkflow } from "./remedy-approval";
import { remedyEffectWaivable, type RemedyEffectKind, type RemedyExecution } from "./remedy";

/**
 * A remedy action the request's state takes now. `allowed` says whether this actor may take it:
 * the permission it needs plus the rules that depend on the actor, such as the policy's amount
 * limit for their authority or dual control's distinct approver. The idempotency key is the one
 * the command expects for this attempt.
 */
export type RemedyActionOffer = Readonly<{ idempotencyKey: string; allowed: boolean }>;

export type RemedyEffectOffer = Readonly<{
  effect: RemedyEffectKind;
  retry: RemedyActionOffer | null;
  waive: RemedyActionOffer | null;
  release: RemedyActionOffer | null;
}>;

/** What the remedy workflow offers an operator on one support request, under the active policy. */
export type SupportRemedyOffer = Readonly<{
  policyVersion: string;
  choices: Readonly<{
    refundTriggers: readonly RefundTrigger[];
    eligibleReasonCodes: readonly string[];
    returnExceptionReasonCodes: readonly string[];
    escalationReasonCodes: readonly string[];
    splitFundingAllowed: boolean;
  }>;
  currencyCode: string;
  propose: RemedyActionOffer | null;
  approve: RemedyActionOffer | null;
  correct: RemedyActionOffer | null;
  effects: readonly RemedyEffectOffer[];
}>;

export type SupportRemedyOfferRequest = Readonly<{
  support_request_id: string;
  status: string;
  resolution: Readonly<{ refundAmount?: string | null }> | null;
  affected_line_items?: unknown;
  remedy: RemedyExecution | null;
  remedy_approval: RemedyApprovalWorkflow | null;
}>;

function withinLimit(
  authority: RemedyPolicyAuthority,
  amount: string,
  eligibleAmount: string,
  policy: PlatformRemedyPolicyValue,
) {
  try {
    assertRemedyPolicyLimit({ authority, amount, eligibleAmount, policy });
    return true;
  } catch {
    return false;
  }
}

function remedyCurrency(request: SupportRemedyOfferRequest) {
  const affected = Array.isArray(request.affected_line_items) ? request.affected_line_items : [];
  const first = affected.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
  return String(first?.currencyCode ?? "usd").toLowerCase();
}

function approvalOffer(
  workflow: RemedyApprovalWorkflow,
  request: SupportRemedyOfferRequest,
  params: Readonly<{
    policy: PlatformRemedyPolicyValue;
    accountId: string;
    permissions: readonly string[];
    now: string;
  }>,
): RemedyActionOffer | null {
  if (workflow.status !== "approval-pending") return null;
  const elevated = params.permissions.includes(platformRemedyCapabilities.approveElevated);
  const permitted = elevated || params.permissions.includes(platformRemedyCapabilities.approve);
  const reservationHolds =
    workflow.reservationStatus !== "pending" &&
    workflow.reservationStatus !== "rejected" &&
    workflow.reservationStatus !== "expired" &&
    (!workflow.reservationExpiresAt || Date.parse(params.now) < Date.parse(workflow.reservationExpiresAt));
  const distinct =
    !workflow.approvals.some((approval) => approval.approvedByAccountId === params.accountId) &&
    !(workflow.requiredApprovalCount > 1 && workflow.proposedByAccountId === params.accountId);
  const amount = workflow.terms.remedy.amount;
  return {
    idempotencyKey: `${workflow.terms.remedyId}:approval`,
    allowed:
      permitted &&
      reservationHolds &&
      distinct &&
      withinLimit(
        elevated ? "approveElevated" : "approve",
        amount,
        request.resolution?.refundAmount ?? amount,
        params.policy,
      ),
  };
}

function effectOffers(remedy: RemedyExecution, permissions: readonly string[]): readonly RemedyEffectOffer[] {
  return remedy.effects.map((effect) => {
    const attempt = `${remedy.remedyId}:${effect.effect}:${effect.facts.at(-1)?.idempotencyKey ?? "pending"}`;
    return {
      effect: effect.effect,
      retry:
        effect.status === "failed-retryable"
          ? { idempotencyKey: `${attempt}:retry`, allowed: permissions.includes(platformRemedyCapabilities.retry) }
          : null,
      waive:
        effect.status === "failed-terminal" && remedyEffectWaivable(effect.effect)
          ? { idempotencyKey: `${attempt}:waive`, allowed: permissions.includes(platformRemedyCapabilities.waive) }
          : null,
      release:
        effect.effect === "operator-release" && effect.status === "pending"
          ? {
              idempotencyKey: `${remedy.remedyId}:operator-release`,
              allowed: permissions.includes(platformRemedyCapabilities.overrideReturn),
            }
          : null,
    };
  });
}

/**
 * The remedy choices the active policy allows and the actions the request takes now, with whether
 * this actor may take each. A command can still refuse what is offered when the request changes
 * in between or a value the operator enters breaks a policy rule.
 */
export function describeSupportRemedyOffer(
  params: Readonly<{
    request: SupportRemedyOfferRequest;
    policy: PlatformRemedyPolicyValue;
    policyVersion: string;
    actor: Readonly<{ accountId: string; permissions: readonly string[] }>;
    now: string;
  }>,
): SupportRemedyOffer {
  const { request, policy, actor } = params;
  const workflow = request.remedy_approval;
  const refundAmount = request.resolution?.refundAmount ?? null;
  const proposer = strongestRemedyPolicyAuthority(actor.permissions);
  return {
    policyVersion: params.policyVersion,
    choices: {
      refundTriggers: policy.allowableRefundTriggers,
      eligibleReasonCodes: policy.eligibleReasonCodes,
      returnExceptionReasonCodes: policy.returnExceptionReasonCodes,
      escalationReasonCodes: policy.escalationReasonCodes,
      splitFundingAllowed: policy.splitFundingAllowed,
    },
    currencyCode: remedyCurrency(request),
    propose:
      !workflow && request.status === "resolved" && refundAmount
        ? {
            idempotencyKey: `${request.support_request_id}:platform-remedy-proposal`,
            allowed:
              proposer !== null &&
              actor.permissions.includes(platformRemedyCapabilities.propose) &&
              withinLimit(proposer, refundAmount, refundAmount, policy),
          }
        : null,
    approve: workflow
      ? approvalOffer(workflow, request, {
          policy,
          accountId: actor.accountId,
          permissions: actor.permissions,
          now: params.now,
        })
      : null,
    correct: workflow
      ? {
          idempotencyKey: `${workflow.terms.remedyId}:correction`,
          allowed: actor.permissions.includes(platformRemedyCapabilities.correct),
        }
      : null,
    effects: request.remedy ? effectOffers(request.remedy, actor.permissions) : [],
  };
}
