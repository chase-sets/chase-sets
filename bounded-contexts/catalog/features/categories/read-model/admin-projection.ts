import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import { loadNameMap } from "../../../support/projection-support/read-model-support";

const CATEGORY_STREAM_PREFIX = "catalog.category-";

type BaseCategoryRow = Readonly<{
  category_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  status: string;
  parent_category_id: string | null;
  display_order: number;
  updated_at: string;
}>;

async function refreshCategoryPageRow(
  db: PgQueryable,
  tableName: "catalog_admin_category_list_pages" | "catalog_admin_category_detail_pages",
  category: BaseCategoryRow,
  parentCategoryName: string | undefined,
): Promise<void> {
  await db.query(
    `INSERT INTO ${tableName} (
      category_id,
      key,
      name_i18n,
      name,
      description_i18n,
      description,
      status,
      parent_category_id,
      parent_category,
      display_order,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (category_id) DO UPDATE SET
      key = EXCLUDED.key,
      name_i18n = EXCLUDED.name_i18n,
      name = EXCLUDED.name,
      description_i18n = EXCLUDED.description_i18n,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      parent_category_id = EXCLUDED.parent_category_id,
      parent_category = EXCLUDED.parent_category,
      display_order = EXCLUDED.display_order,
      updated_at = EXCLUDED.updated_at`,
    [
      category.category_id,
      category.key,
      JSON.stringify(category.name_i18n),
      category.name,
      JSON.stringify(category.description_i18n),
      category.description,
      category.status,
      category.parent_category_id,
      category.parent_category_id && parentCategoryName
        ? JSON.stringify({ categoryId: category.parent_category_id, name: parentCategoryName })
        : null,
      category.display_order,
      category.updated_at,
    ],
  );
}

export async function refreshCatalogAdminCategoryPages(db: PgQueryable, categoryId: string): Promise<void> {
  const result = await db.query<BaseCategoryRow>(`SELECT * FROM catalog_categories WHERE category_id = $1`, [
    categoryId,
  ]);
  const category = result.rows[0];
  if (!category) {
    await db.query(`DELETE FROM catalog_admin_category_list_pages WHERE category_id = $1`, [categoryId]);
    await db.query(`DELETE FROM catalog_admin_category_detail_pages WHERE category_id = $1`, [categoryId]);
    return;
  }

  const parentCategoryName = category.parent_category_id
    ? (await loadNameMap(db, "catalog_categories", "category_id", "name", [category.parent_category_id])).get(
        category.parent_category_id,
      )
    : undefined;
  await refreshCategoryPageRow(db, "catalog_admin_category_list_pages", category, parentCategoryName);
  await refreshCategoryPageRow(db, "catalog_admin_category_detail_pages", category, parentCategoryName);
}

async function findCategoryChildren(db: PgQueryable, categoryId: string): Promise<string[]> {
  const result = await db.query<{ category_id: string }>(
    `SELECT category_id FROM catalog_categories WHERE parent_category_id = $1`,
    [categoryId],
  );

  return result.rows.map((row) => row.category_id);
}

export function buildCatalogAdminCategoryProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  async function refreshCategoryAndChildren(categoryId: string) {
    await refreshCatalogAdminCategoryPages(db, categoryId);
    for (const childId of await findCategoryChildren(db, categoryId)) {
      await refreshCatalogAdminCategoryPages(db, childId);
    }
  }

  return {
    "catalog.category.created": async (event) => {
      await refreshCatalogAdminCategoryPages(db, event.data.categoryId as string);
    },
    "catalog.category.revised": async (event) => {
      await refreshCategoryAndChildren(extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },
    "catalog.category.published": async (event) => {
      await refreshCategoryAndChildren(extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },
    "catalog.category.deprecated": async (event) => {
      await refreshCategoryAndChildren(extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },
    "catalog.category.archived": async (event) => {
      await refreshCategoryAndChildren(extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },
  };
}
