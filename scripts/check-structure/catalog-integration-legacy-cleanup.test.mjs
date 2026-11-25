import assert from "node:assert/strict";

const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");
if (!process.env.VITEST) await import("tsx/esm");

const {
  catalogIntegrationLegacyCleanupReleaseChecklist,
  catalogIntegrationLegacyCleanupSurfaces,
  catalogIntegrationLegacyCleanupVerificationQueries,
  catalogIntegrationRetainedLegacyPaths,
  evaluateCatalogIntegrationLegacyCleanupReadiness,
} = await import("./catalog-integration-legacy-cleanup.ts");
const { catalogProviderProfileEditableSectionMetadata } =
  await import("../../bounded-contexts/catalog/features/source-observations/api/admin/provider-profile-admin-contracts.ts");

describe("catalog integration legacy cleanup", () => {
  it("inventories retained fixture metadata and supported authoring paths", () => {
    assert.ok(
      catalogIntegrationLegacyCleanupSurfaces.some(
        (surface) => surface.key === "fixture-contract-metadata-and-payloads",
      ),
    );
    assert.ok(
      catalogIntegrationLegacyCleanupSurfaces.some((surface) => surface.key === "section-scoped-profile-commands"),
    );
  });

  it("does not retain legacy Source Observation marker reads as runtime compatibility paths", () => {
    assert.deepEqual(catalogIntegrationRetainedLegacyPaths, []);
  });

  it("passes readiness with retained Catalog integration data", () => {
    assert.deepEqual(
      evaluateCatalogIntegrationLegacyCleanupReadiness({
        report: {
          ...cleanReport(),
          sourceObservations: 2,
          integrationDurableJobs: 1,
          providerOptionQueryCacheEntries: 3,
          providerOptionRateLimits: 3,
          providerOptionRateLimitsAboveFloor: 3,
        },
        editableSections: catalogProviderProfileEditableSectionMetadata(),
      }),
      { launchReady: true, findings: [] },
    );
  });

  it("blocks launch readiness when legacy data or raw JSON workflow leaks remain", () => {
    const readiness = evaluateCatalogIntegrationLegacyCleanupReadiness({
      report: {
        ...cleanReport(),
        sourceObservations: 2,
        legacySourceObservationReferences: 1,
        integrationDurableJobs: 1,
        providerOptionRateLimits: 3,
        providerOptionRateLimitsAboveFloor: 3,
      },
      editableSections: [{ section: "basics", rawJsonBacked: true }],
    });
    assert.equal(readiness.launchReady, false);
    assert.deepEqual(
      readiness.findings.map((finding) => finding.code),
      ["legacy-source-observation-references", "raw-json-section-editor"],
    );
  });

  it("publishes launch verification checklist and SQL for retained-data release evidence", () => {
    const checklist = catalogIntegrationLegacyCleanupReleaseChecklist();
    for (const marker of [
      "read-only report",
      "rawJsonBacked=false",
      "unsupported profile authoring compatibility code",
    ]) {
      assert.ok(
        checklist.some((entry) => entry.includes(marker)),
        marker,
      );
    }
    const queries = catalogIntegrationLegacyCleanupVerificationQueries();
    assert.ok(queries.some((entry) => entry.includes("legacy_source_observation_references")));
    assert.ok(queries.some((entry) => entry.includes("catalog_provider_profile_version_sections")));
  });
});

function cleanReport() {
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
    providerOptionRateLimitsAboveFloor: 0,
  };
}
