import type { AccountId, OrderId, ShipmentId } from "@chase-sets/primitives/typed-ids";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import { t } from "@chase-sets/localization";
import type {
  EmailNotificationChannel,
  NotificationMessage,
  WebNotificationChannel,
} from "@chase-sets/outbound-messaging";

function orderReferenceOrRaw(orderId: string): string {
  return deriveDisplayReferenceOrRaw(orderId as OrderId);
}

function shipmentReferenceOrRaw(shipmentId: string): string {
  return deriveDisplayReferenceOrRaw(shipmentId as ShipmentId);
}

export type OrderCreatedNotificationInput = Readonly<{
  buyerAccountId: AccountId;
  buyerEmail?: string | null;
  orderId: string;
  orderTotal: string;
  correlationId: string;
}>;

export type ShipmentDeliveredNotificationInput = Readonly<{
  buyerAccountId: AccountId;
  buyerEmail?: string | null;
  shipmentId: string;
  orderId: string;
  trackingNumber: string;
  correlationId: string;
}>;

export type SellerStockNotificationInput = Readonly<{
  sellerAccountId: AccountId;
  orderId: string;
  itemId?: string | null;
  lineCount: number;
  totalQuantity: number;
  correlationId: string;
}>;

export type SellerStockReturnedNotificationInput = SellerStockNotificationInput &
  Readonly<{
    releaseReason: "order-cancelled" | "payment-deadline" | string;
  }>;

export type SaleRecordedNotificationInput = SellerStockNotificationInput &
  Readonly<{
    shipmentId?: string | null;
  }>;

export type RestockDecisionPendingNotificationInput = Readonly<{
  sellerAccountId: AccountId;
  orderId: string;
  itemId: string;
  decisionId?: string | null;
  quantity: number;
  correlationId: string;
}>;

