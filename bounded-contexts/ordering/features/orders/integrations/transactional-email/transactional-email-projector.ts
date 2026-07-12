import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  mapOrderConfirmedToTransactionalEmail,
  mapOrderPaymentDeadlineCancelledToTransactionalEmail,
} from "./transactional-email-intents";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export const ORDERING_TRANSACTIONAL_EMAIL_PROJECTION = "ordering-order-transactional-email-projection";

export type OrderingOrderCreatedEmailEvent = Readonly<
  TransportEvent & {
    type: "ordering.order.created";
    data: Readonly<{
      orderId: string;
      sourceType?: string | null;
      buyerAccountId: AccountId;
      totalAmount: string;
      shippingDestinationSnapshot: Readonly<{ email?: string | null }>;
    }>;
  }
>;

export type OrderingOrderCancelledEmailEvent = Readonly<
  TransportEvent & {
    type: "ordering.order.cancelled";
    data: Readonly<{
      orderId: string;
      reason?: string | null;
      buyerEmail?: string | null;
    }>;
  }
>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectOrderingEventToTransactionalEmail(
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = ORDERING_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  if (event.type === "ordering.order.cancelled") {
    const data = event.data as OrderingOrderCancelledEmailEvent["data"];
    if (data.reason !== "payment-deadline") return;
    const buyerEmail = data.buyerEmail?.trim();
    if (!buyerEmail) return;

    await outbox.enqueueNotification({
      message: mapOrderPaymentDeadlineCancelledToTransactionalEmail({
        buyerEmail,
        recipientAccountId: event.audit?.forAccountId ?? null,
        orderId: data.orderId,
        correlationId: correlationIdFromEvent(event),
      }),
      source: {
        sourceEventId: event.id,
        sourceGlobalPosition: event.globalPosition,
        projectionName,
        occurredAt: event.timing.occurredAt,
      },
    });
    return;
  }

  if (event.type !== "ordering.order.created") return;
  const data = event.data as OrderingOrderCreatedEmailEvent["data"];
  if (data.sourceType === "cart-checkout" || data.sourceType === "buy-now") return;
  const buyerEmail = data.shippingDestinationSnapshot.email?.trim();
  if (!buyerEmail) return;

  await outbox.enqueueNotification({
    message: mapOrderConfirmedToTransactionalEmail({
      buyerEmail,
      recipientAccountId: data.buyerAccountId,
      orderId: data.orderId,
      orderTotal: data.totalAmount,
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

export function buildOrderingTransactionalEmailProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = ORDERING_TRANSACTIONAL_EMAIL_PROJECTION,
): ProjectorHandlerMap {
  return {
    "ordering.order.created": (event) => projectOrderingEventToTransactionalEmail(outbox, event, projectionName),
    "ordering.order.cancelled": (event) => projectOrderingEventToTransactionalEmail(outbox, event, projectionName),
  };
}
