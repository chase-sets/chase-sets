import type {
  EmailNotificationChannel,
  NotificationMessage,
  WebNotificationChannel,
} from "@chase-sets/notifications";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export type OrderConfirmedNotificationIntentInput = Readonly<{
  buyerAccountId: AccountId;
  buyerEmail?: string | null;
  orderId: string;
  orderTotal: string;
  correlationId: string;
}>;

export function mapOrderConfirmedToNotification(
  input: OrderConfirmedNotificationIntentInput,
): NotificationMessage {
  const title = `Order ${input.orderId} confirmed`;
  const body = `Your order total is ${input.orderTotal}.`;
  const actionHref = `/account/purchases/${input.orderId}`;
  const webChannel: WebNotificationChannel = {
    channel: "web",
    recipient: { accountId: input.buyerAccountId },
    actionHref,
  };
  const buyerEmail = input.buyerEmail?.trim();
  const channels: NotificationMessage["channels"] = buyerEmail
    ? [
        {
          channel: "email",
          to: [{ email: buyerEmail }],
        } satisfies EmailNotificationChannel,
        webChannel,
      ]
    : [webChannel];

  return {
    messageType: "ordering.order.created",
    criticality: "commerce",
    title,
    body,
    actionHref,
    templateId: "order_confirmed",
    templateVersion: 1,
    locale: "en",
    templateData: { orderId: input.orderId, orderTotal: input.orderTotal },
    channels,
    idempotencyKey: `ordering:order_confirmed:${input.orderId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.buyerAccountId },
  };
}
