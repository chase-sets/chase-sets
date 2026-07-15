import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import { centsToMoneyAmount, moneyToCents } from "@chase-sets/primitives/money";
import type { SupportRequestId } from "@chase-sets/primitives/typed-ids";
import { formatDateTime, formatMoney, t } from "@chase-sets/localization";
import {
  Badge,
  Inline,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
  Stack,
  Timeline,
  type TimelineItem,
} from "@chase-sets/design-system";
import type { PurchaseDetail, SaleDetail } from "./contracts";

function supportHref(baseHref: string | null | undefined, supportRequestId: string) {
  const base = baseHref ?? "/account/support";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}requestId=${encodeURIComponent(supportRequestId)}`;
}

function supportCaseLink(baseHref: string | null | undefined, supportRequestId: string) {
  const reference = deriveDisplayReferenceOrRaw(supportRequestId as SupportRequestId);
  return (
    <LinkButton key={supportRequestId} href={supportHref(baseHref, supportRequestId)} size="sm" tone="secondary">
      {reference}
    </LinkButton>
  );
}

function retainedAmount(totalAmount: string, refundedAmount: string): string {
  const retainedCents = moneyToCents(totalAmount) - moneyToCents(refundedAmount);
  return centsToMoneyAmount(retainedCents > 0n ? retainedCents : 0n);
}

function buyerTimelineItems(order: PurchaseDetail): TimelineItem[] {
  const items: TimelineItem[] = [];
  const paidAt = order.ready_for_fulfillment_at;
  if (paidAt) {
    items.push({
      title: t("ordering.features.orders.ui.moneyTimeline.paid"),
      timestamp: formatDateTime(paidAt),
    });
  }

  for (const refund of order.money_timeline.refunds) {
    items.push({
      title: t("ordering.features.orders.ui.moneyTimeline.refund.requested"),
      description: refund.amount ? formatMoney(refund.amount, refund.currency_code) : undefined,
      timestamp: formatDateTime(refund.requested_at),
    });
    if (refund.status === "issued" && refund.issued_at) {
      items.push({
        title: t("ordering.features.orders.ui.moneyTimeline.refund.issued"),
        description: t("ordering.features.orders.ui.moneyTimeline.refund.issued.eta"),
        timestamp: formatDateTime(refund.issued_at),
      });
    }
    if (refund.status === "failed" && refund.failed_at) {
      items.push({
        title: t("ordering.features.orders.ui.moneyTimeline.refund.failed"),
        description: t("ordering.features.orders.ui.moneyTimeline.refund.failed.support"),
        timestamp: formatDateTime(refund.failed_at),
      });
    }
  }

  return items;
}

export function OrderMoneyTimeline({
  role,
  order,
  supportBaseHref,
}: Readonly<{
  role: "buyer" | "seller";
  order: PurchaseDetail | SaleDetail;
  supportBaseHref?: string | null;
}>) {
  const money = order.money_timeline;
  const activeCases = money.support_cases.filter((supportCase) => supportCase.active_hold);
  const terminalCases = money.support_cases.filter(
    (supportCase) => supportCase.status === "resolved" || supportCase.status === "closed",
  );
  const hasRefund = moneyToCents(money.refunded_amount) > 0n;

  if (role === "buyer") {
    if (money.refunds.length === 0 && terminalCases.length === 0) {
      return null;
    }
    const items = buyerTimelineItems(order as PurchaseDetail);

    return (
      <Stack gap={3}>
        <Timeline items={items} aria-label={t("ordering.features.orders.ui.moneyTimeline.title")} />
        {terminalCases.length > 0 ? (
          <Inline gap={2}>
            <Badge tone="success">{t("ordering.features.orders.ui.moneyTimeline.case.resolved")}</Badge>
            {terminalCases.map((supportCase) => supportCaseLink(supportBaseHref, supportCase.support_request_id))}
          </Inline>
        ) : null}
      </Stack>
    );
  }

  if (activeCases.length === 0 && !hasRefund) {
    return null;
  }
  const retained = retainedAmount(order.total_amount, money.refunded_amount);

  return (
    <Stack gap={3}>
      {activeCases.length > 0 ? (
        <Stack gap={2}>
          <MarketplaceNotice
            tone="warning"
            title={t("ordering.features.orders.ui.moneyTimeline.hold.title")}
            description={t("ordering.features.orders.ui.moneyTimeline.hold.description", {
              amount: formatMoney(order.seller_payout_amount, money.currency_code),
            })}
          />
          <Inline gap={2}>
            <Badge tone="warning">{t("ordering.features.orders.ui.moneyTimeline.hold.active")}</Badge>
            {activeCases.map((supportCase) => supportCaseLink(supportBaseHref, supportCase.support_request_id))}
          </Inline>
        </Stack>
      ) : null}
      {hasRefund ? (
        <MarketplaceDashboardPanel
          title={t("ordering.features.orders.ui.moneyTimeline.refund.outcome")}
          metrics={[
            {
              label: t("ordering.features.orders.ui.moneyTimeline.refunded"),
              value: formatMoney(money.refunded_amount, money.currency_code),
            },
            {
              label: t("ordering.features.orders.ui.moneyTimeline.retained"),
              value: formatMoney(retained, money.currency_code),
            },
          ]}
        />
      ) : null}
    </Stack>
  );
}
