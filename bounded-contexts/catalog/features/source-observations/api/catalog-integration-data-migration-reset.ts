import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { escapeLikePattern, withPgTransaction } from "@chase-sets/event-core-postgres";
import { seedCatalogProviderIntegrationProfileVersionsInTransaction } from "./provider-integration-profile-store";
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

export type CatalogIntegrationDataResetEnvironment = "local-dev-test" | "staging" | "production-prelaunch";

export type CatalogIntegrationDataBackupDecision =
  | Readonly<{
      kind: "create-backup-snapshot-export";
      reference: string;
      owner: string;
      retentionUntil: string;
      restoreVerificationReference: string;
    }>
  | Readonly<{
      kind: "skip-backup-accepted-data-loss";
      approver: string;
      rationale: string;
      targetDataSet: string;
    }>
  | Readonly<{
      kind: "retain-data-reset-unsafe";
      owner: string;
      expiresAt: string;
      reason: string;
    }>;

export type CatalogIntegrationDataResetEnvironmentPlan = Readonly<{
  environment: CatalogIntegrationDataResetEnvironment;
  destructiveResetAllowed: boolean;
  requiresBackupDecision: boolean;
  requiresApprovalReference: boolean;
  requiresDryRunCounts: boolean;
  requiresBeforeAfterVerification: boolean;
  unrelatedDataBoundary: string;
  executionEvidence: readonly string[];
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

export type CatalogIntegrationDataResetForcedActiveJobDecision = Readonly<{
  approver: string;
  rationale: string;
  activeJobCount: number;
}>;

export type CatalogIntegrationDataResetEvidencePacket = Readonly<{
  environment: CatalogIntegrationDataResetEnvironment;
  generatedAt: string;
  operator: string;
  approvalReference?: string | null;
  backupDecision?: CatalogIntegrationDataBackupDecision | null;
  stagingRehearsalReference?: string | null;
  smokeVerificationReference?: string | null;
  targetTables: readonly string[];
  dryRun: CatalogIntegrationDataVerificationReport | null;
  before: CatalogIntegrationDataVerificationReport | null;
  after: CatalogIntegrationDataVerificationReport | null;
  forcedActiveJobReset?: CatalogIntegrationDataResetForcedActiveJobDecision | null;
}>;

export type CatalogIntegrationDataResetEvidenceFinding = Readonly<{
  code:
    | "missing-operator"
    | "missing-generated-at"
    | "missing-approval-reference"
    | "missing-backup-decision"
    | "incomplete-backup-decision"
    | "reset-unsafe-data-retained"
    | "missing-staging-rehearsal-reference"
    | "missing-smoke-verification-reference"
    | "missing-dry-run"
    | "missing-before-verification"
    | "missing-after-verification"
    | "missing-target-tables"
    | "unsafe-target-table"
    | "active-jobs-require-forced-decision"
    | "incomplete-forced-active-job-decision"
    | "post-reset-source-observations-remain"
    | "post-reset-source-observation-event-streams-remain"
    | "post-reset-legacy-references-remain"
    | "post-reset-integration-jobs-remain"
    | "post-reset-bulk-review-jobs-remain"
    | "post-reset-provider-option-cache-remain"
    | "post-reset-provider-rate-limits-remain"
    | "post-reset-seeded-profiles-missing";
  severity: "p0" | "p1";
  message: string;
}>;

type CountRow = Readonly<{ count: number | string }>;
type DeleteRow = Readonly<{ rows_deleted: number | string }>;

const resettablePreLaunchReason =
  "The Catalog Integration Control Plane has not launched; reset/rebuild is preferred unless a retained-data exception exists.";

export const CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_PREFIX = "catalog.source-observation-";
export const CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_RESET_TARGET = `event_store_streams / event_store_events WHERE stream_id LIKE '${CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_PREFIX}%'`;

const CATALOG_INTEGRATION_JOB_TABLES = [
  "catalog_source_observation_integration_durable_jobs",
  "catalog_source_observation_bulk_review_jobs",
] as const;

function sourceObservationStreamLikePattern(): string {
  return `${escapeLikePattern(CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_PREFIX)}%`;
}

export const catalogIntegrationDataResetEnvironmentPlans: readonly CatalogIntegrationDataResetEnvironmentPlan[] = [
  {
    environment: "local-dev-test",
    destructiveResetAllowed: true,
    requiresBackupDecision: false,
    requiresApprovalReference: false,
    requiresDryRunCounts: true,
    requiresBeforeAfterVerification: true,
    unrelatedDataBoundary:
      "Only Catalog integration tables named by catalogIntegrationDataResetTargetTables may be selected.",
    executionEvidence: [
      "dry-run verification counts",
      "before/after reset report",
      "seeded provider profile rebuild result",
    ],
  },
  {
    environment: "staging",
    destructiveResetAllowed: true,
    requiresBackupDecision: true,
    requiresApprovalReference: true,
    requiresDryRunCounts: true,
    requiresBeforeAfterVerification: true,
    unrelatedDataBoundary:
      "Only staging Catalog integration tables named by catalogIntegrationDataResetTargetTables may be selected; unrelated launched context tables are out of scope.",
    executionEvidence: [
      "backup/snapshot/export decision",
      "approval reference",
      "dry-run verification counts",
      "before/after reset report",
      "staging smoke verification",
    ],
  },
  {
    environment: "production-prelaunch",
    destructiveResetAllowed: true,
    requiresBackupDecision: true,
    requiresApprovalReference: true,
    requiresDryRunCounts: true,
    requiresBeforeAfterVerification: true,
    unrelatedDataBoundary:
      "Only production/prelaunch Catalog integration rows in the named reset tables may be selected; customer, order, billing, auth, marketplace, inventory, and unrelated audit data are excluded.",
    executionEvidence: [
      "backup/snapshot/export decision or accepted data-loss approval",
      "production/prelaunch approval reference",
      "dry-run verification counts",
      "before/after reset report",
      "staging rehearsal reference",
      "production smoke verification",
    ],
  },
] as const;

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

export function catalogIntegrationDataResetTargetTables(): readonly string[] {
  return [
    ...catalogIntegrationDataResetDeleteStatements.map((statement) => statement.tableName),
    CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_RESET_TARGET,
  ];
}

export function evaluateCatalogIntegrationDataResetEvidence(
  packet: CatalogIntegrationDataResetEvidencePacket,
): readonly CatalogIntegrationDataResetEvidenceFinding[] {
  const findings: CatalogIntegrationDataResetEvidenceFinding[] = [];
  const plan = catalogIntegrationDataResetEnvironmentPlans.find(
    (candidate) => candidate.environment === packet.environment,
  );
  const allowedTables = new Set(catalogIntegrationDataResetTargetTables());

  if (!packet.operator.trim()) {
    findings.push({
      code: "missing-operator",
      severity: "p1",
      message: resetEvidenceFindingMessage("Catalog integration reset evidence must name the operator."),
    });
  }
  if (!packet.generatedAt.trim()) {
    findings.push({
      code: "missing-generated-at",
      severity: "p1",
      message: resetEvidenceFindingMessage("Catalog integration reset evidence must include the generation timestamp."),
    });
  }
  if (plan?.requiresApprovalReference && !packet.approvalReference?.trim()) {
    findings.push({
      code: "missing-approval-reference",
      severity: "p0",
      message: resetEvidenceFindingMessage(`${packet.environment} reset evidence requires an approval reference.`),
    });
  }
  if (plan?.requiresBackupDecision && !packet.backupDecision) {
    findings.push({
      code: "missing-backup-decision",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        `${packet.environment} reset evidence requires a backup/snapshot/export decision.`,
      ),
    });
  }
  if (packet.backupDecision && !isCompleteBackupDecision(packet.backupDecision)) {
    findings.push({
      code: "incomplete-backup-decision",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        "Backup/snapshot/export decision is missing owner, approval, restore, rationale, or expiry evidence.",
      ),
    });
  }
  if (packet.backupDecision?.kind === "retain-data-reset-unsafe") {
    findings.push({
      code: "reset-unsafe-data-retained",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        "Reset evidence records retained data because destructive cleanup is unsafe; do not treat this as clean reset/drop completion.",
      ),
    });
  }
  if (packet.environment === "production-prelaunch" && !packet.stagingRehearsalReference?.trim()) {
    findings.push({
      code: "missing-staging-rehearsal-reference",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        "Production/prelaunch reset evidence requires the successful staging rehearsal reference.",
      ),
    });
  }
  if (packet.environment !== "local-dev-test" && !packet.smokeVerificationReference?.trim()) {
    findings.push({
      code: "missing-smoke-verification-reference",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        `${packet.environment} reset evidence requires the post-reset smoke verification reference.`,
      ),
    });
  }
  if (plan?.requiresDryRunCounts && packet.dryRun === null) {
    findings.push({
      code: "missing-dry-run",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        `${packet.environment} reset evidence requires dry-run counts before destructive execution.`,
      ),
    });
  }
  if (plan?.requiresBeforeAfterVerification && packet.before === null) {
    findings.push({
      code: "missing-before-verification",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        `${packet.environment} reset evidence requires a before-reset verification report.`,
      ),
    });
  }
  if (plan?.requiresBeforeAfterVerification && packet.after === null) {
    findings.push({
      code: "missing-after-verification",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        `${packet.environment} reset evidence requires an after-reset verification report.`,
      ),
    });
  }

  if (packet.targetTables.length === 0) {
    findings.push({
      code: "missing-target-tables",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        "Reset evidence must name the Catalog-owned tables selected for destructive cleanup.",
      ),
    });
  }
  for (const table of packet.targetTables) {
    if (!allowedTables.has(table)) {
      findings.push({
        code: "unsafe-target-table",
        severity: "p0",
        message: resetEvidenceFindingMessage(
          `Table '${table}' is not owned by the Catalog integration prelaunch reset plan.`,
        ),
      });
    }
  }

  const activeJobCount = Math.max(
    packet.dryRun ? packet.dryRun.activeIntegrationDurableJobs + packet.dryRun.activeBulkReviewJobs : 0,
    packet.before ? packet.before.activeIntegrationDurableJobs + packet.before.activeBulkReviewJobs : 0,
  );
  if (activeJobCount > 0 && !packet.forcedActiveJobReset) {
    findings.push({
      code: "active-jobs-require-forced-decision",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        "Active Catalog integration jobs require an explicit forced pre-launch wipe decision.",
      ),
    });
  }
  if (packet.forcedActiveJobReset && !isCompleteForcedActiveJobDecision(packet.forcedActiveJobReset)) {
    findings.push({
      code: "incomplete-forced-active-job-decision",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        "Forced active-job reset decision must include approver, rationale, and active job count.",
      ),
    });
  }

  if (packet.after) {
    findings.push(...catalogIntegrationDataResetPostconditionFindings(packet.after));
  }

  return findings;
}

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
  const sourceObservationEventStreams = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM event_store_streams WHERE stream_id LIKE $1 ESCAPE '\\'",
    [sourceObservationStreamLikePattern()],
  );
  const sourceObservationEvents = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1 ESCAPE '\\'",
    [sourceObservationStreamLikePattern()],
  );
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
    sourceObservationEventStreams,
    sourceObservationEvents,
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
  db: PgTransactionalPool,
  options: CatalogIntegrationDataResetOptions = {},
): Promise<CatalogIntegrationDataResetReport> {
  const normalizedOptions = {
    mode: options.mode ?? "pre-launch-wipe-and-rebuild",
    rebuildSeedProfiles: options.rebuildSeedProfiles ?? true,
    preserveAdminAuthoredProfileVersions: options.preserveAdminAuthoredProfileVersions ?? true,
    allowActiveJobReset: options.allowActiveJobReset ?? false,
  } as const satisfies Required<CatalogIntegrationDataResetOptions>;

  return withResetTransaction(db, async (queryable) => {
    await queryable.query(`LOCK TABLE ${CATALOG_INTEGRATION_JOB_TABLES.join(", ")} IN SHARE ROW EXCLUSIVE MODE`);
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

    steps.push({
      tableName: CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_RESET_TARGET,
      action: "delete",
      rowsAffected: await deleteRows(queryable, "DELETE FROM event_store_streams WHERE stream_id LIKE $1 ESCAPE '\\'", [
        sourceObservationStreamLikePattern(),
      ]),
    });

    if (normalizedOptions.rebuildSeedProfiles) {
      const seededProfiles = await seedCatalogProviderIntegrationProfileVersionsInTransaction(queryable);
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
    `SELECT COUNT(*) AS source_observation_event_streams FROM event_store_streams WHERE stream_id LIKE '${CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_PREFIX}%' ESCAPE '\\';`,
    `SELECT COUNT(*) AS source_observation_events FROM event_store_events WHERE stream_id LIKE '${CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_PREFIX}%' ESCAPE '\\';`,
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

function isCompleteBackupDecision(decision: CatalogIntegrationDataBackupDecision): boolean {
  if (decision.kind === "create-backup-snapshot-export") {
    return (
      Boolean(decision.reference.trim()) &&
      Boolean(decision.owner.trim()) &&
      Boolean(decision.retentionUntil.trim()) &&
      Boolean(decision.restoreVerificationReference.trim())
    );
  }
  if (decision.kind === "skip-backup-accepted-data-loss") {
    return (
      Boolean(decision.approver.trim()) && Boolean(decision.rationale.trim()) && Boolean(decision.targetDataSet.trim())
    );
  }
  return Boolean(decision.owner.trim()) && Boolean(decision.expiresAt.trim()) && Boolean(decision.reason.trim());
}

function isCompleteForcedActiveJobDecision(decision: CatalogIntegrationDataResetForcedActiveJobDecision): boolean {
  return Boolean(decision.approver.trim()) && Boolean(decision.rationale.trim()) && decision.activeJobCount > 0;
}

function catalogIntegrationDataResetPostconditionFindings(
  report: CatalogIntegrationDataVerificationReport,
): readonly CatalogIntegrationDataResetEvidenceFinding[] {
  const findings: CatalogIntegrationDataResetEvidenceFinding[] = [];
  if (report.sourceObservations > 0) {
    findings.push({
      code: "post-reset-source-observations-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        `Post-reset verification still has ${report.sourceObservations} Source Observation row(s).`,
      ),
    });
  }
  if (report.sourceObservationEventStreams > 0 || report.sourceObservationEvents > 0) {
    findings.push({
      code: "post-reset-source-observation-event-streams-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        `Post-reset verification still has ${report.sourceObservationEventStreams} Source Observation event stream row(s) and ${report.sourceObservationEvents} event row(s).`,
      ),
    });
  }
  if (report.legacySourceObservationReferences > 0) {
    findings.push({
      code: "post-reset-legacy-references-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        `Post-reset verification still has ${report.legacySourceObservationReferences} legacy Source Observation profile marker row(s).`,
      ),
    });
  }
  if (report.integrationDurableJobs > 0 || report.integrationWorkUnits > 0) {
    findings.push({
      code: "post-reset-integration-jobs-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        `Post-reset verification still has ${report.integrationDurableJobs} integration job row(s) and ${report.integrationWorkUnits} integration work-unit row(s).`,
      ),
    });
  }
  if (report.bulkReviewJobs > 0 || report.bulkReviewWorkUnits > 0) {
    findings.push({
      code: "post-reset-bulk-review-jobs-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        `Post-reset verification still has ${report.bulkReviewJobs} bulk-review job row(s) and ${report.bulkReviewWorkUnits} bulk-review work-unit row(s).`,
      ),
    });
  }
  if (report.providerOptionQueryCacheEntries > 0) {
    findings.push({
      code: "post-reset-provider-option-cache-remain",
      severity: "p1",
      message: resetEvidenceFindingMessage(
        `Post-reset verification still has ${report.providerOptionQueryCacheEntries} provider option query cache row(s).`,
      ),
    });
  }
  if (report.providerOptionRateLimits > 0) {
    findings.push({
      code: "post-reset-provider-rate-limits-remain",
      severity: "p1",
      message: resetEvidenceFindingMessage(
        `Post-reset verification still has ${report.providerOptionRateLimits} learned provider rate-limit row(s).`,
      ),
    });
  }
  if (report.activeProviderProfiles === 0) {
    findings.push({
      code: "post-reset-seeded-profiles-missing",
      severity: "p0",
      message: resetEvidenceFindingMessage("Post-reset verification has no active seeded provider profiles."),
    });
  }
  return findings;
}

function resetEvidenceFindingMessage(message: string): string {
  return message;
}

async function countRows(db: PgQueryable, sql: string, params: readonly unknown[] = []): Promise<number> {
  const result = await db.query<CountRow>(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function deleteRows(db: PgQueryable, sql: string, params: readonly unknown[] = []): Promise<number> {
  const result = await db.query<DeleteRow>(
    `WITH deleted AS (${sql} RETURNING 1) SELECT COUNT(*) AS rows_deleted FROM deleted`,
    params,
  );
  return Number(result.rows[0]?.rows_deleted ?? 0);
}

async function withResetTransaction<T>(
  db: PgTransactionalPool,
  work: (queryable: PgQueryable) => Promise<T>,
): Promise<T> {
  return withPgTransaction(db, work);
}

export const catalogIntegrationDataResetPlanSummary = `${resettablePreLaunchReason} Fresh bootstrap must recreate seeded provider profiles through the persisted profile store, and any retained data must be named with owner, reason, and removal criteria in #804.`;
