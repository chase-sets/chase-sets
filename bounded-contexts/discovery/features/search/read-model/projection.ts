import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { normalizeSimpleSearchText } from "../domain/normalization";
import { uniqueStrings } from "../../../support/item-support/unique-strings";

const ITEM_STREAM_PREFIX = "catalog.item-";
const BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
const CATEGORY_STREAM_PREFIX = "catalog.category-";

type FieldValue = Readonly<{ fieldId: string; value: unknown }>;

type SearchCatalogItemRow = Readonly<{
  catalog_item_id: string;
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

function extractIdFromStreamId(streamId: string, prefix: string): string {
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Stream ID "${streamId}" does not start with prefix "${prefix}".`);
  }

  return streamId.slice(prefix.length);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value).filter((entry): entry is string => typeof entry === "string");
}

async function loadNameMap(
  db: PgQueryable,
  table: string,
  idColumn: string,
  nameColumn: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await db.query<Record<string, string>>(
    `SELECT ${idColumn} AS id, ${nameColumn} AS name FROM ${table} WHERE ${idColumn} = ANY($1)`,
    [ids],
  );

  return new Map(result.rows.map((row) => [row.id, row.name]));
}

async function refreshDiscoverySearchItem(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<SearchCatalogItemRow>(
    `SELECT * FROM discovery_search_catalog_items WHERE catalog_item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM discovery_search_items WHERE catalog_item_id = $1`, [itemId]);
    return;
  }

  const rawCategoryIds = asStringArray(item.category_ids);
  const categoryIds = uniqueStrings(rawCategoryIds);
  const tags = asStringArray(item.tags);
  const imageUrls = asStringArray(item.image_urls);
  const fieldValues = asArray<FieldValue>(item.field_values);

  if (categoryIds.length !== rawCategoryIds.length) {
    await db.query(
      `UPDATE discovery_search_catalog_items
       SET category_ids = $2
       WHERE catalog_item_id = $1`,
      [itemId, JSON.stringify(categoryIds)],
    );
  }

  const [blueprintNames, categoryNames] = await Promise.all([
    item.blueprint_id
      ? loadNameMap(
          db,
          "discovery_search_catalog_blueprints",
          "blueprint_id",
          "name",
          [item.blueprint_id],
        )
      : Promise.resolve(new Map<string, string>()),
    loadNameMap(
      db,
      "discovery_search_catalog_categories",
      "category_id",
      "name",
      categoryIds,
    ),
  ]);

  const blueprintName = item.blueprint_id ? blueprintNames.get(item.blueprint_id) ?? null : null;
  const categoryNameList = categoryIds.map((id) => categoryNames.get(id) ?? id);

  const fieldValuesText = fieldValues
    .map((fieldValue) =>
      typeof fieldValue.value === "string" ? fieldValue.value : String(fieldValue.value ?? ""),
    )
    .join(" ");

  const searchText = [
    item.title,
    item.subtitle ?? "",
    item.description,
    ...tags,
    fieldValuesText,
    blueprintName ?? "",
    ...categoryNameList,
  ]
    .filter(Boolean)
    .join(" ");

  await db.query(
    `INSERT INTO discovery_search_items (
      catalog_item_id,
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
    ON CONFLICT (catalog_item_id) DO UPDATE SET
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
      item.catalog_item_id,
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
      normalizeSimpleSearchText(searchText),
      item.updated_at,
    ],
  );
}

export async function rebuildDiscoverySearchIndex(db: PgQueryable): Promise<void> {
  await db.query(`TRUNCATE discovery_search_items`);

  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM discovery_search_catalog_items ORDER BY catalog_item_id ASC`,
  );

  for (const row of result.rows) {
    await refreshDiscoverySearchItem(db, row.catalog_item_id);
  }
}

async function refreshItemsByBlueprint(db: PgQueryable, blueprintId: string): Promise<void> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM discovery_search_catalog_items WHERE blueprint_id = $1`,
    [blueprintId],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoverySearchItem(db, row.catalog_item_id)));
}

