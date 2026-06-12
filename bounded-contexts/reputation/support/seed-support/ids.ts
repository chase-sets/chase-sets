import type { ReviewId } from "@chase-sets/primitives/typed-ids";

export const reputationReservedSeedIds = {
  reviews: {
    buyerToSellerActive: "rev_seed_buyer_to_seller_active" as ReviewId,
    sellerToBuyerWithdrawn: "rev_seed_seller_to_buyer_withdrawn" as ReviewId,
  },
} as const;
