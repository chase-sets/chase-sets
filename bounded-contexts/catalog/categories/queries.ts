import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
} from "../projection-support/list-query";

export type CategoryListRow = Readonly<{
  category_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  parent_category_id: string | null;
  parent_category: unknown;
  display_order: number;
  updated_at: string;
}>;

export type CategoryDetailRow = CategoryListRow;

export async function listCategories(
  db: PgQueryable,
  params: ListParams & { parentCategoryId?: string } = {},
): Promise<ListResult<CategoryListRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];

  if (params.parentCategoryId) {
    extraConditions.push(`parent_category_id = $1`);
    extraValues.push(params.parentCategoryId);
  }

  const query = buildFilteredQuery(
    "catalog_admin_category_list_pages",
    params,
    ["key", "name"],
    "display_order ASC, key ASC",
    extraConditions,
    extraValues,
  );

  return executeListQuery<CategoryListRow>(db, query.countSql, query.listSql, query.values);
}

export async function getCategoryDetail(db: PgQueryable, categoryId: string) {
  const result = await db.query<CategoryDetailRow>(
    `SELECT * FROM catalog_admin_category_detail_pages WHERE category_id = $1`,
    [categoryId],
  );

  return result.rows[0] ?? null;
}


