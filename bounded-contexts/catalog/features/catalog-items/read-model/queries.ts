import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
} from "../../../support/projection-support/list-query";

export type CatalogItemListRow = Readonly<{
  catalog_item_id: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  blueprint_id: string | null;
  blueprint: unknown;
  status: string;
  tags: unknown;
  updated_at: string;
}>;

export type CatalogItemDetailRow = Readonly<{
  catalog_item_id: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  description_i18n: unknown;
  description: string;
  blueprint_id: string | null;
  blueprint: unknown;
  status: string;
  field_values: unknown;
  categories: unknown;
  external_product_references: unknown;
  tags: unknown;
  image_urls: unknown;
  updated_at: string;
}>;

export async function listCatalogItems(
  db: PgQueryable,
  params: ListParams & { blueprintId?: string; tag?: string; language?: string } = {},
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

  if (params.language) {
    extraConditions.push(`language_code = $${paramIndex}`);
    extraValues.push(params.language);
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
    `SELECT * FROM catalog_admin_catalog_item_detail_pages WHERE catalog_item_id = $1`,
    [itemId],
  );

  return result.rows[0] ?? null;
}
