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
      "coalesce(normalized->>'expansionName', normalized->>'setName')",
    ],
    "observed_at DESC",
    filter.conditions,
    filter.values,
  );

  return executeListQuery<SourceObservationListRow>(
    db,
    query.countSql,
    query.listSql,
    query.values,
  );
}

export async function previewSourceObservationPromotionScope(
  db: PgQueryable,
  params: SourceObservationFilterScope = {},
): Promise<SourceObservationPromotionPreview> {
  const scope = normalizeSourceObservationFilterScope(params);
  const eligibleCount = scope.status && scope.status !== "observed"
    ? Promise.resolve(0)
    : countSourceObservations(db, toEligiblePromotionScope(scope));
  const [matched, eligible] = await Promise.all([
    countSourceObservations(db, scope),
    eligibleCount,
  ]);

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
  if (scope.status && scope.status !== "observed") {
    return [];
  }

  const filter = buildSourceObservationFilter(toEligiblePromotionScope(scope), {
    includeListFilters: true,
  });
  const where = filter.conditions.length > 0
    ? `WHERE ${filter.conditions.join(" AND ")}`
    : "";
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
): Promise<number> {
  const filter = buildSourceObservationFilter(params, { includeListFilters: true });
  const where = filter.conditions.length > 0
    ? `WHERE ${filter.conditions.join(" AND ")}`
    : "";
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM catalog_source_observations ${where}`,
    filter.values,
  );

  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}

function buildSourceObservationFilter(
  params: SourceObservationFilterScope,
  options: { includeListFilters: boolean },
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

  if (options.includeListFilters && scope.status) {
    values.push(scope.status);
    conditions.push(`status = $${values.length}`);
  }

  if (options.includeListFilters && scope.search) {
    values.push(`%${scope.search}%`);
    const param = `$${values.length}`;
    conditions.push(`(external_key ILIKE ${param} OR source_url ILIKE ${param} OR (normalized->>'setId') ILIKE ${param} OR (normalized->>'expansionId') ILIKE ${param} OR (normalized->>'name') ILIKE ${param} OR coalesce(normalized->>'expansionName', normalized->>'setName') ILIKE ${param})`);
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

function toEligiblePromotionScope(
  scope: SourceObservationFilterScope,
): SourceObservationFilterScope {
  return {
    ...scope,
    status: "observed",
  };
}
