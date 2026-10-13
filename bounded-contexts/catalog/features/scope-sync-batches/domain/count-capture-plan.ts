import { z } from "zod";
import type { ScopeSyncBatchPlannedScope, ScopeSyncBatchPreview } from "./batch";

export const countCaptureUnitKeys = [
  "scrydex:one-piece:set:reference-data",
  "scrydex:one-piece:single-card:source-observation-import",
  "scrydex:one-piece:sealed-product:source-observation-import",
] as const;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const instant = z.iso.datetime({ offset: true });
const integer = z.number().int().min(0).max(2147483647);
const unitKey = z.enum(countCaptureUnitKeys);
const unitKeys = z
  .array(unitKey)
  .max(3)
  .refine((keys) => new Set(keys).size === keys.length);
const providerLimits = (maximum: number, minimum = 0) =>
  z.object({ scrydex: integer.min(minimum).max(maximum).optional() }).strict();
const profile = z.object({ providerKey: z.literal("scrydex"), unitKey, profileKey: id, profileVersion: id }).strict();
const blocker = z.object({ code: id, scopeRecordId: id.nullable(), providerKey: id.nullable() }).strict();

export const countCapturePlanSchema = z
  .object({
    selection: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("ids"), scopeRecordIds: z.array(id).max(1) }).strict(),
      z
        .object({
          mode: z.literal("matching-scope"),
          query: z
            .object({
              productDomain: z.literal("one-piece").nullish(),
              scopeKind: z.literal("set").nullish(),
              languageCode: z.literal("en").nullish(),
            })
            .strict(),
        })
        .strict(),
    ]),
    budget: z
      .object({
        maxScopesPerTurn: integer.min(1).max(25),
        defaultProviderConcurrency: integer.min(1).max(20),
        providerConcurrency: providerLimits(20, 1),
        providerRequestLimits: providerLimits(1_000_000),
        creditedProviderRequestLimits: providerLimits(1_000_000),
        providerFailureThreshold: integer.min(1).max(100),
      })
      .strict(),
    resolvedAt: instant,
    status: z.enum(["empty", "blocked", "ready"]),
    blockers: z.array(blocker).max(100),
    scopes: z
      .array(
        z
          .object({
            scopeRecordId: id,
            scopeRecordVersion: instant,
            mappingVersions: z
              .array(
                z
                  .object({
                    mappingId: id,
                    version: instant,
                    reviewStatus: z.enum(["accepted", "auto-accepted"]),
                  })
                  .strict(),
              )
              .max(3),
            profileVersions: z.array(profile).max(3),
            scope: z
              .object({
                scopeVersion: z.literal("catalog-sync-scope-v2"),
                productDomain: z.literal("one-piece"),
                productForm: id.nullish(),
                languageCode: z.literal("en").nullish(),
                reference: z.object({ kind: z.literal("set"), scopeRecordId: id }).strict(),
                providerParticipation: z
                  .object({
                    requiredUnitKeys: unitKeys.optional(),
                    selectedUnitKeys: unitKeys.optional(),
                    excludedUnitKeys: unitKeys.optional(),
                  })
                  .strict()
                  .nullish(),
              })
              .strict(),
            providerUnitCount: integer.max(3),
            status: z.enum(["ready", "degraded", "blocked"]),
            startAllowed: z.boolean(),
            blockers: z.array(blocker).max(100),
            participationBlockers: z.array(id).max(100),
            units: z
              .array(
                profile
                  .extend({
                    selected: z.boolean(),
                    defaultSelected: z.boolean(),
                    eligibility: z.enum(["eligible", "ineligible"]),
                    requirement: z.enum(["required", "optional"]),
                    role: z.enum([
                      "primary-source-observation",
                      "supplemental-marketplace-reference",
                      "reference-data",
                      "image-evidence",
                    ]),
                    estimate: z
                      .object({
                        countSourceId: id.nullable(),
                        targetCount: integer.nullable(),
                        estimatedRequestCount: integer.nullable(),
                        requestStrategy: z.enum(["bulk-first", "single-record", "unknown"]).nullable(),
                        estimateState: z.enum(["estimated", "estimate-unavailable", "not-requested", "unavailable"]),
                        usageCheckState: z
                          .enum(["checked", "not-supported", "not-configured", "unavailable", "unknown"])
                          .nullable(),
                      })
                      .strict(),
                    blockers: z.array(id).max(100),
                  })
                  .strict(),
              )
              .max(3),
          })
          .strict(),
      )
      .max(1),
  })
  .strict()
  .refine((plan) =>
    plan.scopes.every((scope) => {
      const selected = scope.units.filter((unit) => unit.selected);
      return (
        scope.scope.reference.scopeRecordId === scope.scopeRecordId &&
        new Set(scope.units.map((unit) => unit.unitKey)).size === scope.units.length &&
        new Set(scope.mappingVersions.map((mapping) => mapping.mappingId)).size === scope.mappingVersions.length &&
        new Set(scope.profileVersions.map((entry) => entry.unitKey)).size === scope.profileVersions.length &&
        scope.providerUnitCount === selected.length &&
        scope.profileVersions.length === selected.length &&
        scope.profileVersions.every((entry) =>
          selected.some(
            (unit) =>
              unit.unitKey === entry.unitKey &&
              unit.profileKey === entry.profileKey &&
              unit.profileVersion === entry.profileVersion,
          ),
        )
      );
    }),
  );

