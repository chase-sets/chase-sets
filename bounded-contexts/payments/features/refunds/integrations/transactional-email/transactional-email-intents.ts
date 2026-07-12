import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/outbound-messaging";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export type RefundEmailIntentInput = Readonly<{
  buyerEmail: string;
  recipientAccountId?: AccountId | null;
  refundId: string;
  paymentId: string;
  orderIds: readonly string[];
  amount: string;
  currencyCode: string;
  correlationId: string;
}>;

export function mapRefundIssuedToTransactionalEmail(input: RefundEmailIntentInput): NotificationMessage {
  return createTransactionalEmailNotificationMessage({
    messageType: "payments.refund-issued",
    criticality: "commerce",
    recipientAccountId: input.recipientAccountId,
    to: [{ email: input.buyerEmail }],
    subject: `Refund issued for ${input.orderIds.length === 1 ? input.orderIds[0] : input.paymentId}`,
    templateId: "refund_issued",
    templateVersion: 1,
    locale: "en",
    templateData: {
      refundId: input.refundId,
      paymentId: input.paymentId,
      orderIds: input.orderIds.join(", "),
      amount: input.amount,
      currencyCode: input.currencyCode,
    },
    idempotencyKey: `payments:refund_issued:${input.refundId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}

export function mapRefundFailedToTransactionalEmail(input: RefundEmailIntentInput): NotificationMessage {
  return createTransactionalEmailNotificationMessage({
    messageType: "payments.refund-failed",
    criticality: "commerce",
    recipientAccountId: input.recipientAccountId,
    to: [{ email: input.buyerEmail }],
    subject: `Refund needs review for ${input.orderIds.length === 1 ? input.orderIds[0] : input.paymentId}`,
    templateId: "refund_failed",
    templateVersion: 1,
    locale: "en",
    templateData: {
      refundId: input.refundId,
      paymentId: input.paymentId,
      orderIds: input.orderIds.join(", "),
      amount: input.amount,
      currencyCode: input.currencyCode,
    },
    idempotencyKey: `payments:refund_failed:${input.refundId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}
