import { z } from "zod";

// The Production Catalog Completion Report contract. A frozen Scope Sync Batch
// manifest carries the eligible sync universe, the observed per-unit outcome,
// and the reconciliation facts required to decide whether the production
// Catalog is complete, reconciled, and convergent after a launch cutoff. The
// manifest is the single authoritative input: completeness is never inferred
// from a hardcoded provider list.

export const productionCatalogCompletionManifestVersion = "production-catalog-completion-manifest-v1" as const;

// How a provider unit participates in production coverage. Only `production`
// units count as required coverage; every other class is excluded from
// required coverage with a matching, stable exclusion reason.
export const providerProductionClasses = [
  "production",
  "validation-only",
  "comparison-only",
  "retired",
  "unapproved",
] as const;
export type ProviderProductionClass = (typeof providerProductionClasses)[number];

export const providerProfileLifecycles = ["draft", "test", "active", "deprecated", "retired"] as const;
export type ProviderProfileLifecycle = (typeof providerProfileLifecycles)[number];

// Terminal-good states settle a unit; every other state after the cutoff is a
// launch blocker unless the unit is explicitly excluded from required coverage.
export const manifestUnitSyncStates = [
  "settled",
  "completed",
  "failed",
  "stale",
  "never-synced",
  "pending",
  "running",
] as const;
export type ManifestUnitSyncState = (typeof manifestUnitSyncStates)[number];

export const mergeCandidateStatuses = ["ready", "has-conflicts", "stale", "deferred", "rejected", "promoted"] as const;
export type MergeCandidateStatus = (typeof mergeCandidateStatuses)[number];

export const providerUsageCheckStates = ["available", "unavailable", "degraded"] as const;
export type ProviderUsageCheckState = (typeof providerUsageCheckStates)[number];

// Stable exclusion reasons. Every excluded scope/provider unit must carry one
// of these; an exclusion outside this set is an unexplained-exclusion blocker.
export const completionExclusionReasons = [
  "ineligible",
  "validation-only",
  "comparison-only",
  "unapproved",
  "retired",
  "rollout-blocked",
  "provider-unavailable",
  "mapping-missing",
  "operator-deferred",
] as const;
export type CompletionExclusionReason = (typeof completionExclusionReasons)[number];

const providerUnitSchema = z.object({
  providerKey: z.string().min(1),
  unitKey: z.string().min(1),
  productionClass: z.enum(providerProductionClasses),
  lifecycle: z.enum(providerProfileLifecycles),
  active: z.boolean(),
});
export type ManifestProviderUnit = z.infer<typeof providerUnitSchema>;

const acceptedMappingSchema = z.object({
  providerKey: z.string().min(1),
  unitKey: z.string().min(1),
});

const scopeSchema = z.object({
  scopeRecordId: z.string().min(1),
  eligible: z.boolean(),
  acceptedMappings: z.array(acceptedMappingSchema).readonly(),
});
export type ManifestScope = z.infer<typeof scopeSchema>;

const expectedUnitSchema = z.object({
  scopeRecordId: z.string().min(1),
  providerKey: z.string().min(1),
  unitKey: z.string().min(1),
});
export type ManifestExpectedUnit = z.infer<typeof expectedUnitSchema>;

const observedUnitSchema = z.object({
  scopeRecordId: z.string().min(1),
  providerKey: z.string().min(1),
  unitKey: z.string().min(1),
  state: z.enum(manifestUnitSyncStates),
  lastCompletedAt: z.string().nullable(),
  syncRunId: z.string().nullable(),
  observedCount: z.number().int().nonnegative(),
  changedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});
export type ManifestObservedUnit = z.infer<typeof observedUnitSchema>;

const mergeCandidateSchema = z.object({
  candidateId: z.string().min(1),
  scopeRecordId: z.string().min(1),
  status: z.enum(mergeCandidateStatuses),
  blockingConflictCount: z.number().int().nonnegative(),
  duplicatePreventionBlocked: z.boolean(),
});
export type ManifestMergeCandidate = z.infer<typeof mergeCandidateSchema>;

