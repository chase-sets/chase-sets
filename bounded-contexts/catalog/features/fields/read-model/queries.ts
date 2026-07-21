import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import type { BulkLifecycleRow } from "../../../support/runtime-support/bulk-lifecycle";
import { catalogIsoUtcListSql } from "../../../support/runtime-support/iso-utc-timestamp";

export type FieldRow = Readonly<{
  field_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  status: string;
  value_type: string;
  filterable: boolean;
  searchable: boolean;
  sortable: boolean;
  updated_at: string;
}>;

export type FieldListParams = ListParams &
  Readonly<{
    valueType?: string;
    filterable?: string;
    searchable?: string;
    sortable?: string;
  }>;

export async function listFields(db: PgQueryable, params: FieldListParams = {}): Promise<ListResult<FieldRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];

  if (params.valueType) {
    extraValues.push(params.valueType);
    extraConditions.push(`value_type = $${extraValues.length}`);
  }
  for (const flag of ["filterable", "searchable", "sortable"] as const) {
    if (params[flag] === "true" || params[flag] === "false") {
      extraValues.push(params[flag] === "true");
      extraConditions.push(`${flag} = $${extraValues.length}`);
    }
  }

  const query = buildFilteredQuery("catalog_fields", params, ["key", "name"], "key ASC", extraConditions, extraValues);
  return executeListQuery<FieldRow>(
    db,
    query.countSql,
    catalogIsoUtcListSql(query.listSql, "updated_at"),
    query.countValues,
    query.listValues,
  );
}

export async function listFieldIds(db: PgQueryable, params: FieldListParams = {}): Promise<string[]> {
  const result = await listFields(db, { ...params, limit: undefined, offset: undefined });
  return result.items.map((row) => row.field_id);
}

export async function listFieldBulkRows(db: PgQueryable, fieldIds: readonly string[]): Promise<BulkLifecycleRow[]> {
  if (fieldIds.length === 0) {
    return [];
  }

  const result = await db.query<FieldRow>(
    catalogIsoUtcListSql(`SELECT * FROM catalog_fields WHERE field_id = ANY($1::text[])`, "updated_at"),
    [[...fieldIds]],
  );

  return result.rows.map((row) => ({
    id: row.field_id,
    label: row.name || row.key,
    status: row.status,
  }));
}

export async function getField(db: PgQueryable, fieldId: string) {
  const result = await db.query<FieldRow>(
    catalogIsoUtcListSql(`SELECT * FROM catalog_fields WHERE field_id = $1`, "updated_at"),
    [fieldId],
  );

  return result.rows[0] ?? null;
}
