import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { escapeLikePattern, withPgTransaction } from "@chase-sets/event-core-postgres";
import {
  catalogIntegrationDataResetEnvironmentPlans,
  type CatalogIntegrationDataBackupDecision,
  type CatalogIntegrationDataResetEnvironment,
} from "../governance/catalog-integration-data-migration-reset";

/**
 * Destructive reset/rebuild plan for Catalog Scope Registry v2 and Catalog
 * Merge Candidate v2 derived state. This is the P0 prerequisite plan for the
 * CatalogSyncScope v2 planner and the Merge Candidate identity re-key
 * described in `../../../docs/scope-registry.md`.
 *
 * This module composes with, and does not replace,
 * `catalog-integration-data-migration-reset.ts`. That module governs Source
 * Observation, integration/bulk-review job, provider option cache, and
 * provider profile version tables — including the durable "Catalog sync
 * parent run" rows (`catalog_source_observation_integration_durable_jobs`)
 * described in `../../../docs/catalog-sync-scope-planning.md`. This module
 * governs the tables and event streams that only exist to support Catalog
 * Merge Candidate review, plus the unreviewed slice of Provider Scope
 * Mapping proposals. Both reset passes are pre-launch and destructive; they
 * should be executed together under one evidence packet.
 *
 * Event stream prefix `catalog.merge-candidate-` must stay in sync with
 * `catalogMergeCandidateStreamId` in `./runtime.ts` and
 * `CATALOG_MERGE_CANDIDATE_STREAM_PREFIX` in
 * `../read-model/catalog-merge-candidate-projection.ts`.
 */
export const CATALOG_MERGE_CANDIDATE_EVENT_STREAM_PREFIX = "catalog.merge-candidate-";

export type CatalogScopeMergeCandidateResetSurfaceKey =
  | "merge-candidate-observation"
  | "merge-candidate"
  | "provider-scope-mapping-proposal"
  | "merge-candidate-event-stream";

export type CatalogScopeMergeCandidateResetSurfacePolicy = Readonly<{
  key: CatalogScopeMergeCandidateResetSurfaceKey;
  targetName: string;
  resetOrder: number;
  rebuildSource: string;
  verificationQuery: string;
}>;

/**
 * Destructive reset targets, ordered child-before-parent. Every row named
 * here is derived matcher/proposal output with a documented, deterministic
 * rebuild path; nothing that requires operator review survival is listed.
 */
export const catalogScopeMergeCandidateResetSurfacePolicies: readonly CatalogScopeMergeCandidateResetSurfacePolicy[] = [
  {
    key: "merge-candidate-observation",
    targetName: "catalog_merge_candidate_observations",
    resetOrder: 10,
    rebuildSource:
      "Recreated automatically when Catalog Merge Candidates are rebuilt from preserved catalog_source_observations rows.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_merge_candidate_observations",
  },
  {
    key: "merge-candidate",
    targetName: "catalog_merge_candidates",
    resetOrder: 20,
    rebuildSource:
      "Recreated by generateCatalogMergeCandidates (POST /merge-candidates/generate with no scope filter), which re-derives candidates from every preserved catalog_source_observations row through the active matcher.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_merge_candidates",
  },
  {
    key: "provider-scope-mapping-proposal",
    targetName: "catalog_provider_scope_mappings WHERE review_status = 'proposed'",
    resetOrder: 30,
    rebuildSource:
      "Recreated by re-running Provider Scope Mapping proposal ingestion for the affected provider units. Accepted, auto-accepted, rejected, and revoked rows are operator review decisions and are never reset targets.",
    verificationQuery: "SELECT COUNT(*) AS count FROM catalog_provider_scope_mappings WHERE review_status = 'proposed'",
  },
  {
    key: "merge-candidate-event-stream",
    targetName: `event_store_streams / event_store_events WHERE stream_id LIKE '${CATALOG_MERGE_CANDIDATE_EVENT_STREAM_PREFIX}%'`,
    resetOrder: 40,
    rebuildSource:
      "Fresh catalog.merge-candidate-<id> streams are appended by generateCatalogMergeCandidates once Source Observations are re-matched under the current identity scheme. Old streams encode the pre-reset candidate identity and are never replayed forward.",
    verificationQuery: `SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE '${CATALOG_MERGE_CANDIDATE_EVENT_STREAM_PREFIX}%' ESCAPE '\\'`,
  },
] as const;

