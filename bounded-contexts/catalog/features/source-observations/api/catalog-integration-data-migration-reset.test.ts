import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_RESET_TARGET,
  catalogIntegrationDataBackfillDecisions,
  catalogIntegrationDataReleaseVerificationQueries,
  catalogIntegrationDataResetDeleteStatements,
  catalogIntegrationDataResetEnvironmentPlans,
  catalogIntegrationDataRollbackChecklist,
  catalogIntegrationDataSurfacePolicies,
  catalogIntegrationDataResetTargetTables,
  collectCatalogIntegrationDataVerificationReport,
  evaluateCatalogIntegrationDataResetEvidence,
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
  seedCatalogProviderIntegrationProfileVersionsInTransaction: seedCatalogProviderIntegrationProfileVersions,
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
      "provider-option-query-cache",
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
      "catalog_provider_option_query_cache",
      "catalog_tcgplayer_automation_domain_rate_limits",
      "catalog_provider_integration_profile_versions",
    ]);

    expect(catalogIntegrationDataResetDeleteStatements.at(-1)?.sql).toContain("authoring_audit_json IS NULL");
    expect(catalogIntegrationDataResetDeleteStatements.at(-1)?.sql).toContain("migration_evidence_json IS NULL");
    expect(catalogIntegrationDataResetTargetTables()).toEqual([
      ...catalogIntegrationDataResetDeleteStatements.map((statement) => statement.tableName),
      CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_RESET_TARGET,
    ]);
    expect(catalogIntegrationDataResetTargetTables()).not.toContain("catalog_items");
    expect(catalogIntegrationDataResetTargetTables()).not.toContain("marketplace_listings");
  });

  it("defines environment-specific reset evidence plans", () => {
    expect(catalogIntegrationDataResetEnvironmentPlans).toEqual([
      expect.objectContaining({
        environment: "local-dev-test",
        requiresBackupDecision: false,
        requiresApprovalReference: false,
      }),
      expect.objectContaining({
        environment: "staging",
        requiresBackupDecision: true,
        requiresApprovalReference: true,
      }),
      expect.objectContaining({
        environment: "production-prelaunch",
        requiresBackupDecision: true,
        requiresApprovalReference: true,
      }),
    ]);
    expect(catalogIntegrationDataResetEnvironmentPlans.at(-1)?.unrelatedDataBoundary).toContain(
      "customer, order, billing, auth, marketplace, inventory",
    );
  });

  it("collects a verification report for launch reset checks", async () => {
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
      sourceObservationEventStreams: 6,
      sourceObservationEvents: 14,
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
      sourceObservationEventStreams: 6,
      sourceObservationEvents: 14,
      integrationDurableJobs: 2,
    });
    expect(report.after).toMatchObject({
      providerProfileVersions: 1,
      adminAuthoredProfileVersions: 1,
      sourceObservations: 0,
      sourceObservationEventStreams: 0,
      sourceObservationEvents: 0,
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
    expect(db.statements.findIndex((sql) => sql.startsWith("LOCK TABLE"))).toBeLessThan(
      db.statements.findIndex((sql) => sql.includes("SELECT COUNT(*) AS count")),
    );
    expect(db.statements).toContain(
      "LOCK TABLE catalog_source_observation_integration_durable_jobs, catalog_source_observation_bulk_review_jobs IN SHARE ROW EXCLUSIVE MODE",
    );
  });

  it("fails the postcondition when Source Observation authority survives the projection wipe", () => {
    const findings = evaluateCatalogIntegrationDataResetEvidence({
      environment: "local-dev-test",
      generatedAt: "2026-07-18T20:00:00.000Z",
      operator: "test-operator",
      targetTables: catalogIntegrationDataResetTargetTables(),
      dryRun: cleanVerificationReport({ sourceObservations: 1, sourceObservationEventStreams: 1 }),
      before: cleanVerificationReport({ sourceObservations: 1, sourceObservationEventStreams: 1 }),
      after: cleanVerificationReport({ sourceObservationEventStreams: 1, sourceObservationEvents: 3 }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: "post-reset-source-observation-event-streams-remain",
        severity: "p0",
        message: "Post-reset verification still has 1 Source Observation event stream row(s) and 3 event row(s).",
      }),
    ]);
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

  it("requires staging reset evidence to include approval, backup posture, dry-run, and before/after reports", () => {
    const findings = evaluateCatalogIntegrationDataResetEvidence({
      environment: "staging",
      generatedAt: "",
      operator: "",
      approvalReference: null,
      backupDecision: null,
      targetTables: ["catalog_source_observations"],
      dryRun: null,
      before: null,
      after: null,
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "missing-operator",
      "missing-generated-at",
      "missing-approval-reference",
      "missing-backup-decision",
      "missing-smoke-verification-reference",
      "missing-dry-run",
      "missing-before-verification",
      "missing-after-verification",
    ]);
  });

  it("accepts production/prelaunch evidence when data loss is approved and reset postconditions are clean", () => {
    expect(
      evaluateCatalogIntegrationDataResetEvidence({
        environment: "production-prelaunch",
        generatedAt: "2026-06-09T00:00:00.000Z",
        operator: "catalog-release-lead",
        approvalReference: "private-evidence://catalog/prelaunch-reset/approval-20260609",
        stagingRehearsalReference: "private-evidence://catalog/prelaunch-reset/staging-rehearsal-20260609",
        smokeVerificationReference: "private-evidence://catalog/prelaunch-reset/prod-smoke-20260609",
        backupDecision: {
          kind: "skip-backup-accepted-data-loss",
          approver: "catalog-release-lead",
          rationale: "Only unlaunched Catalog integration data is targeted; fresh import rebuilds source data.",
          targetDataSet: "Catalog integration prelaunch state",
        },
        targetTables: catalogIntegrationDataResetTargetTables(),
        dryRun: cleanVerificationReport({
          sourceObservations: 12,
          legacySourceObservationReferences: 4,
          integrationDurableJobs: 2,
        }),
        before: cleanVerificationReport({
          sourceObservations: 12,
          legacySourceObservationReferences: 4,
          integrationDurableJobs: 2,
        }),
        after: cleanVerificationReport({ activeProviderProfiles: 3, profileSections: 24 }),
      }),
    ).toEqual([]);
  });

  it("blocks unsafe target tables and forced active-job reset evidence gaps", () => {
    const findings = evaluateCatalogIntegrationDataResetEvidence({
      environment: "production-prelaunch",
      generatedAt: "2026-06-09T00:00:00.000Z",
      operator: "catalog-release-lead",
      approvalReference: "private-evidence://catalog/prelaunch-reset/approval-20260609",
      stagingRehearsalReference: "private-evidence://catalog/prelaunch-reset/staging-rehearsal-20260609",
      smokeVerificationReference: "private-evidence://catalog/prelaunch-reset/prod-smoke-20260609",
      backupDecision: {
        kind: "create-backup-snapshot-export",
        reference: "private-evidence://catalog/prelaunch-reset/export-20260609",
        owner: "catalog-release-lead",
        retentionUntil: "2026-06-30",
        restoreVerificationReference: "private-evidence://catalog/prelaunch-reset/restore-check-20260609",
      },
      targetTables: [...catalogIntegrationDataResetTargetTables(), "orders"],
      dryRun: cleanVerificationReport({ activeIntegrationDurableJobs: 1 }),
      before: cleanVerificationReport({ activeIntegrationDurableJobs: 1 }),
      after: cleanVerificationReport({
        sourceObservations: 1,
        sourceObservationEventStreams: 1,
        sourceObservationEvents: 2,
        legacySourceObservationReferences: 1,
        integrationDurableJobs: 1,
        providerOptionQueryCacheEntries: 2,
        providerOptionRateLimits: 2,
        activeProviderProfiles: 0,
      }),
      forcedActiveJobReset: { approver: "", rationale: "", activeJobCount: 0 },
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "unsafe-target-table",
      "incomplete-forced-active-job-decision",
      "post-reset-source-observations-remain",
      "post-reset-source-observation-event-streams-remain",
      "post-reset-legacy-references-remain",
      "post-reset-integration-jobs-remain",
      "post-reset-provider-option-cache-remain",
      "post-reset-provider-rate-limits-remain",
      "post-reset-seeded-profiles-missing",
    ]);
  });

  it("requires production evidence to identify staging rehearsal, smoke verification, and target tables", () => {
    const findings = evaluateCatalogIntegrationDataResetEvidence({
      environment: "production-prelaunch",
      generatedAt: "2026-06-09T00:00:00.000Z",
      operator: "catalog-release-lead",
      approvalReference: "private-evidence://catalog/prelaunch-reset/approval-20260609",
      backupDecision: {
        kind: "skip-backup-accepted-data-loss",
        approver: "catalog-release-lead",
        rationale: "Only unlaunched Catalog integration data is targeted; fresh import rebuilds source data.",
        targetDataSet: "Catalog integration prelaunch state",
      },
      targetTables: [],
      dryRun: cleanVerificationReport(),
      before: cleanVerificationReport(),
      after: cleanVerificationReport({ activeProviderProfiles: 3, profileSections: 24 }),
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "missing-staging-rehearsal-reference",
      "missing-smoke-verification-reference",
      "missing-target-tables",
    ]);
  });

  it("does not accept retained-data reset-unsafe evidence as clean reset completion", () => {
    const findings = evaluateCatalogIntegrationDataResetEvidence({
      environment: "staging",
      generatedAt: "2026-06-09T00:00:00.000Z",
      operator: "catalog-release-lead",
      approvalReference: "private-evidence://catalog/prelaunch-reset/staging-approval-20260609",
      smokeVerificationReference: "private-evidence://catalog/prelaunch-reset/staging-smoke-20260609",
      backupDecision: {
        kind: "retain-data-reset-unsafe",
        owner: "catalog-release-lead",
        expiresAt: "2026-06-30",
        reason: "Reset postponed until upstream export is verified.",
      },
      targetTables: catalogIntegrationDataResetTargetTables(),
      dryRun: cleanVerificationReport(),
      before: cleanVerificationReport(),
      after: cleanVerificationReport({ activeProviderProfiles: 3, profileSections: 24 }),
    });

    expect(findings.map((finding) => finding.code)).toEqual(["reset-unsafe-data-retained"]);
  });

  it("requires a forced active-job decision when dry-run saw active jobs even if before counts are clean", () => {
    const findings = evaluateCatalogIntegrationDataResetEvidence({
      environment: "staging",
      generatedAt: "2026-06-09T00:00:00.000Z",
      operator: "catalog-release-lead",
      approvalReference: "private-evidence://catalog/prelaunch-reset/staging-approval-20260609",
      smokeVerificationReference: "private-evidence://catalog/prelaunch-reset/staging-smoke-20260609",
      backupDecision: {
        kind: "create-backup-snapshot-export",
        reference: "private-evidence://catalog/prelaunch-reset/staging-export-20260609",
        owner: "catalog-release-lead",
        retentionUntil: "2026-06-30",
        restoreVerificationReference: "private-evidence://catalog/prelaunch-reset/staging-restore-check-20260609",
      },
      targetTables: catalogIntegrationDataResetTargetTables(),
      dryRun: cleanVerificationReport({ activeIntegrationDurableJobs: 1 }),
      before: cleanVerificationReport(),
      after: cleanVerificationReport({ activeProviderProfiles: 3, profileSections: 24 }),
    });

    expect(findings.map((finding) => finding.code)).toEqual(["active-jobs-require-forced-decision"]);
  });

  it("marks backfill work as skipped after a clean pre-launch wipe", () => {
    expect(
      catalogIntegrationDataBackfillDecisions({
        providerProfileVersions: 1,
        adminAuthoredProfileVersions: 0,
        referencedProfileVersions: 0,
        activeProviderProfiles: 1,
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
        profileSections: 12,
        profileSectionDiagnostics: 0,
        providerOptionQueryCacheEntries: 0,
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
  sourceObservationEventStreams: number;
  sourceObservationEvents: number;
  legacySourceObservationReferences: number;
  integrationDurableJobs: number;
  activeIntegrationDurableJobs: number;
  integrationWorkUnits: number;
  bulkReviewJobs: number;
  activeBulkReviewJobs: number;
  bulkReviewWorkUnits: number;
  profileSections: number;
  profileSectionDiagnostics: number;
  providerOptionQueryCacheEntries: number;
  providerOptionRateLimits: number;
}>;

function cleanVerificationReport(counts: Partial<CatalogIntegrationCounts> = {}): CatalogIntegrationCounts {
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
    ...counts,
  };
}

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
      sourceObservationEventStreams: 0,
      sourceObservationEvents: 0,
      legacySourceObservationReferences: 0,
      integrationDurableJobs: 0,
      activeIntegrationDurableJobs: 0,
      integrationWorkUnits: 0,
      bulkReviewJobs: 0,
      activeBulkReviewJobs: 0,
      bulkReviewWorkUnits: 0,
      profileSections: 0,
      profileSectionDiagnostics: 0,
      providerOptionQueryCacheEntries: 0,
      providerOptionRateLimits: 0,
      ...counts,
    };
  }

  async connect(): Promise<{ query: InMemoryCatalogIntegrationDataDb["query"]; release: () => void }> {
    return {
      query: this.query.bind(this),
      release: () => undefined,
    };
  }

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    this.statements.push(sql);

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("LOCK TABLE")) {
      return { rows: [] };
    }

    if (sql.startsWith("WITH deleted AS (DELETE FROM ")) {
      return { rows: [{ rows_deleted: this.applyDelete(sql) } as T] };
    }

    return { rows: [{ count: this.countFor(sql) } as T] };
  }

  private applyDelete(sql: string): number {
    if (sql.includes("event_store_streams")) {
      const deleted = this.clear("sourceObservationEventStreams");
      this.counts = { ...this.counts, sourceObservationEvents: 0 };
      return deleted;
    }
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
    if (sql.includes("catalog_provider_option_query_cache")) {
      return this.clear("providerOptionQueryCacheEntries");
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
      return this.counts.providerOptionRateLimits;
    }
    if (sql.includes("catalog_provider_option_query_cache")) {
      return this.counts.providerOptionQueryCacheEntries;
    }
    return 0;
  }
}
