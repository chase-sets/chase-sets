import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/outbound-messaging";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";

export type PaymentEmailIntentInput = Readonly<{
  buyerEmail: string;
  recipientAccountId?: AccountId | null;
  paymentId: string;
  orderIds: readonly string[];
  amount: string;
  currencyCode: string;
  correlationId: string;
}>;

/**
 * Payments never mint their own display reference (there is no PAY- prefix):
 * when a payment maps to exactly one order it borrows that order's reference,
 * falling back to the raw payment id only when several orders share the payment.
 */
function paymentDisplayReference(input: PaymentEmailIntentInput): string {
  return input.orderIds.length === 1 ? deriveDisplayReferenceOrRaw(input.orderIds[0] as OrderId) : input.paymentId;
}

export function mapPaymentCapturedToTransactionalEmail(input: PaymentEmailIntentInput): NotificationMessage {
  const paymentReference = paymentDisplayReference(input);

  return createTransactionalEmailNotificationMessage({
    messageType: "payments.payment-captured",
    criticality: "commerce",
    recipientAccountId: input.recipientAccountId,
    to: [{ email: input.buyerEmail }],
    subject: `Payment received for ${paymentReference}`,
    templateId: "payment_captured",
    templateVersion: 1,
    locale: "en",
    templateData: {
      paymentReference,
      amount: input.amount,
      currencyCode: input.currencyCode,
    },
    idempotencyKey: `payments:payment_captured:${input.paymentId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}
