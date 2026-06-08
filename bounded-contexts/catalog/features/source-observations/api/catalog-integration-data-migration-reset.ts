import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import { seedCatalogProviderIntegrationProfileVersions } from "./provider-integration-profile-store";
import type { CatalogIntegrationSchemaCompatibilitySurfaceKey } from "./catalog-integration-schema-compatibility";

export type CatalogIntegrationDataSurfaceKey =
  | "provider-profile-version"
  | "profile-section-projection"
  | "profile-section-diagnostic"
  | "source-observation"
  | "integration-durable-job"
  | "integration-job-event"
  | "integration-work-unit"
  | "bulk-review-job"
  | "bulk-review-job-event"
  | "bulk-review-work-unit"
  | "provider-option-query-cache"
  | "provider-option-rate-limit";

export type CatalogIntegrationDataResetAction =
  | "delete"
  | "delete-and-rebuild-seed"
  | "rebuild-from-profile-version"
  | "verify-only";

export type CatalogIntegrationDataRetention =
  | "resettable-pre-launch"
  | "retain-when-referenced"
  | "preserve-admin-authored"
  | "operational-cache";

export type CatalogIntegrationDataSurfacePolicy = Readonly<{
  key: CatalogIntegrationDataSurfaceKey;
  tableName: string;
  compatibilitySurface: CatalogIntegrationSchemaCompatibilitySurfaceKey;
  retention: CatalogIntegrationDataRetention;
  resetAction: CatalogIntegrationDataResetAction;
  resetOrder: number;
  retainedWhen: readonly string[];
  backfillRequirement: string;
  rollbackRequirement: string;
  verificationQuery: string;
}>;

export type CatalogIntegrationDataResetMode = "pre-launch-wipe-and-rebuild";

export type CatalogIntegrationDataResetOptions = Readonly<{
  mode?: CatalogIntegrationDataResetMode;
  rebuildSeedProfiles?: boolean;
  preserveAdminAuthoredProfileVersions?: boolean;
  allowActiveJobReset?: boolean;
}>;

export type CatalogIntegrationDataResetStepReport = Readonly<{
  tableName: string;
  action: CatalogIntegrationDataResetAction;
  rowsAffected: number;
}>;

export type CatalogIntegrationDataVerificationReport = Readonly<{
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
  providerOptionQueryCacheEntries: number;
  providerOptionRateLimits: number;
}>;

export type CatalogIntegrationDataBackfillDecision = Readonly<{
  key: "profile-section-projections" | "source-observation-profile-references" | "durable-job-profile-snapshots";
  required: boolean;
  reason: string;
}>;

export type CatalogIntegrationDataResetReport = Readonly<{
  mode: CatalogIntegrationDataResetMode;
  before: CatalogIntegrationDataVerificationReport;
  after: CatalogIntegrationDataVerificationReport;
  steps: readonly CatalogIntegrationDataResetStepReport[];
  backfillDecisions: readonly CatalogIntegrationDataBackfillDecision[];
  seedProfilesRebuilt: boolean;
}>;

type CountRow = Readonly<{ count: number | string }>;
type DeleteRow = Readonly<{ rows_deleted: number | string }>;

const resettablePreLaunchReason =
  "The Catalog Integration Control Plane has not launched; reset/rebuild is preferred unless a retained-data exception exists.";

