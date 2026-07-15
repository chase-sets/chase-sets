// Marketplace's offer contribution to the Seller Desk attention queue — the
// offer-response source. A plain query module (no HTTP, no UI) that maps offers
// awaiting the seller's response into the shared attention item shape. When an
// offer carries an expiry, that expiry is its deadline and orders it ahead of
// undated work of the same severity.

import {
  buildSellerAttentionItem,
  type SellerAttentionContext,
  type SellerAttentionItem,
  type SellerAttentionSource,
} from "@chase-sets/seller-attention-queue";

// The projected fields the source reads from the offer read model. Only offers
// still awaiting the seller's response (submitted, on an available listing)
// appear.
export type OfferResponseAttentionRow = Readonly<{
  offerId: string;
  // Human display reference for the offer.
  reference: string;
  // ISO-8601 UTC expiry, or null when the offer has no clock.
  expiresAt: string | null;
  // ISO-8601 UTC time the offer arrived and needed a response.
  observedAt: string;
}>;

// Pure mapping: awaiting-response offer rows → attention items.
export function toOfferResponseAttentionItems(
  rows: readonly OfferResponseAttentionRow[],
): readonly SellerAttentionItem[] {
  return rows.map((row) =>
    buildSellerAttentionItem({
      source: "offer-response",
      entityId: row.offerId,
      severity: "warning",
      summary: { code: "offer-awaiting-response", params: { reference: row.reference } },
      dueAt: row.expiresAt,
      observedAt: row.observedAt,
    }),
  );
}

export type OfferResponseAttentionSourceDependencies = Readonly<{
  loadOfferResponseRows: (context: SellerAttentionContext) => Promise<readonly OfferResponseAttentionRow[]>;
}>;

export function createOfferResponseAttentionSource(
  dependencies: OfferResponseAttentionSourceDependencies,
): SellerAttentionSource {
  return {
    id: "offer-response",
    load: async (context) => toOfferResponseAttentionItems(await dependencies.loadOfferResponseRows(context)),
  };
}
