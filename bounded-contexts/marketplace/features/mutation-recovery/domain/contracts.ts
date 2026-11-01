import { z } from "zod";

export const marketplaceAttemptIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
export const marketplaceAcceptanceKeySchema = z
  .string()
  .max(512)
  .refine(
    (key) =>
      marketplaceAttemptIdSchema.safeParse(key).success ||
      /^sell-confirm:[!-9;-~]{1,128}:[!-9;-~]{1,128}:(selected|match):[!-9;-~]{1,128}$/.test(key),
  );
export const recoveryHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_:.,=|%-]+$/);
export const marketplaceListingMutationKinds = [
  "listing.create",
  "listing.publish",
  "listing.update-price",
  "listing.update-quantity",
  "listing.update-purchase-limits",
  "listing.pause",
  "listing.withdraw",
  "seller.availability",
  "seller.away",
  "seller.order-capacity",
] as const;
export const marketplaceMutationKindSchema = z.enum([
  "offer.accept",
  "offer.submit",
  "offer.update-price",
  "offer.decline",
  "offer-policy.command",
  ...marketplaceListingMutationKinds,
]);
export type MarketplaceMutationKind = z.infer<typeof marketplaceMutationKindSchema>;
export type MarketplaceListingMutationKind = (typeof marketplaceListingMutationKinds)[number];
export const marketplaceRecoveryTargetSchema = z.strictObject({
  kind: z.enum(["offer", "product", "offer-policy", "inventory-item", "listing", "seller"]),
  id: identity,
});
export type MarketplaceRecoveryTarget = z.infer<typeof marketplaceRecoveryTargetSchema>;

export function isMarketplaceListingMutationKind(kind: string): kind is MarketplaceListingMutationKind {
  return (marketplaceListingMutationKinds as readonly string[]).includes(kind);
}

export function marketplaceRecoveryTargetKind(kind: MarketplaceMutationKind): MarketplaceRecoveryTarget["kind"] {
  if (kind === "offer.submit") return "product";
  if (kind === "offer-policy.command") return "offer-policy";
  if (kind === "listing.create") return "inventory-item";
  if (kind.startsWith("listing.")) return "listing";
  if (kind.startsWith("seller.")) return "seller";
  return "offer";
}
export const marketplaceOwnerReceiptSchema = z.strictObject({
  id: identity,
  version: z.number().int().nonnegative().safe(),
});
export const marketplaceMutationRecoveryResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mutationKind: marketplaceMutationKindSchema,
  attemptKeyFingerprint: recoveryHashSchema,
  actorBinding: z.strictObject({ accountId: identity }),
  target: marketplaceRecoveryTargetSchema,
  canonicalRequestHash: recoveryHashSchema,
  ownerStatus: z.enum(["not-observed", "prepared", "committed", "partial", "conflict", "failed-safe", "ambiguous"]),
  reason: z.literal("history-incomplete").optional(),
  ownerReceipt: marketplaceOwnerReceiptSchema.optional(),
});
export type MarketplaceMutationRecoveryResult = z.infer<typeof marketplaceMutationRecoveryResultSchema>;

