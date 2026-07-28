import { describe, expect, it } from "vitest";
import {
  buildCatalogLifecycleImpactReadModel,
  buildCatalogReplayReapplyImpactReadModel,
  type CatalogIntegrationImpactJobSample,
} from "./catalog-integration-impact-analysis";
import type { CatalogAdminProfileVersionPointer } from "../admin/admin-control-plane-read-model-contracts";

const profile: CatalogAdminProfileVersionPointer = {
  schemaVersion: "catalog-provider-profile-version-v1",
  compatibilityPolicy: "provider-profile-version",
  providerKey: "tcgdex",
  profileKey: "pokemon-tcg",
  profileVersion: "v2",
  lifecycle: "test",
  active: false,
  connectorKind: "tcgdex-json",
  connectorSourceVersion: null,
  sourceMappingFingerprint: null,
};

const activeJob: CatalogIntegrationImpactJobSample = {
  jobId: "job_active",
  jobKind: "integration",
  action: "reapply",
  status: "running",
  providerKey: "tcgdex",
  profileVersion: "v1",
};

describe("catalog integration impact analysis", () => {
  it("builds reapply impact diagnostics for ineligible observations and active jobs", () => {
    const model = buildCatalogReplayReapplyImpactReadModel({
      generatedAt: "2026-06-08T00:00:00.000Z",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      profile,
      activeJobs: [activeJob],
      impact: {
        matchedObservations: 12,
        eligibleObservations: 7,
        blockedObservations: 5,
        impactedCatalogItemCount: 3,
        impactedCatalogItemIds: ["cat_1"],
        externalReferenceCount: 4,
        externalReferenceSamples: [
          {
            observationId: "obs_1",
            referenceKind: "catalog-item-reference",
            providerKey: "tcgdex",
            externalKey: "card:1",
            catalogItemId: "cat_1",
          },
        ],
        sampleObservationIds: ["obs_1"],
      },
    });

    expect(model).toMatchObject({
      matchedObservations: 12,
      eligibleObservations: 7,
      blockedObservations: 5,
      impactedCatalogItemCount: 3,
      externalReferenceCount: 4,
      activeJobCount: 1,
    });
    expect(model.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "reapply-scope-ineligible-observations",
      "reapply-scope-active-jobs",
    ]);
  });

  it("blocks retirement when observations still reference a profile version", () => {
    const model = buildCatalogLifecycleImpactReadModel({
      generatedAt: "2026-06-08T00:00:00.000Z",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      profile,
      operation: "retire",
      impact: {
        referencedObservationCount: 2,
        sourceProfileReferenceCount: 1,
        promotionProfileReferenceCount: 1,
        impactedCatalogItemCount: 1,
        impactedCatalogItemIds: ["cat_1"],
        externalReferenceCount: 1,
        externalReferenceSamples: [],
        sampleObservationIds: ["obs_1", "obs_2"],
      },
    });

    expect(model.allowed).toBe(false);
    expect(model.blockers).toHaveLength(1);
    expect(model.blockers[0]).toMatchObject({
      code: "profile-retirement-referenced-observations",
      severity: "error",
      providerKey: "tcgdex",
    });
  });

  it("blocks profile lifecycle impact when active work overlaps the provider", () => {
    const model = buildCatalogLifecycleImpactReadModel({
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      profile,
      operation: "rollback",
      activeJobs: [activeJob],
      impact: {
        referencedObservationCount: 0,
        sourceProfileReferenceCount: 0,
        promotionProfileReferenceCount: 0,
        impactedCatalogItemCount: 0,
        impactedCatalogItemIds: [],
        externalReferenceCount: 0,
        externalReferenceSamples: [],
        sampleObservationIds: [],
      },
    });

    expect(model.allowed).toBe(false);
    expect(model.impactedJobCount).toBe(1);
    expect(model.blockers[0]?.code).toBe("profile-lifecycle-active-jobs");
  });
});
