import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
} from "../../../support/projection-support/list-query";

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

export async function listDimensions(
  db: PgQueryable,
  params: ListParams = {},
): Promise<ListResult<DimensionRow>> {
  const query = buildFilteredQuery("catalog_dimensions", params, ["key", "name"], "key ASC");
  return executeListQuery<DimensionRow>(db, query.countSql, query.listSql, query.values);
}

export async function getDimension(db: PgQueryable, dimensionId: string) {
  const dimensionResult = await db.query<DimensionRow>(
    `SELECT * FROM catalog_dimensions WHERE dimension_id = $1`,
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
