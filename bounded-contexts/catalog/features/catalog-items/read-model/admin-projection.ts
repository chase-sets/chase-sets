import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import {
  asArray,
  asStringArray,
  type FieldValue,
  loadNameMap,
} from "../../../support/projection-support/read-model-support";
import {
  localizedTextMapFromEnglish,
  normalizeLocaleCode,
  resolveLocalizedTextMap,
  type LocalizedTextMap,
} from "../../../support/runtime-support/common";
import { resolveAndPersistCatalogItemDisplayIdentities, type PersistedDisplayIdentityResult } from "./display-identity";
import {
  enqueueAllCatalogItemDisplayIdentityRecomputeWork,
  enqueueCatalogItemDisplayIdentityRecomputeWork,
  type DisplayIdentityRecomputeReason,
  type DisplayIdentityRecomputeSource,
} from "./display-identity-recompute";

const ITEM_STREAM_PREFIX = "catalog.item-";
const BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
const CATEGORY_STREAM_PREFIX = "catalog.category-";
const FIELD_STREAM_PREFIX = "catalog.field-";
const REFERENCE_RECORD_STREAM_PREFIX = "catalog.reference-record-";
const MAX_REFERENCE_EXPANSION_DEPTH = 4;

type BaseCatalogItemRow = Readonly<{
  catalog_item_id: string;
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

type ExternalProductReferenceRow = Readonly<{
  catalog_item_id: string;
  provider_key: string;
  external_key: string;
  selected_options: unknown;
  updated_at: string;
}>;

type ExternalCatalogItemReferenceRow = Readonly<{
  catalog_item_id: string;
  provider_key: string;
  external_key: string;
  updated_at: string;
}>;

type ReferenceRecordRow = Readonly<{
  reference_record_id: string;
  type_key: string;
  key: string;
  name: string;
  attributes: unknown;
  relationships: unknown;
  status: string;
}>;

type ReferenceRelationship = Readonly<{
  relationshipType: string;
  referenceId: string;
}>;

type CatalogItemCreatedEventData = Readonly<{
  itemId?: unknown;
  languageCode?: unknown;
  title?: unknown;
  subtitle?: unknown;
  description?: unknown;
}>;

type ReferenceRecordRef = Readonly<{
  referenceId: string;
  typeKey: string;
  key: string;
  name: string;
  attributes: unknown;
  relationships: readonly (ReferenceRelationship & {
    reference?: ReferenceRecordRef;
  })[];
  status: string;
}>;

export async function refreshCatalogAdminCatalogItemPages(db: PgQueryable, itemId: string): Promise<void> {
  await refreshCatalogAdminCatalogItemPagesForItems(db, [itemId]);
}

async function ensureCatalogItemParentForCreatedEvent(
  db: PgQueryable,
  event: Readonly<{ streamId: string; data: unknown; timing: { recordedAt: string } }>,
): Promise<string> {
  const data = event.data as CatalogItemCreatedEventData;
  const itemId =
    typeof data.itemId === "string" && data.itemId.trim()
      ? data.itemId.trim()
      : extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
  const titleI18n = coerceLocalizedTextMap(data.title);
  const subtitleI18n = data.subtitle ? coerceLocalizedTextMap(data.subtitle) : null;
  const descriptionI18n = coerceLocalizedTextMap(data.description ?? "");

  await db.query(
    `INSERT INTO catalog_items (
       catalog_item_id,
       language_code,
       title_i18n,
       title,
       subtitle_i18n,
       subtitle,
       description_i18n,
       description,
       status,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9)
     ON CONFLICT (catalog_item_id) DO NOTHING`,
    [
      itemId,
      normalizeLocaleCode(typeof data.languageCode === "string" ? data.languageCode : "en"),
      JSON.stringify(titleI18n),
      resolveLocalizedTextMap(titleI18n),
      subtitleI18n ? JSON.stringify(subtitleI18n) : null,
      subtitleI18n ? resolveLocalizedTextMap(subtitleI18n) : null,
      JSON.stringify(descriptionI18n),
      resolveLocalizedTextMap(descriptionI18n),
      event.timing.recordedAt,
    ],
  );

  return itemId;
}

async function refreshCatalogAdminCatalogItemPagesForItems(db: PgQueryable, itemIds: readonly string[]): Promise<void> {
  const uniqueItemIds = [...new Set(itemIds)];
  if (uniqueItemIds.length === 0) {
    return;
  }

  const itemResult = await db.query<BaseCatalogItemRow>(`SELECT * FROM catalog_items WHERE catalog_item_id = ANY($1)`, [
    uniqueItemIds,
  ]);
  const itemsById = new Map(itemResult.rows.map((item) => [item.catalog_item_id, item]));
  const missingItemIds = uniqueItemIds.filter((itemId) => !itemsById.has(itemId));

  if (missingItemIds.length > 0) {
    await deleteCatalogAdminCatalogItemPages(db, missingItemIds);
  }

  const items = uniqueItemIds
    .map((itemId) => itemsById.get(itemId))
    .filter((item): item is BaseCatalogItemRow => Boolean(item));

  if (items.length === 0) {
    return;
  }

  const fieldValuesByItemId = new Map(
    items.map((item) => [item.catalog_item_id, asArray<FieldValue>(item.field_values)] as const),
  );
  const categoryIdsByItemId = new Map(
    items.map((item) => [item.catalog_item_id, asStringArray(item.category_ids)] as const),
  );
  const referenceIdsByItemId = new Map(
    items.map((item) => {
      const fieldValues = fieldValuesByItemId.get(item.catalog_item_id) ?? [];
      return [
        item.catalog_item_id,
        fieldValues
          .map((entry) => referenceIdFromValue(entry.value))
          .filter((entry): entry is string => entry !== null),
      ] as const;
    }),
  );
  const blueprintIds = [
    ...new Set(
      items.map((item) => item.blueprint_id).filter((blueprintId): blueprintId is string => Boolean(blueprintId)),
    ),
  ];

  const displayIdentityResults = await resolveAndPersistCatalogItemDisplayIdentities(
    db,
    items,
    (item) => item.updated_at,
  );
  const blueprintNames = await loadNameMap(db, "catalog_blueprints", "blueprint_id", "name", blueprintIds);
  const fieldNames = await loadNameMap(
    db,
    "catalog_fields",
    "field_id",
    "name",
    items.flatMap((item) => (fieldValuesByItemId.get(item.catalog_item_id) ?? []).map((entry) => entry.fieldId)),
  );
  const categoryNames = await loadNameMap(
    db,
    "catalog_categories",
    "category_id",
    "name",
    items.flatMap((item) => categoryIdsByItemId.get(item.catalog_item_id) ?? []),
  );
  const referenceRowsById = await loadReferenceRecordRowsByGraph(
    db,
    items.flatMap((item) => referenceIdsByItemId.get(item.catalog_item_id) ?? []),
  );
  const externalProductReferencesByItemId = await loadExternalProductReferencesByItemId(db, uniqueItemIds);
  const externalCatalogItemReferencesByItemId = await loadExternalCatalogItemReferencesByItemId(db, uniqueItemIds);

  await upsertCatalogAdminCatalogItemListPages(db, items, displayIdentityResults, blueprintNames);
  await upsertCatalogAdminCatalogItemDetailPages(db, {
    items,
    displayIdentityResults,
    blueprintNames,
    fieldNames,
    categoryNames,
    fieldValuesByItemId,
    categoryIdsByItemId,
    referenceIdsByItemId,
    referenceRowsById,
    externalProductReferencesByItemId,
    externalCatalogItemReferencesByItemId,
  });
}

async function deleteCatalogAdminCatalogItemPages(db: PgQueryable, itemIds: readonly string[]): Promise<void> {
  await db.query(`DELETE FROM catalog_admin_catalog_item_list_pages WHERE catalog_item_id = ANY($1)`, [itemIds]);
  await db.query(`DELETE FROM catalog_admin_catalog_item_detail_pages WHERE catalog_item_id = ANY($1)`, [itemIds]);
}

async function upsertCatalogAdminCatalogItemListPages(
  db: PgQueryable,
  items: readonly BaseCatalogItemRow[],
  displayIdentityResults: ReadonlyMap<string, PersistedDisplayIdentityResult>,
  blueprintNames: ReadonlyMap<string, string>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  await db.query(
    `INSERT INTO catalog_admin_catalog_item_list_pages (
      catalog_item_id,
      language_code,
      title_i18n,
      title,
      subtitle_i18n,
      subtitle,
      display_template_key,
      display_identity_hash,
      display_identity_resolved_at,
      blueprint_id,
      blueprint,
      status,
      tags,
      updated_at
    )
    SELECT
      input.catalog_item_id,
      input.language_code,
      input.title_i18n::jsonb,
      input.title,
      input.subtitle_i18n::jsonb,
      input.subtitle,
      input.display_template_key,
      input.display_identity_hash,
      input.display_identity_resolved_at,
      input.blueprint_id,
      input.blueprint::jsonb,
      input.status,
      input.tags::jsonb,
      input.updated_at
    FROM unnest(
      $1::text[],
      $2::text[],
      $3::text[],
      $4::text[],
      $5::text[],
      $6::text[],
      $7::text[],
      $8::text[],
      $9::timestamptz[],
      $10::text[],
      $11::text[],
      $12::text[],
      $13::text[],
      $14::timestamptz[]
    ) AS input(
      catalog_item_id,
      language_code,
      title_i18n,
      title,
      subtitle_i18n,
      subtitle,
      display_template_key,
      display_identity_hash,
      display_identity_resolved_at,
      blueprint_id,
      blueprint,
      status,
      tags,
      updated_at
    )
    ON CONFLICT (catalog_item_id) DO UPDATE SET
      language_code = EXCLUDED.language_code,
      title_i18n = EXCLUDED.title_i18n,
      title = EXCLUDED.title,
      subtitle_i18n = EXCLUDED.subtitle_i18n,
      subtitle = EXCLUDED.subtitle,
      display_template_key = EXCLUDED.display_template_key,
      display_identity_hash = EXCLUDED.display_identity_hash,
      display_identity_resolved_at = EXCLUDED.display_identity_resolved_at,
      blueprint_id = EXCLUDED.blueprint_id,
      blueprint = EXCLUDED.blueprint,
      status = EXCLUDED.status,
      tags = EXCLUDED.tags,
      updated_at = EXCLUDED.updated_at`,
    [
      items.map((item) => item.catalog_item_id),
      items.map((item) => item.language_code),
      items.map((item) => JSON.stringify(item.title_i18n ?? { defaultLocale: "en", values: { en: item.title } })),
      items.map((item) => displayIdentityFor(displayIdentityResults, item).identity.title),
      items.map((item) => (item.subtitle_i18n === null ? null : JSON.stringify(item.subtitle_i18n))),
      items.map((item) => displayIdentityFor(displayIdentityResults, item).identity.subtitle),
      items.map((item) => displayIdentityFor(displayIdentityResults, item).identity.templateKey),
      items.map((item) => displayIdentityFor(displayIdentityResults, item).identity.hash),
      items.map((item) => displayIdentityFor(displayIdentityResults, item).resolvedAt),
      items.map((item) => item.blueprint_id),
      items.map((item) =>
        item.blueprint_id && blueprintNames.get(item.blueprint_id)
          ? JSON.stringify({ blueprintId: item.blueprint_id, name: blueprintNames.get(item.blueprint_id) })
          : null,
      ),
      items.map((item) => item.status),
      items.map((item) => JSON.stringify(asStringArray(item.tags))),
      items.map((item) => item.updated_at),
    ],
  );
}

type CatalogAdminDetailPageBatchInput = Readonly<{
  items: readonly BaseCatalogItemRow[];
  displayIdentityResults: ReadonlyMap<string, PersistedDisplayIdentityResult>;
  blueprintNames: ReadonlyMap<string, string>;
  fieldNames: ReadonlyMap<string, string>;
  categoryNames: ReadonlyMap<string, string>;
  fieldValuesByItemId: ReadonlyMap<string, readonly FieldValue[]>;
  categoryIdsByItemId: ReadonlyMap<string, readonly string[]>;
  referenceIdsByItemId: ReadonlyMap<string, readonly string[]>;
  referenceRowsById: ReadonlyMap<string, ReferenceRecordRow>;
  externalProductReferencesByItemId: ReadonlyMap<string, readonly ExternalProductReferenceRow[]>;
  externalCatalogItemReferencesByItemId: ReadonlyMap<string, readonly ExternalCatalogItemReferenceRow[]>;
}>;

async function upsertCatalogAdminCatalogItemDetailPages(
  db: PgQueryable,
  input: CatalogAdminDetailPageBatchInput,
): Promise<void> {
  const { items } = input;
  if (items.length === 0) {
    return;
  }

  const detailRows = items.map((item) => buildCatalogAdminCatalogItemDetailPageRow(item, input));

  await db.query(
    `INSERT INTO catalog_admin_catalog_item_detail_pages (
      catalog_item_id,
      language_code,
      title_i18n,
      title,
      subtitle_i18n,
      subtitle,
      display_template_key,
      display_identity_hash,
      display_identity_resolved_at,
      description_i18n,
      description,
      blueprint_id,
      blueprint,
      status,
      field_values,
      categories,
      external_catalog_item_references,
      external_product_references,
      tags,
      image_urls,
      product_asset_sets,
      image_fallback,
      updated_at
    )
    SELECT
      input.catalog_item_id,
      input.language_code,
      input.title_i18n::jsonb,
      input.title,
      input.subtitle_i18n::jsonb,
      input.subtitle,
      input.display_template_key,
      input.display_identity_hash,
      input.display_identity_resolved_at,
      input.description_i18n::jsonb,
      input.description,
      input.blueprint_id,
      input.blueprint::jsonb,
      input.status,
      input.field_values::jsonb,
      input.categories::jsonb,
      input.external_catalog_item_references::jsonb,
      input.external_product_references::jsonb,
      input.tags::jsonb,
      input.image_urls::jsonb,
      input.product_asset_sets::jsonb,
      input.image_fallback::jsonb,
      input.updated_at
    FROM unnest(
      $1::text[],
      $2::text[],
      $3::text[],
      $4::text[],
      $5::text[],
      $6::text[],
      $7::text[],
      $8::text[],
      $9::timestamptz[],
      $10::text[],
      $11::text[],
      $12::text[],
      $13::text[],
      $14::text[],
      $15::text[],
      $16::text[],
      $17::text[],
      $18::text[],
      $19::text[],
      $20::text[],
      $21::text[],
      $22::text[],
      $23::timestamptz[]
    ) AS input(
      catalog_item_id,
      language_code,
      title_i18n,
      title,
      subtitle_i18n,
      subtitle,
      display_template_key,
      display_identity_hash,
      display_identity_resolved_at,
      description_i18n,
      description,
      blueprint_id,
      blueprint,
      status,
      field_values,
      categories,
      external_catalog_item_references,
      external_product_references,
      tags,
      image_urls,
      product_asset_sets,
      image_fallback,
      updated_at
    )
    ON CONFLICT (catalog_item_id) DO UPDATE SET
      language_code = EXCLUDED.language_code,
      title_i18n = EXCLUDED.title_i18n,
      title = EXCLUDED.title,
      subtitle_i18n = EXCLUDED.subtitle_i18n,
      subtitle = EXCLUDED.subtitle,
      display_template_key = EXCLUDED.display_template_key,
      display_identity_hash = EXCLUDED.display_identity_hash,
      display_identity_resolved_at = EXCLUDED.display_identity_resolved_at,
      description_i18n = EXCLUDED.description_i18n,
      description = EXCLUDED.description,
      blueprint_id = EXCLUDED.blueprint_id,
      blueprint = EXCLUDED.blueprint,
      status = EXCLUDED.status,
      field_values = EXCLUDED.field_values,
      categories = EXCLUDED.categories,
      external_catalog_item_references = EXCLUDED.external_catalog_item_references,
      external_product_references = EXCLUDED.external_product_references,
      tags = EXCLUDED.tags,
      image_urls = EXCLUDED.image_urls,
      product_asset_sets = EXCLUDED.product_asset_sets,
      image_fallback = EXCLUDED.image_fallback,
      updated_at = EXCLUDED.updated_at`,
    [
      detailRows.map((row) => row.catalogItemId),
      detailRows.map((row) => row.languageCode),
      detailRows.map((row) => row.titleI18n),
      detailRows.map((row) => row.title),
      detailRows.map((row) => row.subtitleI18n),
      detailRows.map((row) => row.subtitle),
      detailRows.map((row) => row.displayTemplateKey),
      detailRows.map((row) => row.displayIdentityHash),
      detailRows.map((row) => row.displayIdentityResolvedAt),
      detailRows.map((row) => row.descriptionI18n),
      detailRows.map((row) => row.description),
      detailRows.map((row) => row.blueprintId),
      detailRows.map((row) => row.blueprint),
      detailRows.map((row) => row.status),
      detailRows.map((row) => row.fieldValues),
      detailRows.map((row) => row.categories),
      detailRows.map((row) => row.externalCatalogItemReferences),
      detailRows.map((row) => row.externalProductReferences),
      detailRows.map((row) => row.tags),
      detailRows.map((row) => row.imageUrls),
      detailRows.map((row) => row.productAssetSets),
      detailRows.map((row) => row.imageFallback),
      detailRows.map((row) => row.updatedAt),
    ],
  );
}

function buildCatalogAdminCatalogItemDetailPageRow(item: BaseCatalogItemRow, input: CatalogAdminDetailPageBatchInput) {
  const displayIdentityResult = displayIdentityFor(input.displayIdentityResults, item);
  const displayIdentity = displayIdentityResult.identity;
  const fieldValues = input.fieldValuesByItemId.get(item.catalog_item_id) ?? [];
  const categoryIds = input.categoryIdsByItemId.get(item.catalog_item_id) ?? [];
  const references = buildReferenceRecordMap(
    input.referenceIdsByItemId.get(item.catalog_item_id) ?? [],
    input.referenceRowsById,
  );
  const namedFieldValues = fieldValues.map((entry) => ({
    fieldId: entry.fieldId,
    fieldName: input.fieldNames.get(entry.fieldId) ?? entry.fieldId,
    value: entry.value,
    reference: references.get(referenceIdFromValue(entry.value) ?? "") ?? null,
  }));
  const namedCategories = categoryIds.map((categoryId) => ({
    categoryId,
    name: input.categoryNames.get(categoryId) ?? categoryId,
  }));
  const externalReferences = (input.externalProductReferencesByItemId.get(item.catalog_item_id) ?? []).map(
    (reference) => ({
      providerKey: reference.provider_key,
      externalKey: reference.external_key,
      selectedOptions: Array.isArray(reference.selected_options) ? reference.selected_options : [],
      updatedAt: reference.updated_at,
    }),
  );
  const externalCatalogItemReferences = (
    input.externalCatalogItemReferencesByItemId.get(item.catalog_item_id) ?? []
  ).map((reference) => ({
    providerKey: reference.provider_key,
    externalKey: reference.external_key,
    updatedAt: reference.updated_at,
  }));

  return {
    catalogItemId: item.catalog_item_id,
    languageCode: item.language_code,
    titleI18n: JSON.stringify(item.title_i18n ?? { defaultLocale: "en", values: { en: item.title } }),
    title: displayIdentity.title,
    subtitleI18n: item.subtitle_i18n === null ? null : JSON.stringify(item.subtitle_i18n),
    subtitle: displayIdentity.subtitle,
    displayTemplateKey: displayIdentity.templateKey,
    displayIdentityHash: displayIdentity.hash,
    displayIdentityResolvedAt: displayIdentityResult.resolvedAt,
    descriptionI18n: JSON.stringify(item.description_i18n ?? { defaultLocale: "en", values: { en: item.description } }),
    description: item.description,
    blueprintId: item.blueprint_id,
    blueprint: item.blueprint_id
      ? JSON.stringify({
          blueprintId: item.blueprint_id,
          name: input.blueprintNames.get(item.blueprint_id) ?? item.blueprint_id,
        })
      : null,
    status: item.status,
    fieldValues: JSON.stringify(namedFieldValues),
    categories: JSON.stringify(namedCategories),
    externalCatalogItemReferences: JSON.stringify(externalCatalogItemReferences),
    externalProductReferences: JSON.stringify(externalReferences),
    tags: JSON.stringify(asStringArray(item.tags)),
    imageUrls: JSON.stringify(asStringArray(item.image_urls)),
    productAssetSets: JSON.stringify(asArray(item.product_asset_sets)),
    imageFallback: item.image_fallback === null ? null : JSON.stringify(item.image_fallback),
    updatedAt: item.updated_at,
  };
}

async function loadExternalProductReferencesByItemId(
  db: PgQueryable,
  itemIds: readonly string[],
): Promise<Map<string, ExternalProductReferenceRow[]>> {
  const result = await db.query<ExternalProductReferenceRow>(
    `SELECT catalog_item_id, provider_key, external_key, selected_options, updated_at
     FROM catalog_external_product_references
     WHERE catalog_item_id = ANY($1)
     ORDER BY catalog_item_id ASC, provider_key ASC, external_key ASC`,
    [itemIds],
  );

  return groupByCatalogItemId(result.rows);
}

async function loadExternalCatalogItemReferencesByItemId(
  db: PgQueryable,
  itemIds: readonly string[],
): Promise<Map<string, ExternalCatalogItemReferenceRow[]>> {
  const result = await db.query<ExternalCatalogItemReferenceRow>(
    `SELECT catalog_item_id, provider_key, external_key, updated_at
     FROM catalog_external_catalog_item_references
     WHERE catalog_item_id = ANY($1)
     ORDER BY catalog_item_id ASC, provider_key ASC, external_key ASC`,
    [itemIds],
  );

  return groupByCatalogItemId(result.rows);
}

function groupByCatalogItemId<Row extends { catalog_item_id: string }>(rows: readonly Row[]): Map<string, Row[]> {
  const byItemId = new Map<string, Row[]>();

  for (const row of rows) {
    const itemRows = byItemId.get(row.catalog_item_id) ?? [];
    itemRows.push(row);
    byItemId.set(row.catalog_item_id, itemRows);
  }

  return byItemId;
}

function displayIdentityFor(
  displayIdentityResults: ReadonlyMap<string, PersistedDisplayIdentityResult>,
  item: BaseCatalogItemRow,
): PersistedDisplayIdentityResult {
  const result = displayIdentityResults.get(item.catalog_item_id);
  if (!result) {
    throw new Error(`Missing display identity result for Catalog Item ${item.catalog_item_id}.`);
  }

  return result;
}

async function findCatalogItemIdsByField(db: PgQueryable, fieldId: string): Promise<string[]> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM catalog_items WHERE field_values @> $1::jsonb`,
    [JSON.stringify([{ fieldId }])],
  );

  return result.rows.map((row) => row.catalog_item_id);
}

async function findCatalogItemIdsByReferenceRecords(
  db: PgQueryable,
  referenceRecordIds: readonly string[],
): Promise<string[]> {
  const uniqueReferenceRecordIds = [...new Set(referenceRecordIds)];
  if (uniqueReferenceRecordIds.length === 0) {
    return [];
  }

  const result = await db.query<{ catalog_item_id: string }>(
    `WITH reference_frontier AS (
       SELECT reference_record_id, ordinal
       FROM unnest($1::text[]) WITH ORDINALITY AS input(reference_record_id, ordinal)
     ),
     matched_items AS (
       SELECT item.catalog_item_id, MIN(reference_frontier.ordinal) AS reference_ordinal
       FROM catalog_items AS item
       CROSS JOIN LATERAL jsonb_array_elements(item.field_values) AS field_value
       JOIN reference_frontier
         ON field_value->'value'->>'referenceId' = reference_frontier.reference_record_id
         OR field_value->'value'->>'reference_record_id' = reference_frontier.reference_record_id
       GROUP BY item.catalog_item_id
     )
     SELECT catalog_item_id
     FROM matched_items
     ORDER BY reference_ordinal ASC, catalog_item_id ASC`,
    [uniqueReferenceRecordIds],
  );

  return result.rows.map((row) => row.catalog_item_id);
}

async function findReferenceRecordIdsByRelatedReferences(
  db: PgQueryable,
  referenceRecordIds: readonly string[],
): Promise<string[]> {
  const uniqueReferenceRecordIds = [...new Set(referenceRecordIds)];
  if (uniqueReferenceRecordIds.length === 0) {
    return [];
  }

  const result = await db.query<{ reference_record_id: string }>(
    `WITH reference_frontier AS (
       SELECT reference_record_id, ordinal
       FROM unnest($1::text[]) WITH ORDINALITY AS input(reference_record_id, ordinal)
     ),
     matched_records AS (
       SELECT record.reference_record_id, MIN(reference_frontier.ordinal) AS reference_ordinal
       FROM catalog_reference_records AS record
       CROSS JOIN LATERAL jsonb_array_elements(record.relationships) AS relationship
       JOIN reference_frontier
         ON relationship->>'referenceId' = reference_frontier.reference_record_id
       GROUP BY record.reference_record_id
     )
     SELECT reference_record_id
     FROM matched_records
     ORDER BY reference_ordinal ASC, reference_record_id ASC`,
    [uniqueReferenceRecordIds],
  );

  return result.rows.map((row) => row.reference_record_id);
}

async function findReferenceRecordIdsByRelatedReferenceGraph(
  db: PgQueryable,
  referenceRecordId: string,
): Promise<string[]> {
  const visited = new Set<string>();
  let frontier = [referenceRecordId];

  for (let depth = 0; depth < MAX_REFERENCE_EXPANSION_DEPTH && frontier.length > 0; depth++) {
    const relatedRecordIds = await findReferenceRecordIdsByRelatedReferences(db, frontier);
    const next = [...new Set(relatedRecordIds)].filter((recordId) => !visited.has(recordId));

    for (const recordId of next) {
      visited.add(recordId);
    }

    frontier = next;
  }

  return [...visited];
}

async function findCatalogItemIdsByBlueprint(db: PgQueryable, blueprintId: string): Promise<string[]> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM catalog_items WHERE blueprint_id = $1`,
    [blueprintId],
  );

  return result.rows.map((row) => row.catalog_item_id);
}

