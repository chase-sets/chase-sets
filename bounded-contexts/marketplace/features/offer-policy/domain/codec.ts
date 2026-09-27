import { z } from "zod";
import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import { buyerOfferPolicyAuditSchema, buyerOfferPolicyTermsSchema } from "./contracts";
import type { BuyerOfferPolicyEvent } from "./domain";

const preview = buyerOfferPolicyAuditSchema.extend({
  previewId: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.number().int().positive().safe(),
  terms: buyerOfferPolicyTermsSchema,
});
const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("marketplace.offer-policy.created"), data: buyerOfferPolicyAuditSchema }),
  z.strictObject({ type: z.literal("marketplace.offer-policy.previewed"), data: preview }),
  z.strictObject({
    type: z.literal("marketplace.offer-policy.authorized"),
    data: preview.extend({ revision: z.number().int().positive().safe(), consentedAt: z.iso.datetime() }),
  }),
  z.strictObject({ type: z.literal("marketplace.offer-policy.paused"), data: buyerOfferPolicyAuditSchema }),
  z.strictObject({ type: z.literal("marketplace.offer-policy.stopped"), data: buyerOfferPolicyAuditSchema }),
]);
export const buyerOfferPolicyCodec: DomainEventCodec<BuyerOfferPolicyEvent> = {
  encode(event) {
    const parsed = eventSchema.parse(event);
    return { eventType: parsed.type, payload: parsed.data };
  },
  decode(event) {
    return eventSchema.parse({ type: event.eventType, data: event.payload });
  },
};
