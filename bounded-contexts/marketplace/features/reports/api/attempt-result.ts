import { z } from "zod";
import { marketplaceMutationRecoveryResultSchema } from "../../mutation-recovery/domain/contracts";
import { marketplaceReportReasons } from "../domain/domain";

export const reportAttemptFactSchema = z.strictObject({
  reportId: z.string().min(1),
  targetType: z.enum(["listing", "review"]),
  targetId: z.string().min(1),
  targetOwnerAccountId: z.string().nullable(),
  reporterKind: z.enum(["account", "visitor"]),
  reporterKey: z.string().min(1),
  reporterAccountId: z.string().nullable(),
  reporterUserId: z.string().nullable(),
  reason: z.enum(marketplaceReportReasons),
  details: z.string().max(1000).nullable(),
  sourceRoutePath: z.string().min(1),
  submittedAt: z.iso.datetime(),
  recovery: marketplaceMutationRecoveryResultSchema,
});

export const reviewReportAttemptResultSchema = z.strictObject({
  reportId: z.string().min(1),
  version: z.number().int().positive().safe(),
});

export const listingReportAttemptResultSchema = reviewReportAttemptResultSchema.extend({
  reportCount: z.number().int().nonnegative(),
  threshold: z.number().int().positive(),
  autoUnlisted: z.boolean(),
});
