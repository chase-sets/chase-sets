import type { JsonValue } from "@chase-sets/primitives/json";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import type { SourceObservationNormalized } from "../domain/domain";

export type SourceObservationListRow = Readonly<{
  observation_id: string;
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
  provider?: string;
  language?: string;
  setId?: string;
}>;

export type SourceObservationPromotionPreview = Readonly<{
  matched: number;
  eligible: number;
  terminal: number;
  scope: Required<SourceObservationFilterScope>;
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
  const filter = buildSourceObservationFilter(params, { includeListFilters: false });
  const query = buildFilteredQuery(
    "catalog_source_observations",
    params,
    [
      "external_key",
      "source_url",
      "(normalized->>'setId')",
      "(normalized->>'name')",
      "(normalized->>'cardNumber')",
      "coalesce(normalized->>'expansionName', normalized->>'setName')",
    ],
    "observed_at DESC",
    filter.conditions,
    filter.values,
  );

  return executeListQuery<SourceObservationListRow>(db, query.countSql, query.listSql, query.values);
}

export async function listSourceObservationIntegrationScopes(
  db: PgQueryable,
  params: Pick<SourceObservationFilterScope, "provider" | "language" | "setId"> = {},
): Promise<SourceObservationIntegrationScopeRow[]> {
  const filter = buildSourceObservationFilter(params, { includeListFilters: false });
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
  const result = await db.query<SourceObservationIntegrationScopeRow>(
    `SELECT
       provider_key,
       language_code,
       coalesce(normalized->>'expansionId', normalized->>'setId', normalized->>'setName', '') AS expansion_id,
       coalesce(normalized->>'expansionName', normalized->>'setName', '') AS expansion_name,
       coalesce(normalized->>'seriesId', '') AS series_id,
       coalesce(normalized->>'seriesName', '') AS series_name,
       coalesce(MIN(source_payload->>'productLineId'), '') AS product_line_id,
       coalesce(normalized->>'productLineName', normalized->'mergeIdentity'->>'productLineName', '') AS product_line_name,
       COUNT(*)::integer AS total_observations,
       (COUNT(*) FILTER (WHERE status = 'observed'))::integer AS observed_observations,
       (COUNT(*) FILTER (WHERE status = 'changed'))::integer AS changed_observations,
       (COUNT(*) FILTER (WHERE status = 'promoted'))::integer AS promoted_observations,
       (COUNT(*) FILTER (WHERE status = 'rejected'))::integer AS rejected_observations,
       MIN(observed_at)::text AS first_observed_at,
       MAX(observed_at)::text AS latest_observed_at,
       MAX(source_updated_at)::text AS latest_source_updated_at
     FROM catalog_source_observations
     ${where}
     GROUP BY
       provider_key,
       language_code,
       coalesce(normalized->>'expansionId', normalized->>'setId', normalized->>'setName', ''),
       coalesce(normalized->>'expansionName', normalized->>'setName', ''),
       coalesce(normalized->>'seriesId', ''),
       coalesce(normalized->>'seriesName', ''),
       coalesce(normalized->>'productLineName', normalized->'mergeIdentity'->>'productLineName', '')
     ORDER BY MAX(observed_at) DESC, provider_key ASC, language_code ASC`,
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
  const eligibleCount =
    eligibleStatuses.length === 0 ? Promise.resolve(0) : countSourceObservations(db, scope, eligibleStatuses);
  const [matched, eligible] = await Promise.all([countSourceObservations(db, scope), eligibleCount]);

  return {
    matched,
    eligible,
    terminal: Math.max(0, matched - eligible),
    scope,
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
    };
  }

  const result = await db.query<{ matched: string | number; eligible: string | number }>(
    `SELECT
       COUNT(*)::integer AS matched,
       (COUNT(*) FILTER (WHERE status IN ('observed', 'changed')))::integer AS eligible
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

  if (scope.language) {
    values.push(scope.language);
    conditions.push(`language_code = $${values.length}`);
  }

  if (scope.setId) {
    values.push(scope.setId);
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
    values.push(`%${scope.search}%`);
    const param = `$${values.length}`;
    conditions.push(
      `(external_key ILIKE ${param} OR source_url ILIKE ${param} OR (normalized->>'setId') ILIKE ${param} OR (normalized->>'expansionId') ILIKE ${param} OR (normalized->>'providerProductId') ILIKE ${param} OR (normalized->>'name') ILIKE ${param} OR (normalized->>'cardNumber') ILIKE ${param} OR coalesce(normalized->>'expansionName', normalized->>'setName') ILIKE ${param})`,
    );
  }

  return { conditions, values };
}

function normalizeSourceObservationFilterScope(
  params: SourceObservationFilterScope,
): Required<SourceObservationFilterScope> {
  return {
    search: params.search?.trim() ?? "",
    status: params.status?.trim() ?? "",
    provider: params.provider?.trim() ?? "",
    language: params.language?.trim() ?? "",
    setId: params.setId?.trim() ?? "",
  };
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
