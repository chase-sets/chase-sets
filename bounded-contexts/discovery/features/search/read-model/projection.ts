import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import {
  appendJsonbArrayElement,
  asArray,
  asStringArray,
  loadNameMap,
  removeJsonbArrayElement,
  replaceJsonbArrayElement,
  refreshAffectedRows,
  runBoundedProjectionCascade,
  transitionStatus,
  updateRow,
  upsertRow,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { localizedTextMapValues } from "@chase-sets/localization";
import { buildDiscoveryEmbeddingDocument } from "../domain/embedding-document";
import { buildSimpleSearchText } from "../domain/normalization";
import { aliasTextByWeight, type ResolvedAlias, type SearchTextWeight } from "../domain/alias-weighting";
import { aliasSearchContributionEnabled } from "../domain/alias-rollout";
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
const SEARCH_PRODUCT_CONTENTS_TABLE = "discovery_search_product_contents";
const SEARCH_CATALOG_ITEM_CREATED_COLUMNS = [
  "catalog_item_id",
  "slug",
  "language_code",
  "title_i18n",
  "title",
  "subtitle_i18n",
  "subtitle",
  "description_i18n",
  "description",
  "status",
  "updated_at",
] as const;
const SEARCH_CATALOG_ITEM_CREATED_UPDATE_COLUMNS = [
  "slug",
  "language_code",
  "title_i18n",
  "title",
  "subtitle_i18n",
  "subtitle",
  "description_i18n",
  "description",
  "updated_at",
] as const;
const SEARCH_CATALOG_FIELD_COLUMNS = [
  "field_id",
  "name",
  "value_type",
  "filterable",
  "searchable",
  "sortable",
  "updated_at",
] as const;
const SEARCH_REFERENCE_RECORD_CREATED_COLUMNS = [
  "reference_record_id",
  "type_key",
  "key",
  "name",
  "attributes",
  "relationships",
  "status",
  "updated_at",
] as const;
const SEARCH_REFERENCE_RECORD_REVISED_COLUMNS = [
  "reference_record_id",
  "type_key",
  "key",
  "name",
  "attributes",
  "relationships",
  "updated_at",
] as const;
const SEARCH_REFERENCE_RECORD_UPDATE_COLUMNS = [
  "type_key",
  "key",
  "name",
  "attributes",
  "relationships",
  "updated_at",
] as const;
const SEARCH_DIMENSION_OPTION_COLUMNS = [
  "option_id",
  "dimension_id",
  "code",
  "label",
  "display_order",
  "numeric_value",
  "status",
  "updated_at",
] as const;

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
  resolved_aliases: unknown;
  updated_at: string;
}>;

type CatalogItemDisplayIdentityResolvedEventData = Readonly<{
  catalogItemId: string;
  languageCode?: string;
  title: string;
  subtitle?: string | null;
}>;

// Published Catalog resolved-alias fact. Discovery consumes this stable
// per-target, per-language fact only; an empty `aliases` list is a retraction.
type CatalogItemAliasesResolvedEventData = Readonly<{
  catalogItemId: string;
  aliasLanguageCode: string;
  aliases: readonly ResolvedAlias[];
  resolvedAliasHash?: string;
  resolverVersion?: number;
  resolvedAt?: string;
}>;

type ProductContentLineResolvedEventData = Readonly<{
  lineId: string;
  containerCatalogItemId: string;
  containerProductId: string | null;
  containedCatalogItemId: string | null;
  containedProductId: string | null;
  contentTypeId: string;
  contentTypeDiscoverySearchWeight?: number | null;
  resolutionStatus: "resolved" | "unresolved";
}>;

type ProductContentsResolvedEventData = Readonly<{
  containerCatalogItemId: string;
  containerProductId: string | null;
  lines: readonly ProductContentLineResolvedEventData[];
}>;

async function upsertSearchCatalogBlueprint(
  db: PgQueryable,
  input: Readonly<{ blueprintId: string; name: string; updatedAt: string }>,
): Promise<void> {
  await upsertRow(db, {
    table: "discovery_search_catalog_blueprints",
    insertColumns: ["blueprint_id", "name", "updated_at"],
    conflictColumns: ["blueprint_id"],
    values: { blueprint_id: input.blueprintId, name: input.name, updated_at: input.updatedAt },
  });
}

async function upsertSearchCatalogField(
  db: PgQueryable,
  input: Readonly<{
    fieldId: string;
    name: string;
    valueType: string;
    filterable: boolean;
    searchable: boolean;
    sortable: boolean;
    updatedAt: string;
  }>,
): Promise<void> {
  await upsertRow(db, {
    table: "discovery_search_catalog_fields",
    insertColumns: SEARCH_CATALOG_FIELD_COLUMNS,
    conflictColumns: ["field_id"],
    values: {
      field_id: input.fieldId,
      name: input.name,
      value_type: input.valueType,
      filterable: input.filterable,
      searchable: input.searchable,
      sortable: input.sortable,
      updated_at: input.updatedAt,
    },
  });
}

