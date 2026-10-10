import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  productionCatalogCompletionManifestVersion,
  type ManifestAssetProcessing,
  type ManifestCatalogItemCounts,
  type ManifestExpectedUnit,
  type ManifestMergeCandidate,
  type ManifestObservedUnit,
  type ManifestPromotionOutcomes,
  type ManifestProviderUnit,
  type ManifestProviderUsage,
  type ManifestScope,
  type ManifestSourceObservationCounts,
  type ProductionCatalogCompletionManifest,
  type ProviderProductionClass,
  type ProviderUsageCheckState,
} from "../domain/manifest";

// Database-mode facts for a Production Catalog Completion Report. Every fact is
// read from Catalog-owned tables inside one read-only repeatable-read snapshot,
// so the report describes a single consistent moment and the session cannot
// write. A fact the database cannot establish is listed in `unknownFacts`; it
// is never reported as zero. Only counts and Catalog identifiers are selected;
// raw payloads, URLs, and account identifiers never are.

export type ProductionCatalogReportedFacts = Readonly<{
  // Provider external ids that map to more than one Catalog Item across the
  // product and Catalog Item external reference read models.
  externalReferenceDuplicates: number;
  // Source Observations with missing or retired `legacy` profile metadata.
  legacyProfileMarkerCount: number;
  // Integration durable jobs still queued or running anywhere in Catalog.
  nonTerminalIntegrationJobCount: number;
  publicationCountsByStatus: Readonly<Record<string, number>>;
}>;

export type ProductionCatalogDatabaseFacts = Readonly<{
  manifest: ProductionCatalogCompletionManifest;
  unknownFacts: readonly string[];
  reportedFacts: ProductionCatalogReportedFacts;
  // True only when the sync universe came from a frozen manifest; a universe
  // derived from the batch plan describes state but never proves completion.
  completionProof: boolean;
}>;

export class ProductionCatalogCompletionFactsError extends Error {
  readonly code: "batch-not-found" | "manifest-batch-mismatch";
  constructor(code: ProductionCatalogCompletionFactsError["code"], message: string) {
    super(message);
    this.name = "ProductionCatalogCompletionFactsError";
    this.code = code;
  }
}

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

