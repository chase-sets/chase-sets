// ---------------------------------------------------------------------------
// Catalog attention queue — per-source collectors
//
// Each collector is a pure mapper from one source read model's rows into the
// unified `CatalogAttentionItem` shape, tagging severity, age, and the inline
// resolution. Keeping them pure (row[] → item[]) makes the "projection per
// source" contract unit-testable with fixtures, independent of the database.
// The assembler runs the real queries and feeds the rows here.
// ---------------------------------------------------------------------------

import type { CatalogAliasCandidateRow } from "../../alias-equivalence/read-model/queries";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import type { CatalogScopeRecordRow } from "../../scope-registry/read-model/queries";
import type { CatalogMergeCandidateListRow } from "../../source-observations/read-model/queries";
import type { CatalogIntegrationControlPlaneUnitReadiness } from "../../source-observations/api/runtime";
import type { CatalogIntegrationUnitActivity } from "../../source-observations/api/admin-control-plane-overview";
import type { CatalogAttentionItem, CatalogAttentionResolution } from "./attention-item";

// A drawer resolution reveals the source's deep controls inline on the daily
// surface; no navigation, no cross-surface redirect.
function drawerResolution(
  intent: string,
  labelKey: string,
  fields: Record<string, string>,
): CatalogAttentionResolution {
  return { intent, mode: "drawer", labelKey, fields };
}

function commandResolution(
  intent: string,
  labelKey: string,
  fields: Record<string, string>,
  requiresReason = false,
): CatalogAttentionResolution {
  return { intent, mode: "command", labelKey, fields, requiresReason };
}

// --- Source 1: unmapped provider scopes ------------------------------------
// Provider scope mappings still awaiting review (`proposed`) are the "this
// provider unit produced a scope nobody has mapped yet" case.
export function collectUnmappedScopeItems(rows: readonly ProviderScopeMappingRow[]): CatalogAttentionItem[] {
  return rows
    .filter((row) => row.review_status === "proposed")
    .map((row) => {
      const label = row.set_name ?? row.set_id ?? row.scope_record_id;
      return {
        itemKey: `unmapped-scope:${row.mapping_id}`,
        kind: "unmapped-scope" as const,
        severity: "warning" as const,
        titleKey: "catalog.features.attentionQueue.item.unmappedScope.title",
        titleParams: { label, provider: row.provider_key },
        detailKey: "catalog.features.attentionQueue.item.unmappedScope.detail",
        detailParams: { unit: row.unit_key, confidence: row.confidence },
        providerKey: row.provider_key,
        unitKey: row.unit_key,
        observedAt: row.proposed_at,
        resolution: drawerResolution("review-scope-mapping", "catalog.features.attentionQueue.action.reviewMapping", {
          mappingId: row.mapping_id,
          scopeRecordId: row.scope_record_id,
          providerKey: row.provider_key,
          unitKey: row.unit_key,
        }),
        secondaryResolutions: [],
      } satisfies CatalogAttentionItem;
    });
}

// --- Source 2: merge candidates in has-conflicts / stale --------------------
export function collectMergeConflictItems(rows: readonly CatalogMergeCandidateListRow[]): CatalogAttentionItem[] {
  return rows
    .filter((row) => row.status === "has-conflicts" || row.status === "stale")
    .map((row) => {
      const blocking = row.conflicts_json.filter((conflict) => conflict.severity === "blocking").length;
      const isConflict = row.status === "has-conflicts";
      return {
        itemKey: `merge-conflict:${row.candidate_id}`,
        kind: "merge-conflict" as const,
        severity: isConflict ? ("critical" as const) : ("warning" as const),
        titleKey: isConflict
          ? "catalog.features.attentionQueue.item.mergeConflict.title"
          : "catalog.features.attentionQueue.item.mergeStale.title",
        titleParams: { candidate: row.candidate_id, conflicts: blocking },
        detailKey: isConflict
          ? "catalog.features.attentionQueue.item.mergeConflict.detail"
          : "catalog.features.attentionQueue.item.mergeStale.detail",
        detailParams: { reason: row.status_reason ?? "", observations: row.observation_count },
        providerKey: null,
        unitKey: null,
        observedAt: (isConflict ? row.updated_at : (row.stale_at ?? row.updated_at)) ?? row.created_at,
        resolution: drawerResolution(
          "review-merge-conflict",
          "catalog.features.attentionQueue.action.resolveConflict",
          { candidateId: row.candidate_id },
        ),
        secondaryResolutions: [],
      } satisfies CatalogAttentionItem;
    });
}

// --- Source 3: provider units with error-severity blockers (health) --------
// Consumes the already-computed control-plane unit readiness rather than raw
// diagnostics SQL, so the queue and the health-triage surface agree.
export function collectProviderHealthItems(
  units: readonly CatalogIntegrationControlPlaneUnitReadiness[],
  options: Readonly<{ generatedAt: string }>,
): CatalogAttentionItem[] {
  return units
    .map((unit) => classifyUnitHealth(unit))
    .filter((entry): entry is { unit: CatalogIntegrationControlPlaneUnitReadiness; blocker: string } => entry !== null)
    .map(({ unit, blocker }) => ({
      itemKey: `provider-health:${unit.providerKey}:${unit.unitKey}`,
      kind: "provider-health" as const,
      severity: "critical" as const,
      titleKey: "catalog.features.attentionQueue.item.providerHealth.title",
      titleParams: { unit: unit.displayName, provider: unit.providerKey },
      detailKey: "catalog.features.attentionQueue.item.providerHealth.detail",
      detailParams: { blocker, code: unit.credentialDiagnosticCode ?? unit.latestDiagnosticText ?? "" },
      providerKey: unit.providerKey,
      unitKey: unit.unitKey,
      observedAt: options.generatedAt,
      resolution: drawerResolution("review-provider-health", "catalog.features.attentionQueue.action.reviewHealth", {
        providerKey: unit.providerKey,
        unitKey: unit.unitKey,
      }),
      secondaryResolutions: [],
    }));
}

