import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/outbound-messaging";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { OrderId } from "@chase-sets/primitives/typed-ids";

export type ShipmentDeliveredEmailIntentInput = Readonly<{
  buyerEmail: string;
  orderId: string;
  trackingNumber: string;
  correlationId: string;
}>;

export function mapShipmentDeliveredToTransactionalEmail(
  input: ShipmentDeliveredEmailIntentInput,
): NotificationMessage {
  const orderReference = deriveDisplayReferenceOrRaw(input.orderId as OrderId);

  return createTransactionalEmailNotificationMessage({
    messageType: "fulfillment.shipment.delivered",
    criticality: "operational",
    to: [{ email: input.buyerEmail }],
    subject: `Shipment delivered for order ${orderReference}`,
    templateId: "shipment_delivered",
    templateVersion: 1,
    locale: "en",
    templateData: { orderReference, trackingNumber: input.trackingNumber },
    idempotencyKey: `fulfillment:shipment_delivered:${input.orderId}:${input.trackingNumber}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}
