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
export const marketplaceMutationKindSchema = z.enum([
  "offer.accept",
  "offer.submit",
  "offer.update-price",
  "offer.decline",
  "offer-policy.command",
]);
export type MarketplaceMutationKind = z.infer<typeof marketplaceMutationKindSchema>;
export const marketplaceRecoveryTargetSchema = z.strictObject({
  kind: z.enum(["offer", "product", "offer-policy"]),
  id: identity,
});
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