function classifyUnitHealth(
  unit: CatalogIntegrationControlPlaneUnitReadiness,
): { unit: CatalogIntegrationControlPlaneUnitReadiness; blocker: string } | null {
  if (unit.credentialReadiness === "blocked") {
    return { unit, blocker: "credential" };
  }
  if (unit.transportReadiness === "blocked") {
    return { unit, blocker: "transport" };
  }
  if (unit.semanticReadiness === "blocked") {
    return { unit, blocker: "semantic" };
  }
  if (unit.diagnosticCounts.error > 0) {
    return { unit, blocker: "diagnostic" };
  }
  return null;
}

// --- Source 4: failed / stale import jobs -----------------------------------
export function collectImportJobItems(activity: readonly CatalogIntegrationUnitActivity[]): CatalogAttentionItem[] {
  const items: CatalogAttentionItem[] = [];
  for (const unit of activity) {
    for (const job of unit.recentJobs) {
      const severity = importJobSeverity(job.operatorStatus);
      if (!severity) {
        continue;
      }
      items.push({
        itemKey: `import-job:${job.jobId}`,
        kind: "import-job",
        severity,
        titleKey: "catalog.features.attentionQueue.item.importJob.title",
        titleParams: { job: job.jobId, status: job.operatorStatus },
        detailKey: "catalog.features.attentionQueue.item.importJob.detail",
        detailParams: { provider: job.providerKey, action: job.action, scope: job.importScope ?? "" },
        providerKey: job.providerKey,
        unitKey: job.unitKey,
        observedAt: job.startedAt ?? job.createdAt,
        resolution: drawerResolution("review-import-job", "catalog.features.attentionQueue.action.reviewJob", {
          jobId: job.jobId,
          providerKey: job.providerKey,
          unitKey: job.unitKey ?? "",
        }),
        secondaryResolutions: [],
      });
    }
  }
  return items;
}

function importJobSeverity(operatorStatus: string): CatalogAttentionItem["severity"] | null {
  if (operatorStatus === "failed") {
    return "critical";
  }
  if (operatorStatus === "partial" || operatorStatus === "stale") {
    return "warning";
  }
  return null;
}

// --- Source 5: pending alias-equivalence candidates -------------------------
export function collectAliasCandidateItems(rows: readonly CatalogAliasCandidateRow[]): CatalogAttentionItem[] {
  return rows
    .filter((row) => row.review_status === "pending")
    .map((row) => ({
      itemKey: `alias-candidate:${row.alias_hash}`,
      kind: "alias-candidate" as const,
      severity: "info" as const,
      titleKey: "catalog.features.attentionQueue.item.aliasCandidate.title",
      titleParams: { alias: row.alias_text, type: row.alias_type },
      detailKey: "catalog.features.attentionQueue.item.aliasCandidate.detail",
      detailParams: { provider: row.provider_key, confidence: row.confidence },
      providerKey: row.provider_key,
      unitKey: null,
      observedAt: row.first_observed_at,
      resolution: commandResolution("accept", "catalog.features.attentionQueue.action.acceptAlias", {
        aliasHashes: row.alias_hash,
      }),
      secondaryResolutions: [
        commandResolution(
          "reject",
          "catalog.features.attentionQueue.action.rejectAlias",
          { aliasHashes: row.alias_hash },
          true,
        ),
      ],
    }));
}

// --- Source 6: stale scope syncs --------------------------------------------
// The dedicated scope-sync-state read model is not yet landed, so
// staleness is derived from the scope registry's own freshness: an active scope
// record whose projection has not been refreshed within the freshness window is
// a scope whose provider sync has gone stale.
export function collectStaleScopeSyncItems(
  rows: readonly CatalogScopeRecordRow[],
  options: Readonly<{ now: string; stalenessThresholdMs: number }>,
): CatalogAttentionItem[] {
  const nowMs = Date.parse(options.now);
  return rows
    .filter((row) => row.lifecycle_status === "active")
    .filter((row) => {
      const updatedMs = Date.parse(row.updated_at);
      return Number.isFinite(updatedMs) && nowMs - updatedMs >= options.stalenessThresholdMs;
    })
    .map((row) => ({
      itemKey: `stale-scope-sync:${row.scope_record_id}`,
      kind: "stale-scope-sync" as const,
      severity: "warning" as const,
      titleKey: "catalog.features.attentionQueue.item.staleScopeSync.title",
      titleParams: { scope: row.name, domain: row.product_domain },
      detailKey: "catalog.features.attentionQueue.item.staleScopeSync.detail",
      detailParams: { kind: row.scope_kind, updatedAt: row.updated_at },
      providerKey: null,
      unitKey: null,
      observedAt: row.updated_at,
      resolution: drawerResolution("review-scope-sync", "catalog.features.attentionQueue.action.reviewScopeSync", {
        scopeRecordId: row.scope_record_id,
      }),
      secondaryResolutions: [],
    }));
}
