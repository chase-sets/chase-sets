import { Badge, LinkText, Stack, Surface, Text } from "@chase-sets/design-system";
import { formatMoney, t } from "@chase-sets/localization";
import type { CustomerRemedyState, CustomerRemedyStatusProjection } from "../domain/domain";
import type { CustomerSupportRequestListItem } from "./contracts";
export type { CustomerRemedyRole } from "../domain/domain";

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

function statePresentation(state: CustomerRemedyState): Pick<CustomerRemedyStatusView, "title" | "tone"> {
  switch (state) {
    case "proposed-under-review":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.proposed"),
        tone: "neutral",
      };
    case "awaiting-coverage-approval":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.awaitingCoverage"),
        tone: "warning",
      };
    case "return-label-ready":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.labelReady"),
        tone: "warning",
      };
    case "in-transit":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.inTransit"),
        tone: "neutral",
      };
    case "awaiting-intake":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.awaitingIntake"),
        tone: "neutral",
      };
    case "refund-submitted":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.refundSubmitted"),
        tone: "neutral",
      };
    case "refund-confirmed":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.refundConfirmed"),
        tone: "success",
      };
    case "settlement-reconciliation-pending":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.reconciliationPending"),
        tone: "neutral",
      };
    case "completed":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.completed"),
        tone: "success",
      };
    case "expired-deadline":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.expired"),
        tone: "danger",
      };
    case "carrier-exception":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.carrierException"),
        tone: "danger",
      };
    case "refund-failure":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.refundFailure"),
        tone: "danger",
      };
    case "manual-review":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.manualReview"),
        tone: "warning",
      };
    case "resolution-in-progress":
      return {
        title: t("support.features.supportRequests.ui.customerRemedyStatus.state.inProgress"),
        tone: "neutral",
      };
  }
}

function outcomeCopy(status: CustomerRemedyStatusProjection) {
  const remedyAmount = formatMoney(status.amount, status.currencyCode);
  const sellerAmount = formatMoney(status.sellerAmount, status.allocationCurrencyCode);
  const platformAmount = formatMoney(status.platformAmount, status.allocationCurrencyCode);

  if (status.outcome === "underReview") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.outcome.underReview", {
      amount: remedyAmount,
    });
  }
  if (status.outcome === "fullRefund" || status.outcome === "partialRefund") {
    const approved =
      status.outcome === "fullRefund"
        ? t("support.features.supportRequests.ui.customerRemedyStatus.outcome.fullRefund", {
            amount: remedyAmount,
          })
        : t("support.features.supportRequests.ui.customerRemedyStatus.outcome.partialRefund", {
            amount: remedyAmount,
          });
    return approved;
  }

  if (status.outcome === "sellerFunded") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.sellerAllocation.sellerFunded", {
      sellerAmount,
    });
  }
  if (status.outcome === "completedCovered") {
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

function coverageCopy(status: CustomerRemedyStatusProjection) {
  if (status.coverage === "full") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.coverage.full");
  }
  if (status.coverage === "partial") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.coverage.partial", {
      amount: formatMoney(status.platformAmount, status.allocationCurrencyCode),
    });
  }
  return null;
}

function returnCopy({ returnDirective: directive, role }: CustomerRemedyStatusProjection) {
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

function refundTimingCopy(status: CustomerRemedyStatusProjection) {
  switch (status.refundTrigger) {
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

function nextActionCopy(action: CustomerRemedyStatusProjection["nextAction"]) {
  if (action === null) return null;
  if (action === "ship") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.nextAction.ship");
  }
  if (action === "waitForLabel") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.nextAction.waitForLabel");
  }
  if (action === "followSupport") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.nextAction.followSupport");
  }
  if (action === "refundFailure") {
    return t("support.features.supportRequests.ui.customerRemedyStatus.nextAction.refundFailure");
  }
  return t("support.features.supportRequests.ui.customerRemedyStatus.nextAction.none");
}

export function CustomerRemedyStatus({ request }: Readonly<{ request: CustomerSupportRequestListItem }>) {
  const status = request.customerRemedyStatus;
  if (!status) return null;
  const view: CustomerRemedyStatusView = {
    state: status.state,
    ...statePresentation(status.state),
    terminal: status.terminal,
    outcome: outcomeCopy(status),
    coverageExplanation: coverageCopy(status),
    faultExplanation: status.noFaultFinding
      ? t("support.features.supportRequests.ui.customerRemedyStatus.coverage.noFaultFinding")
      : null,
    returnInstructions: returnCopy(status),
    refundTiming: refundTimingCopy(status),
    nextAction: nextActionCopy(status.nextAction),
  };

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
