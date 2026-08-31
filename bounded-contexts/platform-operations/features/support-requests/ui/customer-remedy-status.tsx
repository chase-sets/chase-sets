import { Badge, LinkText, Stack, Surface, Text } from "@chase-sets/design-system";
import { formatMoney, t } from "@chase-sets/localization";
import type { RemedyEffect, RemedyExecution } from "../domain/remedy";
import type { RemedyApprovalWorkflow } from "../domain/remedy-approval";
import type { SupportRequestListItem } from "./contracts";

export type CustomerRemedyRole = "buyer" | "seller";

export type CustomerRemedyState =
  | "proposed-under-review"
  | "awaiting-coverage-approval"
  | "return-label-ready"
  | "in-transit"
  | "awaiting-intake"
  | "refund-submitted"
  | "refund-confirmed"
  | "settlement-reconciliation-pending"
  | "completed"
  | "expired-deadline"
  | "carrier-exception"
  | "refund-failure"
  | "manual-review"
  | "resolution-in-progress";

type CustomerRemedyStatusView = Readonly<{
  state: CustomerRemedyState;
  title: string;
  tone: "neutral" | "warning" | "danger" | "success";
  outcome: string;
  coverageExplanation: string | null;
  faultExplanation: string | null;
  returnInstructions: string;
  refundTiming: string;
  nextAction: string | null;
  terminal: boolean;
}>;

function effect(remedy: RemedyExecution, effectName: RemedyEffect["effect"]) {
  return remedy.effects.find((candidate) => candidate.effect === effectName);
}

function effectSucceeded(remedy: RemedyExecution, effectName: RemedyEffect["effect"]) {
  const current = effect(remedy, effectName);
  return current?.status === "satisfied" || current?.status === "waived";
}

function failedEffect(remedy: RemedyExecution) {
  return remedy.effects.find(
    (candidate) => candidate.status === "failed-retryable" || candidate.status === "failed-terminal",
  );
}

function approvalState(workflow: RemedyApprovalWorkflow): CustomerRemedyState {
  if (workflow.status === "reservation-pending") return "awaiting-coverage-approval";
  if (workflow.status === "expired") return "expired-deadline";
  if (workflow.status === "reservation-rejected" || workflow.status === "correction-requested") {
    return "manual-review";
  }
  return "proposed-under-review";
}

function executionState(remedy: RemedyExecution, role: CustomerRemedyRole): CustomerRemedyState {
  if (remedy.status === "completed") return "completed";

  const failed = failedEffect(remedy);
  if (failed?.effect === "refund-completion") return "refund-failure";
  if (
    failed &&
    ["return-label-available", "carrier-accepted", "return-delivered", "facility-intake"].includes(failed.effect)
  ) {
    return "carrier-exception";
  }
  if (failed) return "manual-review";

  if (effectSucceeded(remedy, "refund-completion")) {
    return role === "buyer" ? "refund-confirmed" : "settlement-reconciliation-pending";
  }
  if (remedy.refundReleasedAt) return "refund-submitted";
  if (effectSucceeded(remedy, "return-delivered") && effect(remedy, "facility-intake")?.status === "pending") {
    return "awaiting-intake";
  }
  if (effectSucceeded(remedy, "carrier-accepted") && effect(remedy, "return-delivered")?.status === "pending") {
    return "in-transit";
  }
  if (effectSucceeded(remedy, "return-label-available")) {
    return "return-label-ready";
  }
  return "resolution-in-progress";
}

