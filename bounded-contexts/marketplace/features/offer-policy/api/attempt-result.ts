import { z } from "zod";
import { buyerOfferPolicyTermsSchema, buyerOfferPolicyOutcomeSchema } from "../domain/contracts";
import type { serializeBuyerOfferPolicy } from "./runtime";
import { centsToMoneyAmount, moneyToCents, isCanonicalMoneyAmount } from "@chase-sets/primitives/money";

export const offerPolicyAttemptResultSchema: z.ZodType<ReturnType<typeof serializeBuyerOfferPolicy>> = z.strictObject({
  policyId: z.string().nullable(),
  status: z.enum(["draft", "active", "paused", "stopped"]),
  version: z.number().int().nonnegative().safe(),
  revision: z.number().int().nonnegative().safe(),
  currency: z.string().nullable(),
  consumedItemAmount: z.string(),
  remainingItemAllowance: z
    .string()
    .refine(isCanonicalMoneyAmount)
    .transform((amount) => centsToMoneyAmount(moneyToCents(amount)))
    .nullable(),
  authority: buyerOfferPolicyTermsSchema.nullable(),
  preview: z
    .strictObject({
      previewId: z.string(),
      policyVersion: z.number().int().positive().safe(),
      terms: buyerOfferPolicyTermsSchema,
      outcomes: z.array(buyerOfferPolicyOutcomeSchema).max(100).optional(),
    })
    .nullable(),
  offerVersions: z.record(z.string(), z.number().int().nonnegative().safe()),
});
