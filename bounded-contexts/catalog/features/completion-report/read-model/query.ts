import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  ManifestCatalogItemCounts,
  ManifestMergeCandidate,
  ManifestObservedUnit,
  ManifestProviderUnit,
  ManifestPromotionOutcomes,
  ManifestScope,
  ManifestSourceObservationCounts,
  ProviderProductionClass,
} from "../domain/manifest";

// Read-model query that assembles the observed reconciliation facts a
// Production Catalog Completion Report needs, straight from the Catalog read
// models. It reads only Catalog-owned tables and returns counts and
// identifiers; raw payloads, URLs, and account identifiers are never selected.

export type ProductionCatalogReconciliationFacts = Readonly<{
  scopes: readonly ManifestScope[];
  providerUnits: readonly ManifestProviderUnit[];
  observedUnits: readonly ManifestObservedUnit[];
  mergeCandidates: readonly ManifestMergeCandidate[];
  promotions: ManifestPromotionOutcomes;
  catalogItems: ManifestCatalogItemCounts;
  sourceObservations: ManifestSourceObservationCounts;
}>;

// A provider unit is production coverage only when its profile version is the
// active, production lifecycle. Every other lifecycle is classified so it can
// be excluded with a stable reason rather than silently dropped.
export function classifyProviderProductionClass(input: {
  lifecycle: string;
  active: boolean;
}): ProviderProductionClass {
  if (input.lifecycle === "retired") return "retired";
  if (input.lifecycle === "active" && input.active) return "production";
  if (input.lifecycle === "test" || input.lifecycle === "draft") return "validation-only";
  return "unapproved";
}

export async function queryProductionCatalogReconciliationFacts(
  db: PgQueryable,
): Promise<ProductionCatalogReconciliationFacts> {
  const [scopes, providerUnits, observedUnits, mergeCandidates, promotions, catalogItems, sourceObservations] =
    await Promise.all([
      queryScopes(db),
      queryProviderUnits(db),
      queryObservedUnits(db),
      queryMergeCandidates(db),
      queryPromotionOutcomes(db),
      queryCatalogItemCounts(db),
      querySourceObservationCounts(db),
    ]);
  return { scopes, providerUnits, observedUnits, mergeCandidates, promotions, catalogItems, sourceObservations };
}

async function queryScopes(db: PgQueryable): Promise<readonly ManifestScope[]> {
  const scopeResult = await db.query<{ scope_record_id: string; lifecycle_status: string }>(
    `SELECT scope_record_id, lifecycle_status FROM catalog_scope_records`,
  );
  const mappingResult = await db.query<{ scope_record_id: string; provider_key: string; unit_key: string }>(
    `SELECT scope_record_id, provider_key, unit_key
       FROM catalog_provider_scope_mappings
      WHERE review_status IN ('accepted', 'auto-accepted')`,
  );
  const mappingsByScope = new Map<string, { providerKey: string; unitKey: string }[]>();
  for (const row of mappingResult.rows) {
    const list = mappingsByScope.get(row.scope_record_id) ?? [];
    list.push({ providerKey: row.provider_key, unitKey: row.unit_key });
    mappingsByScope.set(row.scope_record_id, list);
  }
  return scopeResult.rows.map((row) => ({
    scopeRecordId: row.scope_record_id,
    eligible: row.lifecycle_status === "active",
    acceptedMappings: mappingsByScope.get(row.scope_record_id) ?? [],
  }));
}

async function queryProviderUnits(db: PgQueryable): Promise<readonly ManifestProviderUnit[]> {
  const result = await db.query<{
    provider_key: string;
    ingestion_unit_key: string;
    lifecycle: string;
    active: boolean;
  }>(
    `SELECT DISTINCT provider_key, ingestion_unit_key, lifecycle, active
       FROM catalog_provider_integration_profile_versions
      WHERE ingestion_unit_key IS NOT NULL`,
  );
  return result.rows.map((row) => ({
    providerKey: row.provider_key,
    unitKey: row.ingestion_unit_key,
    productionClass: classifyProviderProductionClass({ lifecycle: row.lifecycle, active: row.active }),
    lifecycle: normalizeLifecycle(row.lifecycle),
    active: row.active,
  }));
}

