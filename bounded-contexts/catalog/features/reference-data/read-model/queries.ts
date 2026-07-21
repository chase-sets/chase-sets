import {
  buildFilteredQuery,
  escapeLikePattern,
  executeListQuery,
  type ListParams,
  type ListResult,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import type { BulkLifecycleRow } from "../../../support/runtime-support/bulk-lifecycle";
import { catalogIsoUtcListSql } from "../../../support/runtime-support/iso-utc-timestamp";

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

export type ReferenceTypeListParams = ListParams &
  Readonly<{
    attributeKey?: string;
  }>;

export type ReferenceRecordListParams = ListParams &
  Readonly<{
    typeKey?: string;
    relationshipType?: string;
    relatedReferenceId?: string;
    attributeKey?: string;
    attributeValue?: string;
  }>;

export async function listReferenceTypes(
  db: PgQueryable,
  params: ReferenceTypeListParams = {},
): Promise<ListResult<ReferenceTypeRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];

  if (params.attributeKey) {
    extraValues.push(JSON.stringify([params.attributeKey]));
    extraConditions.push(`attribute_keys @> $${extraValues.length}::jsonb`);
  }

  const query = buildFilteredQuery(
    "catalog_reference_types",
    params,
    ["key", "name"],
    "name ASC",
    extraConditions,
    extraValues,
  );

  return executeListQuery<ReferenceTypeRow>(
    db,
    query.countSql,
    catalogIsoUtcListSql(query.listSql, "updated_at"),
    query.countValues,
    query.listValues,
  );
}

export async function listReferenceTypeIds(db: PgQueryable, params: ReferenceTypeListParams = {}): Promise<string[]> {
  const result = await listReferenceTypes(db, { ...params, limit: undefined, offset: undefined });
  return result.items.map((row) => row.reference_type_id);
}

export async function listReferenceTypeBulkRows(
  db: PgQueryable,
  referenceTypeIds: readonly string[],
): Promise<BulkLifecycleRow[]> {
  if (referenceTypeIds.length === 0) {
    return [];
  }

  const result = await db.query<ReferenceTypeRow>(
    catalogIsoUtcListSql(
      `SELECT * FROM catalog_reference_types WHERE reference_type_id = ANY($1::text[])`,
      "updated_at",
    ),
    [[...referenceTypeIds]],
  );

  return result.rows.map((row) => ({
    id: row.reference_type_id,
    label: row.name || row.key,
    status: row.status,
  }));
}

export async function getReferenceType(db: PgQueryable, referenceTypeId: string) {
  const result = await db.query<ReferenceTypeRow>(
    catalogIsoUtcListSql(`SELECT * FROM catalog_reference_types WHERE reference_type_id = $1`, "updated_at"),
    [referenceTypeId],
  );

  return result.rows[0] ?? null;
}

export async function listReferenceRecords(
  db: PgQueryable,
  params: ReferenceRecordListParams = {},
): Promise<ListResult<ReferenceRecordRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];

  if (params.typeKey) {
    extraConditions.push("type_key = $1");
    extraValues.push(params.typeKey);
  }

  if (params.relationshipType) {
    extraValues.push(params.relationshipType);
    extraConditions.push(`relationships @> $${extraValues.length}::jsonb`);
    extraValues[extraValues.length - 1] = JSON.stringify([{ relationshipType: params.relationshipType }]);
  }

  if (params.relatedReferenceId) {
    extraValues.push(JSON.stringify([{ referenceId: params.relatedReferenceId }]));
    extraConditions.push(`relationships @> $${extraValues.length}::jsonb`);
  }

  if (params.attributeKey) {
    extraConditions.push(`attributes ? $${extraValues.length + 1}`);
    extraValues.push(params.attributeKey);
  }

  if (params.attributeKey && params.attributeValue) {
    extraValues.push(escapeLikePattern(params.attributeValue));
    extraConditions.push(`attributes->>$${extraValues.length - 1} ILIKE $${extraValues.length} ESCAPE '\\'`);
  }

  const query = buildFilteredQuery(
    "catalog_reference_records",
    params,
    ["key", "name"],
    "name ASC",
    extraConditions,
    extraValues,
  );

  return executeListQuery<ReferenceRecordRow>(
    db,
    query.countSql,
    catalogIsoUtcListSql(query.listSql, "updated_at"),
    query.countValues,
    query.listValues,
  );
}

export async function listReferenceRecordIds(
  db: PgQueryable,
  params: ReferenceRecordListParams = {},
): Promise<string[]> {
  const result = await listReferenceRecords(db, { ...params, limit: undefined, offset: undefined });
  return result.items.map((row) => row.reference_record_id);
}

export async function listReferenceRecordBulkRows(
  db: PgQueryable,
  referenceRecordIds: readonly string[],
): Promise<BulkLifecycleRow[]> {
  if (referenceRecordIds.length === 0) {
    return [];
  }

  const result = await db.query<ReferenceRecordRow>(
    catalogIsoUtcListSql(
      `SELECT * FROM catalog_reference_records WHERE reference_record_id = ANY($1::text[])`,
      "updated_at",
    ),
    [[...referenceRecordIds]],
  );

  return result.rows.map((row) => ({
    id: row.reference_record_id,
    label: row.name || row.key,
    status: row.status,
  }));
}

export async function getReferenceRecord(db: PgQueryable, referenceRecordId: string) {
  const result = await db.query<ReferenceRecordRow>(
    catalogIsoUtcListSql(`SELECT * FROM catalog_reference_records WHERE reference_record_id = $1`, "updated_at"),
    [referenceRecordId],
  );

  return result.rows[0] ?? null;
}
