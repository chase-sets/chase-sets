import type { AccountId, OrderId, ShipmentId } from "@chase-sets/primitives/typed-ids";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import { t } from "@chase-sets/localization";
import type {
  FulfillmentShipmentDispatchedPayload,
  OrderingOrderCancelledPayload,
} from "@chase-sets/event-core/public-event-payloads";
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

/**
 * The enriched arm of the shipped public dispatch union. Binding the classifier and
 * mapper to it keeps a producer contract change a typecheck error here rather than a
 * silently divergent local copy of the payload shape.
 */
type EnrichedShipmentDispatchedPayload = Extract<FulfillmentShipmentDispatchedPayload, { orderId: OrderId }>;

export type ShipmentDispatchedClassification =
  | Readonly<{ kind: "historical" }>
  | Readonly<{ kind: "rejected" }>
  | (Readonly<{ kind: "enriched" }> &
      Pick<EnrichedShipmentDispatchedPayload, "orderId" | "buyerAccountId" | "sellerAccountId" | "trackingIdentifier">);

const SHIPMENT_DISPATCHED_ROUTING_KEYS = [
  "orderId",
  "buyerAccountId",
  "sellerAccountId",
  "trackingIdentifier",
] as const;

/**
 * Routing was added to the durable dispatch fact atomically, so the four keys are all
 * absent (historical, nothing to notify) or all present. Any other combination, and any
 * present-but-invalid value, is transport data this consumer refuses to route on. A
 * public type assertion is not runtime validation, so presence is checked independently
 * of value validity before anything is enqueued.
 */
export function classifyShipmentDispatchedPayload(data: unknown): ShipmentDispatchedClassification {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { kind: "rejected" };
  }

  const payload = data as Readonly<Record<string, unknown>>;
  const presence = SHIPMENT_DISPATCHED_ROUTING_KEYS.map((key) => Object.hasOwn(payload, key));
  if (presence.every((isPresent) => !isPresent)) {
    return { kind: "historical" };
  }
  if (!presence.every(Boolean)) {
    return { kind: "rejected" };
  }

  if (
    !isRoutingId(payload.orderId) ||
    !isRoutingId(payload.buyerAccountId) ||
    !isRoutingId(payload.sellerAccountId) ||
    (typeof payload.trackingIdentifier !== "string" && payload.trackingIdentifier !== null)
  ) {
    return { kind: "rejected" };
  }

  return {
    kind: "enriched",
    orderId: payload.orderId as OrderId,
    buyerAccountId: payload.buyerAccountId as AccountId,
    sellerAccountId: payload.sellerAccountId as AccountId,
    trackingIdentifier: payload.trackingIdentifier,
  };
}

function isRoutingId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type ShipmentDispatchedNotificationInput = Pick<
  EnrichedShipmentDispatchedPayload,
  "shipmentId" | "orderId" | "buyerAccountId" | "trackingIdentifier"
> &
  Readonly<{
    eventId: string;
    correlationId: string;
  }>;

