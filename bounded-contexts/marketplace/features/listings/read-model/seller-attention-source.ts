// Marketplace's listing contribution to the Seller Desk attention queue — the
// listing-action source. A plain query module (no HTTP, no UI) that maps
// listings needing the seller's attention into the shared attention item shape.
// Listing work is the quietest source (its peak severity is info), so a stale
// listing never outranks a ship-by deadline or blocked money.

import {
  buildSellerAttentionItem,
  type SellerAttentionContext,
  type SellerAttentionItem,
  type SellerAttentionSource,
} from "@chase-sets/seller-attention-queue";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

// The projected fields the source reads from the listing read model. Only
// listings the seller can act on — gone unavailable, missing evidence, or with
// repricing paused — appear; `action` names which.
export type ListingActionAttentionRow = Readonly<{
  listingId: string;
  // Human display reference for the listing.
  reference: string;
  // The kind of attention the listing needs (e.g. unavailable, missing-evidence).
  action: string;
  // ISO-8601 UTC time the listing began needing attention.
  observedAt: string;
}>;

// Pure mapping: listing rows → attention items.
export function toListingActionAttentionItems(
  rows: readonly ListingActionAttentionRow[],
): readonly SellerAttentionItem[] {
  return rows.map((row) =>
    buildSellerAttentionItem({
      source: "listing-action",
      entityId: row.listingId,
      severity: "info",
      summary: { code: "listing-needs-action", params: { reference: row.reference, action: row.action } },
      observedAt: row.observedAt,
    }),
  );
}

export type ListingActionAttentionSourceDependencies = Readonly<{
  loadListingActionRows: (context: SellerAttentionContext) => Promise<readonly ListingActionAttentionRow[]>;
}>;

export function createListingActionAttentionSource(
  dependencies: ListingActionAttentionSourceDependencies,
): SellerAttentionSource {
  return {
    id: "listing-action",
    load: async (context) => toListingActionAttentionItems(await dependencies.loadListingActionRows(context)),
  };
}

export function createListingActionAttentionSourceFromReadModel(db: PgQueryable): SellerAttentionSource {
  return createListingActionAttentionSource({
    loadListingActionRows: async (context) => {
      const result = await db.query<{
        listing_id: string;
        item_title: string | null;
        status: string;
        updated_at: string;
      }>(
        `SELECT listing_id, item_title, status, updated_at
         FROM marketplace_listing_pages
         WHERE account_id = $1
           AND status IN ('draft', 'paused')
         ORDER BY updated_at ASC, listing_id ASC`,
        [context.accountId],
      );

      return result.rows.map((row) => ({
        listingId: row.listing_id,
        reference: row.item_title ?? row.listing_id,
        action: row.status,
        observedAt: row.updated_at,
      }));
    },
  });
}