export const catalogIntegrationDataSurfacePolicies = [
  {
    key: "integration-work-unit",
    tableName: "catalog_source_observation_integration_work_units",
    compatibilitySurface: "integration-work-unit",
    retention: "retain-when-referenced",
    resetAction: "delete",
    resetOrder: 10,
    retainedWhen: ["queued or running integration jobs must finish, fail, or be cancelled before reset"],
    backfillRequirement: "No backfill after pre-launch wipe; retained jobs keep their original work-unit snapshots.",
    rollbackRequirement:
      "Rollback must not rewrite queued work units; cancel and re-enqueue if the active profile changes.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_source_observation_integration_work_units",
  },
  {
    key: "integration-job-event",
    tableName: "catalog_source_observation_integration_job_events",
    compatibilitySurface: "integration-durable-job",
    retention: "retain-when-referenced",
    resetAction: "delete",
    resetOrder: 20,
    retainedWhen: ["job event history is retained only for intentionally retained launched/audit evidence"],
    backfillRequirement:
      "No backfill after pre-launch wipe; retained events stay readable through durable-job compatibility.",
    rollbackRequirement: "Rollback records new lifecycle events instead of editing old job events.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_source_observation_integration_job_events",
  },
  {
    key: "integration-durable-job",
    tableName: "catalog_source_observation_integration_durable_jobs",
    compatibilitySurface: "integration-durable-job",
    retention: "retain-when-referenced",
    resetAction: "delete",
    resetOrder: 30,
    retainedWhen: ["queued or running import/reapply jobs block reset unless an operator explicitly forces cleanup"],
    backfillRequirement: "No backfill after pre-launch wipe; retained jobs keep their snapshotted profile version.",
    rollbackRequirement: "Rollback activates a prior profile version for new jobs; already queued jobs keep snapshots.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_source_observation_integration_durable_jobs",
  },
  {
    key: "bulk-review-work-unit",
    tableName: "catalog_source_observation_bulk_review_work_units",
    compatibilitySurface: "integration-work-unit",
    retention: "retain-when-referenced",
    resetAction: "delete",
    resetOrder: 40,
    retainedWhen: ["queued or running bulk review jobs must finish, fail, or be cancelled before reset"],
    backfillRequirement: "No backfill after pre-launch wipe; retained review units keep their target observation IDs.",
    rollbackRequirement: "Bulk review rollback is operational cancellation plus re-enqueue after profile rollback.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_source_observation_bulk_review_work_units",
  },
  {
    key: "bulk-review-job-event",
    tableName: "catalog_source_observation_bulk_review_job_events",
    compatibilitySurface: "integration-durable-job",
    retention: "retain-when-referenced",
    resetAction: "delete",
    resetOrder: 50,
    retainedWhen: ["bulk review event history is retained only for launched/audit evidence"],
    backfillRequirement: "No backfill after pre-launch wipe.",
    rollbackRequirement: "Rollback records new events instead of editing old event snapshots.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_source_observation_bulk_review_job_events",
  },
  {
    key: "bulk-review-job",
    tableName: "catalog_source_observation_bulk_review_jobs",
    compatibilitySurface: "integration-durable-job",
    retention: "retain-when-referenced",
    resetAction: "delete",
    resetOrder: 60,
    retainedWhen: ["queued or running bulk promote/reject jobs block reset unless explicitly forced"],
    backfillRequirement: "No backfill after pre-launch wipe.",
    rollbackRequirement: "Rollback is cancellation plus a new review job after the target profile is active.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_source_observation_bulk_review_jobs",
  },
  {
    key: "source-observation",
    tableName: "catalog_source_observations",
    compatibilitySurface: "source-observation-record",
    retention: "retain-when-referenced",
    resetAction: "delete",
    resetOrder: 70,
    retainedWhen: [
      "promoted observations needed to explain launched Catalog Items",
      "observations covered by an explicit #804 retained-data exception",
    ],
    backfillRequirement:
      "Only retained observations need profile-version reference backfill; pre-launch observations are wiped and re-imported.",
    rollbackRequirement: "Rollback never rewrites observations; reapply/import under the rolled-back active profile.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_source_observations",
  },
  {
    key: "profile-section-diagnostic",
    tableName: "catalog_provider_profile_version_section_diagnostics",
    compatibilitySurface: "diagnostic-record",
    retention: "resettable-pre-launch",
    resetAction: "rebuild-from-profile-version",
    resetOrder: 80,
    retainedWhen: ["diagnostics are retained only when the parent profile version is intentionally retained"],
    backfillRequirement: "Rebuild by refreshing profile section projections from retained or seeded profile versions.",
    rollbackRequirement: "Rollback reads diagnostics from the activated profile version's regenerated sections.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_provider_profile_version_section_diagnostics",
  },
  {
    key: "profile-section-projection",
    tableName: "catalog_provider_profile_version_sections",
    compatibilitySurface: "profile-section-command",
    retention: "resettable-pre-launch",
    resetAction: "rebuild-from-profile-version",
    resetOrder: 90,
    retainedWhen: ["sections are retained only when the parent profile version is intentionally retained"],
    backfillRequirement: "Rebuild section rows, fingerprints, validation status, and diagnostics from profile JSON.",
    rollbackRequirement: "Rollback activates a profile version whose sections can be rebuilt deterministically.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_provider_profile_version_sections",
  },
  {
    key: "provider-option-query-cache",
    tableName: "catalog_provider_option_query_cache",
    compatibilitySurface: "provider-payload-provenance-envelope",
    retention: "operational-cache",
    resetAction: "delete",
    resetOrder: 100,
    retainedWhen: ["provider option query cache is operational state and is not retained across pre-launch reset"],
    backfillRequirement: "No backfill; Admin option selectors repopulate cache through bounded live queries.",
    rollbackRequirement: "Rollback does not restore cached provider option pages.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_provider_option_query_cache",
  },
  {
    key: "provider-option-rate-limit",
    tableName: "catalog_tcgplayer_automation_domain_rate_limits",
    compatibilitySurface: "provider-payload-provenance-envelope",
    retention: "operational-cache",
    resetAction: "delete",
    resetOrder: 105,
    retainedWhen: [
      "learned provider throttling state is operational cache and is not retained across pre-launch reset",
    ],
    backfillRequirement: "No backfill; adapters relearn throttling from current runtime behavior.",
    rollbackRequirement: "Rollback does not restore learned throttling state.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_tcgplayer_automation_domain_rate_limits",
  },
  {
    key: "provider-profile-version",
    tableName: "catalog_provider_integration_profile_versions",
    compatibilitySurface: "provider-profile-version",
    retention: "preserve-admin-authored",
    resetAction: "delete-and-rebuild-seed",
    resetOrder: 110,
    retainedWhen: [
      "admin-authored rows with authoring audit",
      "rows with migration evidence",
      "profile versions referenced by intentionally retained Source Observations, jobs, rollback, or audit evidence",
    ],
    backfillRequirement: "Seeded profiles are rebuilt from code; retained admin-authored rows keep their stored JSON.",
    rollbackRequirement: "Rollback activates a prior retained/seeded validated profile version.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_provider_integration_profile_versions",
  },
] as const satisfies readonly CatalogIntegrationDataSurfacePolicy[];

