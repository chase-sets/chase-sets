import type {
  EmailNotificationChannel,
  NotificationMessage,
  WebNotificationChannel,
} from "@chase-sets/notifications";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export type ShipmentDeliveredNotificationIntentInput = Readonly<{
  buyerAccountId: AccountId;
  buyerEmail?: string | null;
  shipmentId: string;
  orderId: string;
  trackingNumber: string;
  correlationId: string;
}>;

export function mapShipmentDeliveredToNotification(
  input: ShipmentDeliveredNotificationIntentInput,
): NotificationMessage {
  const title = `Shipment delivered for order ${input.orderId}`;
  const body = `Tracking ${input.trackingNumber} is marked delivered.`;
  const actionHref = `/account/shipments/${input.shipmentId}`;
  const webChannel: WebNotificationChannel = {
    channel: "web",
    recipient: { accountId: input.buyerAccountId },
    actionHref,
  };
  const buyerEmail = input.buyerEmail?.trim();
  const channels: NotificationMessage["channels"] = buyerEmail
    ? [
        {
          channel: "email",
          to: [{ email: buyerEmail }],
        } satisfies EmailNotificationChannel,
        webChannel,
      ]
    : [webChannel];

  return {
    messageType: "fulfillment.shipment.delivered",
    criticality: "operational",
    title,
    body,
    actionHref,
    templateId: "shipment_delivered",
    templateVersion: 1,
    locale: "en",
    templateData: {
      orderId: input.orderId,
      trackingNumber: input.trackingNumber,
      shipmentId: input.shipmentId,
    },
    channels,
    idempotencyKey: `fulfillment:shipment_delivered:${input.orderId}:${input.trackingNumber}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.buyerAccountId },
  };
}