export function mapShipmentDispatchedToNotification(input: ShipmentDispatchedNotificationInput): NotificationMessage {
  const trackingIdentifier = input.trackingIdentifier?.trim() || null;
  const shipmentHref = `/account/shipments/${input.shipmentId}`;
  const webChannel: WebNotificationChannel = {
    channel: "web",
    recipient: { accountId: input.buyerAccountId },
    actionHref: shipmentHref,
  };

  return {
    messageType: "fulfillment.shipment.dispatched",
    criticality: "commerce",
    category: "order-critical",
    recipientAccountId: input.buyerAccountId,
    title: t("notifications.intents.shipmentDispatched.title"),
    body: trackingIdentifier
      ? t("notifications.intents.shipmentDispatched.body.tracked", { trackingIdentifier })
      : t("notifications.intents.shipmentDispatched.body.trackingless"),
    actionHref: shipmentHref,
    templateId: "shipment_dispatched",
    templateVersion: 1,
    locale: "en",
    templateData: {
      shipmentId: input.shipmentId,
      orderId: input.orderId,
      trackingIdentifier,
      shipmentHref,
    },
    channels: [webChannel],
    idempotencyKey: `notifications:fulfillment:shipment_dispatched:${input.eventId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.buyerAccountId },
  };
}

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

export type SellerAvailabilityRestoredNotificationInput = Readonly<{
  sellerAccountId: AccountId;
  restoredAt: string;
  correlationId: string;
}>;

export function mapSellerAvailabilityRestoredToNotification(
  input: SellerAvailabilityRestoredNotificationInput,
): NotificationMessage {
  const actionHref = "/account/selling/listings";
  return sellerWebNotification({
    sellerAccountId: input.sellerAccountId,
    messageType: "marketplace.seller-listing-availability.enabled",
    criticality: "operational",
    title: t("notifications.intents.sellerAvailabilityRestored.title"),
    body: t("notifications.intents.sellerAvailabilityRestored.body"),
    actionHref,
    templateId: "seller_availability_restored",
    templateData: { restoredAt: input.restoredAt, actionHref },
    idempotencyKey: `notifications:marketplace:seller_availability_restored:${input.sellerAccountId}:${input.restoredAt}`,
    correlationId: input.correlationId,
  });
}

export type PayoutReadinessRegressionNotificationInput = Readonly<{
  sellerAccountId: AccountId;
  sellerEmail?: string | null;
  reason: string;
  deadline?: string | null;
  transitionId: string;
  correlationId: string;
}>;

export function mapPayoutReadinessRegressionToNotification(
  input: PayoutReadinessRegressionNotificationInput,
): NotificationMessage {
  const actionHref = "/account/payouts/setup";
  const title = t("notifications.intents.payoutReadinessRegression.title");
  const body = t("notifications.intents.payoutReadinessRegression.body", {
    reason: input.reason,
    deadline: input.deadline ?? t("notifications.intents.payoutReadinessRegression.noDeadline"),
  });
  const webChannel: WebNotificationChannel = {
    channel: "web",
    recipient: { accountId: input.sellerAccountId },
    actionHref,
  };
  const sellerEmail = input.sellerEmail?.trim();
  const channels: NotificationMessage["channels"] = sellerEmail
    ? [
        {
          channel: "email",
          to: [{ email: sellerEmail }],
          subject: title,
          templateId: "seller_payout_readiness_regression",
          templateVersion: 1,
          templateData: { reason: input.reason, deadline: input.deadline ?? null },
        } satisfies EmailNotificationChannel,
        webChannel,
      ]
    : [webChannel];

  return {
    messageType: "settlement.payout-readiness.regressed",
    criticality: "commerce",
    category: "order-critical",
    recipientAccountId: input.sellerAccountId,
    title,
    body,
    actionHref,
    templateId: "seller_payout_readiness_regression",
    templateVersion: 1,
    locale: "en",
    templateData: {
      reason: input.reason,
      deadline: input.deadline ?? null,
      actionHref,
    },
    channels,
    idempotencyKey: `notifications:settlement:payout_readiness_regression:${input.sellerAccountId}:${input.transitionId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.sellerAccountId },
  };
}

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

export function mapOrderCancelledToNotification(
  input: OrderingOrderCancelledPayload,
  correlationId: string,
): NotificationMessage | null {
  if (typeof input.buyerAccountId !== "string" || input.buyerAccountId.trim().length === 0) return null;
  if (typeof input.statusBeforeCancellation !== "string") return null;

  const buyerAccountId = input.buyerAccountId as AccountId;
  const orderReference = orderReferenceOrRaw(input.orderId);
  const headline = t("notifications.intents.orderCancelled.title", { orderReference });
  const status = input.statusBeforeCancellation;
  const moneyLine =
    status === "pending-reservation"
      ? t("notifications.intents.orderCancelled.body.pendingReservation")
      : status === "pending-payment" || status === "ready-for-fulfillment"
        ? t("notifications.intents.orderCancelled.body.paymentDetails")
        : t("notifications.intents.orderCancelled.body.unknown");
  const purchaseHref = `/account/purchases/${input.orderId}`;
  const buyerEmail = typeof input.buyerEmail === "string" ? input.buyerEmail.trim() : "";
  const webChannel: WebNotificationChannel = {
    channel: "web",
    recipient: { accountId: buyerAccountId },
    actionHref: purchaseHref,
  };
  const channels: NotificationMessage["channels"] =
    input.reason !== "buyer-cancelled" && buyerEmail
      ? [webChannel, { channel: "email", to: [{ email: buyerEmail }] }]
      : [webChannel];

  return {
    messageType: "ordering.order.cancelled",
    criticality: "commerce",
    category: "order-critical",
    recipientAccountId: buyerAccountId,
    title: headline,
    body: moneyLine,
    actionHref: purchaseHref,
    templateId: "order_cancelled",
    templateVersion: 1,
    locale: "en",
    templateData: { orderReference, headline, moneyLine, purchaseHref },
    channels,
    idempotencyKey: `notifications:ordering:order_cancelled:${input.orderId}`,
    correlationId,
    actor: { userId: null, accountId: buyerAccountId },
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
