import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/outbound-messaging";

export type PaymentEmailIntentInput = Readonly<{
  buyerEmail: string;
  paymentId: string;
  orderIds: readonly string[];
  amount: string;
  currencyCode: string;
  correlationId: string;
}>;

export function mapPaymentCapturedToTransactionalEmail(input: PaymentEmailIntentInput): NotificationMessage {
  return createTransactionalEmailNotificationMessage({
    messageType: "payments.payment-captured",
    criticality: "commerce",
    to: [{ email: input.buyerEmail }],
    subject: `Payment received for ${input.orderIds.length === 1 ? input.orderIds[0] : input.paymentId}`,
    templateId: "payment_captured",
    templateVersion: 1,
    locale: "en",
    templateData: {
      paymentId: input.paymentId,
      orderIds: input.orderIds.join(", "),
      amount: input.amount,
      currencyCode: input.currencyCode,
    },
    idempotencyKey: `payments:payment_captured:${input.paymentId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}
