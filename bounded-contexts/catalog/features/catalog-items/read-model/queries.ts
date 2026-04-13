import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
} from "../../../support/projection-support/list-query";

export type CatalogItemListRow = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  blueprint: unknown;
  status: string;
  tags: unknown;
  updated_at: string;
}>;

export type CatalogItemDetailRow = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint_id: string | null;
  blueprint: unknown;
  status: string;
  field_values: unknown;
  categories: unknown;
  tags: unknown;
  image_urls: unknown;
  updated_at: string;
}>;

export async function listCatalogItems(
  db: PgQueryable,
  params: ListParams & { blueprintId?: string; tag?: string } = {},
): Promise<ListResult<CatalogItemListRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];
  let paramIndex = 1;

  if (params.blueprintId) {
    extraConditions.push(`blueprint_id = $${paramIndex}`);
    extraValues.push(params.blueprintId);
    paramIndex++;
  }

  if (params.tag) {
    extraConditions.push(`tags @> $${paramIndex}::jsonb`);
    extraValues.push(JSON.stringify([params.tag]));
    paramIndex++;
  }

  const query = buildFilteredQuery(
    "catalog_admin_catalog_item_list_pages",
    params,
    ["title", "subtitle"],
    "title ASC",
    extraConditions,
    extraValues,
  );

  return executeListQuery<CatalogItemListRow>(db, query.countSql, query.listSql, query.values);
}

export async function getCatalogItemDetail(db: PgQueryable, itemId: string) {
  const result = await db.query<CatalogItemDetailRow>(
    `SELECT * FROM catalog_admin_catalog_item_detail_pages WHERE item_id = $1`,
    [itemId],
  );

  return result.rows[0] ?? null;
}


