export const experienceSeedIds = {
  checkout: "pfb_seed_checkout",
  listing: "pfb_seed_listing",
  offer: "pfb_seed_offer",
  inventory: "pfb_seed_inventory",
} as const;

export const supportSeedIds = {
  supportRequests: {
    activeProductNotReceived: "sup_seed_active_product_not_received",
    selfServiceProductDamaged: "sup_seed_self_service_product_damaged",
    resolvedPartialRefund: "sup_seed_resolved_partial_refund",
  },
  evidence: {
    activeBuyerAttestation: "sev_seed_active_buyer_attestation",
    selfServiceBuyerAttestation: "sev_seed_self_service_buyer_attestation",
    selfServicePhoto: "sev_seed_self_service_photo",
    resolvedBuyerAttestation: "sev_seed_resolved_buyer_attestation",
    resolvedPhoto: "sev_seed_resolved_photo",
  },
} as const;

// Mirrors orderingReservedSeedIds.orders.acceptedOfferReady from
// bounded-contexts/ordering/support/seed-support/ids.ts without taking a
// package dependency on @chase-sets/ordering (which would create a
// marketplace -> platform-operations -> ordering -> marketplace cycle).
export const supportSeedOrderSourceIds = {
  acceptedOfferReady: "ord_seed_offer_ready",
} as const;
