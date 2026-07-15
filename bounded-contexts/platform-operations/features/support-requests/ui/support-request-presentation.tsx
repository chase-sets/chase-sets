import { Badge, Inline, LinkButton, Stack, Text } from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import type { SupportRequestListItem } from "./contracts";

export function formatSupportDateTime(value: string | null) {
  return value
    ? formatDateTime(value, { preset: "short" })
    : t("support.features.supportRequests.ui.supportOperationsPage.not.applicable");
}

export function nextSupportDeadline(request: SupportRequestListItem) {
  const deadlines = [
    request.seller_response_due_at,
    request.support_review_due_at,
    request.seller_condition_attestation_due_at,
  ].filter((value): value is string => Boolean(value));
  return deadlines.sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0] ?? null;
}

export function supportChecklistSummary(request: SupportRequestListItem) {
  const required = request.checklist.filter((item) => item.required);
  const satisfied = required.filter((item) => item.satisfiedAt !== null);
  return t("support.features.supportRequests.ui.supportOperationsPage.checklist.summary", {
    satisfied: satisfied.length,
    required: required.length,
  });
}

function countdownParts(dueAt: string, now: string) {
  const deltaMs = new Date(dueAt).getTime() - new Date(now).getTime();
  const overdue = deltaMs < 0;
  const absoluteMinutes = Math.max(1, Math.ceil(Math.abs(deltaMs) / 60_000));

  if (absoluteMinutes < 60) {
    return { overdue, value: absoluteMinutes, unit: absoluteMinutes === 1 ? "minute" : "minutes" };
  }

  const absoluteHours = Math.ceil(absoluteMinutes / 60);
  if (absoluteHours < 48) {
    return { overdue, value: absoluteHours, unit: absoluteHours === 1 ? "hour" : "hours" };
  }

  const absoluteDays = Math.ceil(absoluteHours / 24);
  return { overdue, value: absoluteDays, unit: absoluteDays === 1 ? "day" : "days" };
}

export function SupportDeadlineCountdown({ dueAt, now }: Readonly<{ dueAt: string | null; now: string }>) {
  if (!dueAt) {
    return (
      <Text size="sm" tone="secondary">
        {t("support.features.supportRequests.ui.supportOperationsPage.deadline.none")}
      </Text>
    );
  }

  const countdown = countdownParts(dueAt, now);
  const key = countdown.overdue
    ? "support.features.supportRequests.ui.supportOperationsPage.deadline.overdue"
    : "support.features.supportRequests.ui.supportOperationsPage.deadline.due";

  return (
    <Stack gap={1}>
      <Badge tone={countdown.overdue ? "danger" : "warning"}>
        {t(key, { value: countdown.value, unit: countdown.unit })}
      </Badge>
      <Text element="span" size="xs" tone="secondary">
        {formatSupportDateTime(dueAt)}
      </Text>
    </Stack>
  );
}

function orderMarketplacePathnames(orderId: string) {
  return {
    purchase: `/account/purchases/${orderId}`,
    sale: `/account/sales/${orderId}`,
  };
}

function resolveOrderMarketplaceHref(pathname: string, marketplaceOrigin: string | null | undefined) {
  if (!marketplaceOrigin) {
    return null;
  }

  return new URL(pathname, `${marketplaceOrigin.replace(/\/+$/, "")}/`).toString();
}

export function SupportOrderMarketplaceLinks({
  orderId,
  marketplaceOrigin,
}: Readonly<{ orderId: string; marketplaceOrigin?: string | null }>) {
  const pathnames = orderMarketplacePathnames(orderId);
  const purchaseHref = resolveOrderMarketplaceHref(pathnames.purchase, marketplaceOrigin);
  const saleHref = resolveOrderMarketplaceHref(pathnames.sale, marketplaceOrigin);

  return (
    <Stack gap={1}>
      <Text element="span" size="sm" wrap="anywhere">
        {orderId}
      </Text>
      {purchaseHref && saleHref ? (
        <Inline gap={1}>
          <LinkButton
            href={purchaseHref}
            size="sm"
            tone="secondary"
            target="_blank"
            rel="noreferrer"
            trailingIcon="externalLink"
          >
            {t("support.features.supportRequests.ui.supportOperationsPage.order.viewPurchase")}
          </LinkButton>
          <LinkButton
            href={saleHref}
            size="sm"
            tone="secondary"
            target="_blank"
            rel="noreferrer"
            trailingIcon="externalLink"
          >
            {t("support.features.supportRequests.ui.supportOperationsPage.order.viewSale")}
          </LinkButton>
        </Inline>
      ) : (
        <Badge tone="warning">
          {t("support.features.supportRequests.ui.supportOperationsPage.order.marketplaceLinkUnavailable")}
        </Badge>
      )}
    </Stack>
  );
}
