import type { TransportEvent } from "@chase-sets/event-core/transport";

/**
 * Maps marketplace order-lifecycle domain events onto the UCP order-update
 * payload shape pushed to agent platforms (issue #3755).
 *
 * UCP order-update semantics recognise a small status vocabulary; ChatGPT and
 * Gemini shopping surfaces expect shipped/delivered/refunded to arrive without
 * the user asking. We keep the payload deliberately thin — the agent re-reads
 * detail via `order:read` — and carry only the fields needed to route and render
 * the update. An ACP-shaped adapter can wrap this later without reshaping it.
 */
export type AgentOrderUpdateStatus = "created" | "shipped" | "delivered" | "cancelled" | "refunded";

export const AGENT_ORDER_UPDATE_TYPE = "order.updated";

export type AgentOrderUpdatePayload = Readonly<{
  type: typeof AGENT_ORDER_UPDATE_TYPE;
  specVersion: string;
  order: Readonly<{
    id: string;
    status: AgentOrderUpdateStatus;
  }>;
  data: Readonly<Record<string, string | number | boolean | null>>;
  occurredAt: string;
  sourceEventId: string;
}>;

export type MappedOrderUpdate = Readonly<{
  status: AgentOrderUpdateStatus;
  /** Every order this event touches (refunds may span multiple orders). */
  orderIds: readonly string[];
  /**
   * Buyer account carried directly on the event, when present. Events that do
   * not carry it (dispatch, cancellation, refund) are resolved by the projector
   * via an order → recipient lookup port.
   */
  recipientAccountId: string | null;
  buildPayload: (orderId: string) => AgentOrderUpdatePayload;
}>;

const AGENT_ORDER_UPDATE_SPEC_VERSION = "ucp.order-update.2026-04-17";

type OrderCreatedData = Readonly<{
  orderId: string;
  buyerAccountId?: string | null;
  totalAmount?: string | null;
  sellerAccountId?: string | null;
}>;

type OrderCancelledData = Readonly<{
  orderId: string;
  reason?: string | null;
  cancelledAt?: string | null;
}>;

type ShipmentDispatchedData = Readonly<{
  shipmentId: string;
  dispatchedAt?: string | null;
}>;

type ShipmentDeliveredData = Readonly<{
  shipmentId: string;
  orderId: string;
  buyerAccountId?: string | null;
  trackingIdentifier?: string | null;
  deliveredAt?: string | null;
}>;

type RefundIssuedData = Readonly<{
  refundId: string;
  orderIds?: readonly string[] | null;
  amount?: string | null;
  currencyCode?: string | null;
  issuedAt?: string | null;
}>;

/**
 * Some lifecycle events (shipment dispatched) reference only the shipment. The
 * projector resolves `shipmentId → orderId` before mapping, and passes the
 * resolved order id back in via `resolvedOrderId`.
 */
export type OrderUpdateMappingContext = Readonly<{
  resolvedOrderId?: string | null;
}>;

export function mapOrderLifecycleEventToOrderUpdate(
  event: TransportEvent,
  context: OrderUpdateMappingContext = {},
): MappedOrderUpdate | null {
  switch (event.type) {
    case "ordering.order.created": {
      const data = event.data as OrderCreatedData;
      if (!data.orderId) return null;
      return singleOrderUpdate(event, "created", data.orderId, data.buyerAccountId ?? null, {
        totalAmount: data.totalAmount ?? null,
        sellerAccountId: data.sellerAccountId ?? null,
      });
    }
    case "fulfillment.shipment.dispatched": {
      const data = event.data as ShipmentDispatchedData;
      const orderId = context.resolvedOrderId ?? null;
      if (!orderId) return null;
      return singleOrderUpdate(event, "shipped", orderId, null, {
        shipmentId: data.shipmentId,
        dispatchedAt: data.dispatchedAt ?? null,
      });
    }
    case "fulfillment.shipment.delivered": {
      const data = event.data as ShipmentDeliveredData;
      if (!data.orderId) return null;
      return singleOrderUpdate(event, "delivered", data.orderId, data.buyerAccountId ?? null, {
        shipmentId: data.shipmentId,
        trackingIdentifier: data.trackingIdentifier ?? null,
        deliveredAt: data.deliveredAt ?? null,
      });
    }
    case "ordering.order.cancelled": {
      const data = event.data as OrderCancelledData;
      if (!data.orderId) return null;
      return singleOrderUpdate(event, "cancelled", data.orderId, null, {
        reason: data.reason ?? null,
        cancelledAt: data.cancelledAt ?? null,
      });
    }
    case "payments.refund-issued": {
      const data = event.data as RefundIssuedData;
      const orderIds = (data.orderIds ?? []).filter((id): id is string => typeof id === "string" && id.length > 0);
      if (orderIds.length === 0) return null;
      return {
        status: "refunded",
        orderIds,
        recipientAccountId: null,
        buildPayload: (orderId) =>
          orderUpdatePayload(event, "refunded", orderId, {
            refundId: data.refundId,
            amount: data.amount ?? null,
            currencyCode: data.currencyCode ?? null,
            issuedAt: data.issuedAt ?? null,
          }),
      };
    }
    default:
      return null;
  }
}

function singleOrderUpdate(
  event: TransportEvent,
  status: AgentOrderUpdateStatus,
  orderId: string,
  recipientAccountId: string | null,
  data: Readonly<Record<string, string | number | boolean | null>>,
): MappedOrderUpdate {
  return {
    status,
    orderIds: [orderId],
    recipientAccountId,
    buildPayload: (targetOrderId) => orderUpdatePayload(event, status, targetOrderId, data),
  };
}

function orderUpdatePayload(
  event: TransportEvent,
  status: AgentOrderUpdateStatus,
  orderId: string,
  data: Readonly<Record<string, string | number | boolean | null>>,
): AgentOrderUpdatePayload {
  return {
    type: AGENT_ORDER_UPDATE_TYPE,
    specVersion: AGENT_ORDER_UPDATE_SPEC_VERSION,
    order: { id: orderId, status },
    data,
    occurredAt: event.timing.occurredAt,
    sourceEventId: event.id,
  };
}
