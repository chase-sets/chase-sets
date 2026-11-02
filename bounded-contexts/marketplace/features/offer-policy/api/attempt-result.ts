import { z } from "zod";
import { buyerOfferPolicyTermsSchema, buyerOfferPolicyOutcomeSchema } from "../domain/contracts";
import type { serializeBuyerOfferPolicy } from "./runtime";

export const offerPolicyAttemptResultSchema: z.ZodType<ReturnType<typeof serializeBuyerOfferPolicy>> = z.strictObject({
  policyId: z.string().min(1).max(128).nullable(),
  status: z.enum(["draft", "active", "paused", "stopped"]),
  version: z.number().int().nonnegative().safe(),
  revision: z.number().int().nonnegative().safe(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  authority: buyerOfferPolicyTermsSchema.nullable(),
  preview: z
    .strictObject({
      previewId: z.string().regex(/^[a-f0-9]{64}$/),
      policyVersion: z.number().int().positive().safe(),
      terms: buyerOfferPolicyTermsSchema,
      outcomes: z.array(buyerOfferPolicyOutcomeSchema).max(100).optional(),
    })
    .nullable(),
  offerVersions: z.record(z.string(), z.number().int().nonnegative().safe()),
});
