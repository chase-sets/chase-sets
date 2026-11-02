import { z } from "zod";
import type { OfferId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceOfferAcceptanceResult } from "./runtime";
import { offerEvidenceSnapshotSchema } from "../domain/evidence-snapshot-schema";

const text = z.string().min(1).max(4096);
export const offerAttemptResultSchema = z.strictObject({
  offerId: text.transform((id) => id as OfferId),
  version: z.number().int().nonnegative().safe(),
});
export const offerPriceAttemptResultSchema = offerAttemptResultSchema.extend({
  status: z.enum(["draft", "submitted", "paused", "withdrawn", "accepted"]),
});
export const offerAcceptanceResultSchema: z.ZodType<MarketplaceOfferAcceptanceResult> = offerAttemptResultSchema.extend(
  {
    listingId: text,
    inventoryItemId: text,
    listingEvidenceSnapshot: offerEvidenceSnapshotSchema,
  },
);
