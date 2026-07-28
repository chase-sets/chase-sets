import { describe, expect, it } from "vitest";
import {
  catalogIntegrationLegacyCleanupReleaseChecklist,
  catalogIntegrationLegacyCleanupSurfaces,
  catalogIntegrationLegacyCleanupVerificationQueries,
  catalogIntegrationRetainedLegacyPaths,
  evaluateCatalogIntegrationLegacyCleanupReadiness,
} from "./catalog-integration-legacy-cleanup";
import {
  catalogIntegrationDataSurfacePolicies,
  type CatalogIntegrationDataVerificationReport,
} from "./catalog-integration-data-migration-reset";
import { catalogProviderProfileEditableSectionMetadata } from "../admin/provider-profile-admin-contracts";

describe("catalog integration legacy cleanup", () => {
  it("inventories resettable data surfaces and supported launch paths", () => {
    const resetSurfaceKeys = new Set(catalogIntegrationDataSurfacePolicies.map((surface) => surface.key));
    const inventoryResetSurfaceKeys = new Set(
      catalogIntegrationLegacyCleanupSurfaces
        .map((surface) => surface.resetSurfaceKey)
        .filter((key): key is NonNullable<typeof key> => Boolean(key)),
    );

    expect(inventoryResetSurfaceKeys).toEqual(resetSurfaceKeys);

    expect(catalogIntegrationLegacyCleanupSurfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "fixture-contract-metadata-and-payloads" }),
        expect.objectContaining({ key: "section-scoped-profile-commands" }),
      ]),
    );
  });

  it("does not retain legacy Source Observation marker reads as runtime compatibility paths", () => {
    expect(catalogIntegrationRetainedLegacyPaths).toEqual([]);
  });

  it("passes clean pre-launch bootstrap readiness", () => {
    const readiness = evaluateCatalogIntegrationLegacyCleanupReadiness({
      report: cleanReport(),
      editableSections: catalogProviderProfileEditableSectionMetadata(),
    });

    expect(readiness).toEqual({ launchReady: true, findings: [] });
  });

  it("blocks launch readiness when legacy data or raw JSON workflow leaks remain", () => {
    const readiness = evaluateCatalogIntegrationLegacyCleanupReadiness({
      report: {
        ...cleanReport(),
        sourceObservations: 2,
        legacySourceObservationReferences: 1,
        integrationDurableJobs: 1,
        providerOptionRateLimits: 3,
      },
      editableSections: [{ section: "basics", rawJsonBacked: true }],
    });

    expect(readiness.launchReady).toBe(false);
    expect(readiness.findings.map((finding) => finding.code)).toEqual([
      "source-observations-not-reset",
      "legacy-source-observation-references",
      "integration-jobs-not-reset",
      "provider-option-rate-limits-not-reset",
      "raw-json-section-editor",
    ]);
  });

  it("publishes launch verification checklist and SQL for clean-start release evidence", () => {
    expect(catalogIntegrationLegacyCleanupReleaseChecklist()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pre-launch wipe/rebuild reset"),
        expect.stringContaining("rawJsonBacked=false"),
        expect.stringContaining("unsupported profile authoring compatibility code"),
      ]),
    );

    expect(catalogIntegrationLegacyCleanupVerificationQueries()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("legacy_source_observation_references"),
        expect.stringContaining("catalog_provider_profile_version_sections"),
      ]),
    );
  });
});

function cleanReport(): CatalogIntegrationDataVerificationReport {
  return {
    providerProfileVersions: 3,
    adminAuthoredProfileVersions: 0,
    referencedProfileVersions: 0,
    activeProviderProfiles: 3,
    sourceObservations: 0,
    sourceObservationEventStreams: 0,
    sourceObservationEvents: 0,
    legacySourceObservationReferences: 0,
    integrationDurableJobs: 0,
    activeIntegrationDurableJobs: 0,
    integrationWorkUnits: 0,
    bulkReviewJobs: 0,
    activeBulkReviewJobs: 0,
    bulkReviewWorkUnits: 0,
    profileSections: 24,
    profileSectionDiagnostics: 0,
    providerOptionQueryCacheEntries: 0,
    providerOptionRateLimits: 0,
  };
}