async function upsertSearchReferenceRecord(
  db: PgQueryable,
  input: Readonly<{
    referenceRecordId: string;
    typeKey: string;
    key: string;
    name: string;
    attributes: unknown;
    relationships: unknown;
    status?: string;
    updatedAt: string;
  }>,
): Promise<void> {
  if (input.status) {
    await upsertRow(db, {
      table: SEARCH_REFERENCE_RECORDS_TABLE,
      insertColumns: SEARCH_REFERENCE_RECORD_CREATED_COLUMNS,
      conflictColumns: ["reference_record_id"],
      updateColumns: SEARCH_REFERENCE_RECORD_UPDATE_COLUMNS,
      values: {
        reference_record_id: input.referenceRecordId,
        type_key: input.typeKey,
        key: input.key,
        name: input.name,
        attributes: input.attributes,
        relationships: input.relationships,
        status: input.status,
        updated_at: input.updatedAt,
      },
      casts: { attributes: "jsonb", relationships: "jsonb" },
    });
    return;
  }

  await upsertRow(db, {
    table: SEARCH_REFERENCE_RECORDS_TABLE,
    insertColumns: SEARCH_REFERENCE_RECORD_REVISED_COLUMNS,
    conflictColumns: ["reference_record_id"],
    updateColumns: SEARCH_REFERENCE_RECORD_UPDATE_COLUMNS,
    values: {
      reference_record_id: input.referenceRecordId,
      type_key: input.typeKey,
      key: input.key,
      name: input.name,
      attributes: input.attributes,
      relationships: input.relationships,
      updated_at: input.updatedAt,
    },
    casts: { attributes: "jsonb", relationships: "jsonb" },
  });
}

async function upsertSearchCatalogDimension(
  db: PgQueryable,
  input: Readonly<{ dimensionId: string; name: string; valueKind: string; updatedAt: string }>,
): Promise<void> {
  await upsertRow(db, {
    table: "discovery_search_catalog_dimensions",
    insertColumns: ["dimension_id", "name", "value_kind", "updated_at"],
    conflictColumns: ["dimension_id"],
    values: {
      dimension_id: input.dimensionId,
      name: input.name,
      value_kind: input.valueKind,
      updated_at: input.updatedAt,
    },
  });
}

async function upsertSearchDimensionOption(
  db: PgQueryable,
  input: Readonly<{
    optionId: string;
    dimensionId: string;
    code: string;
    label: string;
    displayOrder: number;
    numericValue: number | null;
    status: string;
    updatedAt: string;
  }>,
): Promise<void> {
  await upsertRow(db, {
    table: "discovery_search_catalog_dimension_options",
    insertColumns: SEARCH_DIMENSION_OPTION_COLUMNS,
    conflictColumns: ["option_id"],
    values: {
      option_id: input.optionId,
      dimension_id: input.dimensionId,
      code: input.code,
      label: input.label,
      display_order: input.displayOrder,
      numeric_value: input.numericValue,
      status: input.status,
      updated_at: input.updatedAt,
    },
  });
}

async function upsertSearchCategory(
  db: PgQueryable,
  input: Readonly<{ categoryId: string; slug: string; name: string; updatedAt: string }>,
): Promise<void> {
  await upsertRow(db, {
    table: "discovery_search_catalog_categories",
    insertColumns: ["category_id", "slug", "name", "updated_at"],
    conflictColumns: ["category_id"],
    values: {
      category_id: input.categoryId,
      slug: input.slug,
      name: input.name,
      updated_at: input.updatedAt,
    },
  });
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

async function buildContentSearchText(db: PgQueryable, containedCatalogItemId: string): Promise<string> {
  const result = await db.query<SearchCatalogItemRow>(
    `SELECT * FROM discovery_search_catalog_items WHERE catalog_item_id = $1`,
    [containedCatalogItemId],
  );
  const item = result.rows[0];
  if (!item || item.status !== "active") {
    return "";
  }

  return uniqueStrings([
    item.title,
    item.subtitle ?? "",
    ...localizedMapValues(item.title_i18n),
    ...localizedMapValues(item.subtitle_i18n),
  ])
    .filter((entry) => entry.trim().length > 0)
    .join(" ");
}

function contentSearchWeight(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return 0.2;
  }

  return Math.max(0, Math.min(1, Number(value)));
}

