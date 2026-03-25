import type { ProjectorHandlerMap } from "../../../../contracts/event-core/projector";
import type { PgQueryable } from "../../../../contracts/event-core/postgres/types";
import { extractIdFromStreamId } from "../support/projections/extract-id-from-stream";
import {
  asArray,
  asStringArray,
  type FieldValue,
  loadNameMap,
} from "../support/projections/read-model-support";

const ITEM_STREAM_PREFIX = "catalog.item-";
const BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
const CATEGORY_STREAM_PREFIX = "catalog.category-";
const FIELD_STREAM_PREFIX = "catalog.field-";

type BaseCatalogItemRow = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint_id: string | null;
  status: string;
  field_values: unknown;
  category_ids: unknown;
  tags: unknown;
  image_urls: unknown;
  updated_at: string;
}>;

async function refreshCatalogAdminCatalogItemListPage(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<BaseCatalogItemRow>(
    `SELECT * FROM catalog_items WHERE item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM catalog_admin_catalog_item_list_pages WHERE item_id = $1`, [itemId]);
    return;
  }

  const blueprintName = item.blueprint_id
    ? (await loadNameMap(db, "catalog_blueprints", "blueprint_id", "name", [item.blueprint_id])).get(item.blueprint_id)
    : undefined;

  await db.query(
    `INSERT INTO catalog_admin_catalog_item_list_pages (
      item_id,
      title,
      subtitle,
      blueprint_id,
      blueprint,
      status,
      tags,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (item_id) DO UPDATE SET
      title = EXCLUDED.title,
      subtitle = EXCLUDED.subtitle,
      blueprint_id = EXCLUDED.blueprint_id,
      blueprint = EXCLUDED.blueprint,
      status = EXCLUDED.status,
      tags = EXCLUDED.tags,
      updated_at = EXCLUDED.updated_at`,
    [
      item.item_id,
      item.title,
      item.subtitle,
      item.blueprint_id,
      item.blueprint_id && blueprintName
        ? JSON.stringify({ blueprintId: item.blueprint_id, name: blueprintName })
        : null,
      item.status,
      JSON.stringify(asStringArray(item.tags)),
      item.updated_at,
    ],
  );
}

async function refreshCatalogAdminCatalogItemDetailPage(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<BaseCatalogItemRow>(
    `SELECT * FROM catalog_items WHERE item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM catalog_admin_catalog_item_detail_pages WHERE item_id = $1`, [itemId]);
    return;
  }

  const fieldValues = asArray<FieldValue>(item.field_values);
  const categoryIds = asStringArray(item.category_ids);
  const fieldIds = fieldValues.map((entry) => entry.fieldId);

  const [fieldNames, categoryNames, blueprintNames] = await Promise.all([
    loadNameMap(db, "catalog_fields", "field_id", "name", fieldIds),
    loadNameMap(db, "catalog_categories", "category_id", "name", categoryIds),
    item.blueprint_id
      ? loadNameMap(db, "catalog_blueprints", "blueprint_id", "name", [item.blueprint_id])
      : Promise.resolve(new Map<string, string>()),
  ]);

  const namedFieldValues = fieldValues.map((entry) => ({
    fieldId: entry.fieldId,
    fieldName: fieldNames.get(entry.fieldId) ?? entry.fieldId,
    value: entry.value,
  }));

  const namedCategories = categoryIds.map((categoryId) => ({
    categoryId,
    name: categoryNames.get(categoryId) ?? categoryId,
  }));

  await db.query(
    `INSERT INTO catalog_admin_catalog_item_detail_pages (
      item_id,
      title,
      subtitle,
      description,
      blueprint_id,
      blueprint,
      status,
      field_values,
      categories,
      tags,
      image_urls,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (item_id) DO UPDATE SET
      title = EXCLUDED.title,
      subtitle = EXCLUDED.subtitle,
      description = EXCLUDED.description,
      blueprint_id = EXCLUDED.blueprint_id,
      blueprint = EXCLUDED.blueprint,
      status = EXCLUDED.status,
      field_values = EXCLUDED.field_values,
      categories = EXCLUDED.categories,
      tags = EXCLUDED.tags,
      image_urls = EXCLUDED.image_urls,
      updated_at = EXCLUDED.updated_at`,
    [
      item.item_id,
      item.title,
      item.subtitle,
      item.description,
      item.blueprint_id,
      item.blueprint_id
        ? JSON.stringify({
            blueprintId: item.blueprint_id,
            name: blueprintNames.get(item.blueprint_id) ?? item.blueprint_id,
          })
        : null,
      item.status,
      JSON.stringify(namedFieldValues),
      JSON.stringify(namedCategories),
      JSON.stringify(asStringArray(item.tags)),
      JSON.stringify(asStringArray(item.image_urls)),
      item.updated_at,
    ],
  );
}

