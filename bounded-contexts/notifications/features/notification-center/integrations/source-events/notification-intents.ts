import type {
  AccountId,
} from "@chase-sets/primitives/typed-ids";
import type {
  EmailNotificationChannel,
  NotificationMessage,
  WebNotificationChannel,
} from "@chase-sets/notifications";

export type OrderCreatedNotificationInput = Readonly<{
  buyerAccountId: AccountId;
  buyerEmail?: string | null;
  orderId: string;
  orderTotal: string;
  correlationId: string;
}>;

export type ShipmentDeliveredNotificationInput = Readonly<{
  buyerAccountId: AccountId;
  buyerEmail?: string | null;
  shipmentId: string;
  orderId: string;
  trackingNumber: string;
  correlationId: string;
}>;

export function mapOrderCreatedToNotification(
  input: OrderCreatedNotificationInput,
): NotificationMessage {
  const title = `Order ${input.orderId} confirmed`;
  const body = `Your order total is ${input.orderTotal}.`;
  const actionHref = `/account/purchases/${input.orderId}`;
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
    messageType: "ordering.order.created",
    criticality: "commerce",
    title,
    body,
    actionHref,
    templateId: "order_confirmed",
    templateVersion: 1,
    locale: "en",
    templateData: { orderId: input.orderId, orderTotal: input.orderTotal },
    channels,
    idempotencyKey: `notifications:ordering:order_created:${input.orderId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.buyerAccountId },
  };
}

export function mapShipmentDeliveredToNotification(
  input: ShipmentDeliveredNotificationInput,
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
    idempotencyKey: `notifications:fulfillment:shipment_delivered:${input.orderId}:${input.trackingNumber}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.buyerAccountId },
  };
}
