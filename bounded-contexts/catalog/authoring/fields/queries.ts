import type { PgQueryable } from "@chase-sets/event-core/postgres/types";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
} from "../projection-support/list-query";

export type FieldRow = Readonly<{
  field_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  value_type: string;
  filterable: boolean;
  searchable: boolean;
  sortable: boolean;
  updated_at: string;
}>;

export async function listFields(
  db: PgQueryable,
  params: ListParams = {},
): Promise<ListResult<FieldRow>> {
  const query = buildFilteredQuery("catalog_fields", params, ["key", "name"], "key ASC");
  return executeListQuery<FieldRow>(db, query.countSql, query.listSql, query.values);
}

export async function getField(db: PgQueryable, fieldId: string) {
  const result = await db.query<FieldRow>(
    `SELECT * FROM catalog_fields WHERE field_id = $1`,
    [fieldId],
  );

  return result.rows[0] ?? null;
}


