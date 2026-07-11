// The literal cancellation-reason vocabulary ordering's application layer
// assigns at command-dispatch time
// (bounded-contexts/ordering/features/orders/api/runtime.ts: cancelPurchase
// -> "buyer-cancelled", cancelSale -> "seller-cancelled", the
// payment-deadline sweep -> "payment-deadline"). `ordering.order.cancelled`'s
// `reason` field is free text at the domain-type level (no shared enum
// exists to import), so this constant is the seller-metrics slice's own
// pointer to that convention -- kept in one place rather than duplicated
// across the source projection and the read-model recompute.
export const SELLER_CAUSED_CANCELLATION_REASON = "seller-cancelled";