export function canonicalMarketplaceRequest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalMarketplaceRequest).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalMarketplaceRequest(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function marketplaceCanonicalRequest(kind: MarketplaceMutationKind, input: unknown): unknown {
  if (kind === "offer-policy.command" || input === null) return input;
  const request = input as Record<string, unknown>;
  return isMarketplaceListingMutationKind(kind)
    ? marketplaceListingCanonicalRequest(kind, request)
    : marketplaceOfferCanonicalRequest(kind, request);
}

/** Normalizes a decimal money amount so `10`, `10.0` and `010.00` compare equal; anything else stays as sent. */
export function canonicalMarketplaceMoneyAmount(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  const match = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(value);
  if (!match) return value;
  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function canonicalPurchaseLimits(value: unknown) {
  const limits = (value ?? {}) as Record<string, unknown>;
  return {
    maxUnitsPerOrder: limits.maxUnitsPerOrder ?? null,
    maxUnitsPerDay: limits.maxUnitsPerDay ?? null,
    maxUnitsPerCustomerAccount: limits.maxUnitsPerCustomerAccount ?? null,
  };
}

/** Every business field of a Listing or seller-account command; amount and currency compare together. */
export function marketplaceListingCanonicalRequest(
  kind: MarketplaceListingMutationKind,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case "listing.create":
      return {
        inventoryItemId: input.inventoryItemId,
        listingIdOverride: input.listingIdOverride ?? null,
        publicationScope: input.publicationScope ?? "native",
        priceAmount: canonicalMarketplaceMoneyAmount(input.priceAmount),
        priceCurrencyCode: input.priceCurrencyCode,
        quantityCap: input.quantityCap,
        purchaseLimits: canonicalPurchaseLimits(input.purchaseLimits),
      };
    case "listing.publish":
    case "listing.withdraw":
      return { listingId: input.listingId };
    case "listing.update-price":
      return {
        listingId: input.listingId,
        priceAmount: canonicalMarketplaceMoneyAmount(input.priceAmount),
        priceCurrencyCode: input.priceCurrencyCode,
      };
    case "listing.update-quantity":
      return {
        listingId: input.listingId,
        quantityCap: input.quantityCap,
        purchaseLimits: input.purchaseLimits == null ? null : canonicalPurchaseLimits(input.purchaseLimits),
      };
    case "listing.update-purchase-limits":
      return { listingId: input.listingId, purchaseLimits: canonicalPurchaseLimits(input.purchaseLimits) };
    case "listing.pause":
      return { listingId: input.listingId, reason: input.reason ?? "seller" };
    case "seller.availability":
      return {
        status: input.status,
        reasonCategory: input.reasonCategory ?? null,
        availableAgainOn: input.availableAgainOn ?? null,
        availableAgainAt: input.availableAgainAt ?? null,
      };
    case "seller.away":
      return {
        action: input.action,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        reasonCategory: input.reasonCategory ?? null,
      };
    case "seller.order-capacity":
      return { maxOpenOrders: input.maxOpenOrders ?? null };
  }
}

export function marketplaceOfferCanonicalRequest(
  kind: MarketplaceMutationKind,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "offer.accept")
    return {
      offerId: input.offerId,
      listingId: input.listingId,
      feeQuoteFingerprint: input.feeQuoteFingerprint ?? null,
      acceptanceBatchId: input.acceptanceBatchId ?? null,
      acceptanceBatchSize: input.acceptanceBatchSize ?? null,
    };
  if (kind === "offer.decline") return { offerId: input.offerId };
  if (kind === "offer.update-price")
    return { offerId: input.offerId, priceAmount: input.priceAmount, priceCurrencyCode: input.priceCurrencyCode };
  const address = input.shippingDestinationSnapshot as Record<string, unknown> | undefined;
  return {
    offerId: input.offerId,
    counteredOfferId: input.counteredOfferId,
    catalogItemId: input.catalogItemId,
    productId: input.productId,
    itemTitle: input.itemTitle,
    itemSubtitle: input.itemSubtitle ?? null,
    selectedOptions: input.selectedOptions ?? [],
    productSummary: input.productSummary ?? null,
    shippingDestinationSnapshot: {
      name: address?.name,
      company: address?.company ?? null,
      line1: address?.line1,
      line2: address?.line2 ?? null,
      city: address?.city,
      state: address?.state,
      postalCode: address?.postalCode,
      country: address?.country ?? "US",
      phone: address?.phone ?? null,
      email: address?.email ?? null,
    },
    priceAmount: input.priceAmount,
    priceCurrencyCode: input.priceCurrencyCode,
    quantityRequested: input.quantityRequested,
  };
}
