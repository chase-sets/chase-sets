import type { ProjectorHandlerMap } from "../../../contracts/event-core/projector";
import type { PgQueryable } from "../../../contracts/event-core/postgres/types";
import { extractIdFromStreamId, loadNameMap } from "../shared/projections/helpers";

const CATEGORY_STREAM_PREFIX = "catalog.category-";
const ITEM_STREAM_PREFIX = "catalog.item-";

type BaseCategoryRow = Readonly<{
  category_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  parent_category_id: string | null;
  display_order: number;
  updated_at: string;
}>;

async function refreshDiscoveryCategory(db: PgQueryable, categoryId: string): Promise<void> {
  const result = await db.query<BaseCategoryRow>(
    `SELECT * FROM catalog_categories WHERE category_id = $1`,
    [categoryId],
  );

  const category = result.rows[0];

  if (!category) {
    await db.query(`DELETE FROM marketplace_categories WHERE category_id = $1`, [categoryId]);
    return;
  }

  const parentCategoryName = category.parent_category_id
    ? (await loadNameMap(db, "catalog_categories", "category_id", "name", [category.parent_category_id])).get(category.parent_category_id)
    : undefined;

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM catalog_items WHERE category_ids @> $1::jsonb AND status = 'active'`,
    [JSON.stringify([categoryId])],
  );

  const itemCount = parseInt(countResult.rows[0].count, 10);

  await db.query(
    `INSERT INTO marketplace_categories (
      category_id,
      key,
      name,
      description,
      status,
      parent_category_id,
      parent_category,
      display_order,
      item_count,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (category_id) DO UPDATE SET
      key = EXCLUDED.key,
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
      category.name,
      category.description,
      category.status,
      category.parent_category_id,
      category.parent_category_id && parentCategoryName
        ? JSON.stringify({ categoryId: category.parent_category_id, name: parentCategoryName })
        : null,
      category.display_order,
      itemCount,
      category.updated_at,
    ],
  );
}

async function refreshCategoriesForItem(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<{ category_ids: unknown }>(
    `SELECT category_ids FROM catalog_items WHERE item_id = $1`,
    [itemId],
  );

  if (result.rows.length === 0) {
    return;
  }

  const categoryIds = Array.isArray(result.rows[0].category_ids)
    ? (result.rows[0].category_ids as string[])
    : [];

  await Promise.all(categoryIds.map((categoryId) => refreshDiscoveryCategory(db, categoryId)));
}

export function buildDiscoveryCategoryProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.category.created": async (event) => {
      await refreshDiscoveryCategory(db, event.data.categoryId as string);
    },
    "catalog.category.revised": async (event) => {
      await refreshDiscoveryCategory(db, extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },
    "catalog.category.published": async (event) => {
      await refreshDiscoveryCategory(db, extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },
    "catalog.category.deprecated": async (event) => {
      await refreshDiscoveryCategory(db, extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },
    "catalog.category.archived": async (event) => {
      await refreshDiscoveryCategory(db, extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },

    "catalog.catalog-item.category-assigned": async (event) => {
      const { categoryId } = event.data as { categoryId: string };
      await refreshDiscoveryCategory(db, categoryId);
    },
    "catalog.catalog-item.category-removed": async (event) => {
      const { categoryId } = event.data as { categoryId: string };
      await refreshDiscoveryCategory(db, categoryId);
    },
    "catalog.catalog-item.published": async (event) => {
      await refreshCategoriesForItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.retired": async (event) => {
      await refreshCategoriesForItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.archived": async (event) => {
      await refreshCategoriesForItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
  };
}

