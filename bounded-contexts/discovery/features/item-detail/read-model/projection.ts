import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import {
  asArray,
  asStringArray,
  extractIdFromStreamId,
  loadNameMap,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { uniqueStrings } from "../../../support/item-support/unique-strings";
import {
  findCatalogItemIdsByReferenceRecord,
  findReferenceRecordIdsByRelatedReferenceGraph,
  loadReferenceRecordMap,
  referenceIdFromValue,
} from "../../../support/item-support/reference-records";
import { createMarketplaceSlug, rememberSlugRedirect } from "../../../support/runtime-support/slugs";

const ITEM_STREAM_PREFIX = "catalog.item-";
const BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
const CATEGORY_STREAM_PREFIX = "catalog.category-";
const FIELD_STREAM_PREFIX = "catalog.field-";
const DIMENSION_STREAM_PREFIX = "catalog.dimension-";
const REFERENCE_RECORD_STREAM_PREFIX = "catalog.reference-record-";
const ITEM_DETAIL_REFERENCE_RECORDS_TABLE = "discovery_item_detail_catalog_reference_records";
const ITEM_DETAIL_CATALOG_ITEMS_TABLE = "discovery_item_detail_catalog_items";

type FieldValue = Readonly<{ fieldId: string; value: unknown }>;
type DimensionRule = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedOptionIds?: string[];
  appliesWhen?: Array<{ dimensionId: string; optionIds?: string[] }>;
}>;

type ItemDetailCatalogItemRow = Readonly<{
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
  product_asset_sets: unknown;
  image_fallback: unknown;
  updated_at: string;
}>;

type CatalogItemDisplayIdentityResolvedEventData = Readonly<{
  catalogItemId: string;
  languageCode?: string;
  title: string;
  subtitle?: string | null;
}>;

type ItemDetailBlueprintRow = Readonly<{
  blueprint_id: string;
  name: string;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
}>;

type ChoiceDetailRow = Readonly<{
  option_id: string;
  code: string;
  label_i18n: unknown;
  label: string;
  display_order: number;
  numeric_value: number | null;
}>;

type DimensionDetailRow = Readonly<{
  dimension_id: string;
  name: string;
  value_kind: "unordered" | "ordered" | "numeric";
}>;

async function loadCategoryMap(
  db: PgQueryable,
  ids: readonly string[],
): Promise<Map<string, { name: string; slug: string }>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await db.query<{ category_id: string; name: string; slug: string }>(
    `SELECT category_id, name, slug
     FROM discovery_item_detail_catalog_categories
     WHERE category_id = ANY($1)`,
    [ids],
  );

  return new Map(result.rows.map((row) => [row.category_id, { name: row.name, slug: row.slug }]));
}

