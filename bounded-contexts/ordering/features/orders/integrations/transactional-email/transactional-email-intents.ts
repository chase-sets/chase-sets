import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/outbound-messaging";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";

export type OrderConfirmedEmailIntentInput = Readonly<{
  buyerEmail: string;
  recipientAccountId?: AccountId | null;
  orderId: string;
  orderTotal: string;
  correlationId: string;
}>;

export function mapOrderConfirmedToTransactionalEmail(input: OrderConfirmedEmailIntentInput): NotificationMessage {
  const orderReference = deriveDisplayReferenceOrRaw(input.orderId as OrderId);

  return createTransactionalEmailNotificationMessage({
    messageType: "ordering.order.created",
    criticality: "commerce",
    recipientAccountId: input.recipientAccountId,
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
