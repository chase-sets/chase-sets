import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { coerceLocalizedTextMap, resolveLocalizedTextMap } from "@chase-sets/localization";
import { createMarketplaceSlug, rememberSlugRedirect } from "../../../support/runtime-support/slugs";

const CATEGORY_STREAM_PREFIX = "catalog.category-";
const ITEM_STREAM_PREFIX = "catalog.item-";

type CategorySourceRow = Readonly<{
  category_id: string;
  key: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  parent_category_id: string | null;
  display_order: number;
  updated_at: string;
}>;

function extractIdFromStreamId(streamId: string, prefix: string): string {
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Stream ID "${streamId}" does not start with prefix "${prefix}".`);
  }

  return streamId.slice(prefix.length);
}

async function refreshDiscoveryCategory(db: PgQueryable, categoryId: string): Promise<void> {
  const result = await db.query<CategorySourceRow>(
    `SELECT * FROM discovery_category_catalog_categories WHERE category_id = $1`,
    [categoryId],
  );

  const category = result.rows[0];

  if (!category) {
    await db.query(`DELETE FROM discovery_categories WHERE category_id = $1`, [categoryId]);
    return;
  }

  const parentResult = category.parent_category_id
    ? await db.query<{ category_id: string; name: string }>(
        `SELECT category_id, name
         FROM discovery_category_catalog_categories
         WHERE category_id = $1`,
        [category.parent_category_id],
      )
    : { rows: [] as Array<{ category_id: string; name: string }> };

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM discovery_category_catalog_items
     WHERE category_ids @> $1::jsonb
       AND status = 'active'`,
    [JSON.stringify([categoryId])],
  );

  await db.query(
    `INSERT INTO discovery_categories (
      category_id,
      key,
      slug,
      name,
      description,
      status,
      parent_category_id,
      parent_category,
      display_order,
      item_count,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (category_id) DO UPDATE SET
      key = EXCLUDED.key,
      slug = EXCLUDED.slug,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      parent_category_id = EXCLUDED.parent_category_id,
      parent_category = EXCLUDED.parent_category,
      display_order = EXCLUDED.display_order,
      item_count = EXCLUDED.item_count,
      updated_at = EXCLUDED.updated_at`,
    [
      category.category_id,
      category.key,
      category.slug,
      category.name,
      category.description,
      category.status,
      category.parent_category_id,
      parentResult.rows[0]
        ? JSON.stringify({
            categoryId: parentResult.rows[0].category_id,
            name: parentResult.rows[0].name,
          })
        : null,
      category.display_order,
      Number.parseInt(countResult.rows[0].count, 10),
      category.updated_at,
    ],
  );
}

async function refreshChildCategories(db: PgQueryable, parentCategoryId: string): Promise<void> {
  const result = await db.query<{ category_id: string }>(
    `SELECT category_id
     FROM discovery_category_catalog_categories
     WHERE parent_category_id = $1`,
    [parentCategoryId],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoveryCategory(db, row.category_id)));
}

async function refreshCategoriesForItem(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<{ category_ids: unknown }>(
    `SELECT category_ids FROM discovery_category_catalog_items WHERE catalog_item_id = $1`,
    [itemId],
  );

  if (result.rows.length === 0) {
    return;
  }

  const categoryIds = Array.isArray(result.rows[0].category_ids) ? (result.rows[0].category_ids as string[]) : [];

  await Promise.all(categoryIds.map((categoryId) => refreshDiscoveryCategory(db, categoryId)));
}

export function buildDiscoveryCategoryProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.category.created": async (event) => {
      const { categoryId, key, name, description, parentCategoryId, displayOrder } = event.data as {
        categoryId: string;
        key: string;
        name: unknown;
        description: unknown;
        parentCategoryId?: string;
        displayOrder: number;
      };
      const resolvedName = resolveLocalizedTextMap(coerceLocalizedTextMap(name));
      const resolvedDescription = resolveLocalizedTextMap(coerceLocalizedTextMap(description));
      const slug = createMarketplaceSlug([resolvedName], categoryId);

      await db.query(
        `INSERT INTO discovery_category_catalog_categories (
          category_id,
          key,
          slug,
          name,
          description,
          status,
          parent_category_id,
          display_order,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8)
        ON CONFLICT (category_id) DO UPDATE SET
          key = EXCLUDED.key,
          slug = EXCLUDED.slug,
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          parent_category_id = EXCLUDED.parent_category_id,
          display_order = EXCLUDED.display_order,
          updated_at = EXCLUDED.updated_at`,
        [
          categoryId,
          key,
          slug,
          resolvedName,
          resolvedDescription,
          parentCategoryId ?? null,
          displayOrder,
          event.timing.recordedAt,
        ],
      );

      await refreshDiscoveryCategory(db, categoryId);
    },
    "catalog.category.revised": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX);
      const { key, name, description, parentCategoryId, displayOrder } = event.data as {
        key: string;
        name: unknown;
        description: unknown;
        parentCategoryId?: string;
        displayOrder: number;
      };
      const resolvedName = resolveLocalizedTextMap(coerceLocalizedTextMap(name));
      const resolvedDescription = resolveLocalizedTextMap(coerceLocalizedTextMap(description));
      const slug = createMarketplaceSlug([resolvedName], categoryId);
      const current = await db.query<{ slug: string | null }>(
        `SELECT slug FROM discovery_category_catalog_categories WHERE category_id = $1`,
        [categoryId],
      );

      await db.query(
        `UPDATE discovery_category_catalog_categories
         SET key = $2,
             slug = $3,
             name = $4,
             description = $5,
             parent_category_id = $6,
             display_order = $7,
             updated_at = $8
         WHERE category_id = $1`,
        [
          categoryId,
          key,
          slug,
          resolvedName,
          resolvedDescription,
          parentCategoryId ?? null,
          displayOrder,
          event.timing.recordedAt,
        ],
      );
      await rememberSlugRedirect(db, {
        entityKind: "category",
        entityId: categoryId,
        previousSlug: current.rows[0]?.slug,
        nextSlug: slug,
        updatedAt: event.timing.recordedAt,
      });

      await refreshDiscoveryCategory(db, categoryId);
      await refreshChildCategories(db, categoryId);
    },
    "catalog.category.published": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_category_catalog_categories
         SET status = 'active', updated_at = $2
         WHERE category_id = $1`,
        [categoryId, event.timing.recordedAt],
      );

      await refreshDiscoveryCategory(db, categoryId);
      await refreshChildCategories(db, categoryId);
    },
    "catalog.category.deprecated": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_category_catalog_categories
         SET status = 'deprecated', updated_at = $2
         WHERE category_id = $1`,
        [categoryId, event.timing.recordedAt],
      );

      await refreshDiscoveryCategory(db, categoryId);
      await refreshChildCategories(db, categoryId);
    },
    "catalog.category.archived": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_category_catalog_categories
         SET status = 'archived', updated_at = $2
         WHERE category_id = $1`,
        [categoryId, event.timing.recordedAt],
      );

      await refreshDiscoveryCategory(db, categoryId);
      await refreshChildCategories(db, categoryId);
    },

    "catalog.catalog-item.created": async (event) => {
      const { itemId } = event.data as { itemId: string };

      await db.query(
        `INSERT INTO discovery_category_catalog_items (catalog_item_id, updated_at)
         VALUES ($1, $2)
         ON CONFLICT (catalog_item_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        [itemId, event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await db.query(
        `UPDATE discovery_category_catalog_items
         SET category_ids = category_ids || $2::jsonb,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify([categoryId]), event.timing.recordedAt],
      );

      await refreshDiscoveryCategory(db, categoryId);
    },
    "catalog.catalog-item.category-removed": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await db.query(
        `UPDATE discovery_category_catalog_items
         SET category_ids = (
           SELECT COALESCE(jsonb_agg(category_id), '[]'::jsonb)
           FROM jsonb_array_elements(category_ids) AS category_id
           WHERE category_id #>> '{}' != $2
         ),
         updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, categoryId, event.timing.recordedAt],
      );

      await refreshDiscoveryCategory(db, categoryId);
    },
    "catalog.catalog-item.published": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_category_catalog_items
         SET status = 'active', updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshCategoriesForItem(db, itemId);
    },
    "catalog.catalog-item.retired": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_category_catalog_items
         SET status = 'archived', updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshCategoriesForItem(db, itemId);
    },
    "catalog.catalog-item.archived": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_category_catalog_items
         SET status = 'archived', updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshCategoriesForItem(db, itemId);
    },
  };
}
