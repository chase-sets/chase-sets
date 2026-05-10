import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { localizedTextMapValues } from "@chase-sets/localization";
import { normalizeSimpleSearchText } from "../domain/normalization";
import { uniqueStrings } from "../../../support/item-support/unique-strings";
import {
  createMarketplaceSlug,
  rememberSlugRedirect,
} from "../../../support/runtime-support/slugs";

const ITEM_STREAM_PREFIX = "catalog.item-";
const BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
const CATEGORY_STREAM_PREFIX = "catalog.category-";

type FieldValue = Readonly<{ fieldId: string; value: unknown }>;

type SearchCatalogItemRow = Readonly<{
  catalog_item_id: string;
  slug: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  description_i18n: unknown;
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

async function loadCategoryMap(
  db: PgQueryable,
  ids: readonly string[],
): Promise<Map<string, { name: string; slug: string }>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await db.query<{ category_id: string; name: string; slug: string }>(
    `SELECT category_id, name, slug
     FROM discovery_search_catalog_categories
     WHERE category_id = ANY($1)`,
    [ids],
  );

  return new Map(
    result.rows.map((row) => [
      row.category_id,
      { name: row.name, slug: row.slug },
    ]),
  );
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

  const [blueprintNames, categoryRefs] = await Promise.all([
    item.blueprint_id
      ? loadNameMap(
          db,
          "discovery_search_catalog_blueprints",
          "blueprint_id",
          "name",
          [item.blueprint_id],
        )
      : Promise.resolve(new Map<string, string>()),
    loadCategoryMap(db, categoryIds),
  ]);

  const blueprintName = item.blueprint_id ? blueprintNames.get(item.blueprint_id) ?? null : null;
  const categoryNameList = categoryIds.map((id) => categoryRefs.get(id)?.name ?? id);
  const categorySlugList = categoryIds.map((id) => categoryRefs.get(id)?.slug ?? id);

  const fieldValuesText = fieldValues
    .flatMap((fieldValue) => searchableValueText(fieldValue.value))
    .join(" ");
  const localizedText = localizedMapValues(item.title_i18n)
    .concat(localizedMapValues(item.subtitle_i18n))
    .concat(localizedMapValues(item.description_i18n))
    .join(" ");

  const searchText = [
    item.title,
    item.subtitle ?? "",
    item.description,
    localizedText,
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
      slug,
      language_code,
      title_i18n,
      title,
      subtitle_i18n,
      subtitle,
      description_i18n,
      description,
      blueprint_id,
      blueprint_name,
      status,
      category_names,
      category_slugs,
      tags,
      field_values_text,
      image_urls,
      search_text,
      search_text_simple,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, to_tsvector('english', $18), to_tsvector('simple', $19), $20)
    ON CONFLICT (catalog_item_id) DO UPDATE SET
      slug = EXCLUDED.slug,
      language_code = EXCLUDED.language_code,
      title_i18n = EXCLUDED.title_i18n,
      title = EXCLUDED.title,
      subtitle_i18n = EXCLUDED.subtitle_i18n,
      subtitle = EXCLUDED.subtitle,
      description_i18n = EXCLUDED.description_i18n,
      description = EXCLUDED.description,
      blueprint_id = EXCLUDED.blueprint_id,
      blueprint_name = EXCLUDED.blueprint_name,
      status = EXCLUDED.status,
      category_names = EXCLUDED.category_names,
      category_slugs = EXCLUDED.category_slugs,
      tags = EXCLUDED.tags,
      field_values_text = EXCLUDED.field_values_text,
      image_urls = EXCLUDED.image_urls,
      search_text = EXCLUDED.search_text,
      search_text_simple = EXCLUDED.search_text_simple,
      updated_at = EXCLUDED.updated_at`,
    [
      item.catalog_item_id,
      item.slug,
      item.language_code,
      JSON.stringify(item.title_i18n ?? localizedTextMap(item.title)),
      item.title,
      item.subtitle_i18n === null ? null : JSON.stringify(item.subtitle_i18n),
      item.subtitle,
      JSON.stringify(item.description_i18n ?? localizedTextMap(item.description)),
      item.description,
      item.blueprint_id,
      blueprintName,
      item.status,
      JSON.stringify(categoryNameList),
      JSON.stringify(categorySlugList),
      JSON.stringify(tags),
      fieldValuesText,
      JSON.stringify(imageUrls),
      searchText,
      normalizeSimpleSearchText(searchText),
      item.updated_at,
    ],
  );
}

function searchableValueText(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  if (typeof value === "object" && value !== null && "values" in value) {
    return localizedTextMapValues(value as Parameters<typeof localizedTextMapValues>[0]);
  }

  return value === null || value === undefined ? [] : [String(value)];
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
      const { itemId, languageCode, title, subtitle, description } = event.data as {
        itemId: string;
        languageCode?: string;
        title: unknown;
        subtitle: unknown;
        description: unknown;
      };
      const titleI18n = coerceLocalizedTextMap(title);
      const subtitleI18n = subtitle ? coerceLocalizedTextMap(subtitle) : null;
      const descriptionI18n = coerceLocalizedTextMap(description);
      const resolvedTitle = resolveLocalizedText(titleI18n);
      const resolvedSubtitle = subtitleI18n ? resolveLocalizedText(subtitleI18n) : null;
      const resolvedDescription = resolveLocalizedText(descriptionI18n);
      const slug = createMarketplaceSlug([resolvedTitle, resolvedSubtitle], itemId);

      await db.query(
        `INSERT INTO discovery_search_catalog_items (
          catalog_item_id,
          slug,
          language_code,
          title_i18n,
          title,
          subtitle_i18n,
          subtitle,
          description_i18n,
          description,
          status,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9)
        ON CONFLICT (catalog_item_id) DO UPDATE SET
          slug = EXCLUDED.slug,
          language_code = EXCLUDED.language_code,
          title_i18n = EXCLUDED.title_i18n,
          title = EXCLUDED.title,
          subtitle_i18n = EXCLUDED.subtitle_i18n,
          subtitle = EXCLUDED.subtitle,
          description_i18n = EXCLUDED.description_i18n,
          description = EXCLUDED.description,
          updated_at = EXCLUDED.updated_at`,
        [
          itemId,
          slug,
          languageCode ?? "en",
          JSON.stringify(titleI18n),
          resolvedTitle,
          subtitleI18n ? JSON.stringify(subtitleI18n) : null,
          resolvedSubtitle,
          JSON.stringify(descriptionI18n),
          resolvedDescription,
          event.timing.recordedAt,
        ],
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
      const { languageCode, title, subtitle, description } = event.data as {
        languageCode?: string;
        title: unknown;
        subtitle: unknown;
        description: unknown;
      };
      const titleI18n = coerceLocalizedTextMap(title);
      const subtitleI18n = subtitle ? coerceLocalizedTextMap(subtitle) : null;
      const descriptionI18n = coerceLocalizedTextMap(description);
      const resolvedTitle = resolveLocalizedText(titleI18n);
      const resolvedSubtitle = subtitleI18n ? resolveLocalizedText(subtitleI18n) : null;
      const resolvedDescription = resolveLocalizedText(descriptionI18n);
      const slug = createMarketplaceSlug([resolvedTitle, resolvedSubtitle], itemId);
      const current = await db.query<{ slug: string | null }>(
        `SELECT slug FROM discovery_search_catalog_items WHERE catalog_item_id = $1`,
        [itemId],
      );

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET slug = $2,
             language_code = $3,
             title_i18n = $4,
             title = $5,
             subtitle_i18n = $6,
             subtitle = $7,
             description_i18n = $8,
             description = $9,
             updated_at = $10
         WHERE catalog_item_id = $1`,
        [
          itemId,
          slug,
          languageCode ?? "en",
          JSON.stringify(titleI18n),
          resolvedTitle,
          subtitleI18n ? JSON.stringify(subtitleI18n) : null,
          resolvedSubtitle,
          JSON.stringify(descriptionI18n),
          resolvedDescription,
          event.timing.recordedAt,
        ],
      );
      await rememberSlugRedirect(db, {
        entityKind: "item",
        entityId: itemId,
        previousSlug: current.rows[0]?.slug,
        nextSlug: slug,
        updatedAt: event.timing.recordedAt,
      });

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
      const { blueprintId, name } = event.data as { blueprintId: string; name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO discovery_search_catalog_blueprints (blueprint_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (blueprint_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [blueprintId, resolvedName, event.timing.recordedAt],
      );
    },
    "catalog.blueprint.revised": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX);
      const { name } = event.data as { name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO discovery_search_catalog_blueprints (blueprint_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (blueprint_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [blueprintId, resolvedName, event.timing.recordedAt],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },

    "catalog.category.created": async (event) => {
      const { categoryId, name } = event.data as { categoryId: string; name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));
      const slug = createMarketplaceSlug([resolvedName], categoryId);

      await db.query(
        `INSERT INTO discovery_search_catalog_categories (category_id, slug, name, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (category_id) DO UPDATE SET
           slug = EXCLUDED.slug,
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [categoryId, slug, resolvedName, event.timing.recordedAt],
      );
    },
    "catalog.category.revised": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX);
      const { name } = event.data as { name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));
      const slug = createMarketplaceSlug([resolvedName], categoryId);
      const current = await db.query<{ slug: string | null }>(
        `SELECT slug FROM discovery_search_catalog_categories WHERE category_id = $1`,
        [categoryId],
      );

      await db.query(
        `INSERT INTO discovery_search_catalog_categories (category_id, slug, name, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (category_id) DO UPDATE SET
           slug = EXCLUDED.slug,
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [categoryId, slug, resolvedName, event.timing.recordedAt],
      );
      await rememberSlugRedirect(db, {
        entityKind: "category",
        entityId: categoryId,
        previousSlug: current.rows[0]?.slug,
        nextSlug: slug,
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByCategory(db, categoryId);
    },
  };
}

type LocalizedTextMap = Readonly<{
  defaultLocale: "en";
  values: Readonly<Record<string, string>>;
}>;

function localizedTextMap(value: string): LocalizedTextMap {
  return { defaultLocale: "en", values: value ? { en: value } : {} };
}

function coerceLocalizedTextMap(value: unknown): LocalizedTextMap {
  if (
    value &&
    typeof value === "object" &&
    "defaultLocale" in value &&
    "values" in value
  ) {
    return value as LocalizedTextMap;
  }

  return localizedTextMap(String(value ?? ""));
}

function resolveLocalizedText(value: LocalizedTextMap): string {
  return value.values.en ?? value.values[value.defaultLocale] ?? Object.values(value.values)[0] ?? "";
}

function localizedMapValues(value: unknown): string[] {
  if (!value || typeof value !== "object" || !("values" in value)) {
    return [];
  }

  const values = (value as { values?: unknown }).values;
  if (!values || typeof values !== "object") {
    return [];
  }

  return Object.values(values).filter((entry): entry is string => typeof entry === "string");
}
