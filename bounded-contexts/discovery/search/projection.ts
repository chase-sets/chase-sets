import type { ProjectorHandlerMap } from "../../../contracts/event-core/projector";
import type { PgQueryable } from "../../../contracts/event-core/postgres/types";
import { asArray, asStringArray, extractIdFromStreamId, loadNameMap } from "../shared/projections/helpers";
import { normalizeSimpleSearchText } from "./normalization";

const ITEM_STREAM_PREFIX = "catalog.item-";
const BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
const CATEGORY_STREAM_PREFIX = "catalog.category-";

type FieldValue = Readonly<{ fieldId: string; value: unknown }>;

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

export async function refreshDiscoverySearchItem(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<BaseCatalogItemRow>(
    `SELECT * FROM catalog_items WHERE item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM marketplace_search_items WHERE item_id = $1`, [itemId]);
    return;
  }

  const categoryIds = asStringArray(item.category_ids);
  const tags = asStringArray(item.tags);
  const imageUrls = asStringArray(item.image_urls);
  const fieldValues = asArray<FieldValue>(item.field_values);

  const [blueprintNames, categoryNames] = await Promise.all([
    item.blueprint_id
      ? loadNameMap(db, "catalog_blueprints", "blueprint_id", "name", [item.blueprint_id])
      : Promise.resolve(new Map<string, string>()),
    loadNameMap(db, "catalog_categories", "category_id", "name", categoryIds),
  ]);

  const blueprintName = item.blueprint_id ? blueprintNames.get(item.blueprint_id) ?? null : null;
  const categoryNameList = categoryIds.map((id) => categoryNames.get(id) ?? id);

  const fieldValuesText = fieldValues
    .map((fv) => (typeof fv.value === "string" ? fv.value : String(fv.value ?? "")))
    .join(" ");

  const searchTextParts = [
    item.title,
    item.subtitle ?? "",
    item.description,
    ...tags,
    fieldValuesText,
    blueprintName ?? "",
    ...categoryNameList,
  ].filter(Boolean);

  const searchText = searchTextParts.join(" ");
  const simpleSearchText = normalizeSimpleSearchText(searchText);

  await db.query(
    `INSERT INTO marketplace_search_items (
      item_id,
      title,
      subtitle,
      description,
      blueprint_id,
      blueprint_name,
      status,
      category_names,
      tags,
      field_values_text,
      image_urls,
      search_text,
      search_text_simple,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_tsvector('english', $12), to_tsvector('simple', $13), $14)
    ON CONFLICT (item_id) DO UPDATE SET
      title = EXCLUDED.title,
      subtitle = EXCLUDED.subtitle,
      description = EXCLUDED.description,
      blueprint_id = EXCLUDED.blueprint_id,
      blueprint_name = EXCLUDED.blueprint_name,
      status = EXCLUDED.status,
      category_names = EXCLUDED.category_names,
      tags = EXCLUDED.tags,
      field_values_text = EXCLUDED.field_values_text,
      image_urls = EXCLUDED.image_urls,
      search_text = EXCLUDED.search_text,
      search_text_simple = EXCLUDED.search_text_simple,
      updated_at = EXCLUDED.updated_at`,
    [
      item.item_id,
      item.title,
      item.subtitle,
      item.description,
      item.blueprint_id,
      blueprintName,
      item.status,
      JSON.stringify(categoryNameList),
      JSON.stringify(tags),
      fieldValuesText,
      JSON.stringify(imageUrls),
      searchText,
      simpleSearchText,
      item.updated_at,
    ],
  );
}

export async function rebuildDiscoverySearchIndex(db: PgQueryable): Promise<void> {
  await db.query(`TRUNCATE marketplace_search_items`);

  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items ORDER BY item_id ASC`,
  );

  for (const row of result.rows) {
    await refreshDiscoverySearchItem(db, row.item_id);
  }
}

async function refreshItemsByBlueprint(db: PgQueryable, blueprintId: string): Promise<void> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items WHERE blueprint_id = $1`,
    [blueprintId],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoverySearchItem(db, row.item_id)));
}

async function refreshItemsByCategory(db: PgQueryable, categoryId: string): Promise<void> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items WHERE category_ids @> $1::jsonb`,
    [JSON.stringify([categoryId])],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoverySearchItem(db, row.item_id)));
}

export function buildDiscoverySearchItemProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.created": async (event) => {
      await refreshDiscoverySearchItem(db, event.data.itemId as string);
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      await refreshDiscoverySearchItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.field-value-set": async (event) => {
      await refreshDiscoverySearchItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.field-value-cleared": async (event) => {
      await refreshDiscoverySearchItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      await refreshDiscoverySearchItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.category-removed": async (event) => {
      await refreshDiscoverySearchItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.published": async (event) => {
      await refreshDiscoverySearchItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      await refreshDiscoverySearchItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.tags-set": async (event) => {
      await refreshDiscoverySearchItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.image-urls-set": async (event) => {
      await refreshDiscoverySearchItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.retired": async (event) => {
      await refreshDiscoverySearchItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.archived": async (event) => {
      await refreshDiscoverySearchItem(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },

    "catalog.blueprint.revised": async (event) => {
      await refreshItemsByBlueprint(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },

    "catalog.category.revised": async (event) => {
      await refreshItemsByCategory(db, extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },
  };
}

