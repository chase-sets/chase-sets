import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/outbound-messaging";

export type OrderConfirmedEmailIntentInput = Readonly<{
  buyerEmail: string;
  orderId: string;
  orderTotal: string;
  correlationId: string;
}>;

export function mapOrderConfirmedToTransactionalEmail(input: OrderConfirmedEmailIntentInput): NotificationMessage {
  return createTransactionalEmailNotificationMessage({
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
  });
}
