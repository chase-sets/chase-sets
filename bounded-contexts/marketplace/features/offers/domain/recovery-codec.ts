import { z } from "zod";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type { MarketplaceOfferEvent } from "./domain";
import { offerEvidenceSnapshotSchema } from "./evidence-snapshot-schema";

const id = z.string().min(1).max(1024);
const version = z.number().int().positive().safe();
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .nullish();
const amount = z.string().regex(/^\d+\.\d{2}$/);
const selection = z.array(z.strictObject({ dimensionId: id, optionId: id })).max(100);
const common = { offerId: id, buyerAccountId: id, priceAmount: amount, priceCurrencyCode: currency };
const lifecycle = z.object({ offerId: id, buyerAccountId: id, at: z.iso.datetime({ offset: true }) });
const submission = z.object({
  ...common,
  catalogItemId: id,
  productId: id,
  itemTitle: id,
  itemSubtitle: z.string().nullable(),
  selectedOptions: selection,
  productSummary: z.string().nullable(),
  quantityRequested: version,
  shippingDestinationSnapshot: z.object({ name: id, line1: id, city: id, state: id, postalCode: id, country: id }),
});
const payloads = {
  "marketplace.offer.submitted": submission,
  "marketplace.offer.price-updated": z.object(common),
  "marketplace.offer.paused": lifecycle,
  "marketplace.offer.resumed": lifecycle,
  "marketplace.offer.withdrawn": lifecycle,
  "marketplace.offer.accepted": submission.extend({
    sellerAccountId: id,
    listingId: id,
    inventoryItemId: id,
    listingVersion: version,
    acceptedAt: z.iso.datetime({ offset: true }),
    marketplaceSalesFeeUnitAmount: amount,
    sellerNetUnitAmount: amount,
    shippingAllowancePercentageBps: z.number().int().nonnegative(),
    listingEvidenceSnapshot: offerEvidenceSnapshotSchema,
  }),
  "marketplace.offer.buyer-policy-bound": z.object({ offerId: id, buyerAccountId: id, policyId: id }),
  "marketplace.offer.managed-evaluated": z.object({
    offerId: id,
    policyId: id,
    policyVersion: version,
    operationId: id,
    status: z.enum(["applied", "held"]),
    reason: id,
    evidence: z.record(z.string(), z.json()),
  }),
} satisfies Record<MarketplaceOfferEvent["type"], z.ZodType>;

const codec = createPassthroughDomainEventCodec<MarketplaceOfferEvent>();
export const marketplaceOfferRecoveryCodec: DomainEventCodec<MarketplaceOfferEvent> = {
  encode: codec.encode,
  decode(event) {
    const schema = payloads[event.eventType as keyof typeof payloads];
    if (!schema) throw new Error("Unknown Offer recovery fact.");
    schema.parse(event.payload);
    return codec.decode(event);
  },
};
