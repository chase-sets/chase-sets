import type { NotificationOutbox } from "@chase-sets/notifications";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  mapRefundFailedToTransactionalEmail,
  mapRefundIssuedToTransactionalEmail,
} from "./transactional-email-intents";

export const PAYMENTS_REFUND_TRANSACTIONAL_EMAIL_PROJECTION = "payments-refund-transactional-email-projection";

type RefundEmailEventData = Readonly<{
  refundId: string;
  paymentId: string;
  orderIds: readonly string[];
  amount: string;
  currencyCode: string;
}>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

async function findBuyerEmailForOrders(db: PgQueryable, orderIds: readonly string[]) {
  if (orderIds.length === 0) return null;

  const result = await db.query<{ buyer_email: string | null }>(
    `SELECT buyer_email
     FROM payments_order_inputs
     WHERE order_id = ANY($1)
       AND buyer_email IS NOT NULL
     ORDER BY order_id ASC
     LIMIT 1`,
    [orderIds],
  );

  return result.rows[0]?.buyer_email?.trim() || null;
}

export async function projectRefundEventToTransactionalEmail(
  db: PgQueryable,
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = PAYMENTS_REFUND_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  if (event.type !== "payments.refund-issued" && event.type !== "payments.refund-failed") return;
  const data = event.data as RefundEmailEventData;
  const buyerEmail = await findBuyerEmailForOrders(db, data.orderIds);
  if (!buyerEmail) return;

  const mapper =
    event.type === "payments.refund-issued" ? mapRefundIssuedToTransactionalEmail : mapRefundFailedToTransactionalEmail;

  await outbox.enqueueNotification({
    message: mapper({
      buyerEmail,
      refundId: data.refundId,
      paymentId: data.paymentId,
      orderIds: data.orderIds,
      amount: data.amount,
      currencyCode: data.currencyCode,
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

export function buildRefundTransactionalEmailProjectionHandlers(
  db: PgQueryable,
  outbox: NotificationOutbox,
  projectionName = PAYMENTS_REFUND_TRANSACTIONAL_EMAIL_PROJECTION,
): ProjectorHandlerMap {
  return {
    "payments.refund-issued": (event) => projectRefundEventToTransactionalEmail(db, outbox, event, projectionName),
    "payments.refund-failed": (event) => projectRefundEventToTransactionalEmail(db, outbox, event, projectionName),
  };
}