async function refreshItemsByCategory(db: PgQueryable, categoryId: string): Promise<void> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM discovery_search_catalog_items WHERE category_ids @> $1::jsonb`,
    [JSON.stringify([categoryId])],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoverySearchItem(db, row.catalog_item_id)));
}

export function buildDiscoverySearchItemProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.created": async (event) => {
      const { itemId, title, subtitle, description } = event.data as {
        itemId: string;
        title: string;
        subtitle: string | null;
        description: string;
      };

      await db.query(
        `INSERT INTO discovery_search_catalog_items (
          catalog_item_id,
          title,
          subtitle,
          description,
          status,
          updated_at
        ) VALUES ($1, $2, $3, $4, 'draft', $5)
        ON CONFLICT (catalog_item_id) DO UPDATE SET
          title = EXCLUDED.title,
          subtitle = EXCLUDED.subtitle,
          description = EXCLUDED.description,
          updated_at = EXCLUDED.updated_at`,
        [itemId, title, subtitle, description ?? "", event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { blueprintId } = event.data as { blueprintId: string };

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET blueprint_id = $2, updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, blueprintId, event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.field-value-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { fieldId, value } = event.data as { fieldId: string; value: unknown };

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET field_values = (
           SELECT COALESCE(jsonb_agg(field_value), '[]'::jsonb)
           FROM jsonb_array_elements(field_values) AS field_value
           WHERE field_value->>'fieldId' != $2
         ) || $3::jsonb,
         updated_at = $4
         WHERE catalog_item_id = $1`,
        [itemId, fieldId, JSON.stringify([{ fieldId, value }]), event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.field-value-cleared": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { fieldId } = event.data as { fieldId: string };

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET field_values = (
           SELECT COALESCE(jsonb_agg(field_value), '[]'::jsonb)
           FROM jsonb_array_elements(field_values) AS field_value
           WHERE field_value->>'fieldId' != $2
         ),
         updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, fieldId, event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET category_ids = CASE
               WHEN category_ids @> $2::jsonb THEN category_ids
               ELSE category_ids || $2::jsonb
             END,
         updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify([categoryId]), event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.category-removed": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET category_ids = (
           SELECT COALESCE(jsonb_agg(category_id), '[]'::jsonb)
           FROM jsonb_array_elements(category_ids) AS category_id
           WHERE category_id #>> '{}' != $2
         ),
         updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, categoryId, event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.published": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET status = 'active', updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { title, subtitle, description } = event.data as {
        title: string;
        subtitle: string | null;
        description: string;
      };

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET title = $2,
             subtitle = $3,
             description = $4,
             updated_at = $5
         WHERE catalog_item_id = $1`,
        [itemId, title, subtitle, description ?? "", event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.tags-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { tags } = event.data as { tags: string[] };

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET tags = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(tags), event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.image-urls-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { imageUrls } = event.data as { imageUrls: string[] };

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET image_urls = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(imageUrls), event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.retired": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET status = 'retired', updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.archived": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET status = 'archived', updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },

    "catalog.blueprint.created": async (event) => {
      const { blueprintId, name } = event.data as { blueprintId: string; name: string };

      await db.query(
        `INSERT INTO discovery_search_catalog_blueprints (blueprint_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (blueprint_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [blueprintId, name, event.timing.recordedAt],
      );
    },
    "catalog.blueprint.revised": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX);
      const { name } = event.data as { name: string };

      await db.query(
        `INSERT INTO discovery_search_catalog_blueprints (blueprint_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (blueprint_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [blueprintId, name, event.timing.recordedAt],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },

    "catalog.category.created": async (event) => {
      const { categoryId, name } = event.data as { categoryId: string; name: string };

      await db.query(
        `INSERT INTO discovery_search_catalog_categories (category_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (category_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [categoryId, name, event.timing.recordedAt],
      );
    },
    "catalog.category.revised": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX);
      const { name } = event.data as { name: string };

      await db.query(
        `INSERT INTO discovery_search_catalog_categories (category_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (category_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [categoryId, name, event.timing.recordedAt],
      );

      await refreshItemsByCategory(db, categoryId);
    },
  };
}

