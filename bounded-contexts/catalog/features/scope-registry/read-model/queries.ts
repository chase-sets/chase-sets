import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import type { CatalogLifecycleStatus } from "../../../support/runtime-support/common";
import type { CatalogScopeProductDomain, CatalogScopeRecordKind } from "../domain/contract";

export type CatalogScopeRecordRow = Readonly<{
  scope_record_id: string;
  product_domain: CatalogScopeProductDomain;
  scope_kind: CatalogScopeRecordKind;
  reference_type_key: string;
  reference_record_id: string;
  reference_record_key: string;
  name_i18n: unknown;
  name: string;
  parent_scope_record_id: string | null;
  product_line_scope_record_id: string | null;
  series_scope_record_id: string | null;
  release_date: string | null;
  official_set_code: string | null;
  language_editions: unknown;
  attributes: unknown;
  relationships: unknown;
  lifecycle_status: CatalogLifecycleStatus;
  updated_at: string;
}>;

export type CatalogScopeRecordListParams = ListParams &
  Readonly<{
    productDomain?: CatalogScopeProductDomain;
    scopeKind?: CatalogScopeRecordKind;
    lifecycleStatus?: CatalogLifecycleStatus;
    parentScopeRecordId?: string;
    productLineScopeRecordId?: string;
    seriesScopeRecordId?: string;
    referenceRecordId?: string;
  }>;

export async function listCatalogScopeRecords(
  db: PgQueryable,
  params: CatalogScopeRecordListParams = {},
): Promise<ListResult<CatalogScopeRecordRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];

  addEqualCondition(extraConditions, extraValues, "product_domain", params.productDomain);
  addEqualCondition(extraConditions, extraValues, "scope_kind", params.scopeKind);
  addEqualCondition(extraConditions, extraValues, "lifecycle_status", params.lifecycleStatus);
  addEqualCondition(extraConditions, extraValues, "parent_scope_record_id", params.parentScopeRecordId);
  addEqualCondition(extraConditions, extraValues, "product_line_scope_record_id", params.productLineScopeRecordId);
  addEqualCondition(extraConditions, extraValues, "series_scope_record_id", params.seriesScopeRecordId);
  addEqualCondition(extraConditions, extraValues, "reference_record_id", params.referenceRecordId);

  const query = buildFilteredQuery(
    "catalog_scope_records",
    params,
    ["reference_record_key", "name", "official_set_code"],
    "product_domain ASC, scope_kind ASC, name ASC",
    extraConditions,
    extraValues,
  );

  return executeListQuery<CatalogScopeRecordRow>(
    db,
    query.countSql,
    query.listSql,
    query.countValues,
    query.listValues,
  );
}

export async function getCatalogScopeRecord(
  db: PgQueryable,
  scopeRecordId: string,
): Promise<CatalogScopeRecordRow | null> {
  const result = await db.query<CatalogScopeRecordRow>(
    `SELECT *
     FROM catalog_scope_records
     WHERE scope_record_id = $1`,
    [scopeRecordId],
  );

  return result.rows[0] ?? null;
}

function addEqualCondition(
  extraConditions: string[],
  extraValues: unknown[],
  columnName: string,
  value: string | null | undefined,
): void {
  if (!value) {
    return;
  }
  extraValues.push(value);
  extraConditions.push(`${columnName} = $${extraValues.length}`);
}
