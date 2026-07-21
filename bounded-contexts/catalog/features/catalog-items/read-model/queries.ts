import {
  buildPaginationClause,
  escapeLikePattern,
  type ListParams,
  type ListResult,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { normalizeGtin } from "@chase-sets/primitives/gtin";
import type { BulkLifecycleRow } from "../../../support/runtime-support/bulk-lifecycle";
import { catalogIsoUtcTimestamp } from "../../../support/runtime-support/iso-utc-timestamp";

export type CatalogItemGtinLookupRow = Readonly<{
  gtin: string;
  catalog_item_id: string;
  product_form: string | null;
  title: string;
  subtitle: string | null;
  status: string;
  blueprint_id: string | null;
  updated_at: string;
}>;

export type CatalogItemListRow = Readonly<{
  catalog_item_id: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  display_template_key: string | null;
  display_identity_hash: string | null;
  display_identity_resolved_at: string | null;
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
  display_template_key: string | null;
  display_identity_hash: string | null;
  display_identity_resolved_at: string | null;
  description_i18n: unknown;
  description: string;
  blueprint_id: string | null;
  blueprint: unknown;
  status: string;
  field_values: unknown;
  categories: unknown;
  external_catalog_item_references: unknown;
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

export type BulkEditCatalogItemRow = Readonly<{
  catalog_item_id: string;
  title: string;
  blueprint_id: string | null;
  status: string;
  category_ids: unknown;
  tags: unknown;
}>;

export type CatalogItemListParams = ListParams & {
  blueprintId?: string;
  tag?: string;
  language?: string;
  source?: string;
  blueprintState?: string;
  hasImages?: string;
  hasSourceReferences?: string;
  missingRequiredFields?: string;
};

export async function listCatalogItems(
  db: PgQueryable,
  params: CatalogItemListParams = {},
): Promise<ListResult<CatalogItemListRow>> {
  const { where, values } = buildCatalogItemConditions(params);
  const pagination = buildPaginationClause(params, values.length + 1);

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM catalog_admin_catalog_item_list_pages AS item
     ${where}`,
    values,
  );

  const listResult = await db.query<CatalogItemListRow>(
    `SELECT item.*,
       ${catalogIsoUtcTimestamp("item.display_identity_resolved_at", "display_identity_resolved_at")},
       ${catalogIsoUtcTimestamp("item.updated_at", "updated_at")},
       COALESCE(source_refs.source_providers, '[]'::jsonb) AS source_providers
     FROM catalog_admin_catalog_item_list_pages AS item
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(DISTINCT reference.provider_key ORDER BY reference.provider_key) AS source_providers
       FROM (
         SELECT provider_key FROM catalog_external_product_references WHERE catalog_item_id = item.catalog_item_id
         UNION
         SELECT provider_key FROM catalog_external_catalog_item_references WHERE catalog_item_id = item.catalog_item_id
       ) AS reference
     ) AS source_refs ON true
     ${where}
     ORDER BY item.title ASC
     ${pagination.sql}`,
    [...values, ...pagination.values],
  );

  return {
    items: listResult.rows,
    total: Number.parseInt(countResult.rows[0].count, 10),
  };
}

export async function getCatalogItemDetail(db: PgQueryable, itemId: string) {
  const result = await db.query<CatalogItemDetailRow>(
    `SELECT *, ${catalogIsoUtcTimestamp("display_identity_resolved_at")}, ${catalogIsoUtcTimestamp("updated_at")} FROM catalog_admin_catalog_item_detail_pages WHERE catalog_item_id = $1`,
    [itemId],
  );

  return result.rows[0] ?? null;
}

/**
 * Resolves a scanned barcode to its Catalog Item, normalizing the input to
 * canonical GTIN-14 form first (see `@chase-sets/primitives/gtin`). Used by
 * inventory import resolution and, eventually, a camera-scan seller intake
 * flow. Returns `null` for both "not a valid GTIN" and "no item linked".
 */
export async function getCatalogItemByGtin(db: PgQueryable, gtin: string): Promise<CatalogItemGtinLookupRow | null> {
  const normalized = normalizeGtin(gtin);
  if (!normalized) {
    return null;
  }

  const result = await db.query<CatalogItemGtinLookupRow>(
    `SELECT
       link.gtin,
       link.catalog_item_id,
       link.product_form,
       item.title,
       item.subtitle,
       item.status,
       item.blueprint_id,
       ${catalogIsoUtcTimestamp("link.updated_at", "updated_at")}
     FROM catalog_item_gtins AS link
     JOIN catalog_items AS item ON item.catalog_item_id = link.catalog_item_id
     WHERE link.gtin = $1`,
    [normalized],
  );

  return result.rows[0] ?? null;
}

export async function listCatalogItemIdsForBulkPublishFilter(
  db: PgQueryable,
  params: CatalogItemListParams = {},
): Promise<string[]> {
  const { where, values } = buildCatalogItemConditions({
    ...params,
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

export async function listCatalogItemIds(db: PgQueryable, params: CatalogItemListParams = {}): Promise<string[]> {
  const { where, values } = buildCatalogItemConditions(params);
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT item.catalog_item_id
     FROM catalog_admin_catalog_item_list_pages AS item
     ${where}
     ORDER BY item.title ASC`,
    values,
  );

  return result.rows.map((row) => row.catalog_item_id);
}

