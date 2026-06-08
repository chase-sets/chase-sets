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
import { catalogProviderProfileEditableSectionMetadata } from "./provider-profile-admin-contracts";

describe("catalog integration legacy cleanup", () => {
  it("inventories resettable data surfaces and raw JSON compatibility paths", () => {
    const resetSurfaceKeys = new Set(catalogIntegrationDataSurfacePolicies.map((surface) => surface.key));
    const inventoryResetSurfaceKeys = new Set(
      catalogIntegrationLegacyCleanupSurfaces
        .map((surface) => surface.resetSurfaceKey)
        .filter((key): key is NonNullable<typeof key> => Boolean(key)),
    );

    expect(inventoryResetSurfaceKeys).toEqual(resetSurfaceKeys);

    expect(catalogIntegrationLegacyCleanupSurfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "broad-provider-profile-patch-route", action: "quarantine" }),
        expect.objectContaining({ key: "fixture-contract-metadata-and-payloads" }),
        expect.objectContaining({
          key: "transitional-static-profile-compatibility",
          action: "retain-with-explicit-exception",
        }),
      ]),
    );
  });

  it("requires retained legacy paths to carry owner, reason, removal date, and launch gate", () => {
    expect(catalogIntegrationRetainedLegacyPaths.map((path) => path.key)).toEqual([
      "transitional-static-profile-compatibility",
      "legacy-source-observation-profile-marker-read",
      "broad-provider-profile-patch-route",
    ]);

    for (const path of catalogIntegrationRetainedLegacyPaths) {
      expect(path.owner).toBe("catalog-source-observations");
      expect(path.ownerIssue).toBeGreaterThan(0);
      expect(path.reason).not.toHaveLength(0);
      expect(path.removalDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(path.removalCriteria).not.toHaveLength(0);
      expect(path.launchGate).not.toHaveLength(0);
    }
  });

  it("passes clean pre-launch bootstrap readiness", () => {
    const readiness = evaluateCatalogIntegrationLegacyCleanupReadiness({
      report: cleanReport(),
      editableSections: catalogProviderProfileEditableSectionMetadata(),
      rawProfilePatchRouteQuarantined: true,
      profileVersions: [
        {
          providerKey: "tcgdex",
          profileVersion: "2026.06.04",
          compatibilityMode: "executable-mapping-contract",
          retirementPlan: null,
        },
        {
          providerKey: "tcgplayer",
          profileVersion: "2026.06.04",
          compatibilityMode: "transitional-static-profile",
          retirementPlan: {
            trackingIssue: 789,
            removeAfter: "executable-mapping-contract-activated",
            diagnosticText: "Retire after TCGplayer executable mapping activation.",
          },
        },
      ],
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
      rawProfilePatchRouteQuarantined: false,
      profileVersions: [
        {
          providerKey: "tcgdex",
          profileVersion: "legacy-static",
          compatibilityMode: "transitional-static-profile",
          retirementPlan: null,
        },
      ],
    });

    expect(readiness.launchReady).toBe(false);
    expect(readiness.findings.map((finding) => finding.code)).toEqual([
      "source-observations-not-reset",
      "legacy-source-observation-references",
      "integration-jobs-not-reset",
      "provider-option-rate-limits-not-reset",
      "raw-json-section-editor",
      "raw-profile-patch-route-unowned",
      "transitional-profile-without-retirement",
    ]);
  });

  it("publishes launch verification checklist and SQL for clean-start release evidence", () => {
    expect(catalogIntegrationLegacyCleanupReleaseChecklist()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pre-launch wipe/rebuild reset"),
        expect.stringContaining("rawJsonBacked=false"),
        expect.stringContaining("broad profile patch route"),
      ]),
    );

    expect(catalogIntegrationLegacyCleanupVerificationQueries()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("legacy_source_observation_references"),
        expect.stringContaining("compatibility_mode = 'transitional-static-profile'"),
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