export function catalogScopeMergeCandidateResetTargetTables(): readonly string[] {
  return catalogScopeMergeCandidateResetSurfacePolicies
    .slice()
    .sort((left, right) => left.resetOrder - right.resetOrder)
    .map((surface) => surface.targetName);
}

export type CatalogScopeMergeCandidatePreservedSurface = Readonly<{
  targetName: string;
  reason: string;
}>;

/**
 * Explicit preserve list. Nothing named here is a delete target of this
 * reset plan under any option; `resetCatalogMergeCandidateDerivedState`
 * asserts the counted rows are unchanged after every reset run.
 */
export const catalogScopeMergeCandidatePreservedSurfaces: readonly CatalogScopeMergeCandidatePreservedSurface[] = [
  {
    targetName: "catalog_scope_records",
    reason:
      "Canonical Catalog Scope Registry projected from catalog.reference-record.* lifecycle events. Scope identity is Catalog-owned and independent of Merge Candidate streams; this reset never touches it.",
  },
  {
    targetName: "catalog_provider_scope_mappings WHERE review_status <> 'proposed'",
    reason:
      "Accepted, auto-accepted, rejected, and revoked Provider Scope Mappings are operator-reviewed decisions that become canonical (accepted) or record an intentional rejection (rejected/revoked). Only unreviewed 'proposed' rows are derived matcher output eligible for reset.",
  },
  {
    targetName: "catalog_source_observations",
    reason:
      "Source Observations are the canonical input candidates are rebuilt from and are explicitly preserved by #3799's accepted data-loss boundary; only unpromoted candidate review state is wiped.",
  },
  {
    targetName:
      "catalog_items, catalog_item_aliases, catalog_item_resolved_aliases, catalog_external_catalog_item_references, catalog_external_product_references",
    reason:
      "Promoted Catalog Items and their aliases/external references are launched authoring state. They are out of this reset's table scope entirely, whether or not a Merge Candidate that once proposed them still exists.",
  },
  {
    targetName: "catalog_source_observation_integration_durable_jobs and related job/work-unit tables",
    reason:
      "Catalog sync parent-run cleanup is already governed by catalogIntegrationDataResetTargetTables() in catalog-integration-data-migration-reset.ts; this plan composes with that reset instead of duplicating it.",
  },
] as const;

export type CatalogScopeMergeCandidateVerificationReport = Readonly<{
  mergeCandidates: number;
  mergeCandidateObservations: number;
  mergeCandidateEventStreams: number;
  mergeCandidateEvents: number;
  providerScopeMappingProposals: number;
  preservedScopeRecords: number;
  preservedReviewedProviderScopeMappings: number;
  preservedSourceObservations: number;
}>;

type CountRow = Readonly<{ count: number | string }>;
type DeleteRow = Readonly<{ rows_deleted: number | string }>;

function mergeCandidateStreamLikePattern(): string {
  return `${escapeLikePattern(CATALOG_MERGE_CANDIDATE_EVENT_STREAM_PREFIX)}%`;
}

export async function collectCatalogScopeMergeCandidateVerificationReport(
  db: PgQueryable,
): Promise<CatalogScopeMergeCandidateVerificationReport> {
  const streamLikePattern = mergeCandidateStreamLikePattern();

  const mergeCandidates = await countRows(db, "SELECT COUNT(*) AS count FROM catalog_merge_candidates");
  const mergeCandidateObservations = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_merge_candidate_observations",
  );
  const mergeCandidateEventStreams = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM event_store_streams WHERE stream_id LIKE $1 ESCAPE '\\'",
    [streamLikePattern],
  );
  const mergeCandidateEvents = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1 ESCAPE '\\'",
    [streamLikePattern],
  );
  const providerScopeMappingProposals = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_provider_scope_mappings WHERE review_status = 'proposed'",
  );
  const preservedScopeRecords = await countRows(db, "SELECT COUNT(*) AS count FROM catalog_scope_records");
  const preservedReviewedProviderScopeMappings = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_provider_scope_mappings WHERE review_status <> 'proposed'",
  );
  const preservedSourceObservations = await countRows(db, "SELECT COUNT(*) AS count FROM catalog_source_observations");

  return {
    mergeCandidates,
    mergeCandidateObservations,
    mergeCandidateEventStreams,
    mergeCandidateEvents,
    providerScopeMappingProposals,
    preservedScopeRecords,
    preservedReviewedProviderScopeMappings,
    preservedSourceObservations,
  };
}

