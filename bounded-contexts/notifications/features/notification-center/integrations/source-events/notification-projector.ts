import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { FulfillmentShipmentDeliveredPayload } from "@chase-sets/event-core/public-event-payloads";
import type { TransportEvent, TypedTransportEvent } from "@chase-sets/event-core/transport";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  mapOrderCreatedToNotification,
  mapPayoutReadinessRegressionToNotification,
  mapRestockDecisionPendingToNotification,
  mapSaleRecordedToNotification,
  mapSellerAvailabilityRestoredToNotification,
  mapShipmentDeliveredToNotification,
  mapStockCommittedToNotification,
  mapStockReturnedToNotification,
} from "./notification-intents";

export const NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION = "notifications-source-facts-outbox-projection";

type ReservationRequest = Readonly<{
  reservationRequestId: string;
  inventoryItemId: string;
  sellerAccountId: string;
  quantity: number;
  holdId?: string | null;
  status?: string | null;
}>;

type OrderCreatedEvent = TransportEvent &
  Readonly<{
    type: "ordering.order.created";
    data: Readonly<{
      orderId: string;
      buyerAccountId: AccountId;
      totalAmount: string;
      shippingDestinationSnapshot: Readonly<{ email?: string | null }>;
      reservationRequests?: readonly ReservationRequest[];
    }>;
  }>;

type OrderCancelledEvent = TransportEvent &
  Readonly<{
    type: "ordering.order.cancelled";
    data: Readonly<{
      orderId: string;
      reason?: string | null;
      reservationRequests?: readonly ReservationRequest[];
    }>;
  }>;

type ShipmentDeliveredEvent = TypedTransportEvent<
  FulfillmentShipmentDeliveredPayload,
  "fulfillment.shipment.delivered"
>;

type InventoryHoldConsumedEvent = TransportEvent &
  Readonly<{
    type: "inventory.hold.consumed";
    data: Readonly<{
      holdId: string;
      accountId?: AccountId | null;
      sellerAccountId?: AccountId | null;
      itemId?: string | null;
      quantity?: number | null;
      sourceRef?: Readonly<{ orderId?: string | null; reservationRequestId?: string | null }> | null;
      orderId?: string | null;
      shipmentId?: string | null;
    }>;
  }>;

type RestockDecisionPendingEvent = TransportEvent &
  Readonly<{
    type: "inventory.restock-decision.pending";
    data: Readonly<{
      decisionId?: string | null;
      sellerAccountId?: AccountId | null;
      accountId?: AccountId | null;
      orderId?: string | null;
      itemId?: string | null;
      quantity?: number | null;
    }>;
  }>;

type SellerListingAvailabilityEnabledEvent = TransportEvent &
  Readonly<{
    type: "marketplace.seller-listing-availability.enabled";
    data: Readonly<{
      accountId: AccountId;
      enabledAt: string;
      enabledBy?: "seller" | "scheduled";
    }>;
  }>;

