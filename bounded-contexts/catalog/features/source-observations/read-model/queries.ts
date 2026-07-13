import type { JsonValue } from "@chase-sets/primitives/json";
import {
  buildPaginationClause,
  escapeLikePattern,
  executeListQuery,
  type ListParams,
  type ListResult,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import type { SourceObservationNormalized } from "../domain/domain";
import type {
  CatalogMergeCandidateExternalCatalogItemReference,
  CatalogMergeCandidateExternalProductReference,
  CatalogMergeCandidateFieldProvenance,
  CatalogMergeCandidateIdentity,
  CatalogMergeCandidatePromotionIntent,
  CatalogMergeCandidateStatus,
  CatalogMergeCandidateWarning,
  CatalogMergeCandidateConflict,
  CatalogMergeCandidateObservationMember,
} from "../domain/catalog-merge-candidate";
import {
  sourceObservationIntegrationScopeSummaryTable,
  sourceObservationProductLineIdExpression,
  sourceObservationProductLineNameExpression,
} from "./integration-scope-summary";

export type SourceObservationListRow = Readonly<{
  observation_id: string;
  sync_run_id: string | null;
  provider_key: string;
  external_key: string;
  source_url: string;
  language_code: string;
  source_record_hash: string;
  source_updated_at: string | null;
  observed_at: string;
  source_profile_key: string;
  source_profile_version: string;
  source_mapping_fingerprint: string;
  normalized: SourceObservationNormalized;
  status: string;
  status_reason: string | null;
  promoted_catalog_item_id: string | null;
  promoted_reference_record_id: string | null;
  promoted_at: string | null;
  promotion_profile_key: string | null;
  promotion_profile_version: string | null;
  promotion_plan_fingerprint: string | null;
  updated_at: string;
}>;

export type SourceObservationDetailRow = SourceObservationListRow &
  Readonly<{
    source_payload: JsonValue;
  }>;

export type SourceObservationFilterScope = Readonly<{
  search?: string;
  status?: string;
  syncRunId?: string;
  provider?: string;
  language?: string;
  productLineId?: string;
  seriesId?: string;
  expansionId?: string;
  setId?: string;
}>;

export type CatalogMergeCandidateListRow = Readonly<{
  candidate_id: string;
  identity_fingerprint: string;
  sync_run_ids_json: readonly string[];
  status: CatalogMergeCandidateStatus;
  status_reason: string | null;
  identity_json: CatalogMergeCandidateIdentity;
  matched_catalog_item_id: string | null;
  matched_product_ids_json: readonly string[];
  proposed_catalog_item_facts_json: JsonValue;
  proposed_external_catalog_item_references_json: readonly CatalogMergeCandidateExternalCatalogItemReference[];
  proposed_external_product_references_json: readonly CatalogMergeCandidateExternalProductReference[];
  conflicts_json: readonly CatalogMergeCandidateConflict[];
  warnings_json: readonly CatalogMergeCandidateWarning[];
  field_provenance_json: readonly CatalogMergeCandidateFieldProvenance[];
  membership_json: readonly CatalogMergeCandidateObservationMember[];
  promotion_intent: CatalogMergeCandidatePromotionIntent;
  created_at: string;
  updated_at: string;
  stale_at: string | null;
  observation_count: number;
}>;

export type CatalogMergeCandidateFilterScope = Readonly<{
  search?: string;
  status?: CatalogMergeCandidateStatus | "";
  syncRunId?: string;
  identityFingerprint?: string;
  matchedCatalogItemId?: string;
  provider?: string;
  language?: string;
  productLineId?: string;
  productLineName?: string;
  expansionId?: string;
  setId?: string;
}>;

export type SourceObservationPromotionPreview = Readonly<{
  matched: number;
  eligible: number;
  terminal: number;
  scope: Required<SourceObservationFilterScope>;
  // A content fingerprint over the exact eligible observations this preview
  // computed from: MD5 of their sorted `observation_id:source_record_hash`
  // pairs. Any change to which observations are eligible, or to any eligible
  // observation's own content, changes this value — so a preview checkpoint
  // built from it self-invalidates instead of relying on aggregate counts that
  // can coincidentally still match after a change.
  fingerprint: string;
}>;

export type SourceObservationReapplyPreview = Readonly<{
  matched: number;
  eligible: number;
  ineligible: number;
  scope: Required<SourceObservationFilterScope>;
  impact: SourceObservationReplayImpactSummary;
}>;

export type SourceObservationExternalReferenceImpactSample = Readonly<{
  observationId: string;
  referenceKind: "catalog-item-reference" | "product-reference";
  providerKey: string;
  externalKey: string;
  catalogItemId: string | null;
}>;

export type SourceObservationReplayImpactSummary = Readonly<{
  matchedObservations: number;
  eligibleObservations: number;
  blockedObservations: number;
  impactedCatalogItemCount: number;
  impactedCatalogItemIds: readonly string[];
  externalReferenceCount: number;
  externalReferenceSamples: readonly SourceObservationExternalReferenceImpactSample[];
  sampleObservationIds: readonly string[];
}>;

export type SourceObservationLifecycleImpactOperation = "activation" | "rollback" | "deprecate" | "retire";

export type SourceObservationLifecycleImpactSummary = Readonly<{
  referencedObservationCount: number;
  sourceProfileReferenceCount: number;
  promotionProfileReferenceCount: number;
  impactedCatalogItemCount: number;
  impactedCatalogItemIds: readonly string[];
  externalReferenceCount: number;
  externalReferenceSamples: readonly SourceObservationExternalReferenceImpactSample[];
  sampleObservationIds: readonly string[];
}>;

const sourceObservationListColumns = `observation_id,
       sync_run_id,
       provider_key,
       external_key,
       source_url,
       language_code,
       source_record_hash,
       source_updated_at::text AS source_updated_at,
       observed_at::text AS observed_at,
       source_profile_key,
       source_profile_version,
       source_mapping_fingerprint,
       normalized,
       status,
       status_reason,
       promoted_catalog_item_id,
       promoted_reference_record_id,
       promoted_at::text AS promoted_at,
       promotion_profile_key,
       promotion_profile_version,
       promotion_plan_fingerprint,
       updated_at::text AS updated_at`;

export type SourceObservationIntegrationScopeRow = Readonly<{
  provider_key: string;
  language_code: string;
  expansion_id: string;
  expansion_name: string;
  series_id: string;
  series_name: string;
  product_line_id: string;
  product_line_name: string;
  total_observations: number;
  observed_observations: number;
  changed_observations: number;
  promoted_observations: number;
  rejected_observations: number;
  first_observed_at: string;
  latest_observed_at: string;
  latest_source_updated_at: string | null;
}>;

export async function listSourceObservations(
  db: PgQueryable,
  params: ListParams & SourceObservationFilterScope = {},
): Promise<ListResult<SourceObservationListRow>> {
  const filter = buildSourceObservationFilter(params, { includeListFilters: true });
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
  const pagination = buildPaginationClause(params, filter.values.length + 1);
  const countSql = `SELECT COUNT(*) as count FROM catalog_source_observations ${where}`;
  const listSql = `SELECT ${sourceObservationListColumns}
                   FROM catalog_source_observations
                   ${where}
                   ORDER BY observed_at DESC, observation_id ASC
                   ${pagination.sql}`;

  return executeListQuery<SourceObservationListRow>(db, countSql, listSql, filter.values, [
    ...filter.values,
    ...pagination.values,
  ]);
}

export async function listCatalogMergeCandidates(
  db: PgQueryable,
  params: ListParams & CatalogMergeCandidateFilterScope = {},
): Promise<ListResult<CatalogMergeCandidateListRow>> {
  const filter = buildCatalogMergeCandidateFilter(params);
  let values = [...filter.values];
  const conditions = [...filter.conditions];
  if (params.search?.trim()) {
    values.push(`%${escapeLikePattern(params.search.trim())}%`);
    const param = `$${values.length}`;
    conditions.push(
      `(c.candidate_id ILIKE ${param} ESCAPE '\\' OR c.identity_fingerprint ILIKE ${param} ESCAPE '\\' OR (c.identity_json->>'printedProductName') ILIKE ${param} ESCAPE '\\' OR (c.identity_json->>'setName') ILIKE ${param} ESCAPE '\\' OR (c.identity_json->>'collectorNumber') ILIKE ${param} ESCAPE '\\' OR c.matched_catalog_item_id ILIKE ${param} ESCAPE '\\')`,
    );
  }
  const scopeCondition = buildCatalogMergeCandidateObservationScopeCondition(params, values);
  if (scopeCondition) {
    conditions.push(scopeCondition);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const pagination = buildPaginationClause(params, values.length + 1);
  const countSql = `SELECT COUNT(*) as count FROM catalog_merge_candidates c ${where}`;
  const listSql = `SELECT c.candidate_id,
                          c.identity_fingerprint,
                          c.sync_run_ids_json,
                          c.status,
                          c.status_reason,
                          c.identity_json,
                          c.matched_catalog_item_id,
                          c.matched_product_ids_json,
                          c.proposed_catalog_item_facts_json,
                          c.proposed_external_catalog_item_references_json,
                          c.proposed_external_product_references_json,
                          c.conflicts_json,
                          c.warnings_json,
                          c.field_provenance_json,
                          c.promotion_intent,
                          c.created_at::text AS created_at,
                          c.updated_at::text AS updated_at,
                          c.stale_at::text AS stale_at,
                          COALESCE(m.observation_count, 0)::integer AS observation_count,
                          COALESCE(m.membership_json, '[]'::jsonb) AS membership_json
                   FROM catalog_merge_candidates c
                   LEFT JOIN LATERAL (
                     SELECT COUNT(*)::integer AS observation_count,
                            jsonb_agg(
                              jsonb_build_object(
                                'observationId', observation_id,
                                'syncRunId', sync_run_id,
                                'providerKey', provider_key,
                                'externalKey', external_key,
                                'sourceRecordHash', source_record_hash,
                                'sourceProfileKey', source_profile_key,
                                'sourceProfileVersion', source_profile_version,
                                'sourceMappingFingerprint', source_mapping_fingerprint,
                                'observedAt', observed_at,
                                'addedAt', added_at
                              )
                              ORDER BY observation_id ASC
                            ) AS membership_json
                     FROM catalog_merge_candidate_observations
                     WHERE candidate_id = c.candidate_id
                   ) m ON true
                   ${where}
                   ORDER BY c.updated_at DESC, c.candidate_id ASC
                   ${pagination.sql}`;

  return executeListQuery<CatalogMergeCandidateListRow>(db, countSql, listSql, values, [
    ...values,
    ...pagination.values,
  ]);
}

export async function listSourceObservationsForCandidateMatching(
  db: PgQueryable,
  params: SourceObservationFilterScope = {},
): Promise<readonly SourceObservationListRow[]> {
  const filter = buildSourceObservationFilter(params, {
    includeListFilters: true,
    statuses: ["observed", "changed", "promoted"],
  });
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
  const result = await db.query<SourceObservationListRow>(
    `SELECT ${sourceObservationListColumns}
     FROM catalog_source_observations
     ${where}
     ORDER BY observed_at DESC, observation_id ASC`,
    filter.values,
  );

  return result.rows;
}

export async function listSourceObservationIntegrationScopes(
  db: PgQueryable,
  params: Pick<
    SourceObservationFilterScope,
    "provider" | "language" | "productLineId" | "seriesId" | "expansionId" | "setId"
  > = {},
): Promise<SourceObservationIntegrationScopeRow[]> {
  const filter = buildSourceObservationIntegrationScopeSummaryFilter(params);
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
  const result = await db.query<SourceObservationIntegrationScopeRow>(
    `SELECT
       provider_key,
       language_code,
       expansion_id,
       expansion_name,
       series_id,
       series_name,
       product_line_id,
       product_line_name,
       total_observations,
       observed_observations,
       changed_observations,
       promoted_observations,
       rejected_observations,
       first_observed_at::text AS first_observed_at,
       latest_observed_at::text AS latest_observed_at,
       latest_source_updated_at::text AS latest_source_updated_at
     FROM ${sourceObservationIntegrationScopeSummaryTable}
     ${where}
     ORDER BY latest_observed_at DESC, provider_key ASC, language_code ASC`,
    filter.values,
  );

  return result.rows;
}

export async function previewSourceObservationPromotionScope(
  db: PgQueryable,
  params: SourceObservationFilterScope = {},
): Promise<SourceObservationPromotionPreview> {
  const scope = normalizeSourceObservationFilterScope(params);
  const eligibleStatuses = reviewableStatusesForScope(scope);
  const eligiblePromise =
    eligibleStatuses.length === 0
      ? Promise.resolve({ count: 0, fingerprint: "" })
      : countAndFingerprintSourceObservations(db, scope, eligibleStatuses);
  const [matched, eligible] = await Promise.all([countSourceObservations(db, scope), eligiblePromise]);

  return {
    matched,
    eligible: eligible.count,
    terminal: Math.max(0, matched - eligible.count),
    scope,
    fingerprint: eligible.fingerprint,
  };
}

export async function previewSourceObservationPromotionIds(
  db: PgQueryable,
  observationIds: readonly string[],
): Promise<SourceObservationPromotionPreview> {
  const uniqueIds = [...new Set(observationIds.map((observationId) => observationId.trim()).filter(Boolean))];
  const scope = normalizeSourceObservationFilterScope({});
  if (uniqueIds.length === 0) {
    return {
      matched: 0,
      eligible: 0,
      terminal: 0,
      scope,
      fingerprint: "",
    };
  }

  const result = await db.query<{ matched: string | number; eligible: string | number; fingerprint: string | null }>(
    `SELECT
       COUNT(*)::integer AS matched,
       (COUNT(*) FILTER (WHERE status IN ('observed', 'changed')))::integer AS eligible,
       MD5(COALESCE(STRING_AGG(
         CASE WHEN status IN ('observed', 'changed') THEN observation_id || ':' || source_record_hash END,
         ',' ORDER BY observation_id
       ), '')) AS fingerprint
     FROM catalog_source_observations
     WHERE observation_id = ANY($1)`,
    [uniqueIds],
  );
  const matched = Number(result.rows[0]?.matched ?? 0);
  const eligible = Number(result.rows[0]?.eligible ?? 0);

  return {
    matched,
    eligible,
    terminal: Math.max(0, matched - eligible),
    scope,
    fingerprint: result.rows[0]?.fingerprint ?? "",
  };
}

// Count the observations matching `params` (narrowed further by `statuses` when
// given) together with a content fingerprint over that same set, in one query.
async function countAndFingerprintSourceObservations(
  db: PgQueryable,
  params: SourceObservationFilterScope,
  statuses?: readonly string[],
): Promise<Readonly<{ count: number; fingerprint: string }>> {
  const filter = buildSourceObservationFilter(params, {
    includeListFilters: true,
    statuses,
  });
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
  const result = await db.query<{ count: string | number; fingerprint: string | null }>(
    `SELECT
       COUNT(*)::integer AS count,
       MD5(COALESCE(STRING_AGG(observation_id || ':' || source_record_hash, ',' ORDER BY observation_id), '')) AS fingerprint
     FROM catalog_source_observations ${where}`,
    filter.values,
  );

  return {
    count: Number(result.rows[0]?.count ?? 0),
    fingerprint: result.rows[0]?.fingerprint ?? "",
  };
}

export async function listSourceObservationIdsForPromotion(
  db: PgQueryable,
  params: SourceObservationFilterScope = {},
): Promise<string[]> {
  const scope = normalizeSourceObservationFilterScope(params);
  const eligibleStatuses = reviewableStatusesForScope(scope);
  if (eligibleStatuses.length === 0) {
    return [];
  }

  const filter = buildSourceObservationFilter(scope, {
    includeListFilters: true,
    statuses: eligibleStatuses,
  });
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
  const result = await db.query<{ observation_id: string }>(
    `SELECT observation_id FROM catalog_source_observations ${where} ORDER BY observed_at DESC`,
    filter.values,
  );

  return result.rows.map((row) => row.observation_id);
}

export async function previewSourceObservationReapplyScope(
  db: PgQueryable,
  params: SourceObservationFilterScope = {},
): Promise<SourceObservationReapplyPreview> {
  const scope = normalizeSourceObservationFilterScope(params);
  const impact = await summarizeSourceObservationReplayImpact(db, scope);

  return {
    matched: impact.matchedObservations,
    eligible: impact.eligibleObservations,
    ineligible: impact.blockedObservations,
    scope,
    impact,
  };
}

export async function summarizeSourceObservationReplayImpact(
  db: PgQueryable,
  params: SourceObservationFilterScope = {},
  options: { sampleLimit?: number } = {},
): Promise<SourceObservationReplayImpactSummary> {
  const scope = normalizeSourceObservationFilterScope(params);
  const sampleLimit = normalizeImpactSampleLimit(options.sampleLimit);
  const eligibleStatuses = reapplyStatusesForScope(scope);
  const eligibleCount =
    eligibleStatuses.length === 0 ? Promise.resolve(0) : countSourceObservations(db, scope, eligibleStatuses);
  const [matched, eligible, catalogItems, externalReferences, observations] = await Promise.all([
    countSourceObservations(db, scope),
    eligibleCount,
    listImpactedCatalogItemIds(db, scope, eligibleStatuses, sampleLimit),
    listExternalReferenceImpactSamples(db, scope, eligibleStatuses, sampleLimit),
    listSourceObservationIdsForImpact(db, scope, eligibleStatuses, sampleLimit),
  ]);

  const externalReferenceCount = Number.parseInt(String(externalReferences[0]?.reference_count ?? "0"), 10);

  return {
    matchedObservations: matched,
    eligibleObservations: eligible,
    blockedObservations: Math.max(0, matched - eligible),
    impactedCatalogItemCount: catalogItems.total,
    impactedCatalogItemIds: catalogItems.ids,
    externalReferenceCount,
    externalReferenceSamples: externalReferences.flatMap(toExternalReferenceImpactSample),
    sampleObservationIds: observations,
  };
}

export async function summarizeSourceObservationLifecycleImpact(
  db: PgQueryable,
  input: Readonly<{
    providerKey: string;
    profileVersion: string;
    operation: SourceObservationLifecycleImpactOperation;
    sampleLimit?: number;
  }>,
): Promise<SourceObservationLifecycleImpactSummary> {
  const sampleLimit = normalizeImpactSampleLimit(input.sampleLimit);
  const [counts, catalogItems, externalReferences, observations] = await Promise.all([
    countProfileVersionObservationReferences(db, input.providerKey, input.profileVersion),
    listImpactedCatalogItemIdsForProfileVersion(db, input.providerKey, input.profileVersion, sampleLimit),
    listExternalReferenceImpactSamplesForProfileVersion(db, input.providerKey, input.profileVersion, sampleLimit),
    listObservationIdsForProfileVersionImpact(db, input.providerKey, input.profileVersion, sampleLimit),
  ]);
  const externalReferenceCount = Number.parseInt(String(externalReferences[0]?.reference_count ?? "0"), 10);

  return {
    referencedObservationCount: counts.referenced,
    sourceProfileReferenceCount: counts.source,
    promotionProfileReferenceCount: counts.promotion,
    impactedCatalogItemCount: catalogItems.total,
    impactedCatalogItemIds: catalogItems.ids,
    externalReferenceCount,
    externalReferenceSamples: externalReferences.flatMap(toExternalReferenceImpactSample),
    sampleObservationIds: observations,
  };
}

export async function listSourceObservationIdsForReapply(
  db: PgQueryable,
  params: SourceObservationFilterScope = {},
): Promise<string[]> {
  const scope = normalizeSourceObservationFilterScope(params);
  const eligibleStatuses = reapplyStatusesForScope(scope);
  if (eligibleStatuses.length === 0) {
    return [];
  }

  const filter = buildSourceObservationFilter(scope, {
    includeListFilters: true,
    statuses: eligibleStatuses,
  });
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
  const result = await db.query<{ observation_id: string }>(
    `SELECT observation_id FROM catalog_source_observations ${where} ORDER BY observed_at DESC`,
    filter.values,
  );

  return result.rows.map((row) => row.observation_id);
}

export async function getSourceObservationDetail(
  db: PgQueryable,
  observationId: string,
): Promise<SourceObservationDetailRow | null> {
  const result = await db.query<SourceObservationDetailRow>(
    `SELECT * FROM catalog_source_observations WHERE observation_id = $1`,
    [observationId],
  );

  return result.rows[0] ?? null;
}

async function countSourceObservations(
  db: PgQueryable,
  params: SourceObservationFilterScope,
  statuses?: readonly string[],
): Promise<number> {
  const filter = buildSourceObservationFilter(params, {
    includeListFilters: true,
    statuses,
  });
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM catalog_source_observations ${where}`,
    filter.values,
  );

  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}

type CatalogItemImpactRow = Readonly<{ promoted_catalog_item_id: string; total_count: string | number }>;

type ExternalReferenceImpactRow = Readonly<{
  observation_id: string;
  reference_kind: "catalog-item-reference" | "product-reference";
  provider_key: string | null;
  external_key: string | null;
  catalog_item_id: string | null;
  reference_count: string | number;
}>;

type ProfileReferenceCountRow = Readonly<{
  referenced_count: string | number;
  source_count: string | number;
  promotion_count: string | number;
}>;

async function listImpactedCatalogItemIds(
  db: PgQueryable,
  params: SourceObservationFilterScope,
  statuses: readonly string[],
  sampleLimit: number,
): Promise<Readonly<{ total: number; ids: readonly string[] }>> {
  if (statuses.length === 0) {
    return { total: 0, ids: [] };
  }

  const filter = buildSourceObservationFilter(params, {
    includeListFilters: true,
    statuses,
  });
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
  const result = await db.query<CatalogItemImpactRow>(
    `WITH impacted AS (
       SELECT DISTINCT promoted_catalog_item_id
       FROM catalog_source_observations
       ${where}
       AND promoted_catalog_item_id IS NOT NULL
     )
     SELECT promoted_catalog_item_id,
            COUNT(*) OVER ()::integer AS total_count
     FROM impacted
     ORDER BY promoted_catalog_item_id ASC
     LIMIT ${sampleLimit}`,
    filter.values,
  );

  return {
    total: Number.parseInt(String(result.rows[0]?.total_count ?? result.rows.length), 10),
    ids: result.rows.map((row) => row.promoted_catalog_item_id),
  };
}

async function listImpactedCatalogItemIdsForProfileVersion(
  db: PgQueryable,
  providerKey: string,
  profileVersion: string,
  sampleLimit: number,
): Promise<Readonly<{ total: number; ids: readonly string[] }>> {
  const result = await db.query<CatalogItemImpactRow>(
    `WITH impacted AS (
       SELECT DISTINCT promoted_catalog_item_id
       FROM catalog_source_observations
       WHERE provider_key = $1
         AND (source_profile_version = $2 OR promotion_profile_version = $2)
         AND promoted_catalog_item_id IS NOT NULL
     )
     SELECT promoted_catalog_item_id,
            COUNT(*) OVER ()::integer AS total_count
     FROM impacted
     ORDER BY promoted_catalog_item_id ASC
     LIMIT ${sampleLimit}`,
    [providerKey, profileVersion],
  );

  return {
    total: Number.parseInt(String(result.rows[0]?.total_count ?? result.rows.length), 10),
    ids: result.rows.map((row) => row.promoted_catalog_item_id),
  };
}

async function listExternalReferenceImpactSamples(
  db: PgQueryable,
  params: SourceObservationFilterScope,
  statuses: readonly string[],
  sampleLimit: number,
): Promise<readonly ExternalReferenceImpactRow[]> {
  if (statuses.length === 0) {
    return [];
  }

  const filter = buildSourceObservationFilter(params, {
    includeListFilters: true,
    statuses,
  });
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
  return (await db.query<ExternalReferenceImpactRow>(externalReferenceImpactSql(where, sampleLimit), filter.values))
    .rows;
}

async function listExternalReferenceImpactSamplesForProfileVersion(
  db: PgQueryable,
  providerKey: string,
  profileVersion: string,
  sampleLimit: number,
): Promise<readonly ExternalReferenceImpactRow[]> {
  return (
    await db.query<ExternalReferenceImpactRow>(
      externalReferenceImpactSql(
        `WHERE provider_key = $1 AND (source_profile_version = $2 OR promotion_profile_version = $2)`,
        sampleLimit,
      ),
      [providerKey, profileVersion],
    )
  ).rows;
}

async function listSourceObservationIdsForImpact(
  db: PgQueryable,
  params: SourceObservationFilterScope,
  statuses: readonly string[],
  sampleLimit: number,
): Promise<readonly string[]> {
  if (statuses.length === 0) {
    return [];
  }

  const filter = buildSourceObservationFilter(params, {
    includeListFilters: true,
    statuses,
  });
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
  const result = await db.query<{ observation_id: string }>(
    `SELECT observation_id
     FROM catalog_source_observations
     ${where}
     ORDER BY updated_at DESC, observation_id ASC
     LIMIT ${sampleLimit}`,
    filter.values,
  );

  return result.rows.map((row) => row.observation_id);
}

async function listObservationIdsForProfileVersionImpact(
  db: PgQueryable,
  providerKey: string,
  profileVersion: string,
  sampleLimit: number,
): Promise<readonly string[]> {
  const result = await db.query<{ observation_id: string }>(
    `SELECT observation_id
     FROM catalog_source_observations
     WHERE provider_key = $1
       AND (source_profile_version = $2 OR promotion_profile_version = $2)
     ORDER BY updated_at DESC, observation_id ASC
     LIMIT ${sampleLimit}`,
    [providerKey, profileVersion],
  );

  return result.rows.map((row) => row.observation_id);
}

async function countProfileVersionObservationReferences(
  db: PgQueryable,
  providerKey: string,
  profileVersion: string,
): Promise<Readonly<{ referenced: number; source: number; promotion: number }>> {
  const result = await db.query<ProfileReferenceCountRow>(
    `SELECT COUNT(*)::integer AS referenced_count,
            (COUNT(*) FILTER (WHERE source_profile_version = $2))::integer AS source_count,
            (COUNT(*) FILTER (WHERE promotion_profile_version = $2))::integer AS promotion_count
     FROM catalog_source_observations
     WHERE provider_key = $1
       AND (source_profile_version = $2 OR promotion_profile_version = $2)`,
    [providerKey, profileVersion],
  );
  const row = result.rows[0];

  return {
    referenced: Number.parseInt(String(row?.referenced_count ?? "0"), 10),
    source: Number.parseInt(String(row?.source_count ?? "0"), 10),
    promotion: Number.parseInt(String(row?.promotion_count ?? "0"), 10),
  };
}

function externalReferenceImpactSql(where: string, sampleLimit: number): string {
  return `WITH scoped AS (
      SELECT observation_id,
             promoted_catalog_item_id,
             normalized
      FROM catalog_source_observations
      ${where}
    ),
    references AS (
      SELECT observation_id,
             promoted_catalog_item_id,
             'catalog-item-reference'::text AS reference_kind,
             reference->>'providerKey' AS provider_key,
             reference->>'externalKey' AS external_key
      FROM scoped
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(normalized->'externalCatalogItemReferences', '[]'::jsonb)) reference
      UNION ALL
      SELECT observation_id,
             promoted_catalog_item_id,
             'product-reference'::text AS reference_kind,
             reference->>'providerKey' AS provider_key,
             reference->>'externalKey' AS external_key
      FROM scoped
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(normalized->'externalProductReferences', '[]'::jsonb)) reference
      UNION ALL
      SELECT observation_id,
             promoted_catalog_item_id,
             'product-reference'::text AS reference_kind,
             reference->>'providerKey' AS provider_key,
             reference->>'externalKey' AS external_key
      FROM scoped
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(normalized->'skuReferences', '[]'::jsonb)) reference
    )
    SELECT observation_id,
           reference_kind,
           provider_key,
           external_key,
           promoted_catalog_item_id AS catalog_item_id,
           COUNT(*) OVER ()::integer AS reference_count
    FROM references
    WHERE provider_key IS NOT NULL
      AND external_key IS NOT NULL
    ORDER BY observation_id ASC, reference_kind ASC, external_key ASC
    LIMIT ${sampleLimit}`;
}

function toExternalReferenceImpactSample(
  row: ExternalReferenceImpactRow,
): readonly SourceObservationExternalReferenceImpactSample[] {
  if (!row.provider_key || !row.external_key) {
    return [];
  }

  return [
    {
      observationId: row.observation_id,
      referenceKind: row.reference_kind,
      providerKey: row.provider_key,
      externalKey: row.external_key,
      catalogItemId: row.catalog_item_id,
    },
  ];
}

function normalizeImpactSampleLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 25;
  }

  return Math.min(100, Math.max(1, Math.trunc(value ?? 25)));
}

function buildCatalogMergeCandidateObservationScopeCondition(
  params: CatalogMergeCandidateFilterScope,
  values: unknown[],
): string | null {
  const conditions: string[] = [];

  if (params.provider?.trim()) {
    values.push(params.provider.trim());
    conditions.push(`so.provider_key = $${values.length}`);
  }
  if (params.language?.trim()) {
    values.push(params.language.trim());
    conditions.push(`so.language_code = $${values.length}`);
  }
  if (params.productLineId?.trim()) {
    values.push(params.productLineId.trim());
    conditions.push(`${sourceObservationProductLineIdExpression("so")} = $${values.length}`);
  }
  if (params.productLineName?.trim()) {
    values.push(params.productLineName.trim());
    conditions.push(`${sourceObservationProductLineNameExpression("so")} = $${values.length}`);
  }
  const expansionId = params.expansionId?.trim() || params.setId?.trim();
  if (expansionId) {
    values.push(expansionId);
    conditions.push(
      `((so.normalized->>'setId') = $${values.length} OR (so.normalized->>'expansionId') = $${values.length} OR (so.normalized->>'setName') = $${values.length} OR (so.normalized->>'expansionName') = $${values.length})`,
    );
  }

  if (conditions.length === 0) {
    return null;
  }

  return `EXISTS (
    SELECT 1
    FROM catalog_merge_candidate_observations scoped_mco
    JOIN catalog_source_observations so ON so.observation_id = scoped_mco.observation_id
    WHERE scoped_mco.candidate_id = c.candidate_id
      AND ${conditions.join(" AND ")}
  )`;
}

function buildSourceObservationFilter(
  params: SourceObservationFilterScope,
  options: { includeListFilters: boolean; statuses?: readonly string[] },
): {
  conditions: string[];
  values: unknown[];
} {
  const scope = normalizeSourceObservationFilterScope(params);
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (scope.provider) {
    values.push(scope.provider);
    conditions.push(`provider_key = $${values.length}`);
  }

  if (scope.syncRunId) {
    values.push(scope.syncRunId);
    conditions.push(`sync_run_id = $${values.length}`);
  }

  if (scope.language) {
    values.push(scope.language);
    conditions.push(`language_code = $${values.length}`);
  }

  if (scope.productLineId) {
    values.push(scope.productLineId);
    conditions.push(`${sourceObservationProductLineIdExpression()} = $${values.length}`);
  }

  if (scope.seriesId) {
    values.push(scope.seriesId);
    conditions.push(`normalized->>'seriesId' = $${values.length}`);
  }

  if (scope.expansionId) {
    values.push(scope.expansionId);
    conditions.push(
      `((normalized->>'setId') = $${values.length} OR (normalized->>'expansionId') = $${values.length} OR (normalized->>'setName') = $${values.length})`,
    );
  }

  if (options.statuses && options.statuses.length > 0) {
    values.push(options.statuses);
    conditions.push(`status = ANY($${values.length}::text[])`);
  } else if (options.includeListFilters && scope.status) {
    values.push(scope.status);
    conditions.push(`status = $${values.length}`);
  }

  if (options.includeListFilters && scope.search) {
    values.push(scope.search);
    const param = `$${values.length}`;
    conditions.push(
      `to_tsvector('simple', coalesce(normalized->>'name', '') || ' ' || coalesce(normalized->>'expansionName', normalized->>'setName', '') || ' ' || external_key) @@ plainto_tsquery('simple', ${param})`,
    );
  }

  return { conditions, values };
}

function buildSourceObservationIntegrationScopeSummaryFilter(
  params: Pick<
    SourceObservationFilterScope,
    "provider" | "language" | "productLineId" | "seriesId" | "expansionId" | "setId"
  >,
): {
  conditions: string[];
  values: unknown[];
} {
  const scope = normalizeSourceObservationFilterScope(params);
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (scope.provider) {
    values.push(scope.provider);
    conditions.push(`provider_key = $${values.length}`);
  }

  if (scope.language) {
    values.push(scope.language);
    conditions.push(`language_code = $${values.length}`);
  }

  if (scope.productLineId) {
    values.push(scope.productLineId);
    conditions.push(`product_line_id = $${values.length}`);
  }

  if (scope.seriesId) {
    values.push(scope.seriesId);
    conditions.push(`series_id = $${values.length}`);
  }

  if (scope.expansionId) {
    values.push(scope.expansionId);
    conditions.push(`expansion_id = $${values.length}`);
  }

  return { conditions, values };
}

function normalizeSourceObservationFilterScope(
  params: SourceObservationFilterScope,
): Required<SourceObservationFilterScope> {
  const expansionId = params.expansionId?.trim() || params.setId?.trim() || "";

  return {
    search: params.search?.trim() ?? "",
    status: params.status?.trim() ?? "",
    syncRunId: params.syncRunId?.trim() ?? "",
    provider: params.provider?.trim() ?? "",
    language: params.language?.trim() ?? "",
    productLineId: params.productLineId?.trim() ?? "",
    seriesId: params.seriesId?.trim() ?? "",
    expansionId,
    setId: expansionId,
  };
}

function buildCatalogMergeCandidateFilter(params: CatalogMergeCandidateFilterScope): {
  conditions: string[];
  values: unknown[];
} {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.status?.trim()) {
    values.push(params.status.trim());
    conditions.push(`c.status = $${values.length}`);
  }

  if (params.syncRunId?.trim()) {
    values.push(params.syncRunId.trim());
    conditions.push(`c.sync_run_ids_json ? $${values.length}`);
  }

  if (params.identityFingerprint?.trim()) {
    values.push(params.identityFingerprint.trim());
    conditions.push(`c.identity_fingerprint = $${values.length}`);
  }

  if (params.matchedCatalogItemId?.trim()) {
    values.push(params.matchedCatalogItemId.trim());
    conditions.push(`c.matched_catalog_item_id = $${values.length}`);
  }

  return { conditions, values };
}

function reviewableStatusesForScope(scope: SourceObservationFilterScope): readonly string[] {
  if (!scope.status) {
    return ["observed", "changed"];
  }

  return scope.status === "observed" || scope.status === "changed" || scope.status === "promoted" ? [scope.status] : [];
}

function reapplyStatusesForScope(scope: SourceObservationFilterScope): readonly string[] {
  if (!scope.status) {
    return ["promoted"];
  }

  return scope.status === "promoted" ? ["promoted"] : [];
}
