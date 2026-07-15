import { productionCatalogCompletionManifestVersion, type ProductionCatalogCompletionManifest } from "../manifest";

const cutoff = "2026-08-01T00:00:00.000Z";
const afterCutoff = "2026-08-02T00:00:00.000Z";
const beforeCutoff = "2026-07-30T00:00:00.000Z";

// A complete, fully-reconciled manifest: one eligible scope, one production
// provider unit, terminal-good coverage after the cutoff, all merge candidates
// disposed. Every failure fixture is a shallow override of this baseline.
export function completeManifest(): ProductionCatalogCompletionManifest {
  return {
    manifestVersion: productionCatalogCompletionManifestVersion,
    frozenAt: cutoff,
    launchCutoff: cutoff,
    batch: { batchId: "batch-1", planFingerprint: "fp-1", status: "completed" },
    providerUnits: [
      { providerKey: "scrydex", unitKey: "cards", productionClass: "production", lifecycle: "active", active: true },
      {
        providerKey: "tcgdex",
        unitKey: "sealed",
        productionClass: "validation-only",
        lifecycle: "test",
        active: false,
      },
    ],
    scopes: [
      {
        scopeRecordId: "scope-1",
        eligible: true,
        acceptedMappings: [{ providerKey: "scrydex", unitKey: "cards" }],
      },
    ],
    expectedUnits: [{ scopeRecordId: "scope-1", providerKey: "scrydex", unitKey: "cards" }],
    observedUnits: [
      {
        scopeRecordId: "scope-1",
        providerKey: "scrydex",
        unitKey: "cards",
        state: "settled",
        lastCompletedAt: afterCutoff,
        syncRunId: "run-1",
        observedCount: 100,
        changedCount: 4,
        failedCount: 0,
      },
    ],
    mergeCandidates: [
      {
        candidateId: "cand-1",
        scopeRecordId: "scope-1",
        status: "promoted",
        blockingConflictCount: 0,
        duplicatePreventionBlocked: false,
      },
    ],
    promotions: { create: 1, update: 0, ignore: 0, defer: 0 },
    catalogItems: { draft: 0, published: 100 },
    sourceObservations: { total: 100, observed: 0, changed: 0, promoted: 100, rejected: 0, terminalJobFailures: 0 },
    assetProcessing: { approvedFailures: 0, exclusions: 0 },
    providerUsage: [
      {
        providerKey: "scrydex",
        credited: true,
        estimatedRequestCount: 10,
        actualRequestCount: 9,
        pageCount: 3,
        cacheHitCount: 6,
        cacheMissCount: 3,
        usageCheckState: "available",
      },
    ],
    exclusions: [],
  };
}

export const fixtureCutoff = cutoff;
export const fixtureAfterCutoff = afterCutoff;
export const fixtureBeforeCutoff = beforeCutoff;
