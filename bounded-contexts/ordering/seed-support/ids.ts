import type { OrderId } from "@chase-sets/primitives/typed-ids";

export const orderingReservedSeedIds = {
  orders: {
    checkoutPending: "ord_seed_checkout_pending" as OrderId,
    cancelled: "ord_seed_cancelled" as OrderId,
    acceptedOfferReady: "ord_seed_offer_ready" as OrderId,
  },
} as const;
