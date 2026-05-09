import type { TransactionalEmailGateway } from "@chase-sets/communications-email";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { mapOrderConfirmedToTransactionalEmail } from "./transactional-email-intents";

export type OrderingOrderCreatedEmailEvent = Readonly<
  TransportEvent & {
    type: "ordering.order.created";
    data: Readonly<{
      orderId: string;
      totalAmount: string;
      shippingDestinationSnapshot: Readonly<{ email?: string | null }>;
    }>;
  }
>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectOrderingEventToTransactionalEmail(
  gateway: TransactionalEmailGateway,
  event: TransportEvent,
) {
  if (event.type !== "ordering.order.created") return;
  const data = event.data as OrderingOrderCreatedEmailEvent["data"];
  const buyerEmail = data.shippingDestinationSnapshot.email?.trim();
  if (!buyerEmail) return;

  await gateway.sendTransactionalEmail(
    mapOrderConfirmedToTransactionalEmail({
      buyerEmail,
      orderId: data.orderId,
      orderTotal: data.totalAmount,
      correlationId: correlationIdFromEvent(event),
    }),
  );
}

export function buildOrderingTransactionalEmailProjectionHandlers(
  gateway: TransactionalEmailGateway,
): ProjectorHandlerMap {
  return {
    "ordering.order.created": (event) =>
      projectOrderingEventToTransactionalEmail(gateway, event),
  };
}