export const countCapturePlannerInputSchema = z
  .object({
    selection: z.object({ mode: z.literal("ids"), scopeRecordIds: z.array(id).length(1) }).strict(),
    budget: countCapturePlanSchema.shape.budget,
  })
  .strict();

// Project only support-safe facts from the observed resolver result. No second
// resolve, sampled public preview, diagnostic prose or provider payload is used.
export function captureCountPlan(
  plan: Readonly<{ preview: ScopeSyncBatchPreview; plans: readonly ScopeSyncBatchPlannedScope[] }>,
) {
  const blockers = (values: ScopeSyncBatchPreview["blockers"]) =>
    values.map(({ code, scopeRecordId, providerKey }) => ({ code, scopeRecordId, providerKey }));
  return countCapturePlanSchema.parse({
    selection: plan.preview.selection,
    budget: plan.preview.budget,
    resolvedAt: plan.preview.resolvedAt,
    status: plan.preview.status,
    blockers: blockers(plan.preview.blockers),
    scopes: plan.plans.map((entry) => ({
      scopeRecordId: entry.scopeRecordId,
      scopeRecordVersion: entry.scopeRecordVersion,
      mappingVersions: entry.mappingVersions,
      profileVersions: entry.profileVersions,
      scope: entry.scope,
      providerUnitCount: entry.providerUnitCount,
      status: entry.participationPreview.status,
      startAllowed: entry.participationPreview.startAllowed,
      blockers: blockers(entry.blockers),
      participationBlockers: entry.participationPreview.blockers.map((blocker) => blocker.code),
      units: entry.participationPreview.units.map((unit) => ({
        providerKey: unit.providerKey,
        unitKey: unit.unitKey,
        profileKey: unit.profileKey,
        profileVersion: unit.profileVersion,
        selected: unit.selected,
        defaultSelected: unit.defaultSelected,
        eligibility: unit.eligibility,
        requirement: unit.requirement,
        role: unit.role,
        estimate: {
          countSourceId: unit.estimate.countSource?.sourceId ?? null,
          targetCount: unit.estimate.targetCount,
          estimatedRequestCount: unit.estimate.estimatedRequestCount,
          requestStrategy: unit.estimate.requestStrategy,
          estimateState: unit.estimate.estimateState,
          usageCheckState: unit.estimate.usageCheckState ?? null,
        },
        blockers: unit.blockers.map((blocker) => blocker.code),
      })),
    })),
  });
}
