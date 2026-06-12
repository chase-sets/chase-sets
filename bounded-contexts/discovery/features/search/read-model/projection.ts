import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import { asArray, asStringArray, loadNameMap, type PgQueryable } from "@chase-sets/event-core-postgres";
import { localizedTextMapValues } from "@chase-sets/localization";
import { normalizeSimpleSearchText } from "../domain/normalization";
import { uniqueStrings } from "../../../support/item-support/unique-strings";
import {
  collectReferenceRecords,
  findCatalogItemIdsByReferenceRecord,
  findReferenceRecordIdsByRelatedReferenceGraph,
  flattenReferenceRecordText,
  loadReferenceRecordMap,
  referenceIdFromValue,
  type ReferenceRecordRef,
} from "../../../support/item-support/reference-records";
import { createMarketplaceSlug, rememberSlugRedirect } from "../../../support/runtime-support/slugs";
import { fieldFacetSortMetadata } from "./facet-ordering";

const ITEM_STREAM_PREFIX = "catalog.item-";
const BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
const CATEGORY_STREAM_PREFIX = "catalog.category-";
const FIELD_STREAM_PREFIX = "catalog.field-";
const DIMENSION_STREAM_PREFIX = "catalog.dimension-";
const REFERENCE_RECORD_STREAM_PREFIX = "catalog.reference-record-";
const SEARCH_REFERENCE_RECORDS_TABLE = "discovery_search_catalog_reference_records";
const SEARCH_CATALOG_ITEMS_TABLE = "discovery_search_catalog_items";

type FieldValue = Readonly<{ fieldId: string; value: unknown }>;
type SearchFieldDefinition = Readonly<{
  field_id: string;
  name: string;
  value_type: string;
  filterable: boolean;
}>;
type SearchDimensionFilterValue = Readonly<{
  dimensionId: string;
  label: string;
  optionId: string;
  optionLabel: string;
  valueKind: string;
  displayOrder: number;
  numericValue: number | null;
}>;
type SearchReferenceFilterValue = Readonly<{
  typeKey: string;
  label: string;
  referenceId: string;
  referenceLabel: string;
  sortKind: string | null;
  sortValue: string | null;
}>;

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

  return new Map(result.rows.map((row) => [row.category_id, { name: row.name, slug: row.slug }]));
}

async function loadFilterableFieldDefinitions(
  db: PgQueryable,
  ids: readonly string[],
): Promise<Map<string, SearchFieldDefinition>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await db.query<SearchFieldDefinition>(
    `SELECT field_id, name, value_type, filterable
     FROM discovery_search_catalog_fields
     WHERE filterable = true
       AND field_id = ANY($1)`,
    [ids],
  );

  return new Map(result.rows.map((row) => [row.field_id, row]));
}