async function upsertSearchProductContent(
  db: PgQueryable,
  line: ProductContentLineResolvedEventData & { containedCatalogItemId: string },
  updatedAt: string,
): Promise<void> {
  const contentSearchText = await buildContentSearchText(db, line.containedCatalogItemId);
  const contentSearchTextSimple = buildSimpleSearchText(contentSearchText);

  await db.query(
    `INSERT INTO ${SEARCH_PRODUCT_CONTENTS_TABLE} (
       line_id,
       container_catalog_item_id,
       container_product_id,
       contained_catalog_item_id,
       contained_product_id,
       content_type_id,
       content_type_search_weight,
       content_search_text,
       content_search_text_simple,
       search_text,
       search_text_simple,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_tsvector('english', $8), to_tsvector('simple', $9), $10)
     ON CONFLICT (line_id) DO UPDATE SET
       container_catalog_item_id = EXCLUDED.container_catalog_item_id,
       container_product_id = EXCLUDED.container_product_id,
       contained_catalog_item_id = EXCLUDED.contained_catalog_item_id,
       contained_product_id = EXCLUDED.contained_product_id,
       content_type_id = EXCLUDED.content_type_id,
       content_type_search_weight = EXCLUDED.content_type_search_weight,
       content_search_text = EXCLUDED.content_search_text,
       content_search_text_simple = EXCLUDED.content_search_text_simple,
       search_text = EXCLUDED.search_text,
       search_text_simple = EXCLUDED.search_text_simple,
       updated_at = EXCLUDED.updated_at`,
    [
      line.lineId,
      line.containerCatalogItemId,
      line.containerProductId,
      line.containedCatalogItemId,
      line.containedProductId,
      line.contentTypeId,
      contentSearchWeight(line.contentTypeDiscoverySearchWeight),
      contentSearchText,
      contentSearchTextSimple,
      updatedAt,
    ],
  );
}

async function applyProductContentsResolved(
  db: PgQueryable,
  input: ProductContentsResolvedEventData,
  updatedAt: string,
): Promise<void> {
  await db.query(
    `DELETE FROM ${SEARCH_PRODUCT_CONTENTS_TABLE}
     WHERE container_catalog_item_id = $1
       AND (
         (container_product_id IS NULL AND $2::text IS NULL)
         OR container_product_id = $2
       )`,
    [input.containerCatalogItemId, input.containerProductId],
  );

  for (const line of input.lines) {
    if (line.resolutionStatus !== "resolved" || !line.containedCatalogItemId) {
      continue;
    }

    await upsertSearchProductContent(
      db,
      {
        ...line,
        containedCatalogItemId: line.containedCatalogItemId,
      },
      updatedAt,
    );
  }
}

async function refreshSearchProductContentsForContainedItem(
  db: PgQueryable,
  containedCatalogItemId: string,
  updatedAt: string,
): Promise<void> {
  const contentSearchText = await buildContentSearchText(db, containedCatalogItemId);
  const contentSearchTextSimple = buildSimpleSearchText(contentSearchText);

  await db.query(
    `UPDATE ${SEARCH_PRODUCT_CONTENTS_TABLE}
     SET content_search_text = $2,
         content_search_text_simple = $3,
         search_text = to_tsvector('english', $2),
         search_text_simple = to_tsvector('simple', $3),
         updated_at = $4
     WHERE contained_catalog_item_id = $1`,
    [containedCatalogItemId, contentSearchText, contentSearchTextSimple, updatedAt],
  );
}

