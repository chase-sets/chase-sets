import type { NotificationMessage, WebNotificationChannel } from "@chase-sets/outbound-messaging";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export type ProductAlertNotificationInput = Readonly<{
  accountId: string;
  alertId: string;
  marketSide: "listing" | "offer";
  activityId: string;
  catalogItemId: string;
  itemTitle: string | null;
  productSummary: string | null;
  priceAmount: string;
  correlationId: string;
}>;

export function mapProductAlertMatchToNotification(input: ProductAlertNotificationInput): NotificationMessage {
  const itemTitle = input.itemTitle?.trim() || "A watched product";
  const actionHref =
    input.marketSide === "offer"
      ? `/items/${encodeURIComponent(input.catalogItemId)}?market=sell`
      : `/items/${encodeURIComponent(input.catalogItemId)}`;
  const title = input.marketSide === "offer" ? `Product Alert: demand for ${itemTitle}` : `Product Alert: ${itemTitle}`;
  const body =
    input.marketSide === "offer"
      ? `${input.productSummary ?? "The selected product"} has matching demand at $${input.priceAmount}.`
      : `${input.productSummary ?? "The selected product"} is available at $${input.priceAmount}.`;
  const webChannel: WebNotificationChannel = {
    channel: "web",
    recipient: { accountId: input.accountId as AccountId },
    title,
    body,
    actionHref,
  };

  return {
    messageType: `discovery.product-alert.${input.marketSide}`,
    criticality: "commerce",
    category: "product-alerts",
    recipientAccountId: input.accountId as AccountId,
    title,
    body,
    actionHref,
    templateId: `product_alert_${input.marketSide}`,
    templateVersion: 1,
    locale: "en",
    templateData: {
      alertId: input.alertId,
      activityId: input.activityId,
      itemTitle,
      productSummary: input.productSummary,
      priceAmount: input.priceAmount,
    },
    channels: [webChannel],
    idempotencyKey: `discovery:product-alert:${input.alertId}:${input.activityId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.accountId as AccountId },
  };
}