async function loadDimensionFilterValues(
  db: PgQueryable,
  blueprintId: string | null,
): Promise<SearchDimensionFilterValue[]> {
  if (!blueprintId) {
    return [];
  }

  const result = await db.query<{
    dimension_id: string;
    dimension_name: string;
    option_id: string;
    option_label: string;
    value_kind: string;
    blueprint_display_order: number;
    option_display_order: number;
    numeric_value: string | number | null;
  }>(
    `SELECT
       rule.dimension_id,
       dimension.name AS dimension_name,
       dimension.value_kind,
       option.option_id,
       option.label AS option_label,
       rule.display_order AS blueprint_display_order,
       option.display_order AS option_display_order,
       option.numeric_value
     FROM discovery_search_catalog_blueprint_dimensions AS rule
     INNER JOIN discovery_search_catalog_dimensions AS dimension
       ON dimension.dimension_id = rule.dimension_id
     INNER JOIN LATERAL jsonb_array_elements_text(rule.allowed_option_ids) WITH ORDINALITY AS allowed(option_id, allowed_order)
       ON true
     INNER JOIN discovery_search_catalog_dimension_options AS option
       ON option.option_id = allowed.option_id
      AND option.dimension_id = rule.dimension_id
      AND option.status = 'active'
     WHERE rule.blueprint_id = $1
     ORDER BY rule.display_order ASC, allowed.allowed_order ASC, option.display_order ASC, option.label ASC`,
    [blueprintId],
  );

  return result.rows.map((row) => ({
    dimensionId: row.dimension_id,
    label: row.dimension_name,
    optionId: row.option_id,
    optionLabel: row.option_label,
    valueKind: row.value_kind,
    displayOrder: row.blueprint_display_order * 10_000 + row.option_display_order,
    numericValue: row.numeric_value === null ? null : Number(row.numeric_value),
  }));
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
  const productAssetSets = asArray(item.product_asset_sets);
  const fieldValues = asArray<FieldValue>(item.field_values);
  const referenceIds = fieldValues
    .map((fieldValue) => referenceIdFromValue(fieldValue.value))
    .filter((referenceId): referenceId is string => referenceId !== null);
  const filterableFields = await loadFilterableFieldDefinitions(
    db,
    uniqueStrings(fieldValues.map((fieldValue) => fieldValue.fieldId)),
  );
  const references = await loadReferenceRecordMap(db, SEARCH_REFERENCE_RECORDS_TABLE, referenceIds);
  const fieldFilterValues = fieldValues.flatMap((fieldValue) => {
    const definition = filterableFields.get(fieldValue.fieldId);
    if (!definition) {
      return [];
    }

    if (definition.value_type === "reference") {
      return buildReferenceFieldFilterValues(
        fieldValue,
        definition,
        references.get(referenceIdFromValue(fieldValue.value) ?? ""),
      );
    }

    const normalized = normalizeFilterValue(fieldValue.value);
    if (!normalized) {
      return [];
    }

    const sort = fieldFacetSortMetadata({
      fieldId: fieldValue.fieldId,
      label: definition.name,
      value: fieldValue.value,
      valueType: definition.value_type,
    });

    return [
      {
        fieldId: fieldValue.fieldId,
        label: definition.name,
        value: normalized,
        valueLabel: formatFilterValueLabel(fieldValue.value),
        valueType: definition.value_type,
        sortKind: sort.sortKind,
        sortValue: sort.sortValue,
      },
    ];
  });
  const referenceFilterValues = uniqueReferenceFilterValues(
    fieldValues.flatMap((fieldValue) => {
      const reference = references.get(referenceIdFromValue(fieldValue.value) ?? "");
      return buildReferenceTypeFilterValues(reference);
    }),
  );
  const dimensionFilterValues = await loadDimensionFilterValues(db, item.blueprint_id);

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
      ? loadNameMap(db, "discovery_search_catalog_blueprints", "blueprint_id", "name", [item.blueprint_id])
      : Promise.resolve(new Map<string, string>()),
    loadCategoryMap(db, categoryIds),
  ]);

  const blueprintName = item.blueprint_id ? (blueprintNames.get(item.blueprint_id) ?? null) : null;
  const categoryNameList = categoryIds.map((id) => categoryRefs.get(id)?.name ?? id);
  const categorySlugList = categoryIds.map((id) => categoryRefs.get(id)?.slug ?? id);

  const fieldValuesText = fieldValues
    .flatMap((fieldValue) =>
      searchableValueText(fieldValue.value, references.get(referenceIdFromValue(fieldValue.value) ?? "")),
    )
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
      field_filter_values,
      reference_filter_values,
      dimension_filter_values,
      image_urls,
      product_asset_sets,
      image_fallback,
      search_text,
      search_text_simple,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, to_tsvector('english', $23), to_tsvector('simple', $24), $25)
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
      field_filter_values = EXCLUDED.field_filter_values,
      reference_filter_values = EXCLUDED.reference_filter_values,
      dimension_filter_values = EXCLUDED.dimension_filter_values,
      image_urls = EXCLUDED.image_urls,
      product_asset_sets = EXCLUDED.product_asset_sets,
      image_fallback = EXCLUDED.image_fallback,
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
      JSON.stringify(fieldFilterValues),
      JSON.stringify(referenceFilterValues),
      JSON.stringify(dimensionFilterValues),
      JSON.stringify(imageUrls),
      JSON.stringify(productAssetSets),
      item.image_fallback === null ? null : JSON.stringify(item.image_fallback),
      searchText,
      normalizeSimpleSearchText(searchText),
      item.updated_at,
    ],
  );
}

