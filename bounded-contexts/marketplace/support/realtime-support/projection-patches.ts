import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import { omitPrivateOfferResponseFields, submittedOfferResponse } from "../../features/offers/api/response-shape";
import { marketplaceRealtimeTopics } from "./topics";

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

export function createMarketplaceSubmittedOfferPatch(
  buyerAccountId: string,
  offer: Readonly<{ offer_id: string; offers_away?: boolean }>,
): RealtimeProjectionPatch {
  return {
    kind: "projection.patch",
    context: "marketplace",
    projection: "marketplace-offer-projection",
    topics: [marketplaceRealtimeTopics.accountOffers(buyerAccountId)],
    changes: [
      {
        op: "upsert",
        entity: "marketplace.offer",
        id: offer.offer_id,
        value: submittedOfferResponse(offer),
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
            value: omitPrivateOfferResponseFields(offerMatch),
          }
        : {
            op: "remove",
            entity: "marketplace.offerMatch",
            id: offerId,
          },
    ],
  };
}
