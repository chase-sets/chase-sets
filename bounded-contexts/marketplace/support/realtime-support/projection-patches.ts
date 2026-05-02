import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";

export function createMarketplaceListingPatch(
  topics: readonly string[],
  listing: Readonly<{ listing_id: string }>,
): RealtimeProjectionPatch {
  return {
    kind: "projection.patch",
    context: "marketplace",
    projection: "marketplace-listing-projection",
    topics,
    changes: [
      {
        op: "upsert",
        entity: "marketplace.sellerListing",
        id: listing.listing_id,
        value: listing,
      },
    ],
  };
}

export function createMarketplaceOfferPatch(
  topics: readonly string[],
  offer: Readonly<{ offer_id: string }>,
): RealtimeProjectionPatch {
  return {
    kind: "projection.patch",
    context: "marketplace",
    projection: "marketplace-offer-projection",
    topics,
    changes: [
      {
        op: "upsert",
        entity: "marketplace.offer",
        id: offer.offer_id,
        value: offer,
      },
    ],
  };
}

export function createMarketplaceOfferMatchPatch(
  topics: readonly string[],
  offerId: string,
  offerMatch: Readonly<{ offer_id: string }> | null,
): RealtimeProjectionPatch {
  return {
    kind: "projection.patch",
    context: "marketplace",
    projection: "marketplace-offer-projection",
    topics,
    changes: [
      offerMatch
        ? {
            op: "upsert",
            entity: "marketplace.offerMatch",
            id: offerMatch.offer_id,
            value: offerMatch,
          }
        : {
            op: "remove",
            entity: "marketplace.offerMatch",
            id: offerId,
          },
    ],
  };
}
