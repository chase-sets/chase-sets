import type {
  RealtimeProjectionPatch,
  RealtimeProjectionPatchChange,
} from "@chase-sets/platform-runtime/realtime";

const DISCOVERY_MARKET_PROJECTION = "discovery-market-projection";

export function createDiscoveryProjectionPatch(
  topics: readonly string[],
  changes: readonly RealtimeProjectionPatchChange[],
): RealtimeProjectionPatch {
  return {
    kind: "projection.patch",
    context: "discovery",
    projection: DISCOVERY_MARKET_PROJECTION,
    topics,
    changes,
  };
}

export function createDiscoveryListingPatch(
  topics: readonly string[],
  listing: Readonly<{
    listing_id: string;
    catalog_catalog_item_id: string;
    status: string;
  }>,
  summary: unknown,
): RealtimeProjectionPatch {
  return createDiscoveryProjectionPatch(topics, [
    listing.status === "active"
      ? {
          op: "upsert",
          entity: "discovery.marketListing",
          id: listing.listing_id,
          value: listing,
        }
      : {
          op: "remove",
          entity: "discovery.marketListing",
          id: listing.listing_id,
        },
    {
      op: "summary",
      entity: "discovery.marketSummary",
      id: listing.catalog_catalog_item_id,
      value: summary,
    },
  ]);
}

export function createDiscoveryOfferPatch(
  topics: readonly string[],
  offer: Readonly<{
    offer_id: string;
    status: string;
  }>,
): RealtimeProjectionPatch {
  return createDiscoveryProjectionPatch(topics, [
    offer.status === "submitted"
      ? {
          op: "upsert",
          entity: "discovery.buyerOffer",
          id: offer.offer_id,
          value: offer,
        }
      : {
          op: "remove",
          entity: "discovery.buyerOffer",
          id: offer.offer_id,
        },
  ]);
}

export function createDiscoverySellerUpsertPatch(
  topics: readonly string[],
  seller: unknown,
  sellerId: string,
): RealtimeProjectionPatch {
  return createDiscoveryProjectionPatch(topics, [
    {
      op: "upsert",
      entity: "discovery.publicSeller",
      id: sellerId,
      value: seller,
    },
  ]);
}

export function createDiscoverySellerRemovePatch(
  topics: readonly string[],
  sellerId: string,
): RealtimeProjectionPatch {
  return createDiscoveryProjectionPatch(topics, [
    { op: "remove", entity: "discovery.publicSeller", id: sellerId },
  ]);
}