export async function listCatalogItemBulkRows(
  db: PgQueryable,
  itemIds: readonly string[],
): Promise<BulkLifecycleRow[]> {
  if (itemIds.length === 0) {
    return [];
  }

  const result = await db.query<CatalogItemListRow>(
    `SELECT item.*,
       ${catalogIsoUtcTimestamp("item.display_identity_resolved_at", "display_identity_resolved_at")},
       ${catalogIsoUtcTimestamp("item.updated_at", "updated_at")},
       COALESCE(source_refs.source_providers, '[]'::jsonb) AS source_providers
     FROM catalog_admin_catalog_item_list_pages AS item
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(DISTINCT reference.provider_key ORDER BY reference.provider_key) AS source_providers
       FROM (
         SELECT provider_key FROM catalog_external_product_references WHERE catalog_item_id = item.catalog_item_id
         UNION
         SELECT provider_key FROM catalog_external_catalog_item_references WHERE catalog_item_id = item.catalog_item_id
       ) AS reference
     ) AS source_refs ON true
     WHERE item.catalog_item_id = ANY($1::text[])`,
    [[...itemIds]],
  );

  return result.rows.map((row) => ({
    id: row.catalog_item_id,
    label: row.title,
    status: row.status,
  }));
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
       ${catalogIsoUtcTimestamp("item.updated_at", "updated_at")}
     FROM catalog_items AS item
     LEFT JOIN catalog_blueprints AS blueprint
       ON blueprint.blueprint_id = item.blueprint_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(DISTINCT reference.provider_key ORDER BY reference.provider_key) AS source_providers
       FROM (
         SELECT provider_key FROM catalog_external_product_references WHERE catalog_item_id = item.catalog_item_id
         UNION
         SELECT provider_key FROM catalog_external_catalog_item_references WHERE catalog_item_id = item.catalog_item_id
       ) AS reference
     ) AS source_refs ON true
     WHERE item.catalog_item_id = ANY($1::text[])
     ORDER BY array_position($1::text[], item.catalog_item_id)`,
    [[...itemIds]],
  );

  return result.rows;
}

export async function listCatalogItemsForBulkEdit(
  db: PgQueryable,
  itemIds: readonly string[],
): Promise<BulkEditCatalogItemRow[]> {
  if (itemIds.length === 0) {
    return [];
  }

  const result = await db.query<BulkEditCatalogItemRow>(
    `SELECT catalog_item_id,
       title,
       blueprint_id,
       status,
       category_ids,
       tags
     FROM catalog_items
     WHERE catalog_item_id = ANY($1::text[])
     ORDER BY array_position($1::text[], catalog_item_id)`,
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

  if (params.blueprintState === "missing") {
    conditions.push("item.blueprint_id IS NULL");
  } else if (params.blueprintState === "assigned") {
    conditions.push("item.blueprint_id IS NOT NULL");
  }

  if (params.source) {
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM catalog_external_product_references AS source_filter
        WHERE source_filter.catalog_item_id = item.catalog_item_id
          AND source_filter.provider_key = $${paramIndex}
        UNION
        SELECT 1
        FROM catalog_external_catalog_item_references AS source_filter
        WHERE source_filter.catalog_item_id = item.catalog_item_id
          AND source_filter.provider_key = $${paramIndex}
      )`,
    );
    values.push(params.source);
    paramIndex++;
  }

  if (params.hasSourceReferences === "true") {
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM catalog_external_product_references AS source_presence
        WHERE source_presence.catalog_item_id = item.catalog_item_id
        UNION
        SELECT 1
        FROM catalog_external_catalog_item_references AS source_presence
        WHERE source_presence.catalog_item_id = item.catalog_item_id
      )`,
    );
  } else if (params.hasSourceReferences === "false") {
    conditions.push(
      `NOT EXISTS (
        SELECT 1
        FROM catalog_external_product_references AS source_presence
        WHERE source_presence.catalog_item_id = item.catalog_item_id
        UNION
        SELECT 1
        FROM catalog_external_catalog_item_references AS source_presence
        WHERE source_presence.catalog_item_id = item.catalog_item_id
      )`,
    );
  }

  if (params.hasImages === "true") {
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM catalog_admin_catalog_item_detail_pages AS detail
        WHERE detail.catalog_item_id = item.catalog_item_id
          AND jsonb_array_length(detail.image_urls) > 0
      )`,
    );
  } else if (params.hasImages === "false") {
    conditions.push(
      `NOT EXISTS (
        SELECT 1
        FROM catalog_admin_catalog_item_detail_pages AS detail
        WHERE detail.catalog_item_id = item.catalog_item_id
          AND jsonb_array_length(detail.image_urls) > 0
      )`,
    );
  }

  if (params.missingRequiredFields === "true") {
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM catalog_admin_catalog_item_detail_pages AS detail
        JOIN catalog_blueprints AS blueprint ON blueprint.blueprint_id = detail.blueprint_id
        WHERE detail.catalog_item_id = item.catalog_item_id
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(blueprint.field_rules) AS rule
            WHERE (rule->>'required')::boolean IS TRUE
              AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(detail.field_values) AS field_value
                WHERE field_value->>'fieldId' = rule->>'fieldId'
              )
          )
      )`,
    );
  } else if (params.missingRequiredFields === "false") {
    conditions.push(
      `NOT EXISTS (
        SELECT 1
        FROM catalog_admin_catalog_item_detail_pages AS detail
        JOIN catalog_blueprints AS blueprint ON blueprint.blueprint_id = detail.blueprint_id
        WHERE detail.catalog_item_id = item.catalog_item_id
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(blueprint.field_rules) AS rule
            WHERE (rule->>'required')::boolean IS TRUE
              AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(detail.field_values) AS field_value
                WHERE field_value->>'fieldId' = rule->>'fieldId'
              )
          )
      )`,
    );
  }

  if (params.status) {
    conditions.push(`item.status = $${paramIndex}`);
    values.push(params.status);
    paramIndex++;
  }

  if (params.search) {
    conditions.push(
      `(item.title ILIKE $${paramIndex} ESCAPE '\\'
        OR item.subtitle ILIKE $${paramIndex} ESCAPE '\\'
        OR item.tags::text ILIKE $${paramIndex} ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM catalog_external_product_references AS source_search
          WHERE source_search.catalog_item_id = item.catalog_item_id
            AND (source_search.provider_key ILIKE $${paramIndex} ESCAPE '\\' OR source_search.external_key ILIKE $${paramIndex} ESCAPE '\\')
          UNION
          SELECT 1
          FROM catalog_external_catalog_item_references AS source_search
          WHERE source_search.catalog_item_id = item.catalog_item_id
            AND (source_search.provider_key ILIKE $${paramIndex} ESCAPE '\\' OR source_search.external_key ILIKE $${paramIndex} ESCAPE '\\')
        ))`,
    );
    values.push(`%${escapeLikePattern(params.search)}%`);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}
