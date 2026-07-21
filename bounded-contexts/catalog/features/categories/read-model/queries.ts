import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import type { BulkLifecycleRow } from "../../../support/runtime-support/bulk-lifecycle";
import { catalogIsoUtcListSql } from "../../../support/runtime-support/iso-utc-timestamp";

export type CategoryListRow = Readonly<{
  category_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  status: string;
  parent_category_id: string | null;
  parent_category: unknown;
  display_order: number;
  updated_at: string;
}>;

export type CategoryDetailRow = CategoryListRow;

export type CategoryListParams = ListParams &
  Readonly<{
    parentCategoryId?: string;
    hierarchy?: string;
  }>;

export async function listCategories(
  db: PgQueryable,
  params: CategoryListParams = {},
): Promise<ListResult<CategoryListRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];

  if (params.parentCategoryId) {
    extraConditions.push(`parent_category_id = $1`);
    extraValues.push(params.parentCategoryId);
  }

  if (params.hierarchy === "root") {
    extraConditions.push("parent_category_id IS NULL");
  } else if (params.hierarchy === "child") {
    extraConditions.push("parent_category_id IS NOT NULL");
  }

  const query = buildFilteredQuery(
    "catalog_admin_category_list_pages",
    params,
    ["key", "name"],
    "display_order ASC, key ASC",
    extraConditions,
    extraValues,
  );

  return executeListQuery<CategoryListRow>(
    db,
    query.countSql,
    catalogIsoUtcListSql(query.listSql, "updated_at"),
    query.countValues,
    query.listValues,
  );
}

export async function listCategoryIds(db: PgQueryable, params: CategoryListParams = {}): Promise<string[]> {
  const result = await listCategories(db, { ...params, limit: undefined, offset: undefined });
  return result.items.map((row) => row.category_id);
}

export async function listCategoryBulkRows(
  db: PgQueryable,
  categoryIds: readonly string[],
): Promise<BulkLifecycleRow[]> {
  if (categoryIds.length === 0) {
    return [];
  }

  const result = await db.query<CategoryListRow>(
    catalogIsoUtcListSql(
      `SELECT * FROM catalog_admin_category_list_pages WHERE category_id = ANY($1::text[])`,
      "updated_at",
    ),
    [[...categoryIds]],
  );

  return result.rows.map((row) => ({
    id: row.category_id,
    label: row.name || row.key,
    status: row.status,
  }));
}

export async function getCategoryDetail(db: PgQueryable, categoryId: string) {
  const result = await db.query<CategoryDetailRow>(
    catalogIsoUtcListSql(`SELECT * FROM catalog_admin_category_detail_pages WHERE category_id = $1`, "updated_at"),
    [categoryId],
  );

  return result.rows[0] ?? null;
}