export type CatalogScopeMergeCandidateResetStepReport = Readonly<{
  targetName: string;
  rowsAffected: number;
}>;

export type CatalogScopeMergeCandidateResetReport = Readonly<{
  before: CatalogScopeMergeCandidateVerificationReport;
  after: CatalogScopeMergeCandidateVerificationReport;
  steps: readonly CatalogScopeMergeCandidateResetStepReport[];
  preservedInvariantsHeld: true;
}>;

/**
 * Executes the destructive reset transactionally: deletes Merge Candidate
 * review state, unreviewed Provider Scope Mapping proposals, and the
 * Merge Candidate event streams, then asserts every preserved surface's row
 * count is unchanged. Throws instead of returning a report when a preserved
 * surface would be touched, so callers cannot silently commit an unsafe
 * reset.
 *
 * This function only performs the wipe half of "wipe + rebuild". Rebuild is
 * a separate, explicit step — see `catalogScopeMergeCandidateRebuildChecklist`.
 */
export async function resetCatalogMergeCandidateDerivedState(
  db: PgTransactionalPool,
): Promise<CatalogScopeMergeCandidateResetReport> {
  return withPgTransaction(db, async (client) => {
    const before = await collectCatalogScopeMergeCandidateVerificationReport(client);
    const streamLikePattern = mergeCandidateStreamLikePattern();

    const steps: CatalogScopeMergeCandidateResetStepReport[] = [];
    steps.push({
      targetName: "catalog_merge_candidate_observations",
      rowsAffected: await deleteRows(client, "DELETE FROM catalog_merge_candidate_observations"),
    });
    steps.push({
      targetName: "catalog_merge_candidates",
      rowsAffected: await deleteRows(client, "DELETE FROM catalog_merge_candidates"),
    });
    steps.push({
      targetName: "catalog_provider_scope_mappings WHERE review_status = 'proposed'",
      rowsAffected: await deleteRows(
        client,
        "DELETE FROM catalog_provider_scope_mappings WHERE review_status = 'proposed'",
      ),
    });
    steps.push({
      targetName: `event_store_streams WHERE stream_id LIKE '${CATALOG_MERGE_CANDIDATE_EVENT_STREAM_PREFIX}%'`,
      rowsAffected: await deleteRows(client, "DELETE FROM event_store_streams WHERE stream_id LIKE $1 ESCAPE '\\'", [
        streamLikePattern,
      ]),
    });

    const after = await collectCatalogScopeMergeCandidateVerificationReport(client);
    assertPreservedSurfacesUnchanged(before, after);

    return { before, after, steps, preservedInvariantsHeld: true };
  });
}

function assertPreservedSurfacesUnchanged(
  before: CatalogScopeMergeCandidateVerificationReport,
  after: CatalogScopeMergeCandidateVerificationReport,
): void {
  if (after.preservedScopeRecords !== before.preservedScopeRecords) {
    throw new Error(
      "Catalog Merge Candidate reset would change catalog_scope_records row count; the Catalog Scope Registry is preserved and must never be touched by this reset.",
    );
  }
  if (after.preservedReviewedProviderScopeMappings !== before.preservedReviewedProviderScopeMappings) {
    throw new Error(
      "Catalog Merge Candidate reset would change reviewed catalog_provider_scope_mappings rows; only review_status = 'proposed' rows may be reset.",
    );
  }
  if (after.preservedSourceObservations !== before.preservedSourceObservations) {
    throw new Error(
      "Catalog Merge Candidate reset would change catalog_source_observations row count; Source Observations are preserved rebuild input, never a reset target.",
    );
  }
}

