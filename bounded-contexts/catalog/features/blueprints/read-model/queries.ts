import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import type { BulkLifecycleRow } from "../../../support/runtime-support/bulk-lifecycle";
import { catalogIsoUtcListSql, catalogIsoUtcTimestamp } from "../../../support/runtime-support/iso-utc-timestamp";

export type BlueprintRow = Readonly<{
  blueprint_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
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
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  status: string;
  components: unknown;
  field_rules: unknown;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
  updated_at: string;
}>;

export type BlueprintListParams = ListParams &
  Readonly<{
    hasComponents?: string;
    hasFieldRules?: string;
    hasDimensionRules?: string;
  }>;

export async function listBlueprints(
  db: PgQueryable,
  params: BlueprintListParams = {},
): Promise<ListResult<BlueprintRow>> {
  const extraConditions: string[] = [];

  if (params.hasComponents === "true") {
    extraConditions.push("jsonb_array_length(component_ids) > 0");
  } else if (params.hasComponents === "false") {
    extraConditions.push("jsonb_array_length(component_ids) = 0");
  }
  if (params.hasFieldRules === "true") {
    extraConditions.push("jsonb_array_length(field_rules) > 0");
  } else if (params.hasFieldRules === "false") {
    extraConditions.push("jsonb_array_length(field_rules) = 0");
  }
  if (params.hasDimensionRules === "true") {
    extraConditions.push("jsonb_array_length(dimension_rules) > 0");
  } else if (params.hasDimensionRules === "false") {
    extraConditions.push("jsonb_array_length(dimension_rules) = 0");
  }

  const query = buildFilteredQuery("catalog_blueprints", params, ["key", "name"], "key ASC", extraConditions);
  return executeListQuery<BlueprintRow>(
    db,
    query.countSql,
    catalogIsoUtcListSql(query.listSql, "updated_at"),
    query.countValues,
    query.listValues,
  );
}

export async function listBlueprintIds(db: PgQueryable, params: BlueprintListParams = {}): Promise<string[]> {
  const result = await listBlueprints(db, { ...params, limit: undefined, offset: undefined });
  return result.items.map((row) => row.blueprint_id);
}

export async function listBlueprintBulkRows(
  db: PgQueryable,
  blueprintIds: readonly string[],
): Promise<BulkLifecycleRow[]> {
  if (blueprintIds.length === 0) {
    return [];
  }

  const result = await db.query<BlueprintRow>(
    `SELECT *, ${catalogIsoUtcTimestamp("updated_at")} FROM catalog_blueprints WHERE blueprint_id = ANY($1::text[])`,
    [[...blueprintIds]],
  );

  return result.rows.map((row) => ({
    id: row.blueprint_id,
    label: row.name || row.key,
    status: row.status,
  }));
}

export async function getBlueprintDetail(db: PgQueryable, blueprintId: string) {
  const result = await db.query<BlueprintDetailRow>(
    `SELECT *, ${catalogIsoUtcTimestamp("updated_at")} FROM catalog_admin_blueprint_detail_pages WHERE blueprint_id = $1`,
    [blueprintId],
  );

  return result.rows[0] ?? null;
}
