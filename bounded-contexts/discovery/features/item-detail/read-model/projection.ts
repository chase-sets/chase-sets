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
  transitionStatus,
  updateRow,
  upsertRow,
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
const ITEM_DETAIL_PAGE_TABLE = "discovery_item_detail_pages";
const ITEM_DETAIL_CATALOG_ITEM_CREATED_COLUMNS = [
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
const ITEM_DETAIL_CATALOG_ITEM_CREATED_UPDATE_COLUMNS = [
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
const ITEM_DETAIL_PAGE_COLUMNS = [
  "catalog_item_id",
  "slug",
  "language_code",
  "title_i18n",
  "title",
  "subtitle_i18n",
  "subtitle",
  "description_i18n",
  "description",
  "blueprint_id",
  "blueprint",
  "status",
  "field_values",
  "categories",
  "tags",
  "image_urls",
  "product_asset_sets",
  "image_fallback",
  "product_schema",
  "updated_at",
] as const;
const ITEM_DETAIL_REFERENCE_RECORD_CREATED_COLUMNS = [
  "reference_record_id",
  "type_key",
  "key",
  "name",
  "attributes",
  "relationships",
  "status",
  "updated_at",
] as const;
const ITEM_DETAIL_REFERENCE_RECORD_REVISED_COLUMNS = [
  "reference_record_id",
  "type_key",
  "key",
  "name",
  "attributes",
  "relationships",
  "updated_at",
] as const;
const ITEM_DETAIL_REFERENCE_RECORD_UPDATE_COLUMNS = [
  "type_key",
  "key",
  "name",
  "attributes",
  "relationships",
  "updated_at",
] as const;
const ITEM_DETAIL_DIMENSION_OPTION_COLUMNS = [
  "option_id",
  "dimension_id",
  "code",
  "label_i18n",
  "label",
  "display_order",
  "numeric_value",
  "updated_at",
] as const;

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

type ProductContentSelectedOption = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

type ProductContentLineSnapshot = Readonly<{
  lineId: string;
  containerCatalogItemId: string;
  containerSelectedOptions: readonly ProductContentSelectedOption[] | null;
  containerProductId: string | null;
  containedCatalogItemId: string | null;
  containedSelectedOptions: readonly ProductContentSelectedOption[] | null;
  containedProductId: string | null;
  quantity: number | null;
  contentTypeId: string;
  contentTypeDisplayName?: LocalizedTextMap | null;
  inclusionPolicyId: string | null;
  inclusionPolicyDisplayName?: LocalizedTextMap | null;
  provenance: unknown;
  resolutionStatus: "resolved" | "unresolved";
  targetLifecycleStatus: string | null;
}>;

type ProductContentsResolvedFact = Readonly<{
  containerCatalogItemId: string;
  containerSelectedOptions: readonly ProductContentSelectedOption[] | null;
  containerProductId: string | null;
  lines: readonly ProductContentLineSnapshot[];
  resolvedFactHash: string;
  resolverVersion: number;
  resolvedAt: string;
}>;

async function upsertItemDetailCatalogBlueprint(
  db: PgQueryable,
  input: Readonly<{ blueprintId: string; name: string; updatedAt: string }>,
): Promise<void> {
  await upsertRow(db, {
    table: "discovery_item_detail_catalog_blueprints",
    insertColumns: ["blueprint_id", "name", "updated_at"],
    conflictColumns: ["blueprint_id"],
    values: { blueprint_id: input.blueprintId, name: input.name, updated_at: input.updatedAt },
  });
}

async function upsertItemDetailCategory(
  db: PgQueryable,
  input: Readonly<{ categoryId: string; slug: string; name: string; updatedAt: string }>,
): Promise<void> {
  await upsertRow(db, {
    table: "discovery_item_detail_catalog_categories",
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

async function upsertItemDetailField(
  db: PgQueryable,
  input: Readonly<{ fieldId: string; name: string; updatedAt: string }>,
): Promise<void> {
  await upsertRow(db, {
    table: "discovery_item_detail_catalog_fields",
    insertColumns: ["field_id", "name", "updated_at"],
    conflictColumns: ["field_id"],
    values: { field_id: input.fieldId, name: input.name, updated_at: input.updatedAt },
  });
}

async function upsertItemDetailReferenceRecord(
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
      table: ITEM_DETAIL_REFERENCE_RECORDS_TABLE,
      insertColumns: ITEM_DETAIL_REFERENCE_RECORD_CREATED_COLUMNS,
      conflictColumns: ["reference_record_id"],
      updateColumns: ITEM_DETAIL_REFERENCE_RECORD_UPDATE_COLUMNS,
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
    table: ITEM_DETAIL_REFERENCE_RECORDS_TABLE,
    insertColumns: ITEM_DETAIL_REFERENCE_RECORD_REVISED_COLUMNS,
    conflictColumns: ["reference_record_id"],
    updateColumns: ITEM_DETAIL_REFERENCE_RECORD_UPDATE_COLUMNS,
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

async function upsertItemDetailDimensionOption(
  db: PgQueryable,
  input: Readonly<{
    optionId: string;
    dimensionId: string;
    code: string;
    labelI18n: LocalizedTextMap;
    label: string;
    displayOrder: number;
    numericValue: number | null;
    updatedAt: string;
  }>,
): Promise<void> {
  await upsertRow(db, {
    table: "discovery_item_detail_catalog_dimension_options",
    insertColumns: ITEM_DETAIL_DIMENSION_OPTION_COLUMNS,
    conflictColumns: ["option_id"],
    values: {
      option_id: input.optionId,
      dimension_id: input.dimensionId,
      code: input.code,
      label_i18n: input.labelI18n,
      label: input.label,
      display_order: input.displayOrder,
      numeric_value: input.numericValue,
      updated_at: input.updatedAt,
    },
    casts: { label_i18n: "jsonb" },
  });
}

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

  const dimensionRows =
    dimensionIds.length > 0
      ? (
          await db.query<DimensionDetailRow>(
            `SELECT dimension_id, name, value_kind
           FROM discovery_item_detail_catalog_dimensions
           WHERE dimension_id = ANY($1)`,
            [dimensionIds],
          )
        ).rows
      : [];
  const choiceRows =
    optionIds.length > 0
      ? (
          await db.query<ChoiceDetailRow>(
            `SELECT option_id, code, label_i18n, label, display_order, numeric_value::float8 AS numeric_value
           FROM discovery_item_detail_catalog_dimension_options
           WHERE option_id = ANY($1)`,
            [optionIds],
          )
        ).rows
      : [];

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
  await refreshDiscoveryItemDetailPages(db, [itemId]);
}

// Cascade refreshes used to rebuild pages one item at a time (~10 queries per
// item: item select, four lookup maps, a three-query product schema, page
// upsert). A single catalog blueprint/dimension/category/field/reference event
// cascading over an imported staging catalog therefore ran minutes of
// sequential round trips inside ONE projection transaction and aborted at the
// transaction cap, rolling back all progress and never catching up
// (issue #4751). The batched refresher processes affected items in bounded
// chunks with set-based lookups and memoizes product schemas per blueprint for
// the whole cascade — cascades share a handful of blueprints — collapsing the
// per-item cost to roughly one page upsert.
const ITEM_DETAIL_REFRESH_CHUNK_SIZE = 200;

async function refreshDiscoveryItemDetailPages(
  db: PgQueryable,
  itemIds: readonly string[],
  throwIfCancelled?: () => void,
): Promise<void> {
  const uniqueItemIds = [...new Set(itemIds)];
  if (uniqueItemIds.length === 0) {
    return;
  }

  const productSchemaByBlueprintId = new Map<string, unknown | null>();
  for (let offset = 0; offset < uniqueItemIds.length; offset += ITEM_DETAIL_REFRESH_CHUNK_SIZE) {
    throwIfCancelled?.();
    await refreshDiscoveryItemDetailPageChunk(
      db,
      uniqueItemIds.slice(offset, offset + ITEM_DETAIL_REFRESH_CHUNK_SIZE),
      productSchemaByBlueprintId,
      throwIfCancelled,
    );
  }
  throwIfCancelled?.();
}

async function refreshDiscoveryItemDetailPageChunk(
  db: PgQueryable,
  chunkItemIds: readonly string[],
  productSchemaByBlueprintId: Map<string, unknown | null>,
  throwIfCancelled?: () => void,
): Promise<void> {
  const result = await db.query<ItemDetailCatalogItemRow>(
    `SELECT * FROM discovery_item_detail_catalog_items WHERE catalog_item_id = ANY($1)`,
    [chunkItemIds],
  );
  const itemsById = new Map(result.rows.map((row) => [row.catalog_item_id, row]));

  const missingItemIds = chunkItemIds.filter((itemId) => !itemsById.has(itemId));
  if (missingItemIds.length > 0) {
    await db.query(`DELETE FROM discovery_item_detail_pages WHERE catalog_item_id = ANY($1)`, [missingItemIds]);
  }

  const items = chunkItemIds
    .map((itemId) => itemsById.get(itemId))
    .filter((item): item is ItemDetailCatalogItemRow => item !== undefined);
  if (items.length === 0) {
    return;
  }

  const chunkFieldIds = new Set<string>();
  const chunkCategoryIds = new Set<string>();
  const chunkReferenceIds = new Set<string>();
  const chunkBlueprintIds = new Set<string>();
  const parsedItems = items.map((item) => {
    const fieldValues = asArray<FieldValue>(item.field_values);
    const rawCategoryIds = asStringArray(item.category_ids);
    const categoryIds = uniqueStrings(rawCategoryIds);
    const referenceIds = fieldValues
      .map((entry) => referenceIdFromValue(entry.value))
      .filter((referenceId): referenceId is string => referenceId !== null);

    for (const fieldValue of fieldValues) {
      chunkFieldIds.add(fieldValue.fieldId);
    }
    for (const categoryId of categoryIds) {
      chunkCategoryIds.add(categoryId);
    }
    for (const referenceId of referenceIds) {
      chunkReferenceIds.add(referenceId);
    }
    if (item.blueprint_id) {
      chunkBlueprintIds.add(item.blueprint_id);
    }

    return { item, fieldValues, rawCategoryIds, categoryIds };
  });

  for (const { item, rawCategoryIds, categoryIds } of parsedItems) {
    if (categoryIds.length !== rawCategoryIds.length) {
      throwIfCancelled?.();
      await updateRow(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        setColumns: ["category_ids"],
        values: { category_ids: categoryIds },
        casts: { category_ids: "jsonb" },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: item.catalog_item_id } },
      });
    }
  }

  const fieldNames = await loadNameMap(db, "discovery_item_detail_catalog_fields", "field_id", "name", [
    ...chunkFieldIds,
  ]);
  const categoryRefs = await loadCategoryMap(db, [...chunkCategoryIds]);
  const blueprintNames = await loadNameMap(db, "discovery_item_detail_catalog_blueprints", "blueprint_id", "name", [
    ...chunkBlueprintIds,
  ]);
  const references = await loadReferenceRecordMap(db, ITEM_DETAIL_REFERENCE_RECORDS_TABLE, [...chunkReferenceIds]);

  for (const blueprintId of chunkBlueprintIds) {
    if (!productSchemaByBlueprintId.has(blueprintId)) {
      throwIfCancelled?.();
      productSchemaByBlueprintId.set(blueprintId, await buildProductSchema(db, blueprintId));
    }
  }

  for (const { item, fieldValues, categoryIds } of parsedItems) {
    throwIfCancelled?.();
    await upsertRow(db, {
      table: ITEM_DETAIL_PAGE_TABLE,
      insertColumns: ITEM_DETAIL_PAGE_COLUMNS,
      conflictColumns: ["catalog_item_id"],
      values: {
        catalog_item_id: item.catalog_item_id,
        slug: item.slug,
        language_code: item.language_code,
        title_i18n: item.title_i18n ?? localizedTextMap(item.title),
        title: item.title,
        subtitle_i18n: item.subtitle_i18n,
        subtitle: item.subtitle,
        description_i18n: item.description_i18n ?? localizedTextMap(item.description),
        description: item.description,
        blueprint_id: item.blueprint_id,
        blueprint: item.blueprint_id
          ? {
              blueprintId: item.blueprint_id,
              name: blueprintNames.get(item.blueprint_id) ?? item.blueprint_id,
            }
          : null,
        status: item.status,
        field_values: fieldValues.map((entry) => ({
          fieldId: entry.fieldId,
          fieldName: fieldNames.get(entry.fieldId) ?? entry.fieldId,
          value: entry.value,
          reference: references.get(referenceIdFromValue(entry.value) ?? "") ?? null,
        })),
        categories: categoryIds.map((categoryId) => ({
          categoryId,
          slug: categoryRefs.get(categoryId)?.slug ?? categoryId,
          name: categoryRefs.get(categoryId)?.name ?? categoryId,
        })),
        tags: asStringArray(item.tags),
        image_urls: asStringArray(item.image_urls),
        product_asset_sets: asArray(item.product_asset_sets),
        image_fallback: item.image_fallback,
        product_schema: item.blueprint_id ? (productSchemaByBlueprintId.get(item.blueprint_id) ?? null) : null,
        updated_at: item.updated_at,
      },
      casts: {
        title_i18n: "jsonb",
        description_i18n: "jsonb",
        field_values: "jsonb",
        categories: "jsonb",
        tags: "jsonb",
        image_urls: "jsonb",
        product_asset_sets: "jsonb",
      },
    });
  }
}

async function refreshItemsByBlueprint(
  db: PgQueryable,
  blueprintId: string,
  throwIfCancelled?: () => void,
): Promise<void> {
  // Collect the affected ids first, then rebuild pages through the batched
  // chunk refresher (issue #4751): the per-id refresh callback would pay the
  // full per-item lookup cost again.
  const itemIds = await refreshAffectedRows(db, {
    select: { column: "catalog_item_id" },
    from: { table: ITEM_DETAIL_CATALOG_ITEMS_TABLE },
    where: [{ column: "blueprint_id", value: blueprintId }],
    throwIfCancelled,
    refresh: () => Promise.resolve(),
  });
  await refreshDiscoveryItemDetailPages(db, itemIds, throwIfCancelled);
}

async function refreshItemsByCategory(
  db: PgQueryable,
  categoryId: string,
  throwIfCancelled?: () => void,
): Promise<void> {
  const itemIds = await refreshAffectedRows(db, {
    select: { column: "catalog_item_id" },
    from: { table: ITEM_DETAIL_CATALOG_ITEMS_TABLE },
    where: [{ column: "category_ids", operator: "@>", cast: "jsonb", value: [categoryId] }],
    throwIfCancelled,
    refresh: () => Promise.resolve(),
  });
  await refreshDiscoveryItemDetailPages(db, itemIds, throwIfCancelled);
}

async function refreshItemsByField(db: PgQueryable, fieldId: string, throwIfCancelled?: () => void): Promise<void> {
  const itemIds = await refreshAffectedRows(db, {
    select: { column: "catalog_item_id" },
    from: { table: ITEM_DETAIL_CATALOG_ITEMS_TABLE },
    where: [{ column: "field_values", operator: "@>", cast: "jsonb", value: [{ fieldId }] }],
    throwIfCancelled,
    refresh: () => Promise.resolve(),
  });
  await refreshDiscoveryItemDetailPages(db, itemIds, throwIfCancelled);
}

async function refreshItemsByDimension(
  db: PgQueryable,
  dimensionId: string,
  throwIfCancelled?: () => void,
): Promise<void> {
  throwIfCancelled?.();
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT DISTINCT item.catalog_item_id
     FROM ${ITEM_DETAIL_CATALOG_ITEMS_TABLE} AS item
     INNER JOIN discovery_item_detail_catalog_blueprints AS blueprint
       ON blueprint.blueprint_id = item.blueprint_id
     WHERE COALESCE(blueprint.canonical_dimension_order, '[]'::jsonb) @> $1::jsonb
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(blueprint.dimension_rules, '[]'::jsonb)) AS rule(value)
          WHERE rule.value->>'dimensionId' = $2
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(COALESCE(rule.value->'appliesWhen', '[]'::jsonb)) AS clause(value)
               WHERE clause.value->>'dimensionId' = $2
             )
        )
     ORDER BY item.catalog_item_id`,
    [JSON.stringify([dimensionId]), dimensionId],
  );

  await refreshDiscoveryItemDetailPages(
    db,
    result.rows.map((row) => row.catalog_item_id),
    throwIfCancelled,
  );
}

async function refreshAllItems(db: PgQueryable, throwIfCancelled?: () => void): Promise<void> {
  const itemIds = await refreshAffectedRows(db, {
    select: { column: "catalog_item_id" },
    from: { table: ITEM_DETAIL_CATALOG_ITEMS_TABLE },
    orderBy: [{ column: "catalog_item_id" }],
    throwIfCancelled,
    refresh: () => Promise.resolve(),
  });
  await refreshDiscoveryItemDetailPages(db, itemIds, throwIfCancelled);
}

async function refreshItemsByReferenceRecord(
  db: PgQueryable,
  referenceRecordId: string,
  throwIfCancelled?: () => void,
): Promise<void> {
  throwIfCancelled?.();
  const relatedRecordIds = await findReferenceRecordIdsByRelatedReferenceGraph(
    db,
    ITEM_DETAIL_REFERENCE_RECORDS_TABLE,
    referenceRecordId,
  );
  const itemIds = [
    ...(await findCatalogItemIdsByReferenceRecord(db, ITEM_DETAIL_CATALOG_ITEMS_TABLE, referenceRecordId)),
  ];

  for (const recordId of relatedRecordIds) {
    throwIfCancelled?.();
    itemIds.push(...(await findCatalogItemIdsByReferenceRecord(db, ITEM_DETAIL_CATALOG_ITEMS_TABLE, recordId)));
  }

  await refreshDiscoveryItemDetailPages(db, itemIds, throwIfCancelled);
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

async function replaceResolvedProductContents(
  db: PgQueryable,
  fact: ProductContentsResolvedFact,
  updatedAt: string,
): Promise<void> {
  await db.query(
    `DELETE FROM discovery_item_detail_product_contents
     WHERE container_catalog_item_id = $1
       AND (
         (container_product_id IS NULL AND $2::text IS NULL)
         OR container_product_id = $2
       )`,
    [fact.containerCatalogItemId, fact.containerProductId],
  );

  for (const line of fact.lines) {
    await db.query(
      `INSERT INTO discovery_item_detail_product_contents (
         line_id,
         container_catalog_item_id,
         container_selected_options,
         container_product_id,
         contained_catalog_item_id,
         contained_selected_options,
         contained_product_id,
         quantity,
         content_type_id,
         content_type_display_name,
         inclusion_policy_id,
         inclusion_policy_display_name,
         provenance,
         resolution_status,
         target_lifecycle_status,
         resolved_fact_hash,
         resolver_version,
         resolved_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (line_id) DO UPDATE SET
         container_catalog_item_id = EXCLUDED.container_catalog_item_id,
         container_selected_options = EXCLUDED.container_selected_options,
         container_product_id = EXCLUDED.container_product_id,
         contained_catalog_item_id = EXCLUDED.contained_catalog_item_id,
         contained_selected_options = EXCLUDED.contained_selected_options,
         contained_product_id = EXCLUDED.contained_product_id,
         quantity = EXCLUDED.quantity,
         content_type_id = EXCLUDED.content_type_id,
         content_type_display_name = EXCLUDED.content_type_display_name,
         inclusion_policy_id = EXCLUDED.inclusion_policy_id,
         inclusion_policy_display_name = EXCLUDED.inclusion_policy_display_name,
         provenance = EXCLUDED.provenance,
         resolution_status = EXCLUDED.resolution_status,
         target_lifecycle_status = EXCLUDED.target_lifecycle_status,
         resolved_fact_hash = EXCLUDED.resolved_fact_hash,
         resolver_version = EXCLUDED.resolver_version,
         resolved_at = EXCLUDED.resolved_at,
         updated_at = EXCLUDED.updated_at`,
      [
        line.lineId,
        line.containerCatalogItemId,
        jsonOrNull(line.containerSelectedOptions),
        line.containerProductId,
        line.containedCatalogItemId,
        jsonOrNull(line.containedSelectedOptions),
        line.containedProductId,
        line.quantity,
        line.contentTypeId,
        JSON.stringify(line.contentTypeDisplayName ?? localizedTextMap(line.contentTypeId)),
        line.inclusionPolicyId,
        line.inclusionPolicyDisplayName ? JSON.stringify(line.inclusionPolicyDisplayName) : null,
        JSON.stringify(line.provenance ?? {}),
        line.resolutionStatus,
        line.targetLifecycleStatus,
        fact.resolvedFactHash,
        fact.resolverVersion,
        fact.resolvedAt,
        updatedAt,
      ],
    );
  }
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

      await upsertRow(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        insertColumns: ITEM_DETAIL_CATALOG_ITEM_CREATED_COLUMNS,
        conflictColumns: ["catalog_item_id"],
        updateColumns: ITEM_DETAIL_CATALOG_ITEM_CREATED_UPDATE_COLUMNS,
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

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { blueprintId } = event.data as { blueprintId: string };

      await updateRow(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        setColumns: ["blueprint_id", "updated_at"],
        values: { blueprint_id: blueprintId, updated_at: event.timing.recordedAt },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.field-value-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { fieldId, value } = event.data as { fieldId: string; value: unknown };

      await replaceJsonbArrayElement(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        key: { column: "catalog_item_id", value: itemId },
        column: "field_values",
        match: { kind: "pathText", path: ["fieldId"], value: fieldId },
        element: { fieldId, value },
        updatedAt: { value: event.timing.recordedAt },
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.field-value-cleared": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { fieldId } = event.data as { fieldId: string };

      await removeJsonbArrayElement(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        key: { column: "catalog_item_id", value: itemId },
        column: "field_values",
        match: { kind: "pathText", path: ["fieldId"], value: fieldId },
        updatedAt: { value: event.timing.recordedAt },
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await appendJsonbArrayElement(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        key: { column: "catalog_item_id", value: itemId },
        column: "category_ids",
        element: categoryId,
        unique: true,
        updatedAt: { value: event.timing.recordedAt },
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.category-removed": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await removeJsonbArrayElement(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        key: { column: "catalog_item_id", value: itemId },
        column: "category_ids",
        match: { kind: "value", value: categoryId },
        updatedAt: { value: event.timing.recordedAt },
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.published": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await transitionStatus(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        idColumn: "catalog_item_id",
        id: itemId,
        status: "active",
        updatedAt: event.timing.recordedAt,
      });

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

      await updateRow(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        setColumns: ["description_i18n", "description", "updated_at"],
        values: {
          description_i18n: descriptionI18n,
          description: resolvedDescription,
          updated_at: event.timing.recordedAt,
        },
        casts: { description_i18n: "jsonb" },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.tags-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { tags } = event.data as { tags: string[] };

      await updateRow(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        setColumns: ["tags", "updated_at"],
        values: { tags, updated_at: event.timing.recordedAt },
        casts: { tags: "jsonb" },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.image-urls-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { imageUrls } = event.data as { imageUrls: string[] };

      await updateRow(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        setColumns: ["image_urls", "updated_at"],
        values: { image_urls: imageUrls, updated_at: event.timing.recordedAt },
        casts: { image_urls: "jsonb" },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.product-asset-sets-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { productAssetSets } = event.data as { productAssetSets: unknown };

      await updateRow(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        setColumns: ["product_asset_sets", "updated_at"],
        values: {
          product_asset_sets: Array.isArray(productAssetSets) ? productAssetSets : [],
          updated_at: event.timing.recordedAt,
        },
        casts: { product_asset_sets: "jsonb" },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.image-fallback-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { imageFallback } = event.data as { imageFallback: unknown };

      await updateRow(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        setColumns: ["image_fallback", "updated_at"],
        values: { image_fallback: imageFallback, updated_at: event.timing.recordedAt },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.image-fallback-cleared": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await updateRow(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        setColumns: ["image_fallback", "updated_at"],
        values: { image_fallback: null, updated_at: event.timing.recordedAt },
        where: { columns: ["catalog_item_id"], values: { catalog_item_id: itemId } },
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.retired": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await transitionStatus(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        idColumn: "catalog_item_id",
        id: itemId,
        status: "archived",
        updatedAt: event.timing.recordedAt,
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.archived": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await transitionStatus(db, {
        table: ITEM_DETAIL_CATALOG_ITEMS_TABLE,
        idColumn: "catalog_item_id",
        id: itemId,
        status: "archived",
        updatedAt: event.timing.recordedAt,
      });

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.product-contents.resolved": async (event) => {
      await replaceResolvedProductContents(db, event.data as ProductContentsResolvedFact, event.timing.recordedAt);
    },

    "catalog.blueprint.created": async (event) => {
      const { blueprintId, name } = event.data as { blueprintId: string; name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertItemDetailCatalogBlueprint(db, {
        blueprintId,
        name: resolvedName,
        updatedAt: event.timing.recordedAt,
      });
    },
    "catalog.blueprint.revised": async (event, context) => {
      const blueprintId = extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX);
      const { name } = event.data as { name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertItemDetailCatalogBlueprint(db, {
        blueprintId,
        name: resolvedName,
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByBlueprint(db, blueprintId, context?.throwIfLeaseLost);
    },
    "catalog.blueprint.dimensions-set": async (event, context) => {
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

      await refreshItemsByBlueprint(db, blueprintId, context?.throwIfLeaseLost);
    },
    "catalog.blueprint.product-resolution-rules-set": async (event, context) => {
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

      await refreshItemsByBlueprint(db, blueprintId, context?.throwIfLeaseLost);
    },
    "catalog.blueprint.published": async (event, context) => {
      await refreshItemsByBlueprint(
        db,
        extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX),
        context?.throwIfLeaseLost,
      );
    },

    "catalog.category.created": async (event) => {
      const { categoryId, name } = event.data as { categoryId: string; name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));
      const slug = createMarketplaceSlug([resolvedName], categoryId);

      await upsertItemDetailCategory(db, {
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
        `SELECT slug FROM discovery_item_detail_catalog_categories WHERE category_id = $1`,
        [categoryId],
      );

      await upsertItemDetailCategory(db, {
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

    "catalog.field.created": async (event, context) => {
      const { fieldId, name } = event.data as { fieldId: string; name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertItemDetailField(db, {
        fieldId,
        name: resolvedName,
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByField(db, fieldId, context?.throwIfLeaseLost);
    },
    "catalog.field.configured": async (event, context) => {
      const fieldId = extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX);
      const { name } = event.data as { name: unknown };
      const resolvedName = resolveLocalizedText(coerceLocalizedTextMap(name));

      await upsertItemDetailField(db, {
        fieldId,
        name: resolvedName,
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

      await upsertItemDetailReferenceRecord(db, {
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

      await upsertItemDetailReferenceRecord(db, {
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
        table: ITEM_DETAIL_REFERENCE_RECORDS_TABLE,
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
        table: ITEM_DETAIL_REFERENCE_RECORDS_TABLE,
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
        table: ITEM_DETAIL_REFERENCE_RECORDS_TABLE,
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
        valueKind?: "unordered" | "ordered" | "numeric";
      };
      const nameI18n = coerceLocalizedTextMap(name);

      await upsertRow(db, {
        table: "discovery_item_detail_catalog_dimensions",
        insertColumns: ["dimension_id", "name", "value_kind", "updated_at"],
        conflictColumns: ["dimension_id"],
        values: {
          dimension_id: dimensionId,
          name: resolveLocalizedText(nameI18n),
          value_kind: valueKind ?? "unordered",
          updated_at: event.timing.recordedAt,
        },
      });

      await refreshItemsByDimension(db, dimensionId, context?.throwIfLeaseLost);
    },
    "catalog.dimension.revised": async (event, context) => {
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

      await refreshItemsByDimension(db, dimensionId, context?.throwIfLeaseLost);
    },
    "catalog.dimension.option-added": async (event, context) => {
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

      await upsertItemDetailDimensionOption(db, {
        optionId,
        dimensionId,
        code,
        labelI18n,
        label: resolveLocalizedText(labelI18n),
        displayOrder: displayOrder ?? 0,
        numericValue: numericValue ?? null,
        updatedAt: event.timing.recordedAt,
      });

      await refreshItemsByDimension(db, dimensionId, context?.throwIfLeaseLost);
    },
    "catalog.dimension.option-revised": async (event, context) => {
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

      await upsertItemDetailDimensionOption(db, {
        optionId,
        dimensionId,
        code,
        labelI18n,
        label: resolveLocalizedText(labelI18n),
        displayOrder: displayOrder ?? 0,
        numericValue: numericValue ?? null,
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
          table: "discovery_item_detail_catalog_dimension_options",
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
  };
}

type LocalizedTextMap = Readonly<{
  defaultLocale: "en";
  values: Readonly<Record<string, string>>;
}>;

function localizedTextMap(value: string): LocalizedTextMap {
  return { defaultLocale: "en", values: value ? { en: value } : {} };
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
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
