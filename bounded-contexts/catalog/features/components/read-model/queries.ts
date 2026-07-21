import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import type { BulkLifecycleRow } from "../../../support/runtime-support/bulk-lifecycle";
import { catalogIsoUtcListSql } from "../../../support/runtime-support/iso-utc-timestamp";

export type ComponentRow = Readonly<{
  component_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  status: string;
  field_rules: unknown;
  dimension_rules: unknown;
  updated_at: string;
}>;

export type ComponentDetailRow = Readonly<{
  component_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  status: string;
  field_rules: unknown;
  dimension_rules: unknown;
  updated_at: string;
}>;

export type ComponentListParams = ListParams &
  Readonly<{
    hasFieldRules?: string;
    hasDimensionRules?: string;
  }>;

export async function listComponents(
  db: PgQueryable,
  params: ComponentListParams = {},
): Promise<ListResult<ComponentRow>> {
  const extraConditions: string[] = [];

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

  const query = buildFilteredQuery("catalog_components", params, ["key", "name"], "key ASC", extraConditions);
  return executeListQuery<ComponentRow>(
    db,
    query.countSql,
    catalogIsoUtcListSql(query.listSql, "updated_at"),
    query.countValues,
    query.listValues,
  );
}

export async function listComponentIds(db: PgQueryable, params: ComponentListParams = {}): Promise<string[]> {
  const result = await listComponents(db, { ...params, limit: undefined, offset: undefined });
  return result.items.map((row) => row.component_id);
}

export async function listComponentBulkRows(
  db: PgQueryable,
  componentIds: readonly string[],
): Promise<BulkLifecycleRow[]> {
  if (componentIds.length === 0) {
    return [];
  }

  const result = await db.query<ComponentRow>(
    catalogIsoUtcListSql(`SELECT * FROM catalog_components WHERE component_id = ANY($1::text[])`, "updated_at"),
    [[...componentIds]],
  );

  return result.rows.map((row) => ({
    id: row.component_id,
    label: row.name || row.key,
    status: row.status,
  }));
}

export async function getComponentDetail(db: PgQueryable, componentId: string) {
  const result = await db.query<ComponentDetailRow>(
    catalogIsoUtcListSql(`SELECT * FROM catalog_admin_component_detail_pages WHERE component_id = $1`, "updated_at"),
    [componentId],
  );

  return result.rows[0] ?? null;
}
