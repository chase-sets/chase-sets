import { defineTransactionalEmail, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { mapOrderConfirmedToTransactionalEmail } from "./transactional-email-intents";

export const ORDERING_TRANSACTIONAL_EMAIL_PROJECTION = "ordering-order-transactional-email-projection";

type OrderingOrderCreatedEmailData = Readonly<{
  orderId: string;
  sourceType?: string | null;
  buyerAccountId: AccountId;
  totalAmount: string;
  shippingDestinationSnapshot: Readonly<{ email?: string | null }>;
}>;

export function buildOrderingTransactionalEmailProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = ORDERING_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  return {
    ...defineTransactionalEmail<OrderingOrderCreatedEmailData, string, "ordering.order.created">({
      outbox,
      projectionName,
      on: "ordering.order.created",
      skipWhen: (data) => data.sourceType === "cart-checkout" || data.sourceType === "buy-now",
      recipient: (data) => data.shippingDestinationSnapshot.email?.trim() || null,
      template: (data, { recipient, correlationId }) =>
        mapOrderConfirmedToTransactionalEmail({
          buyerEmail: recipient,
          recipientAccountId: data.buyerAccountId,
          orderId: data.orderId,
          orderTotal: data.totalAmount,
          correlationId,
        }),
    }),
  };
}