// Run `work` inside one REPEATABLE READ READ ONLY transaction. The callback
// must use the supplied handle: every read shares the snapshot, and any write
// is refused by Postgres. The transaction always ends in ROLLBACK, so nothing
// the callback attempted can commit.
export async function withCatalogCompletionReadSnapshot<T>(
  pool: PgTransactionalPool,
  work: (tx: PgQueryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      return await work(client);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
}

export async function queryProductionCatalogCompletionFacts(
  pool: PgTransactionalPool,
  input: Readonly<{
    batchId: string;
    observedAt: string;
    // The frozen universe. When absent the universe is derived from the
    // batch's plan and the result carries `completionProof: false`.
    frozenManifest?: ProductionCatalogCompletionManifest | null;
    launchCutoff?: string | null;
  }>,
): Promise<ProductionCatalogDatabaseFacts> {
  return withCatalogCompletionReadSnapshot(pool, (tx) => readProductionCatalogCompletionFacts(tx, input));
}

type BatchUnitRow = Readonly<{ scope_record_id: string; plan: unknown; sync_run_id: string | null }>;

type PlannedScope = Readonly<{
  scopeRecordId: string;
  profileVersions: readonly Readonly<{ providerKey: string; unitKey: string }>[];
  creditConsumingProviderKeys: readonly string[];
}>;

async function readProductionCatalogCompletionFacts(
  tx: PgQueryable,
  input: Parameters<typeof queryProductionCatalogCompletionFacts>[1],
): Promise<ProductionCatalogDatabaseFacts> {
  const batchResult = await tx.query<{
    batch_id: string;
    plan_fingerprint: string;
    status: string;
    created_at: string | Date;
  }>(
    `SELECT batch_id, plan_fingerprint, status, created_at
       FROM catalog_scope_sync_batches
      WHERE batch_id = $1`,
    [input.batchId],
  );
  const batch = batchResult.rows[0];
  if (!batch) {
    throw new ProductionCatalogCompletionFactsError(
      "batch-not-found",
      `Scope Sync Batch ${input.batchId} was not found.`,
    );
  }
  const frozen = input.frozenManifest ?? null;
  if (frozen && frozen.batch.batchId !== batch.batch_id) {
    throw new ProductionCatalogCompletionFactsError(
      "manifest-batch-mismatch",
      `The frozen manifest describes batch ${frozen.batch.batchId}, not ${batch.batch_id}.`,
    );
  }

  const unitResult = await tx.query<BatchUnitRow>(
    `SELECT scope_record_id, plan, sync_run_id
       FROM catalog_scope_sync_batch_units
      WHERE batch_id = $1
      ORDER BY ordinal ASC, scope_record_id ASC`,
    [input.batchId],
  );
  const plannedScopes = unitResult.rows.map(plannedScopeFromRow);
  const syncRunIds = unitResult.rows.flatMap((row) => (row.sync_run_id ? [row.sync_run_id] : []));
  const batchStartedAt = toIso(batch.created_at);

  const universe = frozen
    ? {
        frozenAt: frozen.frozenAt,
        launchCutoff: frozen.launchCutoff,
        batch: frozen.batch,
        providerUnits: frozen.providerUnits,
        scopes: frozen.scopes,
        expectedUnits: frozen.expectedUnits,
        exclusions: frozen.exclusions,
      }
    : await derivePlannedUniverse(tx, {
        plannedScopes,
        frozenAt: input.observedAt,
        launchCutoff: input.launchCutoff ?? batchStartedAt,
        batch: { batchId: batch.batch_id, planFingerprint: batch.plan_fingerprint, status: batch.status },
      });

  const scopeRecordIds = [
    ...new Set([
      ...universe.scopes.map((scope) => scope.scopeRecordId),
      ...universe.expectedUnits.map((unit) => unit.scopeRecordId),
    ]),
  ].sort();
  const creditedProviderKeys = new Set(plannedScopes.flatMap((scope) => scope.creditConsumingProviderKeys));

  const unknownFacts: string[] = [];
  const observedUnits = await queryObservedUnits(tx, scopeRecordIds);
  const mergeCandidates = await queryMergeCandidates(tx, scopeRecordIds);
  const promotions = await queryPromotionOutcomes(tx, scopeRecordIds);
  const catalogItemsByStatus = await queryCountsByStatus(tx, "catalog_items");
  const sourceObservations = await querySourceObservationCounts(tx, syncRunIds);
  const assetProcessing = await queryAssetProcessing(tx, {
    scopeRecordIds,
    syncRunIds,
    since: batchStartedAt,
    unknownFacts,
  });
  const providerUsage = await queryProviderUsage(tx, { syncRunIds, creditedProviderKeys, unknownFacts });
  const reportedFacts: ProductionCatalogReportedFacts = {
    externalReferenceDuplicates: await queryExternalReferenceDuplicates(tx),
    legacyProfileMarkerCount: await queryLegacyProfileMarkerCount(tx),
    nonTerminalIntegrationJobCount: await queryNonTerminalIntegrationJobCount(tx),
    publicationCountsByStatus: catalogItemsByStatus,
  };

  const catalogItems: ManifestCatalogItemCounts = {
    draft: catalogItemsByStatus.draft ?? 0,
    published: catalogItemsByStatus.active ?? 0,
  };

  return {
    manifest: {
      manifestVersion: productionCatalogCompletionManifestVersion,
      ...universe,
      observedUnits,
      mergeCandidates,
      promotions,
      catalogItems,
      sourceObservations,
      assetProcessing,
      providerUsage,
    },
    unknownFacts: [...new Set(unknownFacts)].sort(),
    reportedFacts,
    completionProof: frozen !== null,
  };
}

async function derivePlannedUniverse(
  tx: PgQueryable,
  input: Readonly<{
    plannedScopes: readonly PlannedScope[];
    frozenAt: string;
    launchCutoff: string;
    batch: ProductionCatalogCompletionManifest["batch"];
  }>,
): Promise<
  Pick<
    ProductionCatalogCompletionManifest,
    "frozenAt" | "launchCutoff" | "batch" | "providerUnits" | "scopes" | "expectedUnits" | "exclusions"
  >
> {
  const expectedUnits: ManifestExpectedUnit[] = input.plannedScopes.flatMap((scope) =>
    scope.profileVersions.map((unit) => ({
      scopeRecordId: scope.scopeRecordId,
      providerKey: unit.providerKey,
      unitKey: unit.unitKey,
    })),
  );
  const scopeRecordIds = input.plannedScopes.map((scope) => scope.scopeRecordId);
  return {
    frozenAt: input.frozenAt,
    launchCutoff: input.launchCutoff,
    batch: input.batch,
    providerUnits: await queryProviderUnits(tx, expectedUnits),
    scopes: await queryScopes(tx, scopeRecordIds),
    expectedUnits,
    exclusions: [],
  };
}

function plannedScopeFromRow(row: BatchUnitRow): PlannedScope {
  const plan = recordFromUnknown(parseJsonValue(row.plan));
  const profileVersions = arrayFromUnknown(plan.profileVersions).flatMap((entry) => {
    const record = recordFromUnknown(entry);
    const providerKey = stringFromUnknown(record.providerKey);
    const unitKey = stringFromUnknown(record.unitKey);
    return providerKey && unitKey ? [{ providerKey, unitKey }] : [];
  });
  const estimate = recordFromUnknown(recordFromUnknown(plan.participationPreview).estimate);
  const creditConsumingProviderKeys = arrayFromUnknown(estimate.creditConsumingProviders).flatMap((entry) => {
    const providerKey = stringFromUnknown(recordFromUnknown(entry).providerKey);
    return providerKey ? [providerKey] : [];
  });
  return { scopeRecordId: row.scope_record_id, profileVersions, creditConsumingProviderKeys };
}

async function queryScopes(tx: PgQueryable, scopeRecordIds: readonly string[]): Promise<readonly ManifestScope[]> {
  const scopeResult = await tx.query<{ scope_record_id: string; lifecycle_status: string }>(
    `SELECT scope_record_id, lifecycle_status
       FROM catalog_scope_records
      WHERE scope_record_id = ANY($1::text[])
      ORDER BY scope_record_id ASC`,
    [scopeRecordIds],
  );
  const mappingResult = await tx.query<{ scope_record_id: string; provider_key: string; unit_key: string }>(
    `SELECT scope_record_id, provider_key, unit_key
       FROM catalog_provider_scope_mappings
      WHERE scope_record_id = ANY($1::text[])
        AND review_status IN ('accepted', 'auto-accepted')
      ORDER BY scope_record_id ASC, provider_key ASC, unit_key ASC`,
    [scopeRecordIds],
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

// One class per provider unit: production when any version is the active
// production lifecycle, otherwise the most recently updated version's class.
async function queryProviderUnits(
  tx: PgQueryable,
  expectedUnits: readonly ManifestExpectedUnit[],
): Promise<readonly ManifestProviderUnit[]> {
  const result = await tx.query<{
    provider_key: string;
    ingestion_unit_key: string;
    lifecycle: string;
    active: boolean;
  }>(
    `SELECT DISTINCT ON (provider_key, ingestion_unit_key) provider_key, ingestion_unit_key, lifecycle, active
       FROM catalog_provider_integration_profile_versions
      WHERE (provider_key, ingestion_unit_key) IN (
              SELECT * FROM unnest($1::text[], $2::text[])
            )
      ORDER BY provider_key, ingestion_unit_key, (lifecycle = 'active' AND active) DESC, updated_at DESC`,
    [expectedUnits.map((unit) => unit.providerKey), expectedUnits.map((unit) => unit.unitKey)],
  );
  return result.rows.map((row) => ({
    providerKey: row.provider_key,
    unitKey: row.ingestion_unit_key,
    productionClass: classifyProviderProductionClass({ lifecycle: row.lifecycle, active: row.active }),
    lifecycle: normalizeLifecycle(row.lifecycle),
    active: row.active,
  }));
}

// Sync state keyed by canonical Scope Record id. Rows written before Scope
// Record linkage carry no `scope_record_id` and never match, so a unit synced
// only through them reports as never-synced rather than borrowing a hashed key.
async function queryObservedUnits(
  tx: PgQueryable,
  scopeRecordIds: readonly string[],
): Promise<readonly ManifestObservedUnit[]> {
  const result = await tx.query<{
    scope_record_id: string;
    provider_key: string;
    unit_key: string;
    state: string;
    last_sync_run_id: string | null;
    last_completed_at: string | Date | null;
    observed_count: number | null;
    changed_count: number | null;
    failed_count: number | null;
  }>(
    `SELECT DISTINCT ON (scope_record_id, provider_key, unit_key)
            scope_record_id, provider_key, unit_key, state, last_sync_run_id, last_completed_at,
            observed_count, changed_count, failed_count
       FROM catalog_scope_sync_state
      WHERE scope_record_id = ANY($1::text[])
      ORDER BY scope_record_id, provider_key, unit_key, updated_at DESC`,
    [scopeRecordIds],
  );
  return result.rows.map((row) => ({
    scopeRecordId: row.scope_record_id,
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

async function queryMergeCandidates(
  tx: PgQueryable,
  scopeRecordIds: readonly string[],
): Promise<readonly ManifestMergeCandidate[]> {
  const result = await tx.query<{
    candidate_id: string;
    scope_record_id: string;
    status: string;
    conflicts_json: unknown;
  }>(
    `SELECT candidate_id, scope_record_id, status, conflicts_json
       FROM catalog_merge_candidates
      WHERE scope_record_id = ANY($1::text[])
      ORDER BY candidate_id ASC`,
    [scopeRecordIds],
  );
  return result.rows.map((row) => {
    const conflicts = parseConflicts(row.conflicts_json);
    return {
      candidateId: row.candidate_id,
      scopeRecordId: row.scope_record_id,
      status: normalizeCandidateStatus(row.status),
      blockingConflictCount: conflicts.filter((conflict) => conflict.severity === "blocking").length,
      duplicatePreventionBlocked: conflicts.some((conflict) => conflict.kind === "duplicate-prevention"),
    };
  });
}

async function queryPromotionOutcomes(
  tx: PgQueryable,
  scopeRecordIds: readonly string[],
): Promise<ManifestPromotionOutcomes> {
  const result = await tx.query<{ status: string; promotion_intent: string; total: number | string }>(
    `SELECT status, promotion_intent, count(*) AS total
       FROM catalog_merge_candidates
      WHERE scope_record_id = ANY($1::text[])
      GROUP BY status, promotion_intent`,
    [scopeRecordIds],
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

async function queryCountsByStatus(tx: PgQueryable, table: "catalog_items"): Promise<Readonly<Record<string, number>>> {
  const result = await tx.query<{ status: string; total: number | string }>(
    `SELECT status, count(*) AS total FROM ${table} GROUP BY status ORDER BY status ASC`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.total)]));
}

// Observation counts are Catalog-wide. Terminal job failures are the batch's
// own: its catalog sync runs and every child job attached to one of them.
async function querySourceObservationCounts(
  tx: PgQueryable,
  syncRunIds: readonly string[],
): Promise<ManifestSourceObservationCounts> {
  const statusCounts = await tx.query<{ status: string; total: number | string }>(
    `SELECT status, count(*) AS total FROM catalog_source_observations GROUP BY status`,
  );
  const failedJobs = await tx.query<{ total: number | string }>(
    `SELECT count(*) AS total
       FROM catalog_source_observation_integration_durable_jobs
      WHERE status = 'failed'
        AND (job_id = ANY($1::text[]) OR payload->>'syncRunId' = ANY($1::text[]))`,
    [syncRunIds],
  );
  const counts = {
    total: 0,
    observed: 0,
    changed: 0,
    promoted: 0,
    rejected: 0,
    terminalJobFailures: Number(failedJobs.rows[0]?.total ?? 0),
  };
  for (const row of statusCounts.rows) {
    const count = Number(row.total);
    counts.total += count;
    if (row.status === "observed") counts.observed += count;
    else if (row.status === "changed") counts.changed += count;
    else if (row.status === "promoted") counts.promoted += count;
    else if (row.status === "rejected") counts.rejected += count;
  }
  return counts;
}

// Failed promotion units since the batch started, in the batch's scope: a
// scope candidate job for one of its scopes, or an observation promotion whose
// observation came from one of its sync runs or belongs to one of its scopes'
// candidates. `asset-processing-failed` units are counted; a failed unit with
// no diagnostic code cannot be classified and is listed as unknown.
async function queryAssetProcessing(
  tx: PgQueryable,
  input: Readonly<{
    scopeRecordIds: readonly string[];
    syncRunIds: readonly string[];
    since: string;
    unknownFacts: string[];
  }>,
): Promise<ManifestAssetProcessing> {
  const result = await tx.query<{ job_id: string; unit_id: string; diagnostic_code: string | null }>(
    `SELECT unit.job_id, unit.unit_id, unit.result->>'diagnosticCode' AS diagnostic_code
       FROM catalog_source_observation_bulk_review_work_units unit
       JOIN catalog_source_observation_bulk_review_jobs job ON job.job_id = unit.job_id
      WHERE unit.state = 'failed'
        AND unit.created_at >= $3::timestamptz
        AND (
          (job.job_kind = 'merge-candidate-promote' AND job.payload->>'scopeRecordId' = ANY($1::text[]))
          OR (
            job.job_kind = 'promote'
            AND (
              EXISTS (
                SELECT 1
                  FROM catalog_source_observations observation
                 WHERE observation.observation_id = unit.payload->>'observationId'
                   AND observation.sync_run_id = ANY($2::text[])
              )
              OR EXISTS (
                SELECT 1
                  FROM catalog_merge_candidate_observations member
                  JOIN catalog_merge_candidates candidate ON candidate.candidate_id = member.candidate_id
                 WHERE member.observation_id = unit.payload->>'observationId'
                   AND candidate.scope_record_id = ANY($1::text[])
              )
            )
          )
        )
      ORDER BY unit.job_id ASC, unit.unit_id ASC`,
    [input.scopeRecordIds, input.syncRunIds, input.since],
  );
  let approvedFailures = 0;
  for (const row of result.rows) {
    if (row.diagnostic_code === "asset-processing-failed") {
      approvedFailures += 1;
    } else if (!row.diagnostic_code) {
      input.unknownFacts.push(`promotion-outcome-diagnostic-code:${row.job_id}/${row.unit_id}`);
    }
  }
  // No Catalog record approves an asset exclusion, so the exact count is zero.
  return { approvedFailures, exclusions: 0 };
}

type UsageEvidence = Readonly<{
  estimatedRequestCount: number | null;
  actualRequestCount: number | null;
  pageCount: number | null;
  cacheHitCount: number | null;
  cacheMissCount: number | null;
  usageCheckState: string | null;
}>;

// Provider usage from the `providerUsageEvidence` each import job of the
// batch's sync runs recorded per outcome. Counts sum only when every outcome
// measured them; otherwise they stay null. A credited provider whose usage
// check state is absent or unknown is listed as unknown and omitted, because
// any reported state for it would be invented.
async function queryProviderUsage(
  tx: PgQueryable,
  input: Readonly<{ syncRunIds: readonly string[]; creditedProviderKeys: ReadonlySet<string>; unknownFacts: string[] }>,
): Promise<readonly ManifestProviderUsage[]> {
  const result = await tx.query<{ provider_key: string | null; evidence: unknown }>(
    `SELECT outcome->>'providerKey' AS provider_key, outcome->'providerUsageEvidence' AS evidence
       FROM catalog_source_observation_integration_durable_jobs job
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(job.result->'outcomes') = 'array' THEN job.result->'outcomes' ELSE '[]'::jsonb END
       ) AS outcome
      WHERE job.payload->>'action' = 'import'
        AND job.payload->>'syncRunId' = ANY($1::text[])
      ORDER BY job.job_id ASC`,
    [input.syncRunIds],
  );
  const evidenceByProvider = new Map<string, UsageEvidence[]>();
  for (const providerKey of input.creditedProviderKeys) evidenceByProvider.set(providerKey, []);
  for (const row of result.rows) {
    if (!row.provider_key) continue;
    const list = evidenceByProvider.get(row.provider_key) ?? [];
    list.push(usageEvidenceFromUnknown(parseJsonValue(row.evidence)));
    evidenceByProvider.set(row.provider_key, list);
  }

  const usage: ManifestProviderUsage[] = [];
  for (const [providerKey, evidence] of [...evidenceByProvider.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const credited = input.creditedProviderKeys.has(providerKey);
    const usageCheckState = combinedUsageCheckState(evidence, credited);
    if (usageCheckState === null) {
      if (credited) input.unknownFacts.push(`provider-usage-check-state:${providerKey}`);
      continue;
    }
    usage.push({
      providerKey,
      credited,
      estimatedRequestCount: sumWhenMeasured(evidence, "estimatedRequestCount"),
      actualRequestCount: sumWhenMeasured(evidence, "actualRequestCount"),
      pageCount: sumWhenMeasured(evidence, "pageCount"),
      cacheHitCount: sumWhenMeasured(evidence, "cacheHitCount"),
      cacheMissCount: sumWhenMeasured(evidence, "cacheMissCount"),
      usageCheckState,
    });
  }
  return usage;
}

const usageCheckStateRank: Readonly<Record<ProviderUsageCheckState, number>> = {
  available: 0,
  degraded: 1,
  unavailable: 2,
};

// The worst state across the provider's outcomes, or null when any outcome
// carries no usable state. A credited provider that cannot check usage is
// unavailable; for an uncredited provider that only degrades the evidence.
function combinedUsageCheckState(
  evidence: readonly UsageEvidence[],
  credited: boolean,
): ProviderUsageCheckState | null {
  if (evidence.length === 0) return null;
  let combined: ProviderUsageCheckState = "available";
  for (const entry of evidence) {
    const state = manifestUsageCheckState(entry.usageCheckState, credited);
    if (state === null) return null;
    if (usageCheckStateRank[state] > usageCheckStateRank[combined]) combined = state;
  }
  return combined;
}

function manifestUsageCheckState(value: string | null, credited: boolean): ProviderUsageCheckState | null {
  switch (value) {
    case "checked":
      return "available";
    case "unavailable":
      return "unavailable";
    case "not-configured":
    case "not-supported":
      return credited ? "unavailable" : "degraded";
    default:
      return null;
  }
}

function sumWhenMeasured(evidence: readonly UsageEvidence[], key: keyof Omit<UsageEvidence, "usageCheckState">) {
  let total = 0;
  for (const entry of evidence) {
    const value = entry[key];
    if (value === null) return null;
    total += value;
  }
  return total;
}

function usageEvidenceFromUnknown(value: unknown): UsageEvidence {
  const record = recordFromUnknown(value);
  return {
    estimatedRequestCount: countFromUnknown(record.estimatedRequestCount),
    actualRequestCount: countFromUnknown(record.actualRequestCount),
    pageCount: countFromUnknown(record.pageCount),
    cacheHitCount: countFromUnknown(record.cacheHitCount),
    cacheMissCount: countFromUnknown(record.cacheMissCount),
    usageCheckState: stringFromUnknown(record.usageCheckState),
  };
}

async function queryExternalReferenceDuplicates(tx: PgQueryable): Promise<number> {
  const result = await tx.query<{ total: number | string }>(
    `SELECT count(*) AS total
       FROM (
         SELECT provider_key, external_key
           FROM (
             SELECT provider_key, external_key, catalog_item_id FROM catalog_external_product_references
             UNION ALL
             SELECT provider_key, external_key, catalog_item_id FROM catalog_external_catalog_item_references
           ) reference
          GROUP BY provider_key, external_key
         HAVING count(DISTINCT catalog_item_id) > 1
       ) duplicate`,
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function queryLegacyProfileMarkerCount(tx: PgQueryable): Promise<number> {
  const result = await tx.query<{ total: number | string }>(
    `SELECT count(*) AS total
       FROM catalog_source_observations
      WHERE coalesce(btrim(source_profile_key), '') = ''
         OR coalesce(btrim(source_profile_version), '') = ''
         OR coalesce(btrim(source_mapping_fingerprint), '') = ''
         OR lower(source_profile_version) = 'legacy'
         OR lower(source_mapping_fingerprint) = 'legacy'
         OR lower(coalesce(promotion_profile_version, '')) = 'legacy'`,
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function queryNonTerminalIntegrationJobCount(tx: PgQueryable): Promise<number> {
  const result = await tx.query<{ total: number | string }>(
    `SELECT count(*) AS total
       FROM catalog_source_observation_integration_durable_jobs
      WHERE status IN ('queued', 'running')`,
  );
  return Number(result.rows[0]?.total ?? 0);
}

type ParsedConflict = Readonly<{ severity: string; kind: string }>;

function parseConflicts(value: unknown): readonly ParsedConflict[] {
  return arrayFromUnknown(parseJsonValue(value)).map((entry) => {
    const record = recordFromUnknown(entry);
    return { severity: stringFromUnknown(record.severity) ?? "", kind: stringFromUnknown(record.kind) ?? "" };
  });
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function recordFromUnknown(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayFromUnknown(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function countFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
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
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
