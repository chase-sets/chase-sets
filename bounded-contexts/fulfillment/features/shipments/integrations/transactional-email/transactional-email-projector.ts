import { defineTransactionalEmail, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { mapShipmentDeliveredToTransactionalEmail } from "./transactional-email-intents";

export const FULFILLMENT_TRANSACTIONAL_EMAIL_PROJECTION = "fulfillment-shipment-transactional-email-projection";

type FulfillmentShipmentDeliveredEmailData = Readonly<{
  shipmentId: string;
  orderId: string;
  buyerAccountId: AccountId;
  trackingIdentifier: string | null;
  shippingDestinationSnapshot: Readonly<{ email?: string | null }>;
}>;

export function buildFulfillmentTransactionalEmailProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = FULFILLMENT_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  return defineTransactionalEmail<FulfillmentShipmentDeliveredEmailData, string, "fulfillment.shipment.delivered">({
    outbox,
    projectionName,
    on: "fulfillment.shipment.delivered",
    recipient: (data) => data.shippingDestinationSnapshot.email?.trim() || null,
    template: (data, { recipient, correlationId }) =>
      mapShipmentDeliveredToTransactionalEmail({
        buyerEmail: recipient,
        recipientAccountId: data.buyerAccountId,
        orderId: data.orderId,
        trackingNumber: data.trackingIdentifier ?? data.shipmentId,
        correlationId,
      }),
  });
}
