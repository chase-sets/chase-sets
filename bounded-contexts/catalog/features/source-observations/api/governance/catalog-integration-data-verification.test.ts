import { describe, expect, it } from "vitest";
import {
  catalogIntegrationDataReleaseVerificationQueries,
  catalogIntegrationDataRollbackChecklist,
  collectCatalogIntegrationDataVerificationReport,
  type CatalogIntegrationDataVerificationReport,
} from "./catalog-integration-data-verification";

describe("catalog integration data verification", () => {
  it("collects a verification report for retained Catalog integration data", async () => {
    const db = new InMemoryCatalogIntegrationDataDb({
      providerProfileVersions: 3,
      adminAuthoredProfileVersions: 1,
      referencedProfileVersions: 2,
      activeProviderProfiles: 1,
      sourceObservations: 12,
      sourceObservationEventStreams: 12,
      sourceObservationEvents: 24,
      legacySourceObservationReferences: 4,
      integrationDurableJobs: 5,
      activeIntegrationDurableJobs: 1,
      integrationWorkUnits: 8,
      bulkReviewJobs: 2,
      activeBulkReviewJobs: 0,
      bulkReviewWorkUnits: 7,
      profileSections: 30,
      profileSectionDiagnostics: 3,
      providerOptionQueryCacheEntries: 6,
      providerOptionRateLimits: 4,
      providerOptionRateLimitsAboveFloor: 4,
    });

    await expect(collectCatalogIntegrationDataVerificationReport(db)).resolves.toEqual({
      providerProfileVersions: 3,
      adminAuthoredProfileVersions: 1,
      referencedProfileVersions: 2,
      activeProviderProfiles: 1,
      sourceObservations: 12,
      sourceObservationEventStreams: 12,
      sourceObservationEvents: 24,
      legacySourceObservationReferences: 4,
      integrationDurableJobs: 5,
      activeIntegrationDurableJobs: 1,
      integrationWorkUnits: 8,
      bulkReviewJobs: 2,
      activeBulkReviewJobs: 0,
      bulkReviewWorkUnits: 7,
      profileSections: 30,
      profileSectionDiagnostics: 3,
      providerOptionQueryCacheEntries: 6,
      providerOptionRateLimits: 4,
      providerOptionRateLimitsAboveFloor: 4,
    });
  });

  it("publishes rollback and release verification checklists", () => {
    expect(catalogIntegrationDataRollbackChecklist()).toContain(
      "Activate the prior validated Provider Integration Profile version instead of editing historical profile rows.",
    );
    expect(catalogIntegrationDataReleaseVerificationQueries()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("legacy_source_observation_references"),
        expect.stringContaining("catalog_source_observation_integration_durable_jobs"),
      ]),
    );
  });
});

class InMemoryCatalogIntegrationDataDb {
  constructor(private readonly counts: CatalogIntegrationDataVerificationReport) {}
  async query<T>(sql: string): Promise<{ rows: T[] }> {
    expect(sql).toMatch(/^(SELECT|WITH referenced_versions)/);
    return { rows: [{ count: this.countFor(sql) } as T] };
  }

  private countFor(sql: string): number {
    if (sql.includes("event_store_streams")) {
      return this.counts.sourceObservationEventStreams;
    }
    if (sql.includes("event_store_events")) {
      return this.counts.sourceObservationEvents;
    }
    if (sql.includes("authoring_audit_json IS NOT NULL")) {
      return this.counts.adminAuthoredProfileVersions;
    }
    if (sql.includes("WITH referenced_versions")) {
      return this.counts.referencedProfileVersions;
    }
    if (sql.includes("active = true AND lifecycle = 'active'")) {
      return this.counts.activeProviderProfiles;
    }
    if (sql.includes("catalog_provider_integration_profile_versions")) {
      return this.counts.providerProfileVersions;
    }
    if (sql.includes("source_profile_version = 'legacy'")) {
      return this.counts.legacySourceObservationReferences;
    }
    if (sql.includes("catalog_source_observations")) {
      return this.counts.sourceObservations;
    }
    if (sql.includes("catalog_source_observation_integration_durable_jobs") && sql.includes("queued")) {
      return this.counts.activeIntegrationDurableJobs;
    }
    if (sql.includes("catalog_source_observation_integration_durable_jobs")) {
      return this.counts.integrationDurableJobs;
    }
    if (sql.includes("catalog_source_observation_integration_work_units")) {
      return this.counts.integrationWorkUnits;
    }
    if (sql.includes("catalog_source_observation_bulk_review_jobs") && sql.includes("queued")) {
      return this.counts.activeBulkReviewJobs;
    }
    if (sql.includes("catalog_source_observation_bulk_review_jobs")) {
      return this.counts.bulkReviewJobs;
    }
    if (sql.includes("catalog_source_observation_bulk_review_work_units")) {
      return this.counts.bulkReviewWorkUnits;
    }
    if (sql.includes("catalog_provider_profile_version_sections")) {
      return this.counts.profileSections;
    }
    if (sql.includes("catalog_provider_profile_version_section_diagnostics")) {
      return this.counts.profileSectionDiagnostics;
    }
    if (sql.includes("catalog_tcgplayer_automation_domain_rate_limits")) {
      if (sql.includes("effective_request_delay_ms <> min_request_delay_ms")) {
        return this.counts.providerOptionRateLimitsAboveFloor;
      }
      return this.counts.providerOptionRateLimits;
    }
    if (sql.includes("catalog_provider_option_query_cache")) {
      return this.counts.providerOptionQueryCacheEntries;
    }
    return 0;
  }
}
