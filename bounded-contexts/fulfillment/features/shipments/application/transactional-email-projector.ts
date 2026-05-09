import type { TransactionalEmailGateway } from "@chase-sets/communications-email";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { mapShipmentDeliveredToTransactionalEmail } from "./transactional-email-intents";

export type FulfillmentShipmentDeliveredEmailEvent = Readonly<
  TransportEvent & {
    type: "fulfillment.shipment.delivered";
    data: Readonly<{
      shipmentId: string;
      orderId: string;
      trackingIdentifier: string | null;
      shippingDestinationSnapshot: Readonly<{ email?: string | null }>;
    }>;
  }
>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectFulfillmentEventToTransactionalEmail(
  gateway: TransactionalEmailGateway,
  event: TransportEvent,
) {
  if (event.type !== "fulfillment.shipment.delivered") return;
  const data = event.data as FulfillmentShipmentDeliveredEmailEvent["data"];
  const buyerEmail = data.shippingDestinationSnapshot.email?.trim();
  if (!buyerEmail) return;

  await gateway.sendTransactionalEmail(
    mapShipmentDeliveredToTransactionalEmail({
      buyerEmail,
      orderId: data.orderId,
      trackingNumber: data.trackingIdentifier ?? data.shipmentId,
      correlationId: correlationIdFromEvent(event),
    }),
  );
}

export function buildFulfillmentTransactionalEmailProjectionHandlers(
  gateway: TransactionalEmailGateway,
): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.delivered": (event) =>
      projectFulfillmentEventToTransactionalEmail(gateway, event),
  };
}
