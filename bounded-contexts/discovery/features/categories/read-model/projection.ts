import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import {
  appendJsonbArrayElement,
  refreshAffectedRows,
  removeJsonbArrayElement,
  transitionStatus,
  updateRow,
  upsertRow,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { coerceLocalizedTextMap, resolveLocalizedTextMap } from "@chase-sets/localization";
import { createMarketplaceSlug, rememberSlugRedirect } from "../../../support/runtime-support/slugs";

const CATEGORY_STREAM_PREFIX = "catalog.category-";
const ITEM_STREAM_PREFIX = "catalog.item-";
const CATEGORY_SOURCE_TABLE = "discovery_category_catalog_categories";
const CATEGORY_ITEM_SOURCE_TABLE = "discovery_category_catalog_items";
const CATEGORIES_TABLE = "discovery_categories";
const CATEGORY_SOURCE_INSERT_COLUMNS = [
  "category_id",
  "key",
  "slug",
  "name",
  "description",
  "status",
  "parent_category_id",
  "display_order",
  "updated_at",
] as const;
const CATEGORY_SOURCE_UPDATE_COLUMNS = [
  "key",
  "slug",
  "name",
  "description",
  "parent_category_id",
  "display_order",
  "updated_at",
] as const;
const CATEGORY_SOURCE_REVISION_COLUMNS = [
  "key",
  "slug",
  "name",
  "description",
  "parent_category_id",
  "display_order",
  "updated_at",
] as const;
const CATEGORY_PROJECTION_COLUMNS = [
  "category_id",
  "key",
  "slug",
  "name",
  "description",
  "status",
  "parent_category_id",
  "parent_category",
  "display_order",
  "item_count",
  "updated_at",
] as const;

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

  await upsertRow(db, {
    table: CATEGORIES_TABLE,
    insertColumns: CATEGORY_PROJECTION_COLUMNS,
    conflictColumns: ["category_id"],
    values: {
      category_id: category.category_id,
      key: category.key,
      slug: category.slug,
      name: category.name,
      description: category.description,
      status: category.status,
      parent_category_id: category.parent_category_id,
      parent_category: parentResult.rows[0]
        ? {
            categoryId: parentResult.rows[0].category_id,
            name: parentResult.rows[0].name,
          }
        : null,
      display_order: category.display_order,
      item_count: Number.parseInt(countResult.rows[0].count, 10),
      updated_at: category.updated_at,
    },
  });
}

async function refreshChildCategories(db: PgQueryable, parentCategoryId: string): Promise<void> {
  await refreshAffectedRows(db, {
    select: { column: "category_id" },
    from: { table: CATEGORY_SOURCE_TABLE },
    where: [{ column: "parent_category_id", value: parentCategoryId }],
    refresh: (categoryId) => refreshDiscoveryCategory(db, categoryId),
  });
}

async function refreshCategoriesForItem(db: PgQueryable, itemId: string): Promise<void> {
  await refreshAffectedRows(db, {
    select: { column: "category_ids" },
    from: { table: CATEGORY_ITEM_SOURCE_TABLE },
    where: [{ column: "catalog_item_id", value: itemId }],
    idsFromRow: (row) => (Array.isArray(row.category_ids) ? row.category_ids.filter(isString) : []),
    refresh: (categoryId) => refreshDiscoveryCategory(db, categoryId),
  });
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

      await upsertRow(db, {
        table: CATEGORY_SOURCE_TABLE,
        insertColumns: CATEGORY_SOURCE_INSERT_COLUMNS,
        conflictColumns: ["category_id"],
        updateColumns: CATEGORY_SOURCE_UPDATE_COLUMNS,
        values: {
          category_id: categoryId,
          key,
          slug,
          name: resolvedName,
          description: resolvedDescription,
          status: "draft",
          parent_category_id: parentCategoryId ?? null,
          display_order: displayOrder,
          updated_at: event.timing.recordedAt,
        },
      });

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

      await updateRow(db, {
        table: CATEGORY_SOURCE_TABLE,
        setColumns: CATEGORY_SOURCE_REVISION_COLUMNS,
        values: {
          key,
          slug,
          name: resolvedName,
          description: resolvedDescription,
          parent_category_id: parentCategoryId ?? null,
          display_order: displayOrder,
          updated_at: event.timing.recordedAt,
        },
        where: {
          columns: ["category_id"],
          values: { category_id: categoryId },
        },
      });
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

      await transitionStatus(db, {
        table: CATEGORY_SOURCE_TABLE,
        idColumn: "category_id",
        id: categoryId,
        status: "active",
        updatedAt: event.timing.recordedAt,
      });

      await refreshDiscoveryCategory(db, categoryId);
      await refreshChildCategories(db, categoryId);
    },
    "catalog.category.deprecated": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX);

      await transitionStatus(db, {
        table: CATEGORY_SOURCE_TABLE,
        idColumn: "category_id",
        id: categoryId,
        status: "deprecated",
        updatedAt: event.timing.recordedAt,
      });

      await refreshDiscoveryCategory(db, categoryId);
      await refreshChildCategories(db, categoryId);
    },
    "catalog.category.archived": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX);

      await transitionStatus(db, {
        table: CATEGORY_SOURCE_TABLE,
        idColumn: "category_id",
        id: categoryId,
        status: "archived",
        updatedAt: event.timing.recordedAt,
      });

      await refreshDiscoveryCategory(db, categoryId);
      await refreshChildCategories(db, categoryId);
    },

    "catalog.catalog-item.created": async (event) => {
      const { itemId } = event.data as { itemId: string };

      await upsertRow(db, {
        table: CATEGORY_ITEM_SOURCE_TABLE,
        insertColumns: ["catalog_item_id", "updated_at"],
        conflictColumns: ["catalog_item_id"],
        values: { catalog_item_id: itemId, updated_at: event.timing.recordedAt },
      });
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await appendJsonbArrayElement(db, {
        table: CATEGORY_ITEM_SOURCE_TABLE,
        key: { column: "catalog_item_id", value: itemId },
        column: "category_ids",
        element: categoryId,
        updatedAt: { value: event.timing.recordedAt },
      });

      await refreshDiscoveryCategory(db, categoryId);
    },
    "catalog.catalog-item.category-removed": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await removeJsonbArrayElement(db, {
        table: CATEGORY_ITEM_SOURCE_TABLE,
        key: { column: "catalog_item_id", value: itemId },
        column: "category_ids",
        match: { kind: "value", value: categoryId },
        updatedAt: { value: event.timing.recordedAt },
      });

      await refreshDiscoveryCategory(db, categoryId);
    },
    "catalog.catalog-item.published": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await transitionStatus(db, {
        table: CATEGORY_ITEM_SOURCE_TABLE,
        idColumn: "catalog_item_id",
        id: itemId,
        status: "active",
        updatedAt: event.timing.recordedAt,
      });

      await refreshCategoriesForItem(db, itemId);
    },
    "catalog.catalog-item.retired": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await transitionStatus(db, {
        table: CATEGORY_ITEM_SOURCE_TABLE,
        idColumn: "catalog_item_id",
        id: itemId,
        status: "archived",
        updatedAt: event.timing.recordedAt,
      });

      await refreshCategoriesForItem(db, itemId);
    },
    "catalog.catalog-item.archived": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await transitionStatus(db, {
        table: CATEGORY_ITEM_SOURCE_TABLE,
        idColumn: "catalog_item_id",
        id: itemId,
        status: "archived",
        updatedAt: event.timing.recordedAt,
      });

      await refreshCategoriesForItem(db, itemId);
    },
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