const promotionOutcomesSchema = z.object({
  create: z.number().int().nonnegative(),
  update: z.number().int().nonnegative(),
  ignore: z.number().int().nonnegative(),
  defer: z.number().int().nonnegative(),
});
export type ManifestPromotionOutcomes = z.infer<typeof promotionOutcomesSchema>;

const catalogItemCountsSchema = z.object({
  draft: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
});
export type ManifestCatalogItemCounts = z.infer<typeof catalogItemCountsSchema>;

const sourceObservationCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  promoted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  terminalJobFailures: z.number().int().nonnegative(),
});
export type ManifestSourceObservationCounts = z.infer<typeof sourceObservationCountsSchema>;

const assetProcessingSchema = z.object({
  approvedFailures: z.number().int().nonnegative(),
  exclusions: z.number().int().nonnegative(),
});
export type ManifestAssetProcessing = z.infer<typeof assetProcessingSchema>;

const providerUsageSchema = z.object({
  providerKey: z.string().min(1),
  credited: z.boolean(),
  estimatedRequestCount: z.number().int().nonnegative().nullable(),
  actualRequestCount: z.number().int().nonnegative().nullable(),
  pageCount: z.number().int().nonnegative().nullable(),
  cacheHitCount: z.number().int().nonnegative().nullable(),
  cacheMissCount: z.number().int().nonnegative().nullable(),
  usageCheckState: z.enum(providerUsageCheckStates),
});
export type ManifestProviderUsage = z.infer<typeof providerUsageSchema>;

const exclusionSchema = z.object({
  scopeRecordId: z.string().min(1).nullable(),
  providerKey: z.string().min(1).nullable(),
  unitKey: z.string().min(1).nullable(),
  reason: z.enum(completionExclusionReasons),
  note: z.string().nullable(),
});
export type ManifestExclusion = z.infer<typeof exclusionSchema>;

export const productionCatalogCompletionManifestSchema = z.object({
  manifestVersion: z.literal(productionCatalogCompletionManifestVersion),
  frozenAt: z.string().min(1),
  launchCutoff: z.string().min(1),
  batch: z.object({
    batchId: z.string().min(1),
    planFingerprint: z.string().min(1),
    status: z.string().min(1),
  }),
  providerUnits: z.array(providerUnitSchema).readonly(),
  scopes: z.array(scopeSchema).readonly(),
  expectedUnits: z.array(expectedUnitSchema).readonly(),
  observedUnits: z.array(observedUnitSchema).readonly(),
  mergeCandidates: z.array(mergeCandidateSchema).readonly(),
  promotions: promotionOutcomesSchema,
  catalogItems: catalogItemCountsSchema,
  sourceObservations: sourceObservationCountsSchema,
  assetProcessing: assetProcessingSchema,
  providerUsage: z.array(providerUsageSchema).readonly(),
  exclusions: z.array(exclusionSchema).readonly(),
});

export type ProductionCatalogCompletionManifest = z.infer<typeof productionCatalogCompletionManifestSchema>;

export class ProductionCatalogCompletionManifestError extends Error {
  readonly code = "production_catalog_completion_manifest_invalid";
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[]) {
    super(message);
    this.name = "ProductionCatalogCompletionManifestError";
    this.issues = issues;
  }
}

// Parse an untrusted manifest artifact into the typed contract. Throws a
// support-safe error naming the offending paths (never the raw values) so
// operator tooling can surface a malformed manifest without leaking payloads.
export function parseProductionCatalogCompletionManifest(raw: unknown): ProductionCatalogCompletionManifest {
  const result = productionCatalogCompletionManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    throw new ProductionCatalogCompletionManifestError(
      "Production Catalog completion manifest failed contract validation.",
      issues,
    );
  }
  return result.data;
}

export function unitKey(scopeRecordId: string, providerKey: string, providerUnitKey: string): string {
  return `${scopeRecordId} ${providerKey} ${providerUnitKey}`;
}

export function providerUnitKey(providerKey: string, providerUnitKey: string): string {
  return `${providerKey} ${providerUnitKey}`;
}