async function refreshDiscoverySearchItem(
  db: PgQueryable,
  itemId: string,
  options: Readonly<{ refreshProductContentText?: boolean }> = {},
): Promise<void> {
  const result = await db.query<SearchCatalogItemRow>(
    `SELECT * FROM discovery_search_catalog_items WHERE catalog_item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM discovery_search_items WHERE catalog_item_id = $1`, [itemId]);
    if (options.refreshProductContentText) {
      await refreshSearchProductContentsForContainedItem(db, itemId, new Date().toISOString());
    }
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

  const blueprintNames = item.blueprint_id
    ? await loadNameMap(db, "discovery_search_catalog_blueprints", "blueprint_id", "name", [item.blueprint_id])
    : new Map<string, string>();
  const categoryRefs = await loadCategoryMap(db, categoryIds);

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

  // Resolved Catalog alias text folds into search only when the rollout
  // kill-switch is open. Title/subtitle/description keep ownership of display and
  // slugs; aliases add matchable text at type-aware weights so a broad species
  // alias never outranks an exact title or an official equivalent.
  const aliasWeights = aliasSearchContributionEnabled()
    ? aliasTextByWeight(collectResolvedAliases(item.resolved_aliases))
    : EMPTY_ALIAS_WEIGHTS;

  // Base item text keeps weight ordering title > subtitle > body so existing
  // English relevance ranks the resolved display identity highest; aliases merge
  // into the same tiers per their resolved weight.
  const baseTextByWeight: Record<SearchTextWeight, string> = {
    A: [item.title].filter(Boolean).join(" "),
    B: [item.subtitle ?? ""].filter(Boolean).join(" "),
    C: [localizedText, ...tags, fieldValuesText, blueprintName ?? "", ...categoryNameList].filter(Boolean).join(" "),
    D: item.description,
  };

  const weightedText: Record<SearchTextWeight, string> = {
    A: joinSearchText(baseTextByWeight.A, aliasWeights.A),
    B: joinSearchText(baseTextByWeight.B, aliasWeights.B),
    C: joinSearchText(baseTextByWeight.C, aliasWeights.C),
    D: joinSearchText(baseTextByWeight.D, aliasWeights.D),
  };
  const embeddingDocument = buildDiscoveryEmbeddingDocument({
    title: item.title,
    titleI18n: item.title_i18n,
    subtitle: item.subtitle,
    subtitleI18n: item.subtitle_i18n,
    resolvedAliases: item.resolved_aliases,
    categoryNames: categoryNameList,
    keyFieldValues: fieldValuesText ? [fieldValuesText] : [],
    description: item.description,
    descriptionI18n: item.description_i18n,
  });

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
      embedded_text_hash,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
      setweight(to_tsvector('english', $23), 'A') ||
        setweight(to_tsvector('english', $24), 'B') ||
        setweight(to_tsvector('english', $25), 'C') ||
        setweight(to_tsvector('english', $26), 'D'),
      setweight(to_tsvector('simple', $27), 'A') ||
        setweight(to_tsvector('simple', $28), 'B') ||
        setweight(to_tsvector('simple', $29), 'C') ||
        setweight(to_tsvector('simple', $30), 'D'),
      $31,
      $32)
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
      embedding_updated_at = CASE
        WHEN discovery_search_items.embedded_text_hash IS NOT DISTINCT FROM EXCLUDED.embedded_text_hash
          THEN discovery_search_items.embedding_updated_at
        ELSE NULL
      END,
      embedded_text_hash = EXCLUDED.embedded_text_hash,
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
      weightedText.A,
      weightedText.B,
      weightedText.C,
      weightedText.D,
      buildSimpleSearchText(weightedText.A),
      buildSimpleSearchText(weightedText.B),
      buildSimpleSearchText(weightedText.C),
      buildSimpleSearchText(weightedText.D),
      embeddingDocument.hash,
      item.updated_at,
    ],
  );

  if (options.refreshProductContentText) {
    await refreshSearchProductContentsForContainedItem(db, item.catalog_item_id, item.updated_at);
  }
}

const EMPTY_ALIAS_WEIGHTS: Readonly<Record<SearchTextWeight, string>> = { A: "", B: "", C: "", D: "" };

function joinSearchText(...parts: readonly string[]): string {
  return parts.filter((part) => part.trim().length > 0).join(" ");
}

/**
 * Flattens the per-language resolved alias map stored on the search source row
 * into one alias list. Discovery dedupes downstream by alias hash and by
 * catalog_item_id, so carrying every language here is safe and keeps English and
 * native-script aliases both searchable.
 */
function collectResolvedAliases(value: unknown): ResolvedAlias[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.values(value as Record<string, unknown>).flatMap((entry) =>
    Array.isArray(entry) ? (entry.filter(isResolvedAlias) as ResolvedAlias[]) : [],
  );
}

function isResolvedAlias(value: unknown): value is ResolvedAlias {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { aliasText?: unknown }).aliasText === "string" &&
    typeof (value as { aliasType?: unknown }).aliasType === "string"
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

/**
 * Refresh a set of search items, bounded + resumable when a cascade controller is
 * active (a projection event apply): at most the per-pass budget is refreshed and a
 * durable cursor lets a large fan-out resume on a later pass without exceeding the
 * transaction budget. Without a controller (rebuild/retry) it refreshes the whole set.
 */
async function refreshDiscoverySearchItems(
  db: PgQueryable,
  itemIds: readonly string[],
  throwIfCancelled?: () => void,
): Promise<void> {
  await runBoundedProjectionCascade(itemIds, async (slice) => {
    for (const itemId of slice) {
      throwIfCancelled?.();
      await refreshDiscoverySearchItem(db, itemId);
    }
    throwIfCancelled?.();
  });
}

async function refreshItemsByReferenceRecord(
  db: PgQueryable,
  referenceRecordId: string,
  throwIfCancelled?: () => void,
): Promise<void> {
  throwIfCancelled?.();
  const relatedRecordIds = await findReferenceRecordIdsByRelatedReferenceGraph(
    db,
    SEARCH_REFERENCE_RECORDS_TABLE,
    referenceRecordId,
  );
  const itemIds = [...(await findCatalogItemIdsByReferenceRecord(db, SEARCH_CATALOG_ITEMS_TABLE, referenceRecordId))];

  for (const recordId of relatedRecordIds) {
    throwIfCancelled?.();
    itemIds.push(...(await findCatalogItemIdsByReferenceRecord(db, SEARCH_CATALOG_ITEMS_TABLE, recordId)));
  }

  await refreshDiscoverySearchItems(db, itemIds, throwIfCancelled);
}

