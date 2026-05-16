import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
} from "../../../support/projection-support/list-query";

export type ReferenceTypeRow = Readonly<{
  reference_type_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  attribute_keys: unknown;
  status: string;
  updated_at: string;
}>;

export type ReferenceRecordRow = Readonly<{
  reference_record_id: string;
  type_key: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  attributes: unknown;
  relationships: unknown;
  status: string;
  updated_at: string;
}>;

export async function listReferenceTypes(
  db: PgQueryable,
  params: ListParams = {},
): Promise<ListResult<ReferenceTypeRow>> {
  const query = buildFilteredQuery(
    "catalog_reference_types",
    params,
    ["key", "name"],
    "name ASC",
  );

  return executeListQuery<ReferenceTypeRow>(db, query.countSql, query.listSql, query.values);
}

export async function getReferenceType(db: PgQueryable, referenceTypeId: string) {
  const result = await db.query<ReferenceTypeRow>(
    `SELECT * FROM catalog_reference_types WHERE reference_type_id = $1`,
    [referenceTypeId],
  );

  return result.rows[0] ?? null;
}

export async function listReferenceRecords(
  db: PgQueryable,
  params: ListParams & { typeKey?: string } = {},
): Promise<ListResult<ReferenceRecordRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];

  if (params.typeKey) {
    extraConditions.push("type_key = $1");
    extraValues.push(params.typeKey);
  }

  const query = buildFilteredQuery(
    "catalog_reference_records",
    params,
    ["key", "name"],
    "name ASC",
    extraConditions,
    extraValues,
  );

  return executeListQuery<ReferenceRecordRow>(db, query.countSql, query.listSql, query.values);
}

export async function getReferenceRecord(db: PgQueryable, referenceRecordId: string) {
  const result = await db.query<ReferenceRecordRow>(
    `SELECT * FROM catalog_reference_records WHERE reference_record_id = $1`,
    [referenceRecordId],
  );

  return result.rows[0] ?? null;
}
