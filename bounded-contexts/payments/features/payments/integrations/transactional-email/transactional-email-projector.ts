import { defineTransactionalEmail, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { mapPaymentCapturedToTransactionalEmail } from "./transactional-email-intents";

export const PAYMENTS_PAYMENT_TRANSACTIONAL_EMAIL_PROJECTION = "payments-payment-transactional-email-projection";

type PaymentEmailEventData = Readonly<{
  paymentId: string;
  orderIds: readonly string[];
  amount: string;
  currencyCode: string;
}>;

async function findBuyerEmailForOrders(db: PgQueryable, orderIds: readonly string[]) {
  if (orderIds.length === 0) return null;

  const result = await db.query<{ buyer_email: string | null; buyer_account_id: string | null }>(
    `SELECT buyer_email, buyer_account_id
     FROM payments_order_inputs
     WHERE order_id = ANY($1)
       AND buyer_email IS NOT NULL
     ORDER BY order_id ASC
     LIMIT 1`,
    [orderIds],
  );

  const row = result.rows[0];
  return row?.buyer_email?.trim() ? { email: row.buyer_email.trim(), accountId: row.buyer_account_id } : null;
}

export function buildPaymentTransactionalEmailProjectionHandlers(
  db: PgQueryable,
  outbox: NotificationOutbox,
  projectionName = PAYMENTS_PAYMENT_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  return defineTransactionalEmail<
    PaymentEmailEventData,
    { email: string; accountId: string | null },
    "payments.payment-captured"
  >({
    outbox,
    projectionName,
    on: "payments.payment-captured",
    recipient: (data) => findBuyerEmailForOrders(db, data.orderIds),
    template: (data, { recipient, correlationId }) =>
      mapPaymentCapturedToTransactionalEmail({
        buyerEmail: recipient.email,
        recipientAccountId: recipient.accountId as AccountId | null,
        paymentId: data.paymentId,
        orderIds: data.orderIds,
        amount: data.amount,
        currencyCode: data.currencyCode,
        correlationId,
      }),
  });
}