export async function refreshCatalogAdminCatalogItemPages(
  db: PgQueryable,
  itemId: string,
): Promise<void> {
  await Promise.all([
    refreshCatalogAdminCatalogItemListPage(db, itemId),
    refreshCatalogAdminCatalogItemDetailPage(db, itemId),
  ]);
}

async function findCatalogItemIdsByField(db: PgQueryable, fieldId: string): Promise<string[]> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items WHERE field_values @> $1::jsonb`,
    [JSON.stringify([{ fieldId }])],
  );

  return result.rows.map((row) => row.item_id);
}

async function findCatalogItemIdsByBlueprint(db: PgQueryable, blueprintId: string): Promise<string[]> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items WHERE blueprint_id = $1`,
    [blueprintId],
  );

  return result.rows.map((row) => row.item_id);
}

async function findCatalogItemIdsByCategory(db: PgQueryable, categoryId: string): Promise<string[]> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items WHERE category_ids @> $1::jsonb`,
    [JSON.stringify([categoryId])],
  );

  return result.rows.map((row) => row.item_id);
}

async function refreshCatalogItemIds(db: PgQueryable, itemIds: readonly string[]): Promise<void> {
  await Promise.all(itemIds.map((itemId) => refreshCatalogAdminCatalogItemPages(db, itemId)));
}

export function buildCatalogAdminCatalogItemProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  async function refreshFieldDependents(fieldId: string) {
    await refreshCatalogItemIds(db, await findCatalogItemIdsByField(db, fieldId));
  }

  async function refreshBlueprintDependents(blueprintId: string) {
    await refreshCatalogItemIds(db, await findCatalogItemIdsByBlueprint(db, blueprintId));
  }

  async function refreshCategoryDependents(categoryId: string) {
    await refreshCatalogItemIds(db, await findCatalogItemIdsByCategory(db, categoryId));
  }

  return {
    "catalog.catalog-item.created": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, event.data.itemId as string);
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.field-value-set": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.field-value-cleared": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.category-removed": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.published": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.tags-set": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.image-urls-set": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.retired": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.archived": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },

    "catalog.blueprint.revised": async (event) => {
      await refreshBlueprintDependents(extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.published": async (event) => {
      await refreshBlueprintDependents(extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.deprecated": async (event) => {
      await refreshBlueprintDependents(extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.archived": async (event) => {
      await refreshBlueprintDependents(extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },

    "catalog.category.created": async (event) => {
      await refreshCategoryDependents(event.data.categoryId as string);
    },
    "catalog.category.revised": async (event) => {
      await refreshCategoryDependents(extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },
    "catalog.category.published": async (event) => {
      await refreshCategoryDependents(extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },
    "catalog.category.deprecated": async (event) => {
      await refreshCategoryDependents(extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },
    "catalog.category.archived": async (event) => {
      await refreshCategoryDependents(extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },

    "catalog.field.created": async (event) => {
      await refreshFieldDependents(event.data.fieldId as string);
    },
    "catalog.field.configured": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX));
    },
    "catalog.field.activated": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX));
    },
    "catalog.field.deprecated": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX));
    },
    "catalog.field.archived": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX));
    },
  };
}