type PayoutReadinessRecordedEvent = TransportEvent &
  Readonly<{
    type: "settlement.payout-readiness.recorded";
    data: Readonly<{
      accountId: AccountId;
      previousStatus?: string;
      status: string;
      missingRequirements?: readonly string[];
      disabledReason?: string | null;
      requirementsDeadline?: string | null;
      contactEmail?: string | null;
    }>;
  }>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectSourceEventToNotification(
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName: string,
) {
  const source = sourceFromEvent(event, projectionName);

  if (event.type === "ordering.order.created") {
    const data = event.data as OrderCreatedEvent["data"];
    await outbox.enqueueNotification({
      message: mapOrderCreatedToNotification({
        buyerAccountId: data.buyerAccountId,
        buyerEmail: data.shippingDestinationSnapshot.email,
        orderId: data.orderId,
        orderTotal: data.totalAmount,
        correlationId: correlationIdFromEvent(event),
      }),
      source,
    });
    for (const stockCommitment of stockCommitmentsBySeller(data.orderId, data.reservationRequests ?? [])) {
      await outbox.enqueueNotification({
        message: mapStockCommittedToNotification({
          ...stockCommitment,
          correlationId: correlationIdFromEvent(event),
        }),
        source,
      });
    }
    return;
  }

  if (event.type === "ordering.order.cancelled") {
    const data = event.data as OrderCancelledEvent["data"];
    for (const stockReturn of stockCommitmentsBySeller(
      data.orderId,
      releasedStockRequests(data.reservationRequests ?? []),
    )) {
      await outbox.enqueueNotification({
        message: mapStockReturnedToNotification({
          ...stockReturn,
          releaseReason: releaseReasonFromOrderCancellation(data.reason),
          correlationId: correlationIdFromEvent(event),
        }),
        source,
      });
    }
    return;
  }

  if (event.type === "fulfillment.shipment.delivered") {
    const data = (event as ShipmentDeliveredEvent).data;
    const trackingNumber = data.trackingIdentifier ?? data.shipmentId;
    await outbox.enqueueNotification({
      message: mapShipmentDeliveredToNotification({
        buyerAccountId: data.buyerAccountId,
        buyerEmail: data.shippingDestinationSnapshot.email,
        shipmentId: data.shipmentId,
        orderId: data.orderId,
        trackingNumber,
        correlationId: correlationIdFromEvent(event),
      }),
      source,
    });
    return;
  }

  if (event.type === "inventory.hold.consumed") {
    const data = event.data as InventoryHoldConsumedEvent["data"];
    const sellerAccountId = data.sellerAccountId ?? data.accountId ?? null;
    const orderId = data.orderId ?? data.sourceRef?.orderId ?? null;
    if (!sellerAccountId || !orderId) {
      return;
    }

    await outbox.enqueueNotification({
      message: mapSaleRecordedToNotification({
        sellerAccountId,
        orderId,
        itemId: data.itemId ?? null,
        lineCount: 1,
        totalQuantity: data.quantity ?? 1,
        shipmentId: data.shipmentId ?? null,
        correlationId: correlationIdFromEvent(event),
      }),
      source,
    });
    return;
  }

  if (event.type === "inventory.restock-decision.pending") {
    const data = event.data as RestockDecisionPendingEvent["data"];
    const sellerAccountId = data.sellerAccountId ?? data.accountId ?? null;
    if (!sellerAccountId || !data.orderId || !data.itemId) {
      return;
    }

    await outbox.enqueueNotification({
      message: mapRestockDecisionPendingToNotification({
        sellerAccountId,
        orderId: data.orderId,
        itemId: data.itemId,
        decisionId: data.decisionId ?? null,
        quantity: data.quantity ?? 1,
        correlationId: correlationIdFromEvent(event),
      }),
      source,
    });
    return;
  }

  if (event.type === "marketplace.seller-listing-availability.enabled") {
    const data = event.data as SellerListingAvailabilityEnabledEvent["data"];
    // Only the auto-resume sweep's restore is notification-worthy -- a
    // seller-initiated enable is the seller's own action, they already know.
    // Guarding on the fact itself (not the runner) means replays and
    // read-model rebuilds never re-notify.
    if (data.enabledBy !== "scheduled") {
      return;
    }

    await outbox.enqueueNotification({
      message: mapSellerAvailabilityRestoredToNotification({
        sellerAccountId: data.accountId,
        restoredAt: data.enabledAt,
        correlationId: correlationIdFromEvent(event),
      }),
      source,
    });
    return;
  }

  if (event.type === "settlement.payout-readiness.recorded") {
    const data = event.data as PayoutReadinessRecordedEvent["data"];
    const blockingRequirements = (data.missingRequirements ?? []).filter(Boolean);
    const isRegression =
      data.previousStatus === "ready" &&
      data.status !== "ready" &&
      (blockingRequirements.length > 0 || Boolean(data.disabledReason?.trim()));
    if (!isRegression) {
      return;
    }

    const reason = data.disabledReason?.trim() || `Required information: ${blockingRequirements.join(", ")}`;
    await outbox.enqueueNotification({
      message: mapPayoutReadinessRegressionToNotification({
        sellerAccountId: data.accountId,
        sellerEmail: data.contactEmail,
        reason,
        deadline: data.requirementsDeadline,
        transitionId: event.id,
        correlationId: correlationIdFromEvent(event),
      }),
      source,
    });
  }
}

export function buildNotificationsOrderingProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
): ProjectorHandlerMap {
  return {
    "ordering.order.created": (event) => projectSourceEventToNotification(outbox, event, projectionName),
    "ordering.order.cancelled": (event) => projectSourceEventToNotification(outbox, event, projectionName),
  };
}

export function buildNotificationsFulfillmentProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.delivered": (event) => projectSourceEventToNotification(outbox, event, projectionName),
  };
}

export function buildNotificationsInventoryProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
): ProjectorHandlerMap {
  return {
    "inventory.hold.consumed": (event) => projectSourceEventToNotification(outbox, event, projectionName),
    "inventory.restock-decision.pending": (event) => projectSourceEventToNotification(outbox, event, projectionName),
  };
}

export function buildNotificationsSettlementProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
): ProjectorHandlerMap {
  return {
    "settlement.payout-readiness.recorded": (event) => projectSourceEventToNotification(outbox, event, projectionName),
  };
}

export function buildNotificationsMarketplaceProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = NOTIFICATIONS_SOURCE_FACTS_OUTBOX_PROJECTION,
): ProjectorHandlerMap {
  return {
    "marketplace.seller-listing-availability.enabled": (event) =>
      projectSourceEventToNotification(outbox, event, projectionName),
  };
}

function sourceFromEvent(event: TransportEvent, projectionName: string) {
  return {
    sourceEventId: event.id,
    sourceGlobalPosition: event.globalPosition,
    projectionName,
    occurredAt: event.timing.occurredAt,
  };
}

function stockCommitmentsBySeller(orderId: string, reservationRequests: readonly ReservationRequest[]) {
  const bySeller = new Map<
    string,
    Readonly<{
      sellerAccountId: AccountId;
      orderId: string;
      itemId: string | null;
      lineCount: number;
      totalQuantity: number;
    }>
  >();

  for (const request of reservationRequests) {
    const sellerAccountId = request.sellerAccountId.trim() as AccountId;
    if (!sellerAccountId || request.quantity <= 0) {
      continue;
    }

    const current = bySeller.get(sellerAccountId);
    bySeller.set(sellerAccountId, {
      sellerAccountId,
      orderId,
      itemId: current?.itemId ?? request.inventoryItemId ?? null,
      lineCount: (current?.lineCount ?? 0) + 1,
      totalQuantity: (current?.totalQuantity ?? 0) + request.quantity,
    });
  }

  return [...bySeller.values()];
}

function releaseReasonFromOrderCancellation(reason: string | null | undefined) {
  return reason === "payment-deadline" ? "payment-deadline" : "order-cancelled";
}

function releasedStockRequests(reservationRequests: readonly ReservationRequest[]) {
  return reservationRequests.filter(
    (request) => Boolean(request.holdId) || request.status === "confirmed" || request.status === "released",
  );
}
