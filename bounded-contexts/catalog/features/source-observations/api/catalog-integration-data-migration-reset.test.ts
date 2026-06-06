import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  catalogIntegrationDataBackfillDecisions,
  catalogIntegrationDataReleaseVerificationQueries,
  catalogIntegrationDataResetDeleteStatements,
  catalogIntegrationDataRollbackChecklist,
  catalogIntegrationDataSurfacePolicies,
  collectCatalogIntegrationDataVerificationReport,
  resetCatalogIntegrationPreLaunchData,
} from "./catalog-integration-data-migration-reset";

const seedCatalogProviderIntegrationProfileVersions = vi.hoisted(() =>
  vi.fn(async () => [
    {
      providerKey: "tcgdex",
      profileKey: "pokemon-tcg",
      profileVersion: "2026.06.03",
    },
  ]),
);

vi.mock("./provider-integration-profile-store", () => ({
  seedCatalogProviderIntegrationProfileVersions,
}));

describe("catalog integration data migration reset", () => {
  beforeEach(() => {
    seedCatalogProviderIntegrationProfileVersions.mockClear();
  });

  it("pins reset surface inventory and destructive ordering", () => {
    expect(catalogIntegrationDataSurfacePolicies.map((surface) => surface.key)).toEqual([
      "integration-work-unit",
      "integration-job-event",
      "integration-durable-job",
      "bulk-review-work-unit",
      "bulk-review-job-event",
      "bulk-review-job",
      "source-observation",
      "profile-section-diagnostic",
      "profile-section-projection",
      "provider-option-rate-limit",
      "provider-profile-version",
    ]);

    expect(catalogIntegrationDataResetDeleteStatements.map((statement) => statement.tableName)).toEqual([
      "catalog_source_observation_integration_work_units",
      "catalog_source_observation_integration_job_events",
      "catalog_source_observation_integration_durable_jobs",
      "catalog_source_observation_bulk_review_work_units",
      "catalog_source_observation_bulk_review_job_events",
      "catalog_source_observation_bulk_review_jobs",
      "catalog_source_observations",
      "catalog_tcgplayer_automation_domain_rate_limits",
      "catalog_provider_integration_profile_versions",
    ]);

    expect(catalogIntegrationDataResetDeleteStatements.at(-1)?.sql).toContain("authoring_audit_json IS NULL");
    expect(catalogIntegrationDataResetDeleteStatements.at(-1)?.sql).toContain("migration_evidence_json IS NULL");
  });

  it("collects a verification report for launch reset checks", async () => {
    const db = new InMemoryCatalogIntegrationDataDb({
      providerProfileVersions: 3,
      adminAuthoredProfileVersions: 1,
      referencedProfileVersions: 2,
      activeProviderProfiles: 1,
      sourceObservations: 12,
      legacySourceObservationReferences: 4,
      integrationDurableJobs: 5,
      activeIntegrationDurableJobs: 1,
      integrationWorkUnits: 8,
      bulkReviewJobs: 2,
      activeBulkReviewJobs: 0,
      bulkReviewWorkUnits: 7,
      profileSections: 30,
      profileSectionDiagnostics: 3,
      providerOptionRateLimits: 4,
    });

    await expect(collectCatalogIntegrationDataVerificationReport(db)).resolves.toEqual({
      providerProfileVersions: 3,
      adminAuthoredProfileVersions: 1,
      referencedProfileVersions: 2,
      activeProviderProfiles: 1,
      sourceObservations: 12,
      legacySourceObservationReferences: 4,
      integrationDurableJobs: 5,
      activeIntegrationDurableJobs: 1,
      integrationWorkUnits: 8,
      bulkReviewJobs: 2,
      activeBulkReviewJobs: 0,
      bulkReviewWorkUnits: 7,
      profileSections: 30,
      profileSectionDiagnostics: 3,
      providerOptionRateLimits: 4,
    });
  });

  it("blocks reset while integration or bulk review jobs are active", async () => {
    const db = new InMemoryCatalogIntegrationDataDb({
      integrationDurableJobs: 2,
      activeIntegrationDurableJobs: 1,
      bulkReviewJobs: 1,
      activeBulkReviewJobs: 1,
    });

    await expect(resetCatalogIntegrationPreLaunchData(db)).rejects.toThrow("blocked by 2 queued or running job");
    expect(seedCatalogProviderIntegrationProfileVersions).not.toHaveBeenCalled();
  });

  it("deletes pre-launch integration data, preserves admin-authored profiles, and rebuilds seeded profiles", async () => {
    const db = new InMemoryCatalogIntegrationDataDb({
      providerProfileVersions: 4,
      adminAuthoredProfileVersions: 1,
      sourceObservations: 6,
      legacySourceObservationReferences: 6,
      integrationDurableJobs: 2,
      integrationWorkUnits: 5,
      bulkReviewJobs: 1,
      bulkReviewWorkUnits: 3,
      profileSections: 20,
      profileSectionDiagnostics: 2,
      providerOptionRateLimits: 2,
    });

    const report = await resetCatalogIntegrationPreLaunchData(db);

    expect(report.before).toMatchObject({
      providerProfileVersions: 4,
      sourceObservations: 6,
      integrationDurableJobs: 2,
    });
    expect(report.after).toMatchObject({
      providerProfileVersions: 1,
      adminAuthoredProfileVersions: 1,
      sourceObservations: 0,
      integrationDurableJobs: 0,
      integrationWorkUnits: 0,
      bulkReviewJobs: 0,
      bulkReviewWorkUnits: 0,
      providerOptionRateLimits: 0,
    });
    expect(report.steps.find((step) => step.tableName === "catalog_provider_integration_profile_versions")).toEqual({
      tableName: "catalog_provider_integration_profile_versions",
      action: "delete-and-rebuild-seed",
      rowsAffected: 3,
    });
    expect(report.steps.at(-1)).toEqual({
      tableName: "catalog_provider_integration_profile_versions",
      action: "delete-and-rebuild-seed",
      rowsAffected: 1,
    });
    expect(seedCatalogProviderIntegrationProfileVersions).toHaveBeenCalledOnce();
  });

  it("allows explicit forced reset of active jobs for pre-launch cleanup", async () => {
    const db = new InMemoryCatalogIntegrationDataDb({
      integrationDurableJobs: 2,
      activeIntegrationDurableJobs: 1,
      integrationWorkUnits: 4,
    });

    await expect(resetCatalogIntegrationPreLaunchData(db, { allowActiveJobReset: true })).resolves.toMatchObject({
      after: {
        integrationDurableJobs: 0,
        activeIntegrationDurableJobs: 0,
        integrationWorkUnits: 0,
      },
    });
  });

  it("marks backfill work as skipped after a clean pre-launch wipe", () => {
    expect(
      catalogIntegrationDataBackfillDecisions({
        providerProfileVersions: 1,
        adminAuthoredProfileVersions: 0,
        referencedProfileVersions: 0,
        activeProviderProfiles: 1,
        sourceObservations: 0,
        legacySourceObservationReferences: 0,
        integrationDurableJobs: 0,
        activeIntegrationDurableJobs: 0,
        integrationWorkUnits: 0,
        bulkReviewJobs: 0,
        activeBulkReviewJobs: 0,
        bulkReviewWorkUnits: 0,
        profileSections: 12,
        profileSectionDiagnostics: 0,
        providerOptionRateLimits: 0,
      }),
    ).toEqual([
      expect.objectContaining({ key: "profile-section-projections", required: true }),
      expect.objectContaining({ key: "source-observation-profile-references", required: false }),
      expect.objectContaining({ key: "durable-job-profile-snapshots", required: false }),
    ]);
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

type CatalogIntegrationCounts = Readonly<{
  providerProfileVersions: number;
  adminAuthoredProfileVersions: number;
  referencedProfileVersions: number;
  activeProviderProfiles: number;
  sourceObservations: number;
  legacySourceObservationReferences: number;
  integrationDurableJobs: number;
  activeIntegrationDurableJobs: number;
  integrationWorkUnits: number;
  bulkReviewJobs: number;
  activeBulkReviewJobs: number;
  bulkReviewWorkUnits: number;
  profileSections: number;
  profileSectionDiagnostics: number;
  providerOptionRateLimits: number;
}>;

class InMemoryCatalogIntegrationDataDb {
  readonly statements: string[] = [];
  private counts: CatalogIntegrationCounts;

  constructor(counts: Partial<CatalogIntegrationCounts> = {}) {
    this.counts = {
      providerProfileVersions: 0,
      adminAuthoredProfileVersions: 0,
      referencedProfileVersions: 0,
      activeProviderProfiles: 0,
      sourceObservations: 0,
      legacySourceObservationReferences: 0,
      integrationDurableJobs: 0,
      activeIntegrationDurableJobs: 0,
      integrationWorkUnits: 0,
      bulkReviewJobs: 0,
      activeBulkReviewJobs: 0,
      bulkReviewWorkUnits: 0,
      profileSections: 0,
      profileSectionDiagnostics: 0,
      providerOptionRateLimits: 0,
      ...counts,
    };
  }

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    this.statements.push(sql);

    if (sql.startsWith("WITH deleted AS (DELETE FROM ")) {
      return { rows: [{ rows_deleted: this.applyDelete(sql) } as T] };
    }

    return { rows: [{ count: this.countFor(sql) } as T] };
  }

  private applyDelete(sql: string): number {
    if (sql.includes("catalog_source_observation_integration_work_units")) {
      return this.clear("integrationWorkUnits");
    }
    if (sql.includes("catalog_source_observation_integration_job_events")) {
      return 0;
    }
    if (sql.includes("catalog_source_observation_integration_durable_jobs")) {
      const deleted = this.clear("integrationDurableJobs");
      this.counts = { ...this.counts, activeIntegrationDurableJobs: 0 };
      return deleted;
    }
    if (sql.includes("catalog_source_observation_bulk_review_work_units")) {
      return this.clear("bulkReviewWorkUnits");
    }
    if (sql.includes("catalog_source_observation_bulk_review_job_events")) {
      return 0;
    }
    if (sql.includes("catalog_source_observation_bulk_review_jobs")) {
      const deleted = this.clear("bulkReviewJobs");
      this.counts = { ...this.counts, activeBulkReviewJobs: 0 };
      return deleted;
    }
    if (sql.includes("catalog_source_observations")) {
      const deleted = this.clear("sourceObservations");
      this.counts = {
        ...this.counts,
        referencedProfileVersions: 0,
        legacySourceObservationReferences: 0,
      };
      return deleted;
    }
    if (sql.includes("catalog_tcgplayer_automation_domain_rate_limits")) {
      return this.clear("providerOptionRateLimits");
    }
    if (sql.includes("catalog_provider_integration_profile_versions")) {
      const deleted = sql.includes("authoring_audit_json IS NULL")
        ? this.counts.providerProfileVersions - this.counts.adminAuthoredProfileVersions
        : this.counts.providerProfileVersions;
      this.counts = {
        ...this.counts,
        providerProfileVersions: sql.includes("authoring_audit_json IS NULL")
          ? this.counts.adminAuthoredProfileVersions
          : 0,
        activeProviderProfiles: 0,
      };
      return deleted;
    }
    return 0;
  }

  private clear(key: keyof CatalogIntegrationCounts): number {
    const count = this.counts[key];
    this.counts = { ...this.counts, [key]: 0 };
    return count;
  }

  private countFor(sql: string): number {
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
      return this.counts.providerOptionRateLimits;
    }
    return 0;
  }
}
