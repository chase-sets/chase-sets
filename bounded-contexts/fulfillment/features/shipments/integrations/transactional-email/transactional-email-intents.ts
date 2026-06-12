import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/notifications";

export type ShipmentDeliveredEmailIntentInput = Readonly<{
  buyerEmail: string;
  orderId: string;
  trackingNumber: string;
  correlationId: string;
}>;

export function mapShipmentDeliveredToTransactionalEmail(
  input: ShipmentDeliveredEmailIntentInput,
): NotificationMessage {
  return createTransactionalEmailNotificationMessage({
    messageType: "fulfillment.shipment.delivered",
    criticality: "operational",
    to: [{ email: input.buyerEmail }],
    subject: `Shipment delivered for order ${input.orderId}`,
    templateId: "shipment_delivered",
    templateVersion: 1,
    locale: "en",
    templateData: { orderId: input.orderId, trackingNumber: input.trackingNumber },
    idempotencyKey: `fulfillment:shipment_delivered:${input.orderId}:${input.trackingNumber}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}