function searchableValueText(value: unknown, reference?: ReferenceRecordRef): string[] {
  if (reference) {
    return flattenReferenceRecordText(reference);
  }

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

function formatFilterValueLabel(value: unknown): string {
  const searchableText = searchableValueText(value).find((entry) => entry.trim().length > 0);

  return searchableText ?? String(value ?? "");
}

function normalizeFilterValue(value: unknown): string {
  return formatFilterValueLabel(value).trim().toLocaleLowerCase("en-US");
}

function buildReferenceFieldFilterValues(
  fieldValue: FieldValue,
  definition: SearchFieldDefinition,
  reference: ReferenceRecordRef | undefined,
) {
  if (!reference) {
    return [];
  }

  return collectReferenceRecords(reference).map((record, index) => {
    const fieldId = index === 0 ? fieldValue.fieldId : `${fieldValue.fieldId}:${record.typeKey}`;
    const label = index === 0 ? definition.name : `${definition.name} ${titleizeKey(record.typeKey)}`;
    const sort = fieldFacetSortMetadata({
      fieldId,
      label,
      value: record.referenceId,
      valueType: definition.value_type,
      reference: record,
    });

    return {
      fieldId,
      label,
      value: record.referenceId.toLocaleLowerCase("en-US"),
      valueLabel: record.name,
      valueType: definition.value_type,
      sortKind: sort.sortKind,
      sortValue: sort.sortValue,
    };
  });
}

function buildReferenceTypeFilterValues(reference: ReferenceRecordRef | undefined): SearchReferenceFilterValue[] {
  return collectReferenceRecords(reference).map((record) => {
    const label = formatReferenceTypeLabel(record.typeKey);
    const sort = fieldFacetSortMetadata({
      fieldId: `reference:${record.typeKey}`,
      label,
      value: record.referenceId,
      valueType: "reference",
      reference: record,
    });

    return {
      typeKey: record.typeKey,
      label,
      referenceId: record.referenceId.toLocaleLowerCase("en-US"),
      referenceLabel: record.name,
      sortKind: sort.sortKind,
      sortValue: sort.sortValue,
    };
  });
}

function uniqueReferenceFilterValues(values: readonly SearchReferenceFilterValue[]): SearchReferenceFilterValue[] {
  const byKey = new Map<string, SearchReferenceFilterValue>();
  for (const value of values) {
    byKey.set(`${value.typeKey}:${value.referenceId}`, value);
  }
  return [...byKey.values()];
}

function titleizeKey(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`)
    .join(" ");
}

function formatReferenceTypeLabel(typeKey: string): string {
  return typeKey
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => (part === "tcg" ? "TCG" : `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`))
    .join(" ");
}

async function refreshItemsByReferenceRecord(db: PgQueryable, referenceRecordId: string): Promise<void> {
  const relatedRecordIds = await findReferenceRecordIdsByRelatedReferenceGraph(
    db,
    SEARCH_REFERENCE_RECORDS_TABLE,
    referenceRecordId,
  );
  const itemIds = [
    ...(await findCatalogItemIdsByReferenceRecord(db, SEARCH_CATALOG_ITEMS_TABLE, referenceRecordId)),
    ...(
      await Promise.all(
        relatedRecordIds.map((recordId) =>
          findCatalogItemIdsByReferenceRecord(db, SEARCH_CATALOG_ITEMS_TABLE, recordId),
        ),
      )
    ).flat(),
  ];

  await Promise.all([...new Set(itemIds)].map((itemId) => refreshDiscoverySearchItem(db, itemId)));
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

async function refreshItemsByField(db: PgQueryable, fieldId: string): Promise<void> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id
     FROM discovery_search_catalog_items
     WHERE field_values @> $1::jsonb`,
    [JSON.stringify([{ fieldId }])],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoverySearchItem(db, row.catalog_item_id)));
}

