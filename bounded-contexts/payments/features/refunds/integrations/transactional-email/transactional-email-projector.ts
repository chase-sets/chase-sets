import { defineTransactionalEmail, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
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

type RefundEmailRecipient = Readonly<{ email: string; accountId: string | null }>;

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

export function buildRefundTransactionalEmailProjectionHandlers(
  db: PgQueryable,
  outbox: NotificationOutbox,
  projectionName = PAYMENTS_REFUND_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  const recipient = (data: RefundEmailEventData) => findBuyerEmailForOrders(db, data.orderIds);
  const intentInput = (data: RefundEmailEventData, resolved: RefundEmailRecipient, correlationId: string) => ({
    buyerEmail: resolved.email,
    recipientAccountId: resolved.accountId as AccountId | null,
    refundId: data.refundId,
    paymentId: data.paymentId,
    orderIds: data.orderIds,
    amount: data.amount,
    currencyCode: data.currencyCode,
    correlationId,
  });

  return {
    ...defineTransactionalEmail<RefundEmailEventData, RefundEmailRecipient, "payments.refund-issued">({
      outbox,
      projectionName,
      on: "payments.refund-issued",
      recipient,
      template: (data, { recipient: resolved, correlationId }) =>
        mapRefundIssuedToTransactionalEmail(intentInput(data, resolved, correlationId)),
    }),
    ...defineTransactionalEmail<RefundEmailEventData, RefundEmailRecipient, "payments.refund-failed">({
      outbox,
      projectionName,
      on: "payments.refund-failed",
      recipient,
      template: (data, { recipient: resolved, correlationId }) =>
        mapRefundFailedToTransactionalEmail(intentInput(data, resolved, correlationId)),
    }),
  };
}