export const catalogIntegrationDataResetDeleteStatements = catalogIntegrationDataSurfacePolicies
  .filter((surface) => surface.resetAction === "delete" || surface.resetAction === "delete-and-rebuild-seed")
  .sort((left, right) => left.resetOrder - right.resetOrder)
  .map((surface) => ({
    tableName: surface.tableName,
    action: surface.resetAction,
    sql:
      surface.key === "provider-profile-version"
        ? `DELETE FROM ${surface.tableName}
WHERE authoring_audit_json IS NULL
  AND migration_evidence_json IS NULL`
        : `DELETE FROM ${surface.tableName}`,
  }));

export async function collectCatalogIntegrationDataVerificationReport(
  db: PgQueryable,
): Promise<CatalogIntegrationDataVerificationReport> {
  const providerProfileVersions = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_provider_integration_profile_versions",
  );
  const adminAuthoredProfileVersions = await countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM catalog_provider_integration_profile_versions
       WHERE authoring_audit_json IS NOT NULL
          OR migration_evidence_json IS NOT NULL`,
  );
  const referencedProfileVersions = await countRows(
    db,
    `WITH referenced_versions AS (
         SELECT provider_key, source_profile_version AS profile_version
         FROM catalog_source_observations
         UNION
         SELECT provider_key, promotion_profile_version AS profile_version
         FROM catalog_source_observations
         WHERE promotion_profile_version IS NOT NULL
       )
       SELECT COUNT(*) AS count
       FROM referenced_versions
       WHERE profile_version IS NOT NULL
         AND profile_version <> 'legacy'`,
  );
  const activeProviderProfiles = await countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM catalog_provider_integration_profile_versions
       WHERE active = true AND lifecycle = 'active'`,
  );
  const sourceObservations = await countRows(db, "SELECT COUNT(*) AS count FROM catalog_source_observations");
  const legacySourceObservationReferences = await countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM catalog_source_observations
       WHERE source_profile_version = 'legacy'
          OR source_mapping_fingerprint = 'legacy'
          OR promotion_profile_version = 'legacy'`,
  );
  const integrationDurableJobs = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_source_observation_integration_durable_jobs",
  );
  const activeIntegrationDurableJobs = await countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM catalog_source_observation_integration_durable_jobs
       WHERE status IN ('queued', 'running')`,
  );
  const integrationWorkUnits = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_source_observation_integration_work_units",
  );
  const bulkReviewJobs = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_source_observation_bulk_review_jobs",
  );
  const activeBulkReviewJobs = await countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM catalog_source_observation_bulk_review_jobs
       WHERE status IN ('queued', 'running')`,
  );
  const bulkReviewWorkUnits = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_source_observation_bulk_review_work_units",
  );
  const profileSections = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_provider_profile_version_sections",
  );
  const profileSectionDiagnostics = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_provider_profile_version_section_diagnostics",
  );
  const providerOptionRateLimits = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_tcgplayer_automation_domain_rate_limits",
  );
  const providerOptionQueryCacheEntries = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_provider_option_query_cache",
  );

  return {
    providerProfileVersions,
    adminAuthoredProfileVersions,
    referencedProfileVersions,
    activeProviderProfiles,
    sourceObservations,
    legacySourceObservationReferences,
    integrationDurableJobs,
    activeIntegrationDurableJobs,
    integrationWorkUnits,
    bulkReviewJobs,
    activeBulkReviewJobs,
    bulkReviewWorkUnits,
    profileSections,
    profileSectionDiagnostics,
    providerOptionQueryCacheEntries,
    providerOptionRateLimits,
  };
}

export function catalogIntegrationDataBackfillDecisions(
  report: CatalogIntegrationDataVerificationReport,
): readonly CatalogIntegrationDataBackfillDecision[] {
  return [
    {
      key: "profile-section-projections",
      required: report.providerProfileVersions > 0,
      reason:
        report.providerProfileVersions > 0
          ? "Profile section projections must be rebuilt from every retained or seeded profile version."
          : "No provider profile versions remain to project.",
    },
    {
      key: "source-observation-profile-references",
      required: report.sourceObservations > 0 || report.legacySourceObservationReferences > 0,
      reason:
        report.sourceObservations > 0
          ? "Retained Source Observations must carry non-legacy profile version and mapping fingerprint references."
          : "Pre-launch Source Observations were wiped and will be recreated by import.",
    },
    {
      key: "durable-job-profile-snapshots",
      required: report.integrationDurableJobs > 0 || report.integrationWorkUnits > 0,
      reason:
        report.integrationDurableJobs > 0 || report.integrationWorkUnits > 0
          ? "Retained durable jobs and work units must keep profile snapshots readable through deploy skew."
          : "No retained integration jobs or work units remain.",
    },
  ];
}

export async function resetCatalogIntegrationPreLaunchData(
  db: PgQueryable,
  options: CatalogIntegrationDataResetOptions = {},
): Promise<CatalogIntegrationDataResetReport> {
  const normalizedOptions = {
    mode: options.mode ?? "pre-launch-wipe-and-rebuild",
    rebuildSeedProfiles: options.rebuildSeedProfiles ?? true,
    preserveAdminAuthoredProfileVersions: options.preserveAdminAuthoredProfileVersions ?? true,
    allowActiveJobReset: options.allowActiveJobReset ?? false,
  } as const satisfies Required<CatalogIntegrationDataResetOptions>;

  return withOptionalResetTransaction(db, async (queryable) => {
    const before = await collectCatalogIntegrationDataVerificationReport(queryable);
    if (!normalizedOptions.allowActiveJobReset) {
      assertNoActiveCatalogIntegrationJobs(before);
    }

    const steps: CatalogIntegrationDataResetStepReport[] = [];

    for (const statement of catalogIntegrationDataResetDeleteStatements) {
      if (
        statement.tableName === "catalog_provider_integration_profile_versions" &&
        !normalizedOptions.preserveAdminAuthoredProfileVersions
      ) {
        const rowsAffected = await deleteRows(queryable, `DELETE FROM ${statement.tableName}`);
        steps.push({ tableName: statement.tableName, action: "delete-and-rebuild-seed", rowsAffected });
        continue;
      }

      const rowsAffected = await deleteRows(queryable, statement.sql);
      steps.push({ tableName: statement.tableName, action: statement.action, rowsAffected });
    }

    if (normalizedOptions.rebuildSeedProfiles) {
      const seededProfiles = await seedCatalogProviderIntegrationProfileVersions(queryable);
      steps.push({
        tableName: "catalog_provider_integration_profile_versions",
        action: "delete-and-rebuild-seed",
        rowsAffected: seededProfiles.length,
      });
    }

    const after = await collectCatalogIntegrationDataVerificationReport(queryable);
    return {
      mode: normalizedOptions.mode,
      before,
      after,
      steps,
      backfillDecisions: catalogIntegrationDataBackfillDecisions(after),
      seedProfilesRebuilt: normalizedOptions.rebuildSeedProfiles,
    };
  });
}

export function catalogIntegrationDataRollbackChecklist(): readonly string[] {
  return [
    "Stop or cancel queued/running Catalog integration and bulk review jobs before reset or rollback.",
    "Activate the prior validated Provider Integration Profile version instead of editing historical profile rows.",
    "Let already queued integration jobs finish against their snapshotted profile version, or cancel and re-enqueue them.",
    "Run a narrow import or reapply after rollback and compare Source Observation counts, diagnostics, and promotion plans.",
    "Rebuild profile section projections from the retained/active profile version and verify no legacy profile references remain.",
  ];
}

export function catalogIntegrationDataReleaseVerificationQueries(): readonly string[] {
  return [
    "SELECT COUNT(*) AS provider_profile_versions FROM catalog_provider_integration_profile_versions;",
    "SELECT COUNT(*) AS active_provider_profiles FROM catalog_provider_integration_profile_versions WHERE active = true AND lifecycle = 'active';",
    "SELECT COUNT(*) AS source_observations FROM catalog_source_observations;",
    "SELECT COUNT(*) AS legacy_source_observation_references FROM catalog_source_observations WHERE source_profile_version = 'legacy' OR source_mapping_fingerprint = 'legacy' OR promotion_profile_version = 'legacy';",
    "SELECT status, COUNT(*) AS jobs FROM catalog_source_observation_integration_durable_jobs GROUP BY status ORDER BY status;",
    "SELECT state, COUNT(*) AS work_units FROM catalog_source_observation_integration_work_units GROUP BY state ORDER BY state;",
    "SELECT COUNT(*) AS profile_sections FROM catalog_provider_profile_version_sections;",
    "SELECT COUNT(*) AS profile_section_diagnostics FROM catalog_provider_profile_version_section_diagnostics;",
  ];
}

function assertNoActiveCatalogIntegrationJobs(report: CatalogIntegrationDataVerificationReport): void {
  const activeJobs = report.activeIntegrationDurableJobs + report.activeBulkReviewJobs;
  if (activeJobs > 0) {
    throw new Error(
      `Catalog integration reset is blocked by ${activeJobs} queued or running job(s). Cancel or finish active work before reset, or pass allowActiveJobReset for an explicit forced pre-launch wipe.`,
    );
  }
}

async function countRows(db: PgQueryable, sql: string): Promise<number> {
  const result = await db.query<CountRow>(sql);
  return Number(result.rows[0]?.count ?? 0);
}

async function deleteRows(db: PgQueryable, sql: string): Promise<number> {
  const result = await db.query<DeleteRow>(
    `WITH deleted AS (${sql} RETURNING 1) SELECT COUNT(*) AS rows_deleted FROM deleted`,
  );
  return Number(result.rows[0]?.rows_deleted ?? 0);
}

async function withOptionalResetTransaction<T>(
  db: PgQueryable,
  work: (queryable: PgQueryable) => Promise<T>,
): Promise<T> {
  if (isTransactionalPool(db)) {
    return withPgTransaction(db, work);
  }

  return work(db);
}

function isTransactionalPool(db: PgQueryable): db is PgTransactionalPool {
  return "connect" in db && typeof db.connect === "function";
}

export const catalogIntegrationDataResetPlanSummary = `${resettablePreLaunchReason} Fresh bootstrap must recreate seeded provider profiles through the persisted profile store, and any retained data must be named with owner, reason, and removal criteria in #804.`;
