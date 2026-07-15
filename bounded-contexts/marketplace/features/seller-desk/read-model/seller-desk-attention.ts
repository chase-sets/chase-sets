// Seller Desk home read-model wiring — composes the marketplace-owned attention
// sources (offers awaiting a response, listings needing action) into the shared
// Seller Desk attention queue. The cross-context sources (fulfillment ship-by,
// blocked payouts, import resolution, disputes) are supplied by their owning
// contexts and passed in alongside these; this module never re-declares the
// ordering policy or the item shape — it imports both from the read-model
// contract so the Desk home and the MCP seller tools cannot diverge.

import {
  aggregateSellerAttentionQueue,
  type SellerAttentionContext,
  type SellerAttentionQueue,
  type SellerAttentionSource,
} from "@chase-sets/seller-attention-queue";
import {
  createOfferResponseAttentionSource,
  type OfferResponseAttentionRow,
} from "../../offers/read-model/seller-attention-source";
import {
  createListingActionAttentionSource,
  type ListingActionAttentionRow,
} from "../../listings/read-model/seller-attention-source";
import type { OfferMatchListItem } from "../../offers/ui/contracts";
import type { MarketplaceListingListItem } from "../../listings/ui/contracts";

// A matched offer is awaiting the seller's response while it is still submitted:
// once accepted (or seller-declined into a terminal state) it no longer needs
// the seller and drops out of the queue.
const OFFER_AWAITING_RESPONSE_STATUS = "submitted";

// Listing statuses that still need the seller to act — a draft the seller has
// not published yet, or a listing the seller paused and may want to resume.
const LISTING_ACTION_STATUSES: ReadonlySet<string> = new Set(["draft", "paused"]);

// Map matched-offer rows into the offer-response source's row shape. Only offers
// still awaiting the seller's response contribute; the offer's arrival time is
// its age tiebreak and it carries no deadline (matched offers have no expiry
// clock here, so `expiresAt` is null and the item sorts undated).
export function offerMatchesToAttentionRows(
  offers: readonly OfferMatchListItem[],
): readonly OfferResponseAttentionRow[] {
  return offers
    .filter((offer) => offer.status === OFFER_AWAITING_RESPONSE_STATUS)
    .map((offer) => ({
      offerId: offer.offer_id,
      reference: offer.item_title,
      expiresAt: null,
      observedAt: offer.created_at,
    }));
}

// Map seller listing rows into the listing-action source's row shape. Only
// listings in an actionable status contribute, and the status names which action
// the listing needs; the last update is when it entered that state.
export function sellerListingsToAttentionRows(
  listings: readonly MarketplaceListingListItem[],
): readonly ListingActionAttentionRow[] {
  return listings
    .filter((listing) => LISTING_ACTION_STATUSES.has(listing.status))
    .map((listing) => ({
      listingId: listing.listing_id,
      reference: listing.item_title ?? listing.listing_id,
      action: listing.status,
      observedAt: listing.updated_at,
    }));
}

export type MarketplaceSellerAttentionDependencies = Readonly<{
  // Load the seller's matched offers. Injected so the source itself performs the
  // read: a failure degrades only the offer-response row, never the whole queue.
  loadOfferMatches: () => Promise<readonly OfferMatchListItem[]>;
  // Load the seller's listings. Injected for the same per-source degradation.
  loadSellerListings: () => Promise<readonly MarketplaceListingListItem[]>;
}>;

// Build the two marketplace-owned attention sources. Each source's injected
// loader performs its own read and maps it through the owning-slice factory, so
// the aggregation degrades one source at a time — a failed offer read leaves the
// listing signal intact and vice versa.
export function createMarketplaceSellerAttentionSources(
  dependencies: MarketplaceSellerAttentionDependencies,
): readonly SellerAttentionSource[] {
  return [
    createOfferResponseAttentionSource({
      loadOfferResponseRows: async () => offerMatchesToAttentionRows(await dependencies.loadOfferMatches()),
    }),
    createListingActionAttentionSource({
      loadListingActionRows: async () => sellerListingsToAttentionRows(await dependencies.loadSellerListings()),
    }),
  ];
}

// Compose the supplied sources into the ordered, per-source-degrading queue. A
// thin pass-through over the contract's aggregation so the Desk loader and the
// tests share one composition seam.
export async function loadSellerDeskAttentionQueue(
  sources: readonly SellerAttentionSource[],
  context: SellerAttentionContext,
): Promise<SellerAttentionQueue> {
  return aggregateSellerAttentionQueue(sources, context);
}
