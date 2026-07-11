import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/outbound-messaging";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { OrderId } from "@chase-sets/primitives/typed-ids";

export type OrderConfirmedEmailIntentInput = Readonly<{
  buyerEmail: string;
  orderId: string;
  orderTotal: string;
  correlationId: string;
}>;

export type OrderPaymentDeadlineCancelledEmailIntentInput = Readonly<{
  buyerEmail: string;
  orderId: string;
  correlationId: string;
}>;

export function mapOrderConfirmedToTransactionalEmail(input: OrderConfirmedEmailIntentInput): NotificationMessage {
  const orderReference = deriveDisplayReferenceOrRaw(input.orderId as OrderId);

  return createTransactionalEmailNotificationMessage({
    messageType: "ordering.order.created",
    criticality: "commerce",
    to: [{ email: input.buyerEmail }],
    subject: `Order ${orderReference} confirmed`,
    templateId: "order_confirmed",
    templateVersion: 1,
    locale: "en",
    templateData: { orderReference, orderTotal: input.orderTotal },
    idempotencyKey: `ordering:order_confirmed:${input.orderId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}

export function mapOrderPaymentDeadlineCancelledToTransactionalEmail(
  input: OrderPaymentDeadlineCancelledEmailIntentInput,
): NotificationMessage {
  const orderReference = deriveDisplayReferenceOrRaw(input.orderId as OrderId);

  return createTransactionalEmailNotificationMessage({
    messageType: "ordering.order.cancelled.payment-deadline",
    criticality: "commerce",
    to: [{ email: input.buyerEmail }],
    subject: `Order ${orderReference} cancelled after payment deadline`,
    templateId: "order_payment_deadline_cancelled",
    templateVersion: 1,
    locale: "en",
    templateData: {
      orderReference,
      reorderHref: `/marketplace?reorderFrom=${encodeURIComponent(input.orderId)}`,
    },
    idempotencyKey: `ordering:payment_deadline_cancelled:${input.orderId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}
