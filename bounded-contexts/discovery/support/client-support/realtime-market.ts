import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
  DiscoveryPublicAccount,
  DiscoveryPublicListing,
  DiscoverySearchResponse,
} from "./contracts";

export function applyDiscoverySearchPatch(
  data: DiscoverySearchResponse | null,
  patch: RealtimeProjectionPatch,
): DiscoverySearchResponse | null {
  if (!data) {
    return data;
  }

  let next = data;
  for (const change of patch.changes) {
    if (change.entity !== "discovery.marketSummary" || change.op !== "summary") {
      continue;
    }

    const itemIndex = next.items.findIndex((item) => item.catalog_item_id === change.id);
    if (itemIndex === -1) {
      continue;
    }

    const items = [...next.items];
    items[itemIndex] = {
      ...items[itemIndex],
      market_summary: change.value as DiscoverySearchResponse["items"][number]["market_summary"],
      updated_at: new Date().toISOString(),
    };
    next = { ...next, items };
  }

  return next;
}

export function applyDiscoveryItemPatch(
  data: DiscoveryItemDetail | null,
  patch: RealtimeProjectionPatch,
): DiscoveryItemDetail | null {
  if (!data) {
    return data;
  }

  let next = data;
  for (const change of patch.changes) {
    if (change.entity === "discovery.marketListing") {
      next = {
        ...next,
        market_listings: applyEntityListPatch(next.market_listings, "listing_id", change),
      };
    }

    if (change.entity === "discovery.buyerOffer") {
      next = {
        ...next,
        offer_demand_matches: applyEntityListPatch(next.offer_demand_matches, "offer_id", change),
      };
    }

    if (change.entity === "discovery.marketSummary" && change.op === "summary" && change.id === next.catalog_item_id) {
      next = {
        ...next,
        market_summary: change.value as DiscoveryItemDetail["market_summary"],
      };
    }
  }

  return next;
}

export function applyDiscoveryPublicListingPatch(
  listing: DiscoveryPublicListing | null,
  patch: RealtimeProjectionPatch,
): DiscoveryPublicListing | null {
  let next = listing;
  for (const change of patch.changes) {
    // The direct listing page tracks "discovery.publicListingDetail", not
    // "discovery.marketListing" -- the latter is gated on seller
    // availability (removed when a seller goes away) so search/browse stay
    // excluded, but this page renders a visible-but-unbuyable away/at-
    // capacity state instead of disappearing (m127).
    if (change.entity !== "discovery.publicListingDetail") {
      continue;
    }

    if (change.op === "remove" && next?.listing_id === change.id) {
      next = null;
    }

    if (change.op === "upsert" && (!next || next.listing_id === change.id)) {
      next = change.value as DiscoveryPublicListing;
    }
  }

  return next;
}

export function applyDiscoveryPublicAccountPatch(
  account: DiscoveryPublicAccount | null,
  patch: RealtimeProjectionPatch,
): DiscoveryPublicAccount | null {
  if (!account) {
    return account;
  }

  let next = account;
  for (const change of patch.changes) {
    if (change.entity === "discovery.marketListing" && (change.op === "upsert" || change.op === "remove")) {
      const listings = applyEntityListPatch(next.listings, "listing_id", change);
      next = {
        ...next,
        listings,
        active_listing_count: listings.length,
      };
    }

    if (change.entity === "discovery.publicAccount" && change.id === account.account_id) {
      if (change.op === "remove") {
        return null;
      }

      if (change.op === "upsert") {
        next = {
          ...next,
          ...(change.value as Partial<DiscoveryPublicAccount>),
        };
      }
    }
  }

  return next;
}

function applyEntityListPatch<T>(
  items: readonly T[],
  idField: keyof T,
  change: RealtimeProjectionPatch["changes"][number],
): T[] {
  const index = items.findIndex((item) => String(item[idField]) === change.id);

  if (change.op === "remove") {
    return index === -1 ? [...items] : items.filter((item) => item[idField] !== change.id);
  }

  if (change.op !== "upsert") {
    return [...items];
  }

  const value = change.value as T;
  if (index === -1) {
    return [...items, value];
  }

  const next = [...items];
  next[index] = value;
  return next;
}