async function queryObservedUnits(db: PgQueryable): Promise<readonly ManifestObservedUnit[]> {
  const result = await db.query<{
    scope_key: string;
    provider_key: string;
    unit_key: string;
    state: string;
    last_sync_run_id: string | null;
    last_completed_at: string | Date | null;
    observed_count: number | null;
    changed_count: number | null;
    failed_count: number | null;
  }>(
    `SELECT scope_key, provider_key, unit_key, state, last_sync_run_id, last_completed_at,
            observed_count, changed_count, failed_count
       FROM catalog_scope_sync_state`,
  );
  return result.rows.map((row) => ({
    scopeRecordId: row.scope_key,
    providerKey: row.provider_key,
    unitKey: row.unit_key,
    state: normalizeUnitState(row.state),
    lastCompletedAt: row.last_completed_at ? toIso(row.last_completed_at) : null,
    syncRunId: row.last_sync_run_id,
    observedCount: Number(row.observed_count ?? 0),
    changedCount: Number(row.changed_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
  }));
}

async function queryMergeCandidates(db: PgQueryable): Promise<readonly ManifestMergeCandidate[]> {
  const result = await db.query<{
    candidate_id: string;
    scope_record_id: string;
    status: string;
    conflicts_json: unknown;
  }>(`SELECT candidate_id, scope_record_id, status, conflicts_json FROM catalog_merge_candidates`);
  return result.rows.map((row) => {
    const conflicts = parseConflicts(row.conflicts_json);
    const blockingConflictCount = conflicts.filter((conflict) => conflict.severity === "blocking").length;
    return {
      candidateId: row.candidate_id,
      scopeRecordId: row.scope_record_id,
      status: normalizeCandidateStatus(row.status),
      blockingConflictCount,
      duplicatePreventionBlocked: conflicts.some((conflict) => conflict.kind === "duplicate-prevention"),
    };
  });
}

async function queryPromotionOutcomes(db: PgQueryable): Promise<ManifestPromotionOutcomes> {
  const result = await db.query<{ status: string; promotion_intent: string; total: number | string }>(
    `SELECT status, promotion_intent, count(*) AS total
       FROM catalog_merge_candidates
      GROUP BY status, promotion_intent`,
  );
  const outcomes = { create: 0, update: 0, ignore: 0, defer: 0 };
  for (const row of result.rows) {
    const count = Number(row.total);
    if (row.status === "promoted") {
      if (row.promotion_intent === "create-catalog-item") outcomes.create += count;
      else outcomes.update += count;
    } else if (row.status === "rejected") {
      outcomes.ignore += count;
    } else if (row.status === "deferred") {
      outcomes.defer += count;
    }
  }
  return outcomes;
}

async function queryCatalogItemCounts(db: PgQueryable): Promise<ManifestCatalogItemCounts> {
  const result = await db.query<{ status: string; total: number | string }>(
    `SELECT status, count(*) AS total FROM catalog_items GROUP BY status`,
  );
  const counts = { draft: 0, published: 0 };
  for (const row of result.rows) {
    if (row.status === "published") counts.published += Number(row.total);
    else counts.draft += Number(row.total);
  }
  return counts;
}

async function querySourceObservationCounts(db: PgQueryable): Promise<ManifestSourceObservationCounts> {
  const result = await db.query<{ status: string; total: number | string }>(
    `SELECT status, count(*) AS total FROM catalog_source_observations GROUP BY status`,
  );
  const counts = { total: 0, observed: 0, changed: 0, promoted: 0, rejected: 0, terminalJobFailures: 0 };
  for (const row of result.rows) {
    const count = Number(row.total);
    counts.total += count;
    if (row.status === "observed") counts.observed += count;
    else if (row.status === "changed") counts.changed += count;
    else if (row.status === "promoted") counts.promoted += count;
    else if (row.status === "rejected") counts.rejected += count;
  }
  return counts;
}

type ParsedConflict = Readonly<{ severity: string; kind: string }>;

function parseConflicts(value: unknown): readonly ParsedConflict[] {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => ({
    severity: readString(entry, "severity"),
    kind: readString(entry, "kind"),
  }));
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readString(entry: unknown, key: string): string {
  if (entry && typeof entry === "object" && key in entry) {
    const value = (entry as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

function normalizeLifecycle(value: string): ManifestProviderUnit["lifecycle"] {
  const allowed: ManifestProviderUnit["lifecycle"][] = ["draft", "test", "active", "deprecated", "retired"];
  return allowed.includes(value as ManifestProviderUnit["lifecycle"])
    ? (value as ManifestProviderUnit["lifecycle"])
    : "draft";
}

function normalizeUnitState(value: string): ManifestObservedUnit["state"] {
  const allowed: ManifestObservedUnit["state"][] = [
    "settled",
    "completed",
    "failed",
    "stale",
    "never-synced",
    "pending",
    "running",
  ];
  return allowed.includes(value as ManifestObservedUnit["state"])
    ? (value as ManifestObservedUnit["state"])
    : "never-synced";
}

function normalizeCandidateStatus(value: string): ManifestMergeCandidate["status"] {
  const allowed: ManifestMergeCandidate["status"][] = [
    "ready",
    "has-conflicts",
    "stale",
    "deferred",
    "rejected",
    "promoted",
  ];
  return allowed.includes(value as ManifestMergeCandidate["status"])
    ? (value as ManifestMergeCandidate["status"])
    : "ready";
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
