import type { PgQueryable } from "@chase-sets/event-core/postgres/types";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
} from "../projection-support/list-query";

export type DimensionRow = Readonly<{
  dimension_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  updated_at: string;
}>;

export type DimensionChoiceRow = Readonly<{
  choice_id: string;
  dimension_id: string;
  code: string;
  labels: unknown;
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

  const choicesResult = await db.query<DimensionChoiceRow>(
    `SELECT * FROM catalog_dimension_choices WHERE dimension_id = $1 ORDER BY display_order ASC`,
    [dimensionId],
  );

  return { ...dimensionResult.rows[0], choices: choicesResult.rows };
}


