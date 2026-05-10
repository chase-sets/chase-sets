import type { NotificationOutbox } from "@chase-sets/notifications";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { mapShipmentDeliveredToNotification } from "./notification-intents";

export const FULFILLMENT_NOTIFICATION_PROJECTION =
  "fulfillment-shipment-notification-projection";

export type FulfillmentShipmentDeliveredNotificationEvent = Readonly<
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

export async function projectFulfillmentEventToNotification(
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = FULFILLMENT_NOTIFICATION_PROJECTION,
) {
  if (event.type !== "fulfillment.shipment.delivered") return;
  const data = event.data as FulfillmentShipmentDeliveredNotificationEvent["data"];
  const trackingNumber = data.trackingIdentifier ?? data.shipmentId;

  await outbox.enqueueNotification({
    message: mapShipmentDeliveredToNotification({
      buyerAccountId: data.buyerAccountId,
      buyerEmail: data.shippingDestinationSnapshot.email,
      shipmentId: data.shipmentId,
      orderId: data.orderId,
      trackingNumber,
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

export function buildFulfillmentNotificationProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = FULFILLMENT_NOTIFICATION_PROJECTION,
): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.delivered": (event) =>
      projectFulfillmentEventToNotification(outbox, event, projectionName),
  };
}
