import type { JsonValue } from "@chase-sets/primitives/json";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
} from "../../../support/projection-support/list-query";
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
  normalized: SourceObservationNormalized;
  status: string;
  status_reason: string | null;
  promoted_catalog_item_id: string | null;
  promoted_at: string | null;
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
}>;

export type SourceObservationIntegrationScopeRow = Readonly<{
  provider_key: string;
  language_code: string;
  expansion_id: string;
  expansion_name: string;
  series_id: string;
  series_name: string;
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
       coalesce(normalized->>'expansionId', normalized->>'setId', '') AS expansion_id,
       coalesce(normalized->>'expansionName', normalized->>'setName', '') AS expansion_name,
       coalesce(normalized->>'seriesId', '') AS series_id,
       coalesce(normalized->>'seriesName', '') AS series_name,
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
       coalesce(normalized->>'expansionId', normalized->>'setId', ''),
       coalesce(normalized->>'expansionName', normalized->>'setName', ''),
       coalesce(normalized->>'seriesId', ''),
       coalesce(normalized->>'seriesName', '')
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
  const eligibleStatuses = reapplyStatusesForScope(scope);
  const eligibleCount =
    eligibleStatuses.length === 0 ? Promise.resolve(0) : countSourceObservations(db, scope, eligibleStatuses);
  const [matched, eligible] = await Promise.all([countSourceObservations(db, scope), eligibleCount]);

  return {
    matched,
    eligible,
    ineligible: Math.max(0, matched - eligible),
    scope,
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
    conditions.push(`((normalized->>'setId') = $${values.length} OR (normalized->>'expansionId') = $${values.length})`);
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
      `(external_key ILIKE ${param} OR source_url ILIKE ${param} OR (normalized->>'setId') ILIKE ${param} OR (normalized->>'expansionId') ILIKE ${param} OR (normalized->>'name') ILIKE ${param} OR (normalized->>'cardNumber') ILIKE ${param} OR coalesce(normalized->>'expansionName', normalized->>'setName') ILIKE ${param})`,
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

  return scope.status === "observed" || scope.status === "changed" ? [scope.status] : [];
}

function reapplyStatusesForScope(scope: SourceObservationFilterScope): readonly string[] {
  if (!scope.status) {
    return ["promoted"];
  }

  return scope.status === "promoted" ? ["promoted"] : [];
}