async function findCatalogItemIdsByCategory(db: PgQueryable, categoryId: string): Promise<string[]> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM catalog_items WHERE category_ids @> $1::jsonb`,
    [JSON.stringify([categoryId])],
  );

  return result.rows.map((row) => row.catalog_item_id);
}

async function refreshCatalogItemIds(
  db: PgQueryable,
  itemIds: readonly string[],
  reason: DisplayIdentityRecomputeReason,
  source: DisplayIdentityRecomputeSource = {},
): Promise<void> {
  await enqueueCatalogItemDisplayIdentityRecomputeWork(db, itemIds, reason, source);

  await refreshCatalogAdminCatalogItemPagesForItems(db, [...new Set(itemIds)]);
}

async function enqueueItemAndRefresh(
  db: PgQueryable,
  itemId: string,
  reason: DisplayIdentityRecomputeReason,
  source: DisplayIdentityRecomputeSource = {},
): Promise<void> {
  await refreshCatalogItemIds(db, [itemId], reason, source);
}

function sourceFromEvent(event: { type?: unknown; streamId?: unknown; timing?: { recordedAt?: unknown } }) {
  return {
    eventType: typeof event.type === "string" ? event.type : undefined,
    streamId: typeof event.streamId === "string" ? event.streamId : undefined,
    recordedAt: typeof event.timing?.recordedAt === "string" ? event.timing.recordedAt : undefined,
  };
}

export function buildCatalogAdminCatalogItemProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  async function refreshFieldDependents(fieldId: string, source: DisplayIdentityRecomputeSource) {
    await refreshCatalogItemIds(db, await findCatalogItemIdsByField(db, fieldId), "field-changed", source);
  }

  async function refreshBlueprintDependents(blueprintId: string, source: DisplayIdentityRecomputeSource) {
    await refreshCatalogItemIds(db, await findCatalogItemIdsByBlueprint(db, blueprintId), "blueprint-changed", source);
  }

  async function refreshCategoryDependents(categoryId: string, source: DisplayIdentityRecomputeSource) {
    await refreshCatalogItemIds(db, await findCatalogItemIdsByCategory(db, categoryId), "category-changed", source);
  }

  async function refreshReferenceDependents(referenceRecordId: string, source: DisplayIdentityRecomputeSource) {
    const relatedRecordIds = await findReferenceRecordIdsByRelatedReferenceGraph(db, referenceRecordId);
    const itemIds = await findCatalogItemIdsByReferenceRecords(db, [referenceRecordId, ...relatedRecordIds]);

    await refreshCatalogItemIds(db, [...new Set(itemIds)], "reference-record-changed", source);
  }

  async function refreshReferenceAliasDependents(referenceRecordId: string, source: DisplayIdentityRecomputeSource) {
    const relatedRecordIds = await findReferenceRecordIdsByRelatedReferenceGraph(db, referenceRecordId);
    const itemIds = await findCatalogItemIdsByReferenceRecords(db, [referenceRecordId, ...relatedRecordIds]);

    await refreshCatalogItemIds(db, [...new Set(itemIds)], "alias-resolved", source);
  }

  return {
    "catalog.catalog-item.created": async (event) => {
      const itemId = await ensureCatalogItemParentForCreatedEvent(db, event);
      await enqueueItemAndRefresh(db, itemId, "catalog-item-changed", sourceFromEvent(event));
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      await enqueueItemAndRefresh(
        db,
        extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX),
        "catalog-item-changed",
        sourceFromEvent(event),
      );
    },
    "catalog.catalog-item.field-value-set": async (event) => {
      await enqueueItemAndRefresh(
        db,
        extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX),
        "catalog-item-changed",
        sourceFromEvent(event),
      );
    },
    "catalog.catalog-item.field-value-cleared": async (event) => {
      await enqueueItemAndRefresh(
        db,
        extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX),
        "catalog-item-changed",
        sourceFromEvent(event),
      );
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      await enqueueItemAndRefresh(
        db,
        extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX),
        "catalog-item-changed",
        sourceFromEvent(event),
      );
    },
    "catalog.catalog-item.category-removed": async (event) => {
      await enqueueItemAndRefresh(
        db,
        extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX),
        "catalog-item-changed",
        sourceFromEvent(event),
      );
    },
    "catalog.catalog-item.published": async (event) => {
      await enqueueItemAndRefresh(
        db,
        extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX),
        "catalog-item-changed",
        sourceFromEvent(event),
      );
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      await enqueueItemAndRefresh(
        db,
        extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX),
        "catalog-item-changed",
        sourceFromEvent(event),
      );
    },
    "catalog.catalog-item.tags-set": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.image-urls-set": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.product-asset-sets-set": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.image-fallback-set": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.image-fallback-cleared": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.external-product-reference-linked": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.external-catalog-item-reference-linked": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.external-product-reference-unlinked": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.external-catalog-item-reference-unlinked": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.retired": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.archived": async (event) => {
      await refreshCatalogAdminCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.draft-removed": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(`DELETE FROM catalog_admin_catalog_item_list_pages WHERE catalog_item_id = $1`, [itemId]);
      await db.query(`DELETE FROM catalog_admin_catalog_item_detail_pages WHERE catalog_item_id = $1`, [itemId]);
    },

    // An accepted Catalog Item alias set changed (#1914): the resolved English
    // display name may change, so re-resolve display identity for this item. The
    // resolver reads the publishable aliases and republishes only on hash change.
    "catalog.catalog-item.aliases-resolved": async (event) => {
      await enqueueItemAndRefresh(
        db,
        extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX),
        "alias-resolved",
        sourceFromEvent(event),
      );
    },

    // An accepted set/series (Reference Record) alias set changed (#1914): every
    // Catalog Item whose display copy references that record may change its
    // resolved set/series display, so re-resolve those items' display identity.
    "catalog.reference-record.aliases-resolved": async (event) => {
      await refreshReferenceAliasDependents(
        extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },

    "catalog.blueprint.revised": async (event) => {
      await refreshBlueprintDependents(
        extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },
    "catalog.blueprint.published": async (event) => {
      await refreshBlueprintDependents(
        extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },
    "catalog.blueprint.deprecated": async (event) => {
      await refreshBlueprintDependents(
        extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },
    "catalog.blueprint.archived": async (event) => {
      await refreshBlueprintDependents(
        extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },

    "catalog.category.created": async (event) => {
      await refreshCategoryDependents(event.data.categoryId as string, sourceFromEvent(event));
    },
    "catalog.category.revised": async (event) => {
      await refreshCategoryDependents(
        extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },
    "catalog.category.published": async (event) => {
      await refreshCategoryDependents(
        extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },
    "catalog.category.deprecated": async (event) => {
      await refreshCategoryDependents(
        extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },
    "catalog.category.archived": async (event) => {
      await refreshCategoryDependents(
        extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },

    "catalog.field.created": async (event) => {
      await refreshFieldDependents(event.data.fieldId as string, sourceFromEvent(event));
    },
    "catalog.field.configured": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX), sourceFromEvent(event));
    },
    "catalog.field.activated": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX), sourceFromEvent(event));
    },
    "catalog.field.deprecated": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX), sourceFromEvent(event));
    },
    "catalog.field.archived": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX), sourceFromEvent(event));
    },

    "catalog.reference-record.created": async (event) => {
      await refreshReferenceDependents(event.data.referenceRecordId as string, sourceFromEvent(event));
    },
    "catalog.reference-record.revised": async (event) => {
      await refreshReferenceDependents(
        extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },
    "catalog.reference-record.published": async (event) => {
      await refreshReferenceDependents(
        extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },
    "catalog.reference-record.deprecated": async (event) => {
      await refreshReferenceDependents(
        extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },
    "catalog.reference-record.archived": async (event) => {
      await refreshReferenceDependents(
        extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX),
        sourceFromEvent(event),
      );
    },

    "catalog.display-template.created": async (event) => {
      await enqueueAllCatalogItemDisplayIdentityRecomputeWork(db, "display-template-changed", sourceFromEvent(event));
    },
    "catalog.display-template.revised": async (event) => {
      await enqueueAllCatalogItemDisplayIdentityRecomputeWork(db, "display-template-changed", sourceFromEvent(event));
    },
    "catalog.display-template.published": async (event) => {
      await enqueueAllCatalogItemDisplayIdentityRecomputeWork(db, "display-template-changed", sourceFromEvent(event));
    },
    "catalog.display-template.deprecated": async (event) => {
      await enqueueAllCatalogItemDisplayIdentityRecomputeWork(db, "display-template-changed", sourceFromEvent(event));
    },
    "catalog.display-template.archived": async (event) => {
      await enqueueAllCatalogItemDisplayIdentityRecomputeWork(db, "display-template-changed", sourceFromEvent(event));
    },
  };
}

function coerceLocalizedTextMap(value: unknown): LocalizedTextMap {
  return typeof value === "object" && value !== null && "defaultLocale" in value && "values" in value
    ? (value as LocalizedTextMap)
    : localizedTextMapFromEnglish(String(value ?? ""));
}

function referenceIdFromValue(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as { referenceId?: unknown; reference_record_id?: unknown };

  if (typeof candidate.referenceId === "string" && candidate.referenceId.length > 0) {
    return candidate.referenceId;
  }

  if (typeof candidate.reference_record_id === "string" && candidate.reference_record_id.length > 0) {
    return candidate.reference_record_id;
  }

  return null;
}

async function loadReferenceRecordMap(
  db: PgQueryable,
  ids: readonly string[],
): Promise<Map<string, ReferenceRecordRef>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  return buildReferenceRecordMap(uniqueIds, await loadReferenceRecordRowsByGraph(db, uniqueIds));
}

function buildReferenceRecordMap(
  ids: readonly string[],
  rowsById: ReadonlyMap<string, ReferenceRecordRow>,
): Map<string, ReferenceRecordRef> {
  const uniqueIds = [...new Set(ids)];
  const buildReference = (row: ReferenceRecordRow, depth: number, path: ReadonlySet<string>): ReferenceRecordRef => {
    const nextPath = new Set(path);
    nextPath.add(row.reference_record_id);

    return {
      referenceId: row.reference_record_id,
      typeKey: row.type_key,
      key: row.key,
      name: row.name,
      attributes: row.attributes,
      relationships: asArray<ReferenceRelationship>(row.relationships).map((relationship) => {
        const related = rowsById.get(relationship.referenceId);
        const canExpand = related && depth < MAX_REFERENCE_EXPANSION_DEPTH && !nextPath.has(relationship.referenceId);

        return {
          relationshipType: relationship.relationshipType,
          referenceId: relationship.referenceId,
          reference: canExpand ? buildReference(related, depth + 1, nextPath) : undefined,
        };
      }),
      status: row.status,
    };
  };

  return new Map(
    uniqueIds.flatMap((referenceId) => {
      const row = rowsById.get(referenceId);

      return row ? [[row.reference_record_id, buildReference(row, 0, new Set())] as const] : [];
    }),
  );
}

async function loadReferenceRecordRowsByGraph(
  db: PgQueryable,
  ids: readonly string[],
): Promise<Map<string, ReferenceRecordRow>> {
  const rowsById = new Map<string, ReferenceRecordRow>();
  let frontier = [...new Set(ids)];

  for (let depth = 0; depth <= MAX_REFERENCE_EXPANSION_DEPTH && frontier.length > 0; depth++) {
    const rows = await loadReferenceRecordRows(
      db,
      frontier.filter((referenceId) => !rowsById.has(referenceId)),
    );

    for (const row of rows) {
      rowsById.set(row.reference_record_id, row);
    }

    frontier = [
      ...new Set(
        rows.flatMap((row) =>
          asArray<ReferenceRelationship>(row.relationships)
            .map((relationship) => relationship.referenceId)
            .filter((referenceId): referenceId is string => typeof referenceId === "string"),
        ),
      ),
    ].filter((referenceId) => !rowsById.has(referenceId));
  }

  return rowsById;
}

async function loadReferenceRecordRows(db: PgQueryable, ids: readonly string[]): Promise<ReferenceRecordRow[]> {
  if (ids.length === 0) {
    return [];
  }

  const result = await db.query<ReferenceRecordRow>(
    `SELECT reference_record_id, type_key, key, name, attributes, relationships, status
     FROM catalog_reference_records
     WHERE reference_record_id = ANY($1)`,
    [ids],
  );

  return result.rows;
}