async function buildProductSchema(db: PgQueryable, blueprintId: string): Promise<unknown | null> {
  const blueprintResult = await db.query<ItemDetailBlueprintRow>(
    `SELECT * FROM discovery_item_detail_catalog_blueprints WHERE blueprint_id = $1`,
    [blueprintId],
  );

  const blueprint = blueprintResult.rows[0];

  if (!blueprint) {
    return null;
  }

  const dimensionRules = asArray<DimensionRule>(blueprint.dimension_rules);
  const canonicalDimensionOrder = asStringArray(blueprint.canonical_dimension_order);
  const dimensionIds = [
    ...new Set([
      ...dimensionRules.map((rule) => rule.dimensionId),
      ...dimensionRules.flatMap((rule) => (rule.appliesWhen ?? []).map((clause) => clause.dimensionId)),
      ...canonicalDimensionOrder,
    ]),
  ];
  const optionIds = dimensionRules.flatMap((rule) => [
    ...(rule.allowedOptionIds ?? []),
    ...(rule.appliesWhen ?? []).flatMap((clause) => clause.optionIds ?? []),
  ]);

  const [dimensionRows, choiceRows] = await Promise.all([
    dimensionIds.length > 0
      ? db
          .query<DimensionDetailRow>(
            `SELECT dimension_id, name, value_kind
           FROM discovery_item_detail_catalog_dimensions
           WHERE dimension_id = ANY($1)`,
            [dimensionIds],
          )
          .then((result) => result.rows)
      : Promise.resolve([] as DimensionDetailRow[]),
    optionIds.length > 0
      ? db
          .query<ChoiceDetailRow>(
            `SELECT option_id, code, label_i18n, label, display_order, numeric_value::float8 AS numeric_value
           FROM discovery_item_detail_catalog_dimension_options
           WHERE option_id = ANY($1)`,
            [optionIds],
          )
          .then((result) => result.rows)
      : Promise.resolve([] as ChoiceDetailRow[]),
  ]);

  const dimensionMap = new Map(dimensionRows.map((row) => [row.dimension_id, row]));
  const choiceMap = new Map(choiceRows.map((row) => [row.option_id, row]));

  return {
    canonicalDimensionOrder: canonicalDimensionOrder.map((dimensionId) => ({
      dimensionId,
      dimensionName: dimensionMap.get(dimensionId)?.name ?? dimensionId,
    })),
    dimensions: dimensionRules.map((rule) => ({
      dimensionId: rule.dimensionId,
      dimensionName: dimensionMap.get(rule.dimensionId)?.name ?? rule.dimensionId,
      valueKind: dimensionMap.get(rule.dimensionId)?.value_kind ?? "unordered",
      required: rule.required,
      appliesWhen: (rule.appliesWhen ?? []).map((clause) => ({
        dimensionId: clause.dimensionId,
        optionIds: clause.optionIds ?? [],
      })),
      allowedOptions: (rule.allowedOptionIds ?? [])
        .map((optionId, fallbackOrder) => {
          const detail = choiceMap.get(optionId);
          return {
            optionId,
            code: detail?.code ?? optionId,
            label_i18n: detail?.label_i18n ?? localizedTextMap(detail?.label ?? optionId),
            label: detail?.label ?? detail?.code ?? optionId,
            displayOrder: detail?.display_order ?? fallbackOrder,
            numericValue: detail?.numeric_value ?? null,
          };
        })
        .sort((left, right) => left.displayOrder - right.displayOrder || left.code.localeCompare(right.code)),
    })),
  };
}