function statePresentation(state: CustomerRemedyState): Pick<CustomerRemedyStatusView, "title" | "tone" | "terminal"> {
  switch (state) {
    case "proposed-under-review":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.proposed"),
        tone: "neutral",
        terminal: false,
      };
    case "awaiting-coverage-approval":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.awaitingCoverage"),
        tone: "warning",
        terminal: false,
      };
    case "return-label-ready":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.labelReady"),
        tone: "warning",
        terminal: false,
      };
    case "in-transit":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.inTransit"),
        tone: "neutral",
        terminal: false,
      };
    case "awaiting-intake":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.awaitingIntake"),
        tone: "neutral",
        terminal: false,
      };
    case "refund-submitted":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.refundSubmitted"),
        tone: "neutral",
        terminal: false,
      };
    case "refund-confirmed":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.refundConfirmed"),
        tone: "success",
        terminal: false,
      };
    case "settlement-reconciliation-pending":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.reconciliationPending"),
        tone: "neutral",
        terminal: false,
      };
    case "completed":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.completed"),
        tone: "success",
        terminal: true,
      };
    case "expired-deadline":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.expired"),
        tone: "danger",
        terminal: false,
      };
    case "carrier-exception":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.carrierException"),
        tone: "danger",
        terminal: false,
      };
    case "refund-failure":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.refundFailure"),
        tone: "danger",
        terminal: false,
      };
    case "manual-review":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.manualReview"),
        tone: "warning",
        terminal: false,
      };
    case "resolution-in-progress":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.inProgress"),
        tone: "neutral",
        terminal: false,
      };
  }
}

function outcomeCopy(
  workflow: RemedyApprovalWorkflow | null,
  remedy: RemedyExecution | null,
  role: CustomerRemedyRole,
) {
  const terms = remedy ?? workflow?.terms ?? null;
  if (!terms) return "";

  const remedyAmount = formatMoney(terms.remedy.amount, terms.remedy.currencyCode);
  const sellerAmount = formatMoney(terms.allocation.sellerFundedAmount, terms.allocation.currencyCode);
  const platformAmount = formatMoney(terms.allocation.platformFundedAmount, terms.allocation.currencyCode);

  if (!remedy) {
    return t("support.features.supportRequests.ui.customerRemedyStatus.outcome.underReview", {
      amount: remedyAmount,
    });
  }
  if (role === "buyer") {
    const approved =
      terms.remedy.kind === "full-refund"
        ? t("support.features.supportRequests.ui.customerRemedyStatus.outcome.fullRefund", {
            amount: remedyAmount,
          })
        : t("support.features.supportRequests.ui.customerRemedyStatus.outcome.partialRefund", {
            amount: remedyAmount,
          });
    return approved;
  }

  if (terms.allocation.fundingKind === "seller-funded") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.sellerAllocation.sellerFunded", {
      sellerAmount,
    });
  }
  if (remedy.status === "completed") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.sellerAllocation.completedCovered", {
      sellerAmount,
      platformAmount,
    });
  }
  return t("support.features.supportRequests.ui.customerRemedyStatus.sellerAllocation.covered", {
    sellerAmount,
    platformAmount,
  });
}

function coverageCopy(
  workflow: RemedyApprovalWorkflow | null,
  remedy: RemedyExecution | null,
  role: CustomerRemedyRole,
) {
  if (role !== "buyer" || !remedy) return null;
  const terms = remedy ?? workflow?.terms;
  if (terms.allocation.fundingKind === "platform-funded") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.coverage.full");
  }
  if (terms.allocation.fundingKind === "split") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.coverage.partial", {
      amount: formatMoney(terms.allocation.platformFundedAmount, terms.allocation.currencyCode),
    });
  }
  return null;
}

function returnCopy(workflow: RemedyApprovalWorkflow | null, remedy: RemedyExecution | null, role: CustomerRemedyRole) {
  const directive = (remedy ?? workflow?.terms)?.returnDirective;
  if (directive === "return-to-platform") {
    return role === "buyer"
      ? t("support.features.supportRequests.ui.customerRemedyStatus.return.buyer.platform")
      : t("support.features.supportRequests.ui.customerRemedyStatus.return.seller.platform");
  }
  if (directive === "return-to-seller") {
    return role === "buyer"
      ? t("support.features.supportRequests.ui.customerRemedyStatus.return.buyer.seller")
      : t("support.features.supportRequests.ui.customerRemedyStatus.return.seller.seller");
  }
  return t("support.features.supportRequests.ui.customerRemedyStatus.return.none");
}

