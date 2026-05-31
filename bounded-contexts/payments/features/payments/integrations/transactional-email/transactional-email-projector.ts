import type { TransactionalEmailOutbox } from "@chase-sets/communications-email";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  mapPaymentCapturedToTransactionalEmail,
  mapPaymentFailedToTransactionalEmail,
} from "./transactional-email-intents";

export const PAYMENTS_PAYMENT_TRANSACTIONAL_EMAIL_PROJECTION = "payments-payment-transactional-email-projection";

type PaymentEmailEventData = Readonly<{
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

export async function projectPaymentEventToTransactionalEmail(
  db: PgQueryable,
  outbox: TransactionalEmailOutbox,
  event: TransportEvent,
  projectionName = PAYMENTS_PAYMENT_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  if (event.type !== "payments.payment-captured" && event.type !== "payments.payment-failed") return;
  const data = event.data as PaymentEmailEventData;
  const buyerEmail = await findBuyerEmailForOrders(db, data.orderIds);
  if (!buyerEmail) return;

  const mapper =
    event.type === "payments.payment-captured"
      ? mapPaymentCapturedToTransactionalEmail
      : mapPaymentFailedToTransactionalEmail;

  await outbox.enqueueTransactionalEmail({
    message: mapper({
      buyerEmail,
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

export function buildPaymentTransactionalEmailProjectionHandlers(
  db: PgQueryable,
  outbox: TransactionalEmailOutbox,
  projectionName = PAYMENTS_PAYMENT_TRANSACTIONAL_EMAIL_PROJECTION,
): ProjectorHandlerMap {
  return {
    "payments.payment-captured": (event) => projectPaymentEventToTransactionalEmail(db, outbox, event, projectionName),
    "payments.payment-failed": (event) => projectPaymentEventToTransactionalEmail(db, outbox, event, projectionName),
  };
}