export function mapOrderCreatedToNotification(input: OrderCreatedNotificationInput): NotificationMessage {
  const orderReference = orderReferenceOrRaw(input.orderId);
  const title = `Order ${orderReference} confirmed`;
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
    recipientAccountId: input.buyerAccountId,
    title,
    body,
    actionHref,
    templateId: "order_confirmed",
    templateVersion: 1,
    locale: "en",
    templateData: { orderReference, orderTotal: input.orderTotal },
    channels,
    idempotencyKey: `notifications:ordering:order_created:${input.orderId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.buyerAccountId },
  };
}

export function mapStockCommittedToNotification(input: SellerStockNotificationInput): NotificationMessage {
  const orderHref = sellerOrderHref(input.orderId);
  const itemLedgerHref = input.itemId ? itemLedgerHrefFor(input.itemId, "hold-placed") : null;
  return sellerWebNotification({
    sellerAccountId: input.sellerAccountId,
    messageType: "inventory.stock-committed",
    criticality: "commerce",
    title: t("notifications.intents.stockCommitted.title", { orderReference: orderReferenceOrRaw(input.orderId) }),
    body: t("notifications.intents.stockCommitted.body", {
      quantity: input.totalQuantity,
      lineCount: input.lineCount,
    }),
    actionHref: orderHref,
    templateId: "seller_stock_committed",
    templateData: {
      orderId: input.orderId,
      lineCount: input.lineCount,
      totalQuantity: input.totalQuantity,
      itemId: input.itemId ?? null,
      itemLedgerHref,
      orderHref,
    },
    idempotencyKey: `notifications:inventory:stock_committed:${input.orderId}:${input.sellerAccountId}`,
    correlationId: input.correlationId,
  });
}

export function mapStockReturnedToNotification(input: SellerStockReturnedNotificationInput): NotificationMessage {
  const orderHref = sellerOrderHref(input.orderId);
  const itemLedgerHref = input.itemId ? itemLedgerHrefFor(input.itemId, "hold-released") : null;
  const releaseReasonCopyKey =
    input.releaseReason === "payment-deadline"
      ? "notifications.intents.stockReturned.body.paymentDeadline"
      : "notifications.intents.stockReturned.body.orderCancelled";
  return sellerWebNotification({
    sellerAccountId: input.sellerAccountId,
    messageType: "inventory.stock-returned",
    criticality: "commerce",
    title: t("notifications.intents.stockReturned.title", { orderReference: orderReferenceOrRaw(input.orderId) }),
    body: t(releaseReasonCopyKey, {
      quantity: input.totalQuantity,
      lineCount: input.lineCount,
    }),
    actionHref: orderHref,
    templateId: "seller_stock_returned",
    templateData: {
      orderId: input.orderId,
      lineCount: input.lineCount,
      totalQuantity: input.totalQuantity,
      releaseReason: input.releaseReason,
      itemId: input.itemId ?? null,
      itemLedgerHref,
      orderHref,
    },
    idempotencyKey: `notifications:inventory:stock_returned:${input.orderId}:${input.sellerAccountId}`,
    correlationId: input.correlationId,
  });
}

export function mapSaleRecordedToNotification(input: SaleRecordedNotificationInput): NotificationMessage {
  const orderHref = sellerOrderHref(input.orderId);
  const itemLedgerHref = input.itemId ? itemLedgerHrefFor(input.itemId, "hold-consumed") : null;
  return sellerWebNotification({
    sellerAccountId: input.sellerAccountId,
    messageType: "inventory.sale-recorded",
    criticality: "operational",
    title: t("notifications.intents.saleRecorded.title", { orderReference: orderReferenceOrRaw(input.orderId) }),
    body: t("notifications.intents.saleRecorded.body", {
      quantity: input.totalQuantity,
      lineCount: input.lineCount,
    }),
    actionHref: orderHref,
    templateId: "seller_sale_recorded",
    templateData: {
      orderId: input.orderId,
      shipmentId: input.shipmentId ?? null,
      lineCount: input.lineCount,
      totalQuantity: input.totalQuantity,
      itemId: input.itemId ?? null,
      itemLedgerHref,
      orderHref,
    },
    idempotencyKey: `notifications:inventory:sale_recorded:${input.orderId}:${input.sellerAccountId}`,
    correlationId: input.correlationId,
  });
}

export function mapRestockDecisionPendingToNotification(
  input: RestockDecisionPendingNotificationInput,
): NotificationMessage {
  const orderHref = sellerOrderHref(input.orderId);
  const itemLedgerHref = itemLedgerHrefFor(input.itemId, "hold-consumed");
  return sellerWebNotification({
    sellerAccountId: input.sellerAccountId,
    messageType: "inventory.restock-decision-pending",
    criticality: "commerce",
    title: t("notifications.intents.restockDecisionPending.title", {
      orderReference: orderReferenceOrRaw(input.orderId),
    }),
    body: t("notifications.intents.restockDecisionPending.body", { quantity: input.quantity }),
    actionHref: itemLedgerHref,
    templateId: "seller_restock_decision_pending",
    templateData: {
      orderId: input.orderId,
      decisionId: input.decisionId ?? null,
      quantity: input.quantity,
      itemId: input.itemId,
      itemLedgerHref,
      orderHref,
    },
    idempotencyKey: `notifications:inventory:restock_decision_pending:${
      input.decisionId ?? `${input.orderId}:${input.itemId}`
    }:${input.sellerAccountId}`,
    correlationId: input.correlationId,
  });
}

export function mapShipmentDeliveredToNotification(input: ShipmentDeliveredNotificationInput): NotificationMessage {
  const orderReference = orderReferenceOrRaw(input.orderId);
  const shipmentReference = shipmentReferenceOrRaw(input.shipmentId);
  const title = `Shipment ${shipmentReference} delivered for order ${orderReference}`;
  const body = `Tracking ${input.trackingNumber} is marked delivered.`;
  const actionHref = `/account/shipments/${input.shipmentId}`;
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
    messageType: "fulfillment.shipment.delivered",
    criticality: "operational",
    recipientAccountId: input.buyerAccountId,
    title,
    body,
    actionHref,
    templateId: "shipment_delivered",
    templateVersion: 1,
    locale: "en",
    templateData: {
      orderReference,
      shipmentReference,
      trackingNumber: input.trackingNumber,
      shipmentId: input.shipmentId,
    },
    channels,
    idempotencyKey: `notifications:fulfillment:shipment_delivered:${input.orderId}:${input.trackingNumber}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.buyerAccountId },
  };
}

function sellerWebNotification(
  input: Readonly<{
    sellerAccountId: AccountId;
    messageType: NotificationMessage["messageType"];
    criticality: NotificationMessage["criticality"];
    title: string;
    body: string;
    actionHref: string;
    templateId: string;
    templateData: NotificationMessage["templateData"];
    idempotencyKey: string;
    correlationId: string;
  }>,
): NotificationMessage {
  const webChannel: WebNotificationChannel = {
    channel: "web",
    recipient: { accountId: input.sellerAccountId },
    actionHref: input.actionHref,
  };

  return {
    messageType: input.messageType,
    criticality: input.criticality,
    recipientAccountId: input.sellerAccountId,
    title: input.title,
    body: input.body,
    actionHref: input.actionHref,
    templateId: input.templateId,
    templateVersion: 1,
    locale: "en",
    templateData: input.templateData,
    channels: [webChannel],
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.sellerAccountId },
  };
}

function sellerOrderHref(orderId: string) {
  return `/account/sales/${orderId}`;
}

function itemLedgerHrefFor(itemId: string, ledgerKind: string) {
  return `/account/inventory/items/${itemId}?ledgerKind=${ledgerKind}`;
}