async function refreshDiscoveryItemDetailPage(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<ItemDetailCatalogItemRow>(
    `SELECT * FROM discovery_item_detail_catalog_items WHERE catalog_item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM discovery_item_detail_pages WHERE catalog_item_id = $1`, [itemId]);
    return;
  }

  const fieldValues = asArray<FieldValue>(item.field_values);
  const rawCategoryIds = asStringArray(item.category_ids);
  const categoryIds = uniqueStrings(rawCategoryIds);
  const tags = asStringArray(item.tags);
  const imageUrls = asStringArray(item.image_urls);
  const productAssetSets = asArray(item.product_asset_sets);
  const fieldIds = fieldValues.map((entry) => entry.fieldId);
  const referenceIds = fieldValues
    .map((entry) => referenceIdFromValue(entry.value))
    .filter((referenceId): referenceId is string => referenceId !== null);

  if (categoryIds.length !== rawCategoryIds.length) {
    await db.query(
      `UPDATE discovery_item_detail_catalog_items
       SET category_ids = $2
       WHERE catalog_item_id = $1`,
      [itemId, JSON.stringify(categoryIds)],
    );
  }

  const [fieldNames, categoryRefs, blueprintNames, references] = await Promise.all([
    loadNameMap(db, "discovery_item_detail_catalog_fields", "field_id", "name", fieldIds),
    loadCategoryMap(db, categoryIds),
    item.blueprint_id
      ? loadNameMap(db, "discovery_item_detail_catalog_blueprints", "blueprint_id", "name", [item.blueprint_id])
      : Promise.resolve(new Map<string, string>()),
    loadReferenceRecordMap(db, ITEM_DETAIL_REFERENCE_RECORDS_TABLE, referenceIds),
  ]);

  const productSchema = item.blueprint_id ? await buildProductSchema(db, item.blueprint_id) : null;

  await db.query(
    `INSERT INTO discovery_item_detail_pages (
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
      blueprint,
      status,
      field_values,
      categories,
      tags,
      image_urls,
      product_asset_sets,
      image_fallback,
      product_schema,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
      blueprint = EXCLUDED.blueprint,
      status = EXCLUDED.status,
      field_values = EXCLUDED.field_values,
      categories = EXCLUDED.categories,
      tags = EXCLUDED.tags,
      image_urls = EXCLUDED.image_urls,
      product_asset_sets = EXCLUDED.product_asset_sets,
      image_fallback = EXCLUDED.image_fallback,
      product_schema = EXCLUDED.product_schema,
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
      item.blueprint_id
        ? JSON.stringify({
            blueprintId: item.blueprint_id,
            name: blueprintNames.get(item.blueprint_id) ?? item.blueprint_id,
          })
        : null,
      item.status,
      JSON.stringify(
        fieldValues.map((entry) => ({
          fieldId: entry.fieldId,
          fieldName: fieldNames.get(entry.fieldId) ?? entry.fieldId,
          value: entry.value,
          reference: references.get(referenceIdFromValue(entry.value) ?? "") ?? null,
        })),
      ),
      JSON.stringify(
        categoryIds.map((categoryId) => ({
          categoryId,
          slug: categoryRefs.get(categoryId)?.slug ?? categoryId,
          name: categoryRefs.get(categoryId)?.name ?? categoryId,
        })),
      ),
      JSON.stringify(tags),
      JSON.stringify(imageUrls),
      JSON.stringify(productAssetSets),
      item.image_fallback === null ? null : JSON.stringify(item.image_fallback),
      productSchema === null ? null : JSON.stringify(productSchema),
      item.updated_at,
    ],
  );
}

async function refreshItemsByBlueprint(db: PgQueryable, blueprintId: string): Promise<void> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM discovery_item_detail_catalog_items WHERE blueprint_id = $1`,
    [blueprintId],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoveryItemDetailPage(db, row.catalog_item_id)));
}

async function refreshItemsByCategory(db: PgQueryable, categoryId: string): Promise<void> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM discovery_item_detail_catalog_items WHERE category_ids @> $1::jsonb`,
    [JSON.stringify([categoryId])],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoveryItemDetailPage(db, row.catalog_item_id)));
}

async function refreshAllItems(db: PgQueryable): Promise<void> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM discovery_item_detail_catalog_items ORDER BY catalog_item_id ASC`,
  );

  await Promise.all(result.rows.map((row) => refreshDiscoveryItemDetailPage(db, row.catalog_item_id)));
}

async function refreshItemsByReferenceRecord(db: PgQueryable, referenceRecordId: string): Promise<void> {
  const relatedRecordIds = await findReferenceRecordIdsByRelatedReferenceGraph(
    db,
    ITEM_DETAIL_REFERENCE_RECORDS_TABLE,
    referenceRecordId,
  );
  const itemIds = [
    ...(await findCatalogItemIdsByReferenceRecord(db, ITEM_DETAIL_CATALOG_ITEMS_TABLE, referenceRecordId)),
    ...(
      await Promise.all(
        relatedRecordIds.map((recordId) =>
          findCatalogItemIdsByReferenceRecord(db, ITEM_DETAIL_CATALOG_ITEMS_TABLE, recordId),
        ),
      )
    ).flat(),
  ];

  await Promise.all([...new Set(itemIds)].map((itemId) => refreshDiscoveryItemDetailPage(db, itemId)));
}

