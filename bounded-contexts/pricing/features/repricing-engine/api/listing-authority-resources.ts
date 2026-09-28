import { createHash } from "node:crypto";
import type { RepricingRoundInputs } from "../read-model/queries";

const key = (parts: readonly string[]) => JSON.stringify(parts);

export const pricingAuthorityResources = {
  account: (accountId: string) => `repricing-account/${key([accountId])}`,
  product: (catalogItemId: string, productId: string) => `repricing-product/${key([catalogItemId, productId])}`,
  catalogItem: (catalogItemId: string) => `repricing-catalog/${key([catalogItemId])}`,
  inventoryItem: (itemId: string) => `repricing-inventory/${key([itemId])}`,
  listing: (listingId: string) => `repricing-listing/${key([listingId])}`,
  policy: (policyKey: string) => `repricing-platform-policy/${key([policyKey])}`,
  decision: (evaluationId: string) => `repricing-decision/${key([evaluationId])}`,
};

export function pricingEvaluationResources(round: RepricingRoundInputs, listingId: string): readonly string[] {
  const listing = round.listings.find((entry) => entry.listingId === listingId);
  if (!listing) throw new Error("Pricing evaluation has no assigned listing.");
  return [
    ...new Set([
      pricingAuthorityResources.account(listing.sellerAccountId),
      pricingAuthorityResources.product(listing.catalogItemId, listing.productId),
      pricingAuthorityResources.catalogItem(listing.catalogItemId),
      pricingAuthorityResources.listing(listingId),
      pricingAuthorityResources.policy("pricing.repricing-engine"),
      ...(listing.inventoryItemId ? [pricingAuthorityResources.inventoryItem(listing.inventoryItemId)] : []),
      // A newly inserted policy changes an otherwise hard competing ask into a leaf.
      ...round.competingAsks.map((ask) => pricingAuthorityResources.account(ask.sellerAccountId)),
    ]),
  ].sort();
}

export function pricingAuthorityDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
