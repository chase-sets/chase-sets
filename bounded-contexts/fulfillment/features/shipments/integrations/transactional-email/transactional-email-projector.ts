import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { mapShipmentDeliveredToTransactionalEmail } from "./transactional-email-intents";

export const FULFILLMENT_TRANSACTIONAL_EMAIL_PROJECTION = "fulfillment-shipment-transactional-email-projection";

export type FulfillmentShipmentDeliveredEmailEvent = Readonly<
  TransportEvent & {
    type: "fulfillment.shipment.delivered";
    data: Readonly<{
      shipmentId: string;
      orderId: string;
      buyerAccountId: AccountId;
      trackingIdentifier: string | null;
      shippingDestinationSnapshot: Readonly<{ email?: string | null }>;
    }>;
  }
>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectFulfillmentEventToTransactionalEmail(
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = FULFILLMENT_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  if (event.type !== "fulfillment.shipment.delivered") return;
  const data = event.data as FulfillmentShipmentDeliveredEmailEvent["data"];
  const buyerEmail = data.shippingDestinationSnapshot.email?.trim();
  if (!buyerEmail) return;

  await outbox.enqueueNotification({
    message: mapShipmentDeliveredToTransactionalEmail({
      buyerEmail,
      recipientAccountId: data.buyerAccountId,
      orderId: data.orderId,
      trackingNumber: data.trackingIdentifier ?? data.shipmentId,
      correlationId: correlationIdFromEvent(event),
    }),
    source: {
      sourceEventId: event.id,
      sourceGlobalPosition: event.globalPosition,
      projectionName,
      occurredAt: event.timing.occurredAt,
    },
  });
}

export function buildFulfillmentTransactionalEmailProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = FULFILLMENT_TRANSACTIONAL_EMAIL_PROJECTION,
): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.delivered": (event) =>
      projectFulfillmentEventToTransactionalEmail(outbox, event, projectionName),
  };
}
