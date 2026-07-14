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

// Marketplace integration contract for the Support factual-responsibility fact.
//
// Support owns whose controllable action primarily caused an order problem and
// publishes it on `support.support-request.resolved` as
// `resolution.responsibility`, an explicit classification independent of the
// remedy (see the Support context's responsibility slice). This slice consumes
// that fact through this small anti-corruption boundary rather than importing
// Support's domain types or -- as it did previously -- re-deriving fault from
// refund-class remedy shortcuts. Remedy direction is NOT responsibility: a
// refund can accompany a carrier, platform, buyer, shared, or undetermined
// cause, none of which is a seller-controlled outcome.
//
// Only `seller` degrades a seller's behavioral standing. Every other value --
// including `undetermined` -- is an excluded cause that leaves the
// seller-responsible issue rate untouched. A missing or unrecognized value is
// not silently reinterpreted as seller responsibility; it fails safe to
// exclusion (see `normalizeConsumedResponsibility`) and is surfaced to
// operators as a missing-responsibility signal.
export const SELLER_METRICS_RESPONSIBILITY_VALUES = [
  "seller",
  "buyer",
  "carrier",
  "platform",
  "shared",
  "undetermined",
] as const;

export type SellerMetricsResponsibility = (typeof SELLER_METRICS_RESPONSIBILITY_VALUES)[number];

/**
 * Narrows an inbound Support responsibility value to the contract vocabulary.
 * Returns `null` for a missing or unrecognized value so the caller can persist
 * an explicit "responsibility unknown" marker (excluded from the numerator and
 * counted as a missing-responsibility signal) instead of guessing a cause.
 */
export function normalizeConsumedResponsibility(value: unknown): SellerMetricsResponsibility | null {
  return typeof value === "string" && (SELLER_METRICS_RESPONSIBILITY_VALUES as readonly string[]).includes(value)
    ? (value as SellerMetricsResponsibility)
    : null;
}

/** A seller-responsible outcome is the only responsibility that counts toward the seller-responsible issue rate. */
export function isSellerResponsible(responsibility: SellerMetricsResponsibility | null): boolean {
  return responsibility === "seller";
}
