import { t } from "@chase-sets/localization";
import { Badge, Card, LinkButton, MarketplaceNotice, Stack, Text } from "@chase-sets/design-system";
import type { OrderingOrderReviewOpportunity } from "./contracts";

function getCounterpartyRole(authorRole: string) {
  return authorRole === "buyer" ? "seller" : "buyer";
}

function orderStatusLabel(status: string) {
  const normalized = status.split("-").filter(Boolean).join(" ");
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function ReviewOutcome({
  opportunity,
  reviewReadStatus,
  reviewHref,
  transactionLabel,
  orderStatus,
}: {
  opportunity: OrderingOrderReviewOpportunity | null;
  reviewReadStatus: "ready" | "unavailable";
  reviewHref: string;
  transactionLabel: "purchase" | "sale";
  orderStatus: string;
}) {
  if (reviewReadStatus === "unavailable") {
    return (
      <MarketplaceNotice
        tone="warning"
        title={t("ordering.features.orders.ui.orderOutcome.review.unavailable")}
        description={t("ordering.features.orders.ui.orderOutcome.review.unavailable.description")}
      />
    );
  }

  if (!opportunity) {
    const awaiting = orderStatus !== "cancelled";
    return (
      <Stack gap={1}>
        <Badge tone="neutral">
          {t(
            awaiting
              ? "ordering.features.orders.ui.orderOutcome.review.awaiting"
              : "ordering.features.orders.ui.orderOutcome.review.ineligible",
          )}
        </Badge>
        <Text size="sm" tone="secondary">
          {t(
            awaiting
              ? "ordering.features.orders.ui.orderOutcome.review.awaiting.description"
              : "ordering.features.orders.ui.orderOutcome.review.ineligible.description",
          )}
        </Text>
      </Stack>
    );
  }

  if (opportunity.submission_state === "held") {
    return (
      <Stack gap={1}>
        <Badge tone="warning">{t("ordering.features.orders.ui.orderOutcome.review.held")}</Badge>
        <Text size="sm" tone="secondary">
          {t("ordering.features.orders.ui.orderOutcome.review.held.description")}
        </Text>
      </Stack>
    );
  }

  if (!opportunity.active_review_id && (opportunity.submission_state === "expired" || opportunity.window_expired)) {
    return (
      <Stack gap={1}>
        <Badge tone="neutral">{t("ordering.features.orders.ui.orderOutcome.review.expired")}</Badge>
        <Text size="sm" tone="secondary">
          {t("ordering.features.orders.ui.orderOutcome.review.expired.description")}
        </Text>
      </Stack>
    );
  }

  return (
    <OrderReviewOpportunityCallout
      opportunity={opportunity}
      reviewHref={reviewHref}
      transactionLabel={transactionLabel}
    />
  );
}

export function OrderOutcomePanel({
  orderStatus,
  opportunity,
  reviewReadStatus,
  reviewHref,
  supportHref,
  transactionLabel,
}: {
  orderStatus: string;
  opportunity: OrderingOrderReviewOpportunity | null;
  reviewReadStatus: "ready" | "unavailable";
  reviewHref: string;
  supportHref: string;
  transactionLabel: "purchase" | "sale";
}) {
  return (
    <Card elevation="tinted">
      <Stack gap={3}>
        <Text weight="semibold">{t("ordering.features.orders.ui.orderOutcome.title")}</Text>
        <Stack gap={1}>
          <Text size="sm" tone="secondary">
            {t("ordering.features.orders.ui.orderOutcome.order.status")}
          </Text>
          <Badge tone={orderStatus === "cancelled" ? "neutral" : "success"}>{orderStatusLabel(orderStatus)}</Badge>
        </Stack>
        <Stack gap={1}>
          <Text size="sm" tone="secondary">
            {t("ordering.features.orders.ui.orderOutcome.issue.status")}
          </Text>
          <LinkButton href={supportHref} tone="secondary">
            {t("ordering.features.orders.ui.orderOutcome.track.issue")}
          </LinkButton>
        </Stack>
        <Stack gap={1}>
          <Text size="sm" tone="secondary">
            {t("ordering.features.orders.ui.orderOutcome.review.status")}
          </Text>
          <ReviewOutcome
            opportunity={opportunity}
            reviewReadStatus={reviewReadStatus}
            reviewHref={reviewHref}
            transactionLabel={transactionLabel}
            orderStatus={orderStatus}
          />
        </Stack>
      </Stack>
    </Card>
  );
}

export function OrderReviewOpportunityCallout({
  opportunity,
  reviewHref,
  transactionLabel,
}: {
  opportunity: OrderingOrderReviewOpportunity;
  reviewHref: string;
  transactionLabel: "purchase" | "sale";
}) {
  const counterpartyRole = getCounterpartyRole(opportunity.author_role);
  const href = opportunity.active_review_id ? `/account/reviews/${opportunity.active_review_id}` : reviewHref;
  const published = opportunity.revealed && Boolean(opportunity.active_review_revealed_at);

  return (
    <Card elevation="tinted">
      <Stack gap={2}>
        <Text weight="semibold">
          {opportunity.active_review_id
            ? t("ordering.features.orders.ui.orderReviewOpportunityCallout.your.account.review.is.already.active")
            : t("ordering.features.orders.ui.orderReviewOpportunityCallout.ready.for.counterparty.review", {
                transactionLabel,
                counterpartyRole,
              })}
        </Text>
        {opportunity.active_review_id ? (
          <Badge tone={published ? "success" : "neutral"}>
            {t(
              published
                ? "ordering.features.orders.ui.orderReviewOpportunityCallout.revealed"
                : "ordering.features.orders.ui.orderReviewOpportunityCallout.awaiting.reveal",
            )}
          </Badge>
        ) : null}
        {opportunity.active_review_id || opportunity.submission_state === "allowed" ? (
          <LinkButton href={href}>
            {opportunity.active_review_id
              ? t("ordering.features.orders.ui.orderReviewOpportunityCallout.open.your.review")
              : t("ordering.features.orders.ui.orderReviewOpportunityCallout.leave.account.review")}
          </LinkButton>
        ) : null}
      </Stack>
    </Card>
  );
}
