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
  "offer-payment-authorization.command",
  "review.submit",
  "review.reply",
  "review.report",
  "listing.report",
  ...marketplaceListingMutationKinds,
]);
export type MarketplaceMutationKind = z.infer<typeof marketplaceMutationKindSchema>;
export type MarketplaceListingMutationKind = (typeof marketplaceListingMutationKinds)[number];
export const marketplaceRecoveryTargetSchema = z.strictObject({
  kind: z.enum([
    "offer",
    "product",
    "offer-policy",
    "offer-payment-authorization",
    "inventory-item",
    "listing",
    "seller",
    "order",
    "review",
  ]),
  id: identity,
});
export type MarketplaceRecoveryTarget = z.infer<typeof marketplaceRecoveryTargetSchema>;

export function isMarketplaceListingMutationKind(kind: string): kind is MarketplaceListingMutationKind {
  return (marketplaceListingMutationKinds as readonly string[]).includes(kind);
}

export function marketplaceRecoveryTargetKind(kind: MarketplaceMutationKind): MarketplaceRecoveryTarget["kind"] {
  if (kind === "review.submit") return "order";
  if (kind === "review.reply" || kind === "review.report") return "review";
  if (kind === "offer.submit") return "product";
  if (kind === "offer-policy.command") return "offer-policy";
  if (kind === "offer-payment-authorization.command") return "offer-payment-authorization";
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
  if (kind === "offer-policy.command" || kind === "offer-payment-authorization.command" || input === null) return input;
  const request = input as Record<string, unknown>;
  if (kind === "review.submit")
    return {
      orderId: request.orderId,
      subjectAccountId: request.subjectAccountId,
      rating: request.rating,
      feedback: canonicalReviewText(request.feedback),
    };
  if (kind === "review.reply") return { reviewId: request.reviewId, feedback: canonicalReviewText(request.feedback) };
  if (kind === "review.report" || kind === "listing.report")
    return { targetId: request.targetId, reason: request.reason, details: canonicalReviewText(request.details) };
  return isMarketplaceListingMutationKind(kind)
    ? marketplaceListingCanonicalRequest(kind, request)
    : marketplaceOfferCanonicalRequest(kind, request);
}

function canonicalReviewText(value: unknown) {
  return typeof value === "string" ? value.trim() || null : (value ?? null);
}

/** Normalizes a decimal money amount so `10`, `10.0` and `010.00` compare equal; anything else stays as sent. */
export function canonicalMarketplaceMoneyAmount(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const digits = match[1]!;
  let start = 0;
  while (start < digits.length - 1 && digits[start] === "0") start++;
  const whole = digits.slice(start);
  const decimals = match[2] ?? "";
  let end = decimals.length;
  while (end > 0 && decimals[end - 1] === "0") end--;
  const fraction = decimals.slice(0, end);
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

function canonicalSellerFormText(value: unknown) {
  return typeof value === "string" ? value.trim() || null : (value ?? null);
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
        reasonCategory: canonicalSellerFormText(input.reasonCategory),
        availableAgainOn: canonicalSellerFormText(input.availableAgainOn),
        availableAgainAt: canonicalSellerFormText(input.availableAgainAt),
        ...(input.scope === "offers" || input.scope === "both" ? { scope: input.scope } : {}),
      };
    case "seller.away":
      return {
        action: input.action,
        startsAt: canonicalSellerFormText(input.startsAt),
        endsAt: canonicalSellerFormText(input.endsAt),
        reasonCategory: canonicalSellerFormText(input.reasonCategory),
        ...(input.scope === "offers" || input.scope === "both" ? { scope: input.scope } : {}),
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
