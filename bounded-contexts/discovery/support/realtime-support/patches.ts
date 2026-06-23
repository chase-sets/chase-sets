import type { RealtimeProjectionPatch, RealtimeProjectionPatchChange } from "@chase-sets/platform-runtime/realtime";

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
    product_measure_snapshot?: unknown;
    supply_total_quantity?: unknown;
    active_held_quantity?: unknown;
    visible_quantity?: number | null;
    seller_listing_availability_status?: string | null;
  }>,
  summary: unknown,
): RealtimeProjectionPatch {
  const { product_measure_snapshot, supply_total_quantity, active_held_quantity, ...publicListing } = listing;
  void supply_total_quantity;
  void active_held_quantity;

  const isPubliclyBuyable =
    listing.status === "active" &&
    listing.seller_listing_availability_status === "available" &&
    typeof product_measure_snapshot === "object" &&
    product_measure_snapshot !== null &&
    Number(listing.visible_quantity ?? 0) > 0;

  return createDiscoveryProjectionPatch(topics, [
    isPubliclyBuyable
      ? {
          op: "upsert",
          entity: "discovery.marketListing",
          id: listing.listing_id,
          value: publicListing,
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

export function createDiscoveryAccountUpsertPatch(
  topics: readonly string[],
  account: unknown,
  accountId: string,
): RealtimeProjectionPatch {
  return createDiscoveryProjectionPatch(topics, [
    {
      op: "upsert",
      entity: "discovery.publicAccount",
      id: accountId,
      value: account,
    },
  ]);
}

export function createDiscoveryAccountRemovePatch(
  topics: readonly string[],
  accountId: string,
): RealtimeProjectionPatch {
  return createDiscoveryProjectionPatch(topics, [{ op: "remove", entity: "discovery.publicAccount", id: accountId }]);
}
