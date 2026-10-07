import { z } from "zod";
import { isCanonicalMoneyAmount } from "@chase-sets/primitives/money";

const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const amount = z
  .string()
  .max(13)
  .refine((value): boolean => isCanonicalMoneyAmount(value), "A canonical item amount is required.");
const version = z.number().int().nonnegative().safe();
export const buyerOfferPolicySelectionSchema = z.strictObject({
  offerId: identity,
  offerVersion: version.positive(),
  catalogItemId: identity,
  productId: z.string().min(1).max(1024),
  selectedOptions: z.array(z.strictObject({ dimensionId: identity, optionId: identity })).max(100),
  quantity: z.number().int().positive().safe(),
  maximumUnitItemAmount: amount.refine((value) => value !== "0.00"),
});
export const buyerOfferPolicyTermsSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  adjustmentBps: z.number().int().min(-2500).max(0).default(0),
  itemCommitmentAllowance: amount,
  offers: z.array(buyerOfferPolicySelectionSchema).min(1).max(100),
});
export type BuyerOfferPolicyTerms = z.output<typeof buyerOfferPolicyTermsSchema>;
export type BuyerOfferPolicySelection = BuyerOfferPolicyTerms["offers"][number];

const operation = { operationId: identity, expectedVersion: version };
export const buyerOfferPolicyRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("CreateBuyerOfferPolicy"), ...operation }),
  z.strictObject({ type: z.literal("PreviewBuyerOfferPolicy"), ...operation, terms: buyerOfferPolicyTermsSchema }),
  z.strictObject({
    type: z.literal("AuthorizeBuyerOfferPolicy"),
    ...operation,
    previewId: z.string().regex(/^[a-f0-9]{64}$/),
    consent: z.literal(true),
  }),
  z.strictObject({ type: z.literal("PauseBuyerOfferPolicy"), ...operation }),
  z.strictObject({ type: z.literal("StopBuyerOfferPolicy"), ...operation }),
]);
export type BuyerOfferPolicyRequest = z.output<typeof buyerOfferPolicyRequestSchema>;
export const buyerOfferPolicyIdSchema = identity;
export const buyerOfferPolicyAuditSchema = z.strictObject({
  schemaVersion: z.literal(1),
  policyId: identity,
  buyerAccountId: identity,
  actorUserId: identity,
  operationId: identity,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: z.iso.datetime(),
});