export type CatalogScopeMergeCandidateRebuildEvidence = Readonly<{
  generatedAt: string;
  observationsConsidered: number;
  candidatesCreated: number;
}>;

export type CatalogScopeMergeCandidateResetEvidencePacket = Readonly<{
  environment: CatalogIntegrationDataResetEnvironment;
  generatedAt: string;
  operator: string;
  approvalReference?: string | null;
  backupDecision?: CatalogIntegrationDataBackupDecision | null;
  stagingRehearsalReference?: string | null;
  smokeVerificationReference?: string | null;
  targetTables: readonly string[];
  dryRun: CatalogScopeMergeCandidateVerificationReport | null;
  before: CatalogScopeMergeCandidateVerificationReport | null;
  after: CatalogScopeMergeCandidateVerificationReport | null;
  rebuild?: CatalogScopeMergeCandidateRebuildEvidence | null;
}>;

export type CatalogScopeMergeCandidateResetEvidenceFinding = Readonly<{
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
    | "preserved-scope-records-changed"
    | "preserved-provider-scope-mappings-changed"
    | "preserved-source-observations-changed"
    | "post-reset-merge-candidates-remain"
    | "post-reset-merge-candidate-observations-remain"
    | "post-reset-provider-scope-mapping-proposals-remain"
    | "post-reset-event-streams-remain"
    | "missing-rebuild-evidence"
    | "rebuild-observation-coverage-incomplete";
  severity: "p0" | "p1";
  message: string;
}>;

export function evaluateCatalogScopeMergeCandidateResetEvidence(
  packet: CatalogScopeMergeCandidateResetEvidencePacket,
): readonly CatalogScopeMergeCandidateResetEvidenceFinding[] {
  const findings: CatalogScopeMergeCandidateResetEvidenceFinding[] = [];
  const plan = catalogIntegrationDataResetEnvironmentPlans.find(
    (candidate) => candidate.environment === packet.environment,
  );
  const allowedTargets = new Set(catalogScopeMergeCandidateResetTargetTables());

  if (!packet.operator.trim()) {
    findings.push({
      code: "missing-operator",
      severity: "p1",
      message: resetEvidenceFindingMessage("Catalog Merge Candidate reset evidence must name the operator."),
    });
  }
  if (!packet.generatedAt.trim()) {
    findings.push({
      code: "missing-generated-at",
      severity: "p1",
      message: resetEvidenceFindingMessage(
        "Catalog Merge Candidate reset evidence must include the generation timestamp.",
      ),
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
        "Reset evidence records retained data because destructive cleanup is unsafe; do not treat this as clean reset completion.",
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
        "Reset evidence must name the Catalog-owned targets selected for destructive cleanup.",
      ),
    });
  }
  for (const target of packet.targetTables) {
    if (!allowedTargets.has(target)) {
      findings.push({
        code: "unsafe-target-table",
        severity: "p0",
        message: resetEvidenceFindingMessage(
          `Target '${target}' is not owned by the Catalog Scope Registry / Merge Candidate v2 reset plan.`,
        ),
      });
    }
  }

  if (packet.before && packet.after) {
    if (packet.after.preservedScopeRecords !== packet.before.preservedScopeRecords) {
      findings.push({
        code: "preserved-scope-records-changed",
        severity: "p0",
        message: resetEvidenceFindingMessage(
          "Post-reset verification shows catalog_scope_records row count changed; the Scope Registry must be preserved.",
        ),
      });
    }
    if (packet.after.preservedReviewedProviderScopeMappings !== packet.before.preservedReviewedProviderScopeMappings) {
      findings.push({
        code: "preserved-provider-scope-mappings-changed",
        severity: "p0",
        message: resetEvidenceFindingMessage(
          "Post-reset verification shows reviewed catalog_provider_scope_mappings row count changed; only proposed rows may be reset.",
        ),
      });
    }
    if (packet.after.preservedSourceObservations !== packet.before.preservedSourceObservations) {
      findings.push({
        code: "preserved-source-observations-changed",
        severity: "p0",
        message: resetEvidenceFindingMessage(
          "Post-reset verification shows catalog_source_observations row count changed; Source Observations must be preserved.",
        ),
      });
    }
  }

  if (packet.after) {
    findings.push(...catalogScopeMergeCandidateResetPostconditionFindings(packet.after));
  }

  if (packet.environment !== "local-dev-test") {
    if (!packet.rebuild) {
      findings.push({
        code: "missing-rebuild-evidence",
        severity: "p0",
        message: resetEvidenceFindingMessage(
          `${packet.environment} reset evidence requires a rebuild verification report from generateCatalogMergeCandidates before the reset is considered complete.`,
        ),
      });
    } else if (packet.before && packet.rebuild.observationsConsidered !== packet.before.preservedSourceObservations) {
      findings.push({
        code: "rebuild-observation-coverage-incomplete",
        severity: "p1",
        message: resetEvidenceFindingMessage(
          "Rebuild considered fewer or more Source Observations than the preserved before-reset count; confirm the rebuild scope covers every preserved observation.",
        ),
      });
    }
  }

  return findings;
}

