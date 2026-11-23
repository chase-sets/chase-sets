import { z } from "zod";
import { marketplaceAttemptIdSchema, recoveryHashSchema } from "../../mutation-recovery/domain/contracts";

const identity = z.string().min(1).max(128);
const version = z.number().int().nonnegative().safe();
const consentVersion = z
  .string()
  .regex(/^offer-automatic-charge-v[1-9][0-9]*$/)
  .max(64);
export const instrumentCategorySchema = z.enum(["card", "bank-account"]);
export const paymentSourceSchema = z.strictObject({ useBalance: z.boolean(), instrumentId: identity.nullable() });
export type PaymentSource = z.infer<typeof paymentSourceSchema>;
const validatedSourceSchema = z.discriminatedUnion("category", [
  z.strictObject({ useBalance: z.literal(true), instrumentId: z.null(), category: z.null() }),
  z.strictObject({ useBalance: z.boolean(), instrumentId: identity, category: instrumentCategorySchema }),
]);
export type ValidatedPaymentSource = z.infer<typeof validatedSourceSchema>;
export const authorizationSnapshotSchema = z.strictObject({
  state: z.enum(["none", "active", "payment-method-unavailable", "held", "revoked"]),
  generation: version,
  source: validatedSourceSchema.nullable(),
  consentVersion: consentVersion.nullable(),
  latestHeldOrderId: identity.nullable(),
});
export type AuthorizationSnapshot = z.infer<typeof authorizationSnapshotSchema>;

const commandIdentity = { attemptId: marketplaceAttemptIdSchema, operationId: identity, expectedVersion: version };
export const authorizationRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...commandIdentity, type: z.literal("preview"), source: paymentSourceSchema }),
  z.strictObject({
    ...commandIdentity,
    type: z.literal("authorize"),
    previewId: recoveryHashSchema,
    consent: z.boolean().optional(),
  }),
  z.strictObject({ ...commandIdentity, type: z.literal("resume"), source: paymentSourceSchema }),
  z.strictObject({ ...commandIdentity, type: z.literal("revoke") }),
]);
export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;

const previewSchema = z.strictObject({ previewId: recoveryHashSchema, source: validatedSourceSchema, consentVersion });
export const authorizationResultSchema = authorizationSnapshotSchema.extend({
  authorizationId: z
    .string()
    .regex(/^marketplace\.offer-payment-authorization-[A-Za-z0-9_-]+$/)
    .max(180),
  version,
  preview: previewSchema.nullable(),
});
export type AuthorizationResult = z.infer<typeof authorizationResultSchema>;

export const authorizationRecordSchema = z.strictObject({
  buyerAccountId: identity,
  snapshot: authorizationSnapshotSchema,
  operation: z.strictObject({ id: identity, requestHash: recoveryHashSchema }).optional(),
  preview: previewSchema.extend({ authorityVersion: version }).optional(),
});

export type AuthorizationRecord = z.infer<typeof authorizationRecordSchema>;
export const authorizationStream = (accountId: string) => `marketplace.offer-payment-authorization-${accountId}`;
export const authorizationEvent = {
  previewed: "marketplace.offer-payment-authorization.previewed",
  authorized: "marketplace.offer-payment-authorization.authorized",
  resumed: "marketplace.offer-payment-authorization.resumed",
  revoked: "marketplace.offer-payment-authorization.revoked",
  held: "marketplace.offer-payment-authorization.held",
  unavailable: "marketplace.offer-payment-authorization.payment-method-unavailable",
  required: "marketplace.offer-payment-authorization.marked-required",
  changed: "marketplace.offer-payment-authorization.changed",
} as const;
