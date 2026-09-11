// Ordering-owned public event payloads.
//
// `MarketplaceSalesFeeLineSnapshotPayload` is Marketplace-owned (name and fee concept)
// even though `OrderingOrderCreatedPayload` embeds it, so it is imported, not redeclared.
import type { MarketplaceSalesFeeLineSnapshotPayload } from "./marketplace";

export type OrderingReservationRequestPayload = Readonly<{
  reservationRequestId: string;
  inventoryItemId: string;
  sellerAccountId: string;
  quantity: number;
  holdId?: string | null;
  status?: string;
}>;

/**
 * The neutral, non-PII subset of an order line that a downstream projection may record as a
 * classification input. It deliberately omits the item title, subtitle, product summary,
 * listing evidence, and the grading certification number: those are either buyer-facing
 * presentation or identifying detail no fact recorder needs.
 */
export type OrderingOrderLineSnapshotPayload = Readonly<{
  lineId: string;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  quantity: number;
  lineTotalAmount: string;
  gradedCard?: Readonly<{ gradingCompany: string; grade: string }> | null;
}>;

/**
 * Every field below the reservation requests is optional on decode because events written
 * before it was published are immutable and must still decode; each one is populated on
 * produce by the single Ordering emitter. `authenticityPlanSnapshot` is narrowed to the fee
 * amount alone -- the policy version, category, and threshold stay inside Ordering.
 */
export type OrderingOrderCreatedPayload = Readonly<{
  orderId: string;
  reservationRequests: readonly OrderingReservationRequestPayload[];
  sellerAccountId?: string;
  itemSubtotalAmount?: string;
  shippingChargeAmount?: string;
  shippingAllowanceAmount?: string;
  salesTaxAmount?: string;
  totalAmount?: string;
  authenticityPlanSnapshot?: Readonly<{ feeAmount: string }> | null;
  lines?: readonly OrderingOrderLineSnapshotPayload[];
  protectionAmount?: string;
  protectionAllowanceAmount?: string;
  protectionOverageAmount?: string;
  commercialTermsSnapshot?: Readonly<{
    marketplaceSalesFeeAmount: string;
    marketplaceSalesFeeLines?: readonly MarketplaceSalesFeeLineSnapshotPayload[];
  }>;
}>;

// `buyerAccountId` and `statusBeforeCancellation` are required on produce — both Ordering
// emitters populate them from aggregate state — and optional on decode, because events
// written before they existed are immutable and must still decode. `statusBeforeCancellation`
// mirrors `reason` as an open string: a published payload must decode values a future
// emitter writes, so the closed vocabulary stays inside the Ordering domain event type.
export type OrderingOrderCancelledPayload = Readonly<{
  orderId: string;
  cancelledAt: string;
  reason?: string | null;
  buyerEmail?: string | null;
  buyerAccountId?: string | null;
  statusBeforeCancellation?: string | null;
  reservationRequests: readonly OrderingReservationRequestPayload[];
}>;

export type OrderingEventPayloads = Readonly<{
  "ordering.order.created": OrderingOrderCreatedPayload;
  "ordering.order.cancelled": OrderingOrderCancelledPayload;
}>;