function catalogScopeMergeCandidateResetPostconditionFindings(
  after: CatalogScopeMergeCandidateVerificationReport,
): readonly CatalogScopeMergeCandidateResetEvidenceFinding[] {
  const findings: CatalogScopeMergeCandidateResetEvidenceFinding[] = [];
  if (after.mergeCandidates > 0) {
    findings.push({
      code: "post-reset-merge-candidates-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage("Post-reset verification still has Catalog Merge Candidates."),
    });
  }
  if (after.mergeCandidateObservations > 0) {
    findings.push({
      code: "post-reset-merge-candidate-observations-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        "Post-reset verification still has Catalog Merge Candidate observation members.",
      ),
    });
  }
  if (after.providerScopeMappingProposals > 0) {
    findings.push({
      code: "post-reset-provider-scope-mapping-proposals-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        "Post-reset verification still has unreviewed Provider Scope Mapping proposals.",
      ),
    });
  }
  if (after.mergeCandidateEventStreams > 0 || after.mergeCandidateEvents > 0) {
    findings.push({
      code: "post-reset-event-streams-remain",
      severity: "p0",
      message: resetEvidenceFindingMessage(
        "Post-reset verification still has Catalog Merge Candidate event streams or events.",
      ),
    });
  }
  return findings;
}

function resetEvidenceFindingMessage(message: string): string {
  return message;
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

export function catalogScopeMergeCandidateRebuildChecklist(): readonly string[] {
  return [
    "Confirm evaluateCatalogScopeMergeCandidateResetEvidence returns no findings for the wipe half of this reset before rebuilding.",
    "Call generateCatalogMergeCandidates with an empty scope (POST /merge-candidates/generate, no filters) to rebuild every Catalog Merge Candidate from preserved catalog_source_observations rows through the active matcher.",
    "Record observationCount, matchedObservationCount, excludedObservationCount, and candidateCount from the generate response; retain every unmapped/ambiguous exclusion reason, then attach observationsConsidered and candidatesCreated as CatalogScopeMergeCandidateRebuildEvidence.",
    "Re-run Provider Scope Mapping proposal ingestion for provider units whose proposed rows were reset, then route new proposals through the normal review queue.",
    "Verify catalog_scope_records and reviewed catalog_provider_scope_mappings counts are unchanged from the pre-reset dry run.",
    "Confirm the Admin merge-candidate review queue (/catalog/integrations) shows the rebuilt candidates and that stale/refresh semantics are unaffected.",
  ];
}

export function catalogScopeMergeCandidateReleaseVerificationQueries(): readonly string[] {
  return [
    "SELECT COUNT(*) AS merge_candidates FROM catalog_merge_candidates;",
    "SELECT COUNT(*) AS merge_candidate_observations FROM catalog_merge_candidate_observations;",
    "SELECT COUNT(*) AS merge_candidate_event_streams FROM event_store_streams WHERE stream_id LIKE 'catalog.merge-candidate-%' ESCAPE '\\';",
    "SELECT review_status, COUNT(*) AS mappings FROM catalog_provider_scope_mappings GROUP BY review_status ORDER BY review_status;",
    "SELECT COUNT(*) AS scope_records FROM catalog_scope_records;",
    "SELECT COUNT(*) AS source_observations FROM catalog_source_observations;",
  ];
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
