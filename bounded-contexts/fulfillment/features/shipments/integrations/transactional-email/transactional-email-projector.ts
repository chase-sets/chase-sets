import { defineTransactionalEmail, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { FulfillmentShipmentDeliveredPayload } from "@chase-sets/event-core/public-event-payloads";
import { mapShipmentDeliveredToTransactionalEmail } from "./transactional-email-intents";

export const FULFILLMENT_TRANSACTIONAL_EMAIL_PROJECTION = "fulfillment-shipment-transactional-email-projection";

export function buildFulfillmentTransactionalEmailProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = FULFILLMENT_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  return defineTransactionalEmail<FulfillmentShipmentDeliveredPayload, string, "fulfillment.shipment.delivered">({
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