async function refreshItemsByDimension(db: PgQueryable, dimensionId: string): Promise<void> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT item.catalog_item_id
     FROM discovery_search_catalog_items AS item
     INNER JOIN discovery_search_catalog_blueprint_dimensions AS rule
       ON rule.blueprint_id = item.blueprint_id
     WHERE rule.dimension_id = $1`,
    [dimensionId],
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

async function applyCatalogItemDisplayIdentity(
  db: PgQueryable,
  input: CatalogItemDisplayIdentityResolvedEventData,
  updatedAt: string,
): Promise<void> {
  const resolvedSubtitle = input.subtitle?.trim() || null;
  const slug = createMarketplaceSlug([input.title, resolvedSubtitle], input.catalogItemId);
  const current = await db.query<{ slug: string | null }>(
    `SELECT slug FROM discovery_search_catalog_items WHERE catalog_item_id = $1`,
    [input.catalogItemId],
  );

  await db.query(
    `UPDATE discovery_search_catalog_items
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

  await refreshDiscoverySearchItem(db, input.catalogItemId);
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
        `UPDATE discovery_search_catalog_items
         SET description_i18n = $2,
             description = $3,
             updated_at = $4
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(descriptionI18n), resolvedDescription, event.timing.recordedAt],
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
    "catalog.catalog-item.product-asset-sets-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { productAssetSets } = event.data as { productAssetSets: unknown };

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET product_asset_sets = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(Array.isArray(productAssetSets) ? productAssetSets : []), event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.image-fallback-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { imageFallback } = event.data as { imageFallback: unknown };

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET image_fallback = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(imageFallback), event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.image-fallback-cleared": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET image_fallback = NULL,
             updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.retired": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_search_catalog_items
         SET status = 'archived', updated_at = $2
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

      await db.query(`DELETE FROM discovery_search_items WHERE catalog_item_id = $1`, [itemId]);
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
    "catalog.blueprint.dimensions-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX);
      const { dimensionRules } = event.data as {
        dimensionRules: Array<{
          dimensionId: string;
          required?: boolean;
          allowedOptionIds?: string[];
          appliesWhen?: unknown[];
        }>;
      };

      await db.query(`DELETE FROM discovery_search_catalog_blueprint_dimensions WHERE blueprint_id = $1`, [
        blueprintId,
      ]);

      for (const [index, rule] of dimensionRules.entries()) {
        await db.query(
          `INSERT INTO discovery_search_catalog_blueprint_dimensions (
             blueprint_id,
             dimension_id,
             required,
             allowed_option_ids,
             applies_when,
             display_order,
             updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (blueprint_id, dimension_id) DO UPDATE SET
             required = EXCLUDED.required,
             allowed_option_ids = EXCLUDED.allowed_option_ids,
             applies_when = EXCLUDED.applies_when,
             display_order = EXCLUDED.display_order,
             updated_at = EXCLUDED.updated_at`,
          [
            blueprintId,
            rule.dimensionId,
            Boolean(rule.required),
            JSON.stringify(asStringArray(rule.allowedOptionIds)),
            JSON.stringify(asArray(rule.appliesWhen)),
            index,
            event.timing.recordedAt,
          ],
        );
      }

      await refreshItemsByBlueprint(db, blueprintId);
    },

    "catalog.field.created": async (event) => {
      const { fieldId, name, valueType, behavior } = event.data as {
        fieldId: string;
        name: unknown;
        valueType?: string;
        behavior?: { filterable?: boolean; searchable?: boolean; sortable?: boolean };
      };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO discovery_search_catalog_fields (
           field_id,
           name,
           value_type,
           filterable,
           searchable,
           sortable,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (field_id) DO UPDATE SET
           name = EXCLUDED.name,
           value_type = EXCLUDED.value_type,
           filterable = EXCLUDED.filterable,
           searchable = EXCLUDED.searchable,
           sortable = EXCLUDED.sortable,
           updated_at = EXCLUDED.updated_at`,
        [
          fieldId,
          resolvedName,
          valueType ?? "string",
          Boolean(behavior?.filterable),
          Boolean(behavior?.searchable),
          Boolean(behavior?.sortable),
          event.timing.recordedAt,
        ],
      );

      await refreshItemsByField(db, fieldId);
    },
    "catalog.field.configured": async (event) => {
      const fieldId = extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX);
      const { name, valueType, behavior } = event.data as {
        name: unknown;
        valueType?: string;
        behavior?: { filterable?: boolean; searchable?: boolean; sortable?: boolean };
      };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO discovery_search_catalog_fields (
           field_id,
           name,
           value_type,
           filterable,
           searchable,
           sortable,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (field_id) DO UPDATE SET
           name = EXCLUDED.name,
           value_type = EXCLUDED.value_type,
           filterable = EXCLUDED.filterable,
           searchable = EXCLUDED.searchable,
           sortable = EXCLUDED.sortable,
           updated_at = EXCLUDED.updated_at`,
        [
          fieldId,
          resolvedName,
          valueType ?? "string",
          Boolean(behavior?.filterable),
          Boolean(behavior?.searchable),
          Boolean(behavior?.sortable),
          event.timing.recordedAt,
        ],
      );

      await refreshItemsByField(db, fieldId);
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
        `INSERT INTO ${SEARCH_REFERENCE_RECORDS_TABLE} (
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
        `INSERT INTO ${SEARCH_REFERENCE_RECORDS_TABLE} (
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
        `UPDATE ${SEARCH_REFERENCE_RECORDS_TABLE}
         SET status = 'active', updated_at = $2
         WHERE reference_record_id = $1`,
        [referenceRecordId, event.timing.recordedAt],
      );

      await refreshItemsByReferenceRecord(db, referenceRecordId);
    },
    "catalog.reference-record.deprecated": async (event) => {
      const referenceRecordId = extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX);

      await db.query(
        `UPDATE ${SEARCH_REFERENCE_RECORDS_TABLE}
         SET status = 'deprecated', updated_at = $2
         WHERE reference_record_id = $1`,
        [referenceRecordId, event.timing.recordedAt],
      );

      await refreshItemsByReferenceRecord(db, referenceRecordId);
    },
    "catalog.reference-record.archived": async (event) => {
      const referenceRecordId = extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX);

      await db.query(
        `UPDATE ${SEARCH_REFERENCE_RECORDS_TABLE}
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
        valueKind?: string;
      };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO discovery_search_catalog_dimensions (dimension_id, name, value_kind, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (dimension_id) DO UPDATE SET
           name = EXCLUDED.name,
           value_kind = EXCLUDED.value_kind,
           updated_at = EXCLUDED.updated_at`,
        [dimensionId, resolvedName, valueKind ?? "unordered", event.timing.recordedAt],
      );

      await refreshItemsByDimension(db, dimensionId);
    },
    "catalog.dimension.revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { name, valueKind } = event.data as { name: unknown; valueKind?: string };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO discovery_search_catalog_dimensions (dimension_id, name, value_kind, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (dimension_id) DO UPDATE SET
           name = EXCLUDED.name,
           value_kind = EXCLUDED.value_kind,
           updated_at = EXCLUDED.updated_at`,
        [dimensionId, resolvedName, valueKind ?? "unordered", event.timing.recordedAt],
      );

      await refreshItemsByDimension(db, dimensionId);
    },
    "catalog.dimension.option-added": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { optionId, code, label, displayOrder, numericValue, status } = event.data as {
        optionId: string;
        code?: string;
        label: unknown;
        displayOrder?: number;
        numericValue?: number | null;
        status?: string;
      };
      const resolvedLabel = resolveLocalizedText(coerceLocalizedTextMap(label));

      await db.query(
        `INSERT INTO discovery_search_catalog_dimension_options (
           option_id,
           dimension_id,
           code,
           label,
           display_order,
           numeric_value,
           status,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (option_id) DO UPDATE SET
           dimension_id = EXCLUDED.dimension_id,
           code = EXCLUDED.code,
           label = EXCLUDED.label,
           display_order = EXCLUDED.display_order,
           numeric_value = EXCLUDED.numeric_value,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [
          optionId,
          dimensionId,
          code ?? "",
          resolvedLabel,
          displayOrder ?? 0,
          numericValue ?? null,
          status ?? "active",
          event.timing.recordedAt,
        ],
      );

      await refreshItemsByDimension(db, dimensionId);
    },
    "catalog.dimension.option-revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { optionId, code, label, displayOrder, numericValue, status } = event.data as {
        optionId: string;
        code?: string;
        label: unknown;
        displayOrder?: number;
        numericValue?: number | null;
        status?: string;
      };
      const resolvedLabel = resolveLocalizedText(coerceLocalizedTextMap(label));

      await db.query(
        `INSERT INTO discovery_search_catalog_dimension_options (
           option_id,
           dimension_id,
           code,
           label,
           display_order,
           numeric_value,
           status,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (option_id) DO UPDATE SET
           dimension_id = EXCLUDED.dimension_id,
           code = EXCLUDED.code,
           label = EXCLUDED.label,
           display_order = EXCLUDED.display_order,
           numeric_value = EXCLUDED.numeric_value,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [
          optionId,
          dimensionId,
          code ?? "",
          resolvedLabel,
          displayOrder ?? 0,
          numericValue ?? null,
          status ?? "active",
          event.timing.recordedAt,
        ],
      );

      await refreshItemsByDimension(db, dimensionId);
    },
    "catalog.dimension.options-reordered": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { optionIds } = event.data as { optionIds: string[] };

      for (let i = 0; i < optionIds.length; i++) {
        await db.query(
          `UPDATE discovery_search_catalog_dimension_options
           SET display_order = $3, updated_at = $4
           WHERE dimension_id = $1 AND option_id = $2`,
          [dimensionId, optionIds[i], i, event.timing.recordedAt],
        );
      }

      await refreshItemsByDimension(db, dimensionId);
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
  if (value && typeof value === "object" && "defaultLocale" in value && "values" in value) {
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
