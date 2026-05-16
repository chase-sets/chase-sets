import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { type ListParams, type ListResult } from "../../../support/projection-support/list-query";

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
  source_providers: unknown;
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
  product_asset_sets: unknown;
  image_fallback: unknown;
  updated_at: string;
}>;

export type BulkPublishCatalogItemRow = Readonly<{
  catalog_item_id: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  blueprint_name: string | null;
  blueprint_status: string | null;
  blueprint_field_rules: unknown;
  status: string;
  field_values: unknown;
  source_providers: unknown;
  updated_at: string;
}>;

export type CatalogItemListParams = ListParams & {
  blueprintId?: string;
  tag?: string;
  language?: string;
  source?: string;
};

export async function listCatalogItems(
  db: PgQueryable,
  params: CatalogItemListParams = {},
): Promise<ListResult<CatalogItemListRow>> {
  const { where, values } = buildCatalogItemConditions(params);
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM catalog_admin_catalog_item_list_pages AS item
     ${where}`,
    values,
  );

  const listResult = await db.query<CatalogItemListRow>(
    `SELECT item.*,
       COALESCE(source_refs.source_providers, '[]'::jsonb) AS source_providers
     FROM catalog_admin_catalog_item_list_pages AS item
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(DISTINCT reference.provider_key ORDER BY reference.provider_key) AS source_providers
       FROM catalog_external_product_references AS reference
       WHERE reference.catalog_item_id = item.catalog_item_id
     ) AS source_refs ON true
     ${where}
     ORDER BY item.title ASC
     LIMIT ${limit} OFFSET ${offset}`,
    values,
  );

  return {
    items: listResult.rows,
    total: Number.parseInt(countResult.rows[0].count, 10),
  };
}

export async function getCatalogItemDetail(db: PgQueryable, itemId: string) {
  const result = await db.query<CatalogItemDetailRow>(
    `SELECT * FROM catalog_admin_catalog_item_detail_pages WHERE catalog_item_id = $1`,
    [itemId],
  );

  return result.rows[0] ?? null;
}

export async function listCatalogItemIdsForBulkPublishFilter(
  db: PgQueryable,
  params: CatalogItemListParams = {},
): Promise<string[]> {
  const { where, values } = buildCatalogItemConditions({
    ...params,
    status: "draft",
    limit: undefined,
    offset: undefined,
  });

  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT item.catalog_item_id
     FROM catalog_admin_catalog_item_list_pages AS item
     ${where}
     ORDER BY item.title ASC`,
    values,
  );

  return result.rows.map((row) => row.catalog_item_id);
}

export async function listCatalogItemsForBulkPublish(
  db: PgQueryable,
  itemIds: readonly string[],
): Promise<BulkPublishCatalogItemRow[]> {
  if (itemIds.length === 0) {
    return [];
  }

  const result = await db.query<BulkPublishCatalogItemRow>(
    `SELECT item.catalog_item_id,
       item.title,
       item.subtitle,
       item.blueprint_id,
       blueprint.name AS blueprint_name,
       blueprint.status AS blueprint_status,
       blueprint.field_rules AS blueprint_field_rules,
       item.status,
       item.field_values,
       COALESCE(source_refs.source_providers, '[]'::jsonb) AS source_providers,
       item.updated_at
     FROM catalog_items AS item
     LEFT JOIN catalog_blueprints AS blueprint
       ON blueprint.blueprint_id = item.blueprint_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(DISTINCT reference.provider_key ORDER BY reference.provider_key) AS source_providers
       FROM catalog_external_product_references AS reference
       WHERE reference.catalog_item_id = item.catalog_item_id
     ) AS source_refs ON true
     WHERE item.catalog_item_id = ANY($1::text[])
     ORDER BY array_position($1::text[], item.catalog_item_id)`,
    [[...itemIds]],
  );

  return result.rows;
}

function buildCatalogItemConditions(params: CatalogItemListParams): { where: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.blueprintId) {
    conditions.push(`item.blueprint_id = $${paramIndex}`);
    values.push(params.blueprintId);
    paramIndex++;
  }

  if (params.tag) {
    conditions.push(`item.tags @> $${paramIndex}::jsonb`);
    values.push(JSON.stringify([params.tag]));
    paramIndex++;
  }

  if (params.language) {
    conditions.push(`item.language_code = $${paramIndex}`);
    values.push(params.language);
    paramIndex++;
  }

  if (params.source) {
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM catalog_external_product_references AS source_filter
        WHERE source_filter.catalog_item_id = item.catalog_item_id
          AND source_filter.provider_key = $${paramIndex}
      )`,
    );
    values.push(params.source);
    paramIndex++;
  }

  if (params.status) {
    conditions.push(`item.status = $${paramIndex}`);
    values.push(params.status);
    paramIndex++;
  }

  if (params.search) {
    conditions.push(`(item.title ILIKE $${paramIndex} OR item.subtitle ILIKE $${paramIndex})`);
    values.push(`%${params.search}%`);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}
