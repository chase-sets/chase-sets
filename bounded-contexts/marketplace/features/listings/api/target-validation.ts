import { z } from "zod";
const identity = z.string().trim().min(1).max(200);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const mutation = z.strictObject({ accountId: identity, listingId: identity, expectedListingVersion: revision.positive(), idempotencyKey: identity });
export const acceptListingTargetPriceSchema = mutation.extend({
  target: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("native-marketplace") }), z.strictObject({ kind: z.literal("channel-connection"), connectionId: identity })]),
  priceAmount: z.string().trim().regex(/^\d+(\.\d{1,2})?$/),
  priceCurrencyCode: z.string().trim().regex(/^[A-Za-z]{3}$/),
  expectedTargetPriceRevision: revision,
  decision: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("seller-reference") }), z.strictObject({ kind: z.literal("pricing-evaluation"), evaluationId: identity, evaluationRevision: identity, basePriceRevision: revision.positive(), standingAuthorizationId: identity, standingAuthorizationRevision: identity })]),
});
export const activateListingForChannelSchema = mutation.extend({ connectionId: identity, expectedTargetPriceRevision: revision.positive(), allocationRevision: revision.positive() });