function refundTimingCopy(workflow: RemedyApprovalWorkflow | null, remedy: RemedyExecution | null) {
  switch ((remedy ?? workflow?.terms)?.refundTrigger) {
    case "carrier-accepted":
      return t("support.features.supportRequests.ui.customerRemedyStatus.refundTiming.carrierAccepted");
    case "delivered":
      return t("support.features.supportRequests.ui.customerRemedyStatus.refundTiming.delivered");
    case "facility-intake":
      return t("support.features.supportRequests.ui.customerRemedyStatus.refundTiming.intake");
    case "operator-release":
      return t("support.features.supportRequests.ui.customerRemedyStatus.refundTiming.review");
    default:
      return t("support.features.supportRequests.ui.customerRemedyStatus.refundTiming.immediate");
  }
}

function nextActionCopy(state: CustomerRemedyState, role: CustomerRemedyRole) {
  if (state === "completed") return null;
  if (state === "return-label-ready" && role === "buyer") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.nextAction.ship");
  }
  if (state === "resolution-in-progress" && role === "buyer") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.nextAction.waitForLabel");
  }
  if (state === "expired-deadline" || state === "carrier-exception" || state === "manual-review") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.nextAction.followSupport");
  }
  if (state === "refund-failure") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.nextAction.refundFailure");
  }
  return t("support.features.supportRequests.ui.customerRemedyStatus.nextAction.none");
}

export function deriveCustomerRemedyStatus(
  request: SupportRequestListItem,
  role: CustomerRemedyRole,
): CustomerRemedyStatusView | null {
  if (!request.remedy && !request.remedy_approval) return null;

  const state = request.remedy ? executionState(request.remedy, role) : approvalState(request.remedy_approval!);
  const presentation = statePresentation(state);
  const terms = request.remedy ?? request.remedy_approval?.terms;
  const hasPlatformCoverage = terms?.allocation.fundingKind !== "seller-funded";

  return {
    state,
    ...presentation,
    outcome: outcomeCopy(request.remedy_approval, request.remedy, role),
    coverageExplanation: coverageCopy(request.remedy_approval, request.remedy, role),
    faultExplanation:
      role === "seller" && hasPlatformCoverage
        ? t("support.features.supportRequests.ui.customerRemedyStatus.coverage.noFaultFinding")
        : null,
    returnInstructions: returnCopy(request.remedy_approval, request.remedy, role),
    refundTiming: refundTimingCopy(request.remedy_approval, request.remedy),
    nextAction: nextActionCopy(state, role),
  };
}

export function CustomerRemedyStatus({
  request,
  role,
}: Readonly<{ request: SupportRequestListItem; role: CustomerRemedyRole }>) {
  const view = deriveCustomerRemedyStatus(request, role);
  if (!view) return null;

  return (
    <Stack gap={2}>
      <Badge tone={view.tone}>{view.title}</Badge>
      <Text size="sm" weight="semibold">
        {view.outcome}
      </Text>
      {view.coverageExplanation ? <Text size="sm">{view.coverageExplanation}</Text> : null}
      {view.faultExplanation ? (
        <Text size="sm" tone="secondary">
          {view.faultExplanation}
        </Text>
      ) : null}
      <Text size="sm" tone="secondary">
        {view.returnInstructions}
      </Text>
      <Text size="sm" tone="secondary">
        {view.refundTiming}
      </Text>
      {!view.terminal && view.nextAction ? (
        <Surface tone="muted" elevation="tinted" data-elevation-role="furniture">
          <Stack gap={1}>
            <Text size="xs" tone="secondary" weight="semibold">
              {t("support.features.supportRequests.ui.customerRemedyStatus.nextAction.label")}
            </Text>
            <Text size="sm" weight="semibold">
              {view.nextAction}
            </Text>
          </Stack>
        </Surface>
      ) : null}
      <LinkText href="/help/buying/order-protection#platform-covered-resolutions">
        {t("support.features.supportRequests.ui.customerRemedyStatus.policyLink")}
      </LinkText>
    </Stack>
  );
}
