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
    | "post-reset-legacy-references-remain"
    | "post-reset-integration-jobs-remain"
    | "post-reset-bulk-review-jobs-remain"
    | "post-reset-provider-option-cache-remain"
    | "post-reset-provider-rate-limits-remain"
    | "post-reset-seeded-profiles-missing";
  severity: "p0" | "p1";
  message: string;
}>;

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

const catalogIntegrationDataResetTables = [
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
] as const;

export function catalogIntegrationDataResetTargetTables(): readonly string[] {
  return catalogIntegrationDataResetTables;
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
      message: resetEvidenceFindingMessage("Post-reset verification still has Source Observations."),
    });
  }
  if (report.legacySourceObservationReferences > 0) {
    findings.push({
      code: "post-reset-legacy-references-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        "Post-reset verification still has legacy Source Observation profile markers.",
      ),
    });
  }
  if (report.integrationDurableJobs > 0 || report.integrationWorkUnits > 0) {
    findings.push({
      code: "post-reset-integration-jobs-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage("Post-reset verification still has integration jobs or work units."),
    });
  }
  if (report.bulkReviewJobs > 0 || report.bulkReviewWorkUnits > 0) {
    findings.push({
      code: "post-reset-bulk-review-jobs-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage("Post-reset verification still has bulk review jobs or work units."),
    });
  }
  if (report.providerOptionQueryCacheEntries > 0) {
    findings.push({
      code: "post-reset-provider-option-cache-remain",
      severity: "p1",
      message: resetEvidenceFindingMessage("Post-reset verification still has provider option query cache rows."),
    });
  }
  if (report.providerOptionRateLimits > 0) {
    findings.push({
      code: "post-reset-provider-rate-limits-remain",
      severity: "p1",
      message: resetEvidenceFindingMessage("Post-reset verification still has learned provider rate-limit rows."),
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
