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

export type OrderingOrderCreatedPayload = Readonly<{
  orderId: string;
  reservationRequests: readonly OrderingReservationRequestPayload[];
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