async function applyCatalogItemDisplayIdentity(
  db: PgQueryable,
  input: CatalogItemDisplayIdentityResolvedEventData,
  updatedAt: string,
): Promise<void> {
  const resolvedSubtitle = input.subtitle?.trim() || null;
  const slug = createMarketplaceSlug([input.title, resolvedSubtitle], input.catalogItemId);
  const current = await db.query<{ slug: string | null }>(
    `SELECT slug FROM discovery_item_detail_catalog_items WHERE catalog_item_id = $1`,
    [input.catalogItemId],
  );

  await db.query(
    `UPDATE discovery_item_detail_catalog_items
     SET slug = $2,
         language_code = $3,
         title_i18n = $4,
         title = $5,
         subtitle_i18n = $6,
         subtitle = $7,
         updated_at = $8
     WHERE catalog_item_id = $1`,
    [
      input.catalogItemId,
      slug,
      input.languageCode ?? "en",
      JSON.stringify(localizedTextMap(input.title)),
      input.title,
      resolvedSubtitle ? JSON.stringify(localizedTextMap(resolvedSubtitle)) : null,
      resolvedSubtitle,
      updatedAt,
    ],
  );
  await rememberSlugRedirect(db, {
    entityKind: "item",
    entityId: input.catalogItemId,
    previousSlug: current.rows[0]?.slug,
    nextSlug: slug,
    updatedAt,
  });

  await refreshDiscoveryItemDetailPage(db, input.catalogItemId);
}

export function buildDiscoveryItemDetailProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
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
        `INSERT INTO discovery_item_detail_catalog_items (
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
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10)
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

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { blueprintId } = event.data as { blueprintId: string };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET blueprint_id = $2, updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, blueprintId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.field-value-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { fieldId, value } = event.data as { fieldId: string; value: unknown };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET field_values = (
           SELECT COALESCE(jsonb_agg(field_value), '[]'::jsonb)
           FROM jsonb_array_elements(field_values) AS field_value
           WHERE field_value->>'fieldId' != $2
         ) || $3::jsonb,
         updated_at = $4
         WHERE catalog_item_id = $1`,
        [itemId, fieldId, JSON.stringify([{ fieldId, value }]), event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.field-value-cleared": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { fieldId } = event.data as { fieldId: string };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET field_values = (
           SELECT COALESCE(jsonb_agg(field_value), '[]'::jsonb)
           FROM jsonb_array_elements(field_values) AS field_value
           WHERE field_value->>'fieldId' != $2
         ),
         updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, fieldId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET category_ids = CASE
               WHEN category_ids @> $2::jsonb THEN category_ids
               ELSE category_ids || $2::jsonb
             END,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify([categoryId]), event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.category-removed": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET category_ids = (
           SELECT COALESCE(jsonb_agg(category_id), '[]'::jsonb)
           FROM jsonb_array_elements(category_ids) AS category_id
           WHERE category_id #>> '{}' != $2
         ),
         updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, categoryId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.published": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET status = 'active', updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.display-identity-resolved": async (event) => {
      await applyCatalogItemDisplayIdentity(
        db,
        event.data as CatalogItemDisplayIdentityResolvedEventData,
        event.timing.recordedAt,
      );
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { description } = event.data as {
        description: unknown;
      };
      const descriptionI18n = coerceLocalizedTextMap(description);
      const resolvedDescription = resolveLocalizedText(descriptionI18n);

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET description_i18n = $2,
             description = $3,
             updated_at = $4
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(descriptionI18n), resolvedDescription, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.tags-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { tags } = event.data as { tags: string[] };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET tags = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(tags), event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.image-urls-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { imageUrls } = event.data as { imageUrls: string[] };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET image_urls = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(imageUrls), event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.product-asset-sets-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { productAssetSets } = event.data as { productAssetSets: unknown };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET product_asset_sets = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(Array.isArray(productAssetSets) ? productAssetSets : []), event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.image-fallback-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { imageFallback } = event.data as { imageFallback: unknown };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET image_fallback = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(imageFallback), event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.image-fallback-cleared": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET image_fallback = NULL,
             updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.retired": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET status = 'archived', updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.archived": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET status = 'archived', updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },

    "catalog.blueprint.created": async (event) => {
      const { blueprintId, name } = event.data as { blueprintId: string; name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_blueprints (
          blueprint_id,
          name,
          updated_at
        ) VALUES ($1, $2, $3)
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
        `INSERT INTO discovery_item_detail_catalog_blueprints (
          blueprint_id,
          name,
          updated_at
        ) VALUES ($1, $2, $3)
        ON CONFLICT (blueprint_id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = EXCLUDED.updated_at`,
        [blueprintId, resolvedName, event.timing.recordedAt],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },
    "catalog.blueprint.dimensions-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX);
      const { dimensionRules } = event.data as { dimensionRules: unknown };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_blueprints (
          blueprint_id,
          name,
          dimension_rules,
          updated_at
        ) VALUES (
          $1,
          COALESCE((SELECT name FROM discovery_item_detail_catalog_blueprints WHERE blueprint_id = $1), $1),
          $2,
          $3
        )
        ON CONFLICT (blueprint_id) DO UPDATE SET
          dimension_rules = EXCLUDED.dimension_rules,
          updated_at = EXCLUDED.updated_at`,
        [blueprintId, JSON.stringify(dimensionRules), event.timing.recordedAt],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },
    "catalog.blueprint.product-resolution-rules-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX);
      const { canonicalDimensionOrder } = event.data as { canonicalDimensionOrder: unknown };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_blueprints (
          blueprint_id,
          name,
          canonical_dimension_order,
          updated_at
        ) VALUES (
          $1,
          COALESCE((SELECT name FROM discovery_item_detail_catalog_blueprints WHERE blueprint_id = $1), $1),
          $2,
          $3
        )
        ON CONFLICT (blueprint_id) DO UPDATE SET
          canonical_dimension_order = EXCLUDED.canonical_dimension_order,
          updated_at = EXCLUDED.updated_at`,
        [blueprintId, JSON.stringify(canonicalDimensionOrder), event.timing.recordedAt],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },
    "catalog.blueprint.published": async (event) => {
      await refreshItemsByBlueprint(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },

    "catalog.category.created": async (event) => {
      const { categoryId, name } = event.data as { categoryId: string; name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));
      const slug = createMarketplaceSlug([resolvedName], categoryId);

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_categories (category_id, slug, name, updated_at)
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
        `SELECT slug FROM discovery_item_detail_catalog_categories WHERE category_id = $1`,
        [categoryId],
      );

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_categories (category_id, slug, name, updated_at)
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

    "catalog.field.created": async (event) => {
      const { fieldId, name } = event.data as { fieldId: string; name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_fields (field_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (field_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [fieldId, resolvedName, event.timing.recordedAt],
      );

      await refreshAllItems(db);
    },
    "catalog.field.configured": async (event) => {
      const fieldId = extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX);
      const { name } = event.data as { name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_fields (field_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (field_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [fieldId, resolvedName, event.timing.recordedAt],
      );

      await refreshAllItems(db);
    },

    "catalog.reference-record.created": async (event) => {
      const { referenceRecordId, typeKey, key, name, attributes, relationships } = event.data as {
        referenceRecordId: string;
        typeKey: string;
        key: string;
        name: unknown;
        attributes?: unknown;
        relationships?: unknown;
      };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO ${ITEM_DETAIL_REFERENCE_RECORDS_TABLE} (
          reference_record_id,
          type_key,
          key,
          name,
          attributes,
          relationships,
          status,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7)
        ON CONFLICT (reference_record_id) DO UPDATE SET
          type_key = EXCLUDED.type_key,
          key = EXCLUDED.key,
          name = EXCLUDED.name,
          attributes = EXCLUDED.attributes,
          relationships = EXCLUDED.relationships,
          updated_at = EXCLUDED.updated_at`,
        [
          referenceRecordId,
          typeKey,
          key,
          resolvedName,
          JSON.stringify(attributes ?? {}),
          JSON.stringify(Array.isArray(relationships) ? relationships : []),
          event.timing.recordedAt,
        ],
      );

      await refreshItemsByReferenceRecord(db, referenceRecordId);
    },
    "catalog.reference-record.revised": async (event) => {
      const referenceRecordId = extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX);
      const { typeKey, key, name, attributes, relationships } = event.data as {
        typeKey: string;
        key: string;
        name: unknown;
        attributes?: unknown;
        relationships?: unknown;
      };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO ${ITEM_DETAIL_REFERENCE_RECORDS_TABLE} (
          reference_record_id,
          type_key,
          key,
          name,
          attributes,
          relationships,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (reference_record_id) DO UPDATE SET
          type_key = EXCLUDED.type_key,
          key = EXCLUDED.key,
          name = EXCLUDED.name,
          attributes = EXCLUDED.attributes,
          relationships = EXCLUDED.relationships,
          updated_at = EXCLUDED.updated_at`,
        [
          referenceRecordId,
          typeKey,
          key,
          resolvedName,
          JSON.stringify(attributes ?? {}),
          JSON.stringify(Array.isArray(relationships) ? relationships : []),
          event.timing.recordedAt,
        ],
      );

      await refreshItemsByReferenceRecord(db, referenceRecordId);
    },
    "catalog.reference-record.published": async (event) => {
      const referenceRecordId = extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX);

      await db.query(
        `UPDATE ${ITEM_DETAIL_REFERENCE_RECORDS_TABLE}
         SET status = 'active', updated_at = $2
         WHERE reference_record_id = $1`,
        [referenceRecordId, event.timing.recordedAt],
      );

      await refreshItemsByReferenceRecord(db, referenceRecordId);
    },
    "catalog.reference-record.deprecated": async (event) => {
      const referenceRecordId = extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX);

      await db.query(
        `UPDATE ${ITEM_DETAIL_REFERENCE_RECORDS_TABLE}
         SET status = 'deprecated', updated_at = $2
         WHERE reference_record_id = $1`,
        [referenceRecordId, event.timing.recordedAt],
      );

      await refreshItemsByReferenceRecord(db, referenceRecordId);
    },
    "catalog.reference-record.archived": async (event) => {
      const referenceRecordId = extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX);

      await db.query(
        `UPDATE ${ITEM_DETAIL_REFERENCE_RECORDS_TABLE}
         SET status = 'archived', updated_at = $2
         WHERE reference_record_id = $1`,
        [referenceRecordId, event.timing.recordedAt],
      );

      await refreshItemsByReferenceRecord(db, referenceRecordId);
    },

    "catalog.dimension.created": async (event) => {
      const { dimensionId, name, valueKind } = event.data as {
        dimensionId: string;
        name: unknown;
        valueKind?: "unordered" | "ordered" | "numeric";
      };
      const nameI18n = coerceLocalizedTextMap(name);

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_dimensions (dimension_id, name, value_kind, updated_at)
         VALUES ($1, $2, COALESCE($3, 'unordered'), $4)
         ON CONFLICT (dimension_id) DO UPDATE SET
           name = EXCLUDED.name,
           value_kind = COALESCE($3, discovery_item_detail_catalog_dimensions.value_kind),
           updated_at = EXCLUDED.updated_at`,
        [dimensionId, resolveLocalizedText(nameI18n), valueKind ?? "unordered", event.timing.recordedAt],
      );

      await refreshAllItems(db);
    },
    "catalog.dimension.revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { name, valueKind } = event.data as {
        name: unknown;
        valueKind?: "unordered" | "ordered" | "numeric";
      };
      const nameI18n = coerceLocalizedTextMap(name);

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_dimensions (dimension_id, name, value_kind, updated_at)
         VALUES ($1, $2, COALESCE($3, 'unordered'), $4)
         ON CONFLICT (dimension_id) DO UPDATE SET
           name = EXCLUDED.name,
           value_kind = COALESCE($3, discovery_item_detail_catalog_dimensions.value_kind),
           updated_at = EXCLUDED.updated_at`,
        [dimensionId, resolveLocalizedText(nameI18n), valueKind ?? null, event.timing.recordedAt],
      );

      await refreshAllItems(db);
    },
    "catalog.dimension.option-added": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { optionId, code, label, labels, displayOrder, numericValue } = event.data as {
        optionId: string;
        code: string;
        label?: unknown;
        labels?: unknown;
        displayOrder?: number;
        numericValue?: number | null;
      };
      const labelI18n = coerceDimensionOptionLabel(label ?? labels);

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_dimension_options (
          option_id,
          dimension_id,
          code,
          label_i18n,
          label,
          display_order,
          numeric_value,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (option_id) DO UPDATE SET
          dimension_id = EXCLUDED.dimension_id,
          code = EXCLUDED.code,
          label_i18n = EXCLUDED.label_i18n,
          label = EXCLUDED.label,
          display_order = EXCLUDED.display_order,
          numeric_value = EXCLUDED.numeric_value,
          updated_at = EXCLUDED.updated_at`,
        [
          optionId,
          dimensionId,
          code,
          JSON.stringify(labelI18n),
          resolveLocalizedText(labelI18n),
          displayOrder ?? 0,
          numericValue ?? null,
          event.timing.recordedAt,
        ],
      );

      await refreshAllItems(db);
    },
    "catalog.dimension.option-revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { optionId, code, label, labels, displayOrder, numericValue } = event.data as {
        optionId: string;
        code: string;
        label?: unknown;
        labels?: unknown;
        displayOrder?: number;
        numericValue?: number | null;
      };
      const labelI18n = coerceDimensionOptionLabel(label ?? labels);

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_dimension_options (
          option_id,
          dimension_id,
          code,
          label_i18n,
          label,
          display_order,
          numeric_value,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (option_id) DO UPDATE SET
          dimension_id = EXCLUDED.dimension_id,
          code = EXCLUDED.code,
          label_i18n = EXCLUDED.label_i18n,
          label = EXCLUDED.label,
          display_order = EXCLUDED.display_order,
          numeric_value = EXCLUDED.numeric_value,
          updated_at = EXCLUDED.updated_at`,
        [
          optionId,
          dimensionId,
          code,
          JSON.stringify(labelI18n),
          resolveLocalizedText(labelI18n),
          displayOrder ?? 0,
          numericValue ?? null,
          event.timing.recordedAt,
        ],
      );

      await refreshAllItems(db);
    },
    "catalog.dimension.options-reordered": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { optionIds } = event.data as { optionIds: string[] };

      for (let i = 0; i < optionIds.length; i++) {
        await db.query(
          `UPDATE discovery_item_detail_catalog_dimension_options
           SET display_order = $3, updated_at = $4
           WHERE dimension_id = $1 AND option_id = $2`,
          [dimensionId, optionIds[i], i, event.timing.recordedAt],
        );
      }

      await refreshAllItems(db);
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
  if (value && typeof value === "object" && "defaultLocale" in value && "values" in value) {
    return value as LocalizedTextMap;
  }

  return localizedTextMap(String(value ?? ""));
}

function resolveLocalizedText(value: LocalizedTextMap): string {
  return value.values.en ?? value.values[value.defaultLocale] ?? Object.values(value.values)[0] ?? "";
}

function coerceDimensionOptionLabel(value: unknown) {
  if (Array.isArray(value)) {
    return coerceLocalizedTextMap({
      defaultLocale: "en",
      values: Object.fromEntries(
        value
          .map((entry) => {
            if (typeof entry !== "object" || entry === null) {
              return null;
            }

            const candidate = entry as { locale?: unknown; value?: unknown };
            return typeof candidate.locale === "string" && typeof candidate.value === "string"
              ? [candidate.locale, candidate.value]
              : null;
          })
          .filter((entry): entry is [string, string] => entry !== null),
      ),
    });
  }

  return coerceLocalizedTextMap(value);
}
