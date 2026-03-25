import type { PgQueryable } from "../../../../contracts/event-core/postgres/types";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
} from "../support/projections/list-query";

export type BlueprintRow = Readonly<{
  blueprint_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  component_ids: unknown;
  field_rules: unknown;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
  updated_at: string;
}>;

export type BlueprintDetailRow = Readonly<{
  blueprint_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  components: unknown;
  field_rules: unknown;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
  updated_at: string;
}>;

export async function listBlueprints(
  db: PgQueryable,
  params: ListParams = {},
): Promise<ListResult<BlueprintRow>> {
  const query = buildFilteredQuery("catalog_blueprints", params, ["key", "name"], "key ASC");
  return executeListQuery<BlueprintRow>(db, query.countSql, query.listSql, query.values);
}

export async function getBlueprintDetail(db: PgQueryable, blueprintId: string) {
  const result = await db.query<BlueprintDetailRow>(
    `SELECT * FROM catalog_admin_blueprint_detail_pages WHERE blueprint_id = $1`,
    [blueprintId],
  );

  return result.rows[0] ?? null;
}