export async function rebuildDiscoverySearchIndex(db: PgQueryable): Promise<void> {
  await db.query(`TRUNCATE discovery_search_items`);

  await refreshAffectedRows(db, {
    select: { column: "catalog_item_id" },
    from: { table: SEARCH_CATALOG_ITEMS_TABLE },
    orderBy: [{ column: "catalog_item_id" }],
    refresh: (itemId) => refreshDiscoverySearchItem(db, itemId, { refreshProductContentText: true }),
  });
}

async function refreshItemsByBlueprint(
  db: PgQueryable,
  blueprintId: string,
  throwIfCancelled?: () => void,
): Promise<void> {
  const itemIds = await refreshAffectedRows(db, {
    select: { column: "catalog_item_id" },
    from: { table: SEARCH_CATALOG_ITEMS_TABLE },
    where: [{ column: "blueprint_id", value: blueprintId }],
    throwIfCancelled,
    refresh: () => Promise.resolve(),
  });
  await refreshDiscoverySearchItems(db, itemIds, throwIfCancelled);
}

async function refreshItemsByField(db: PgQueryable, fieldId: string, throwIfCancelled?: () => void): Promise<void> {
  const itemIds = await refreshAffectedRows(db, {
    select: { column: "catalog_item_id" },
    from: { table: SEARCH_CATALOG_ITEMS_TABLE },
    where: [{ column: "field_values", operator: "@>", cast: "jsonb", value: [{ fieldId }] }],
    throwIfCancelled,
    refresh: () => Promise.resolve(),
  });
  await refreshDiscoverySearchItems(db, itemIds, throwIfCancelled);
}

async function refreshItemsByDimension(
  db: PgQueryable,
  dimensionId: string,
  throwIfCancelled?: () => void,
): Promise<void> {
  const itemIds = await refreshAffectedRows(db, {
    select: { tableAlias: "item", column: "catalog_item_id", distinct: true },
    from: { table: SEARCH_CATALOG_ITEMS_TABLE, alias: "item" },
    joins: [
      {
        table: "discovery_search_catalog_blueprint_dimensions",
        alias: "rule",
        on: [
          {
            left: { tableAlias: "rule", column: "blueprint_id" },
            right: { tableAlias: "item", column: "blueprint_id" },
          },
        ],
      },
    ],
    where: [{ tableAlias: "rule", column: "dimension_id", value: dimensionId }],
    throwIfCancelled,
    refresh: () => Promise.resolve(),
  });
  await refreshDiscoverySearchItems(db, itemIds, throwIfCancelled);
}

async function refreshItemsByCategory(
  db: PgQueryable,
  categoryId: string,
  throwIfCancelled?: () => void,
): Promise<void> {
  const itemIds = await refreshAffectedRows(db, {
    select: { column: "catalog_item_id" },
    from: { table: SEARCH_CATALOG_ITEMS_TABLE },
    where: [{ column: "category_ids", operator: "@>", cast: "jsonb", value: [categoryId] }],
    throwIfCancelled,
    refresh: () => Promise.resolve(),
  });
  await refreshDiscoverySearchItems(db, itemIds, throwIfCancelled);
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

  await refreshDiscoverySearchItem(db, input.catalogItemId, { refreshProductContentText: true });
}

/**
 * Applies a published resolved-alias fact to the search source row,
 * per alias language. A non-empty list sets that language's aliases; an empty
 * list is a retraction and removes the language key so the aliases drop out of
 * search_text on the event (and on rebuild, since rebuild reads the same row).
 * Display columns (title/subtitle/slug) are never touched here.
 */
