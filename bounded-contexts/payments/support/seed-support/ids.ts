import type { PaymentId, TypedUlid } from "@chase-sets/primitives/typed-ids";

export type SeedRefundId = TypedUlid<"rfd">;

export const paymentsReservedSeedIds = {
  payments: {
    checkoutPending: "pay_seed_checkout_pending" as PaymentId,
    acceptedOfferCaptured: "pay_seed_offer_captured" as PaymentId,
    reviewEligibleCaptured: "pay_seed_review_eligible_captured" as PaymentId,
    failedModernCheckout: "pay_seed_failed_modern_checkout" as PaymentId,
    cancelledVintageCheckout: "pay_seed_cancelled_vintage_checkout" as PaymentId,
  },
  refunds: {
    acceptedOfferIssued: "rfd_seed_offer_issued" as SeedRefundId,
    acceptedOfferFailed: "rfd_seed_offer_failed" as SeedRefundId,
  },
} as const;
