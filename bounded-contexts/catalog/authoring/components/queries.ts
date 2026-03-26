import type { PgQueryable } from "@chase-sets/event-core/postgres/types";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
} from "../support/projections/list-query";

export type ComponentRow = Readonly<{
  component_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  field_rules: unknown;
  dimension_rules: unknown;
  updated_at: string;
}>;

export type ComponentDetailRow = Readonly<{
  component_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  field_rules: unknown;
  dimension_rules: unknown;
  updated_at: string;
}>;

export async function listComponents(
  db: PgQueryable,
  params: ListParams = {},
): Promise<ListResult<ComponentRow>> {
  const query = buildFilteredQuery("catalog_components", params, ["key", "name"], "key ASC");
  return executeListQuery<ComponentRow>(db, query.countSql, query.listSql, query.values);
}

export async function getComponentDetail(db: PgQueryable, componentId: string) {
  const result = await db.query<ComponentDetailRow>(
    `SELECT * FROM catalog_admin_component_detail_pages WHERE component_id = $1`,
    [componentId],
  );

  return result.rows[0] ?? null;
}