async function applyCatalogItemResolvedAliases(
  db: PgQueryable,
  input: CatalogItemAliasesResolvedEventData,
  updatedAt: string,
): Promise<void> {
  const languageCode = input.aliasLanguageCode;
  const aliases = Array.isArray(input.aliases) ? input.aliases : [];

  if (aliases.length === 0) {
    await db.query(
      `UPDATE discovery_search_catalog_items
       SET resolved_aliases = COALESCE(resolved_aliases, '{}'::jsonb) - $2,
           updated_at = $3
       WHERE catalog_item_id = $1`,
      [input.catalogItemId, languageCode, updatedAt],
    );
  } else {
    await db.query(
      `UPDATE discovery_search_catalog_items
       SET resolved_aliases = COALESCE(resolved_aliases, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb),
           updated_at = $4
       WHERE catalog_item_id = $1`,
      [input.catalogItemId, languageCode, JSON.stringify(aliases), updatedAt],
    );
  }

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

      await upsertRow(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        insertColumns: SEARCH_CATALOG_ITEM_CREATED_COLUMNS,
        conflictColumns: ["catalog_item_id"],
        updateColumns: SEARCH_CATALOG_ITEM_CREATED_UPDATE_COLUMNS,
        values: {
          catalog_item_id: itemId,
          slug,
          language_code: languageCode ?? "en",
          title_i18n: titleI18n,
          title: resolvedTitle,
          subtitle_i18n: subtitleI18n,
          subtitle: resolvedSubtitle,
          description_i18n: descriptionI18n,
          description: resolvedDescription,
          status: "draft",
          updated_at: event.timing.recordedAt,
        },
        casts: { title_i18n: "jsonb", description_i18n: "jsonb" },
      });

      await refreshDiscoverySearchItem(db, itemId, { refreshProductContentText: true });
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { blueprintId } = event.data as { blueprintId: string };

      await updateRow(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        setColumns: ["blueprint_id", "updated_at"],
        values: { blueprint_id: blueprintId, updated_at: event.timing.recordedAt },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.field-value-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { fieldId, value } = event.data as { fieldId: string; value: unknown };

      await replaceJsonbArrayElement(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        key: { column: "catalog_item_id", value: itemId },
        column: "field_values",
        match: { kind: "pathText", path: ["fieldId"], value: fieldId },
        element: { fieldId, value },
        updatedAt: { value: event.timing.recordedAt },
      });

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.field-value-cleared": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { fieldId } = event.data as { fieldId: string };

      await removeJsonbArrayElement(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        key: { column: "catalog_item_id", value: itemId },
        column: "field_values",
        match: { kind: "pathText", path: ["fieldId"], value: fieldId },
        updatedAt: { value: event.timing.recordedAt },
      });

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await appendJsonbArrayElement(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        key: { column: "catalog_item_id", value: itemId },
        column: "category_ids",
        element: categoryId,
        unique: true,
        updatedAt: { value: event.timing.recordedAt },
      });

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.category-removed": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await removeJsonbArrayElement(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        key: { column: "catalog_item_id", value: itemId },
        column: "category_ids",
        match: { kind: "value", value: categoryId },
        updatedAt: { value: event.timing.recordedAt },
      });

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.published": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await transitionStatus(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        idColumn: "catalog_item_id",
        id: itemId,
        status: "active",
        updatedAt: event.timing.recordedAt,
      });

      await refreshDiscoverySearchItem(db, itemId, { refreshProductContentText: true });
    },
    "catalog.catalog-item.display-identity-resolved": async (event) => {
      await applyCatalogItemDisplayIdentity(
        db,
        event.data as CatalogItemDisplayIdentityResolvedEventData,
        event.timing.recordedAt,
      );
    },
    "catalog.catalog-item.aliases-resolved": async (event) => {
      await applyCatalogItemResolvedAliases(
        db,
        event.data as CatalogItemAliasesResolvedEventData,
        event.timing.recordedAt,
      );
    },
    "catalog.product-contents.resolved": async (event) => {
      await applyProductContentsResolved(db, event.data as ProductContentsResolvedEventData, event.timing.recordedAt);
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { description } = event.data as {
        description: unknown;
      };
      const descriptionI18n = coerceLocalizedTextMap(description);
      const resolvedDescription = resolveLocalizedText(descriptionI18n);

      await updateRow(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        setColumns: ["description_i18n", "description", "updated_at"],
        values: {
          description_i18n: descriptionI18n,
          description: resolvedDescription,
          updated_at: event.timing.recordedAt,
        },
        casts: { description_i18n: "jsonb" },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.tags-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { tags } = event.data as { tags: string[] };

      await updateRow(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        setColumns: ["tags", "updated_at"],
        values: { tags, updated_at: event.timing.recordedAt },
        casts: { tags: "jsonb" },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.image-urls-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { imageUrls } = event.data as { imageUrls: string[] };

      await updateRow(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        setColumns: ["image_urls", "updated_at"],
        values: { image_urls: imageUrls, updated_at: event.timing.recordedAt },
        casts: { image_urls: "jsonb" },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.product-asset-sets-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { productAssetSets } = event.data as { productAssetSets: unknown };

      await updateRow(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        setColumns: ["product_asset_sets", "updated_at"],
        values: {
          product_asset_sets: Array.isArray(productAssetSets) ? productAssetSets : [],
          updated_at: event.timing.recordedAt,
        },
        casts: { product_asset_sets: "jsonb" },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.image-fallback-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { imageFallback } = event.data as { imageFallback: unknown };

      await updateRow(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        setColumns: ["image_fallback", "updated_at"],
        values: { image_fallback: imageFallback, updated_at: event.timing.recordedAt },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.image-fallback-cleared": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await updateRow(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        setColumns: ["image_fallback", "updated_at"],
        values: { image_fallback: null, updated_at: event.timing.recordedAt },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoverySearchItem(db, itemId);
    },
    "catalog.catalog-item.retired": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await transitionStatus(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        idColumn: "catalog_item_id",
        id: itemId,
        status: "archived",
        updatedAt: event.timing.recordedAt,
      });

      await refreshDiscoverySearchItem(db, itemId, { refreshProductContentText: true });
    },
    "catalog.catalog-item.archived": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await transitionStatus(db, {
        table: SEARCH_CATALOG_ITEMS_TABLE,
        idColumn: "catalog_item_id",
        id: itemId,
        status: "archived",
        updatedAt: event.timing.recordedAt,
      });

      await db.query(`DELETE FROM discovery_search_items WHERE catalog_item_id = $1`, [itemId]);
      await refreshSearchProductContentsForContainedItem(db, itemId, event.timing.recordedAt);
    },

    "catalog.blueprint.created": async (event) => {
      const { blueprintId, name } = event.data as { blueprintId: string; name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertSearchCatalogBlueprint(db, {
        blueprintId,
        name: resolvedName,
        updatedAt: event.timing.recordedAt,
      });
    },
    "catalog.blueprint.revised": async (event, context) => {
      const blueprintId = extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX);
      const { name } = event.data as { name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertSearchCatalogBlueprint(db, {
        blueprintId,
        name: resolvedName,
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByBlueprint(db, blueprintId, context?.throwIfLeaseLost);
    },
    "catalog.blueprint.dimensions-set": async (event, context) => {
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

      const latestRules = new Map(dimensionRules.map((rule, index) => [rule.dimensionId, { rule, index }] as const));
      for (const { rule, index } of latestRules.values()) {
        await upsertRow(db, {
          table: "discovery_search_catalog_blueprint_dimensions",
          insertColumns: [
            "blueprint_id",
            "dimension_id",
            "required",
            "allowed_option_ids",
            "applies_when",
            "display_order",
            "updated_at",
          ],
          conflictColumns: ["blueprint_id", "dimension_id"],
          values: {
            blueprint_id: blueprintId,
            dimension_id: rule.dimensionId,
            required: Boolean(rule.required),
            allowed_option_ids: asStringArray(rule.allowedOptionIds),
            applies_when: asArray(rule.appliesWhen),
            display_order: index,
            updated_at: event.timing.recordedAt,
          },
          casts: { allowed_option_ids: "jsonb", applies_when: "jsonb" },
        });
      }

      await refreshItemsByBlueprint(db, blueprintId, context?.throwIfLeaseLost);
    },

    "catalog.field.created": async (event, context) => {
      const { fieldId, name, valueType, behavior } = event.data as {
        fieldId: string;
        name: unknown;
        valueType?: string;
        behavior?: { filterable?: boolean; searchable?: boolean; sortable?: boolean };
      };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertSearchCatalogField(db, {
        fieldId,
        name: resolvedName,
        valueType: valueType ?? "string",
        filterable: Boolean(behavior?.filterable),
        searchable: Boolean(behavior?.searchable),
        sortable: Boolean(behavior?.sortable),
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByField(db, fieldId, context?.throwIfLeaseLost);
    },
    "catalog.field.configured": async (event, context) => {
      const fieldId = extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX);
      const { name, valueType, behavior } = event.data as {
        name: unknown;
        valueType?: string;
        behavior?: { filterable?: boolean; searchable?: boolean; sortable?: boolean };
      };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertSearchCatalogField(db, {
        fieldId,
        name: resolvedName,
        valueType: valueType ?? "string",
        filterable: Boolean(behavior?.filterable),
        searchable: Boolean(behavior?.searchable),
        sortable: Boolean(behavior?.sortable),
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByField(db, fieldId, context?.throwIfLeaseLost);
    },

    "catalog.reference-record.created": async (event, context) => {
      const { referenceRecordId, typeKey, key, name, attributes, relationships } = event.data as {
        referenceRecordId: string;
        typeKey: string;
        key: string;
        name: unknown;
        attributes?: unknown;
        relationships?: unknown;
      };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertSearchReferenceRecord(db, {
        referenceRecordId,
        typeKey,
        key,
        name: resolvedName,
        attributes: attributes ?? {},
        relationships: Array.isArray(relationships) ? relationships : [],
        status: "draft",
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByReferenceRecord(db, referenceRecordId, context?.throwIfLeaseLost);
    },
    "catalog.reference-record.revised": async (event, context) => {
      const referenceRecordId = extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX);
      const { typeKey, key, name, attributes, relationships } = event.data as {
        typeKey: string;
        key: string;
        name: unknown;
        attributes?: unknown;
        relationships?: unknown;
      };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertSearchReferenceRecord(db, {
        referenceRecordId,
        typeKey,
        key,
        name: resolvedName,
        attributes: attributes ?? {},
        relationships: Array.isArray(relationships) ? relationships : [],
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByReferenceRecord(db, referenceRecordId, context?.throwIfLeaseLost);
    },
    "catalog.reference-record.published": async (event, context) => {
      const referenceRecordId = extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX);

      await transitionStatus(db, {
        table: SEARCH_REFERENCE_RECORDS_TABLE,
        idColumn: "reference_record_id",
        id: referenceRecordId,
        status: "active",
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByReferenceRecord(db, referenceRecordId, context?.throwIfLeaseLost);
    },
    "catalog.reference-record.deprecated": async (event, context) => {
      const referenceRecordId = extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX);

      await transitionStatus(db, {
        table: SEARCH_REFERENCE_RECORDS_TABLE,
        idColumn: "reference_record_id",
        id: referenceRecordId,
        status: "deprecated",
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByReferenceRecord(db, referenceRecordId, context?.throwIfLeaseLost);
    },
    "catalog.reference-record.archived": async (event, context) => {
      const referenceRecordId = extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX);

      await transitionStatus(db, {
        table: SEARCH_REFERENCE_RECORDS_TABLE,
        idColumn: "reference_record_id",
        id: referenceRecordId,
        status: "archived",
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByReferenceRecord(db, referenceRecordId, context?.throwIfLeaseLost);
    },

    "catalog.dimension.created": async (event, context) => {
      const { dimensionId, name, valueKind } = event.data as {
        dimensionId: string;
        name: unknown;
        valueKind?: string;
      };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertSearchCatalogDimension(db, {
        dimensionId,
        name: resolvedName,
        valueKind: valueKind ?? "unordered",
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByDimension(db, dimensionId, context?.throwIfLeaseLost);
    },
    "catalog.dimension.revised": async (event, context) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { name, valueKind } = event.data as { name: unknown; valueKind?: string };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertSearchCatalogDimension(db, {
        dimensionId,
        name: resolvedName,
        valueKind: valueKind ?? "unordered",
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByDimension(db, dimensionId, context?.throwIfLeaseLost);
    },
    "catalog.dimension.option-added": async (event, context) => {
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

      await upsertSearchDimensionOption(db, {
        optionId,
        dimensionId,
        code: code ?? "",
        label: resolvedLabel,
        displayOrder: displayOrder ?? 0,
        numericValue: numericValue ?? null,
        status: status ?? "active",
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByDimension(db, dimensionId, context?.throwIfLeaseLost);
    },
    "catalog.dimension.option-revised": async (event, context) => {
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

      await upsertSearchDimensionOption(db, {
        optionId,
        dimensionId,
        code: code ?? "",
        label: resolvedLabel,
        displayOrder: displayOrder ?? 0,
        numericValue: numericValue ?? null,
        status: status ?? "active",
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByDimension(db, dimensionId, context?.throwIfLeaseLost);
    },
    "catalog.dimension.options-reordered": async (event, context) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { optionIds } = event.data as { optionIds: string[] };

      const latestOptionOrders = new Map(optionIds.map((optionId, index) => [optionId, index] as const));
      for (const [optionId, index] of latestOptionOrders.entries()) {
        context?.throwIfLeaseLost?.();
        await updateRow(db, {
          table: "discovery_search_catalog_dimension_options",
          setColumns: ["display_order", "updated_at"],
          values: { display_order: index, updated_at: event.timing.recordedAt },
          where: {
            columns: ["dimension_id", "option_id"],
            values: { dimension_id: dimensionId, option_id: optionId },
          },
        });
      }

      await refreshItemsByDimension(db, dimensionId, context?.throwIfLeaseLost);
    },

    "catalog.category.created": async (event) => {
      const { categoryId, name } = event.data as { categoryId: string; name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));
      const slug = createMarketplaceSlug([resolvedName], categoryId);

      await upsertSearchCategory(db, {
        categoryId,
        slug,
        name: resolvedName,
        updatedAt: event.timing.recordedAt,
      });
    },
    "catalog.category.revised": async (event, context) => {
      const categoryId = extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX);
      const { name } = event.data as { name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));
      const slug = createMarketplaceSlug([resolvedName], categoryId);
      const current = await db.query<{ slug: string | null }>(
        `SELECT slug FROM discovery_search_catalog_categories WHERE category_id = $1`,
        [categoryId],
      );

      await upsertSearchCategory(db, {
        categoryId,
        slug,
        name: resolvedName,
        updatedAt: event.timing.recordedAt,
      });
      await rememberSlugRedirect(db, {
        entityKind: "category",
        entityId: categoryId,
        previousSlug: current.rows[0]?.slug,
        nextSlug: slug,
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByCategory(db, categoryId, context?.throwIfLeaseLost);
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
