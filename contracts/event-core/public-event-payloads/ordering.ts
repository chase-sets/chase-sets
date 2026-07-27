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

export type OrderingOrderCancelledPayload = Readonly<{
  orderId: string;
  cancelledAt: string;
  reason?: string | null;
  buyerEmail?: string | null;
  reservationRequests: readonly OrderingReservationRequestPayload[];
}>;

export type OrderingEventPayloads = Readonly<{
  "ordering.order.created": OrderingOrderCreatedPayload;
  "ordering.order.cancelled": OrderingOrderCancelledPayload;
}>;
