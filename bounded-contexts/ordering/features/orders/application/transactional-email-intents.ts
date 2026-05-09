import type { TransactionalEmailMessage } from "@chase-sets/communications-email";

export type OrderConfirmedEmailIntentInput = Readonly<{
  buyerEmail: string;
  orderId: string;
  orderTotal: string;
  correlationId: string;
}>;

export function mapOrderConfirmedToTransactionalEmail(
  input: OrderConfirmedEmailIntentInput,
): TransactionalEmailMessage {
  return {
    messageType: "ordering.order.created",
    criticality: "commerce",
    to: [{ email: input.buyerEmail }],
    subject: `Order ${input.orderId} confirmed`,
    templateId: "order_confirmed",
    templateVersion: 1,
    locale: "en",
    templateData: { orderId: input.orderId, orderTotal: input.orderTotal },
    idempotencyKey: `ordering:order_confirmed:${input.orderId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  };
}
