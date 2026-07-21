import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import type { BulkLifecycleRow } from "../../../support/runtime-support/bulk-lifecycle";
import { catalogIsoUtcListSql } from "../../../support/runtime-support/iso-utc-timestamp";

export type DimensionRow = Readonly<{
  dimension_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  value_kind: string;
  status: string;
  updated_at: string;
}>;

export type DimensionOptionRow = Readonly<{
  option_id: string;
  dimension_id: string;
  code: string;
  label_i18n: unknown;
  label: string;
  display_order: number;
  numeric_value: number | null;
  status: string;
}>;

export type DimensionListParams = ListParams &
  Readonly<{
    valueKind?: string;
  }>;

export async function listDimensions(
  db: PgQueryable,
  params: DimensionListParams = {},
): Promise<ListResult<DimensionRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];

  if (params.valueKind) {
    extraConditions.push("value_kind = $1");
    extraValues.push(params.valueKind);
  }

  const query = buildFilteredQuery(
    "catalog_dimensions",
    params,
    ["key", "name"],
    "key ASC",
    extraConditions,
    extraValues,
  );
  return executeListQuery<DimensionRow>(
    db,
    query.countSql,
    catalogIsoUtcListSql(query.listSql, "updated_at"),
    query.countValues,
    query.listValues,
  );
}

export async function listDimensionIds(db: PgQueryable, params: DimensionListParams = {}): Promise<string[]> {
  const result = await listDimensions(db, { ...params, limit: undefined, offset: undefined });
  return result.items.map((row) => row.dimension_id);
}

export async function listDimensionBulkRows(
  db: PgQueryable,
  dimensionIds: readonly string[],
): Promise<BulkLifecycleRow[]> {
  if (dimensionIds.length === 0) {
    return [];
  }

  const result = await db.query<DimensionRow>(
    catalogIsoUtcListSql(`SELECT * FROM catalog_dimensions WHERE dimension_id = ANY($1::text[])`, "updated_at"),
    [[...dimensionIds]],
  );

  return result.rows.map((row) => ({
    id: row.dimension_id,
    label: row.name || row.key,
    status: row.status,
  }));
}

export async function getDimension(db: PgQueryable, dimensionId: string) {
  const dimensionResult = await db.query<DimensionRow>(
    catalogIsoUtcListSql(`SELECT * FROM catalog_dimensions WHERE dimension_id = $1`, "updated_at"),
    [dimensionId],
  );

  if (dimensionResult.rows.length === 0) {
    return null;
  }

  const optionsResult = await db.query<DimensionOptionRow>(
    `SELECT
       option_id,
       dimension_id,
       code,
       label_i18n,
       label,
       display_order,
       numeric_value::float8 AS numeric_value,
       status
     FROM catalog_dimension_options
     WHERE dimension_id = $1
     ORDER BY display_order ASC`,
    [dimensionId],
  );

  return { ...dimensionResult.rows[0], options: optionsResult.rows };
}
