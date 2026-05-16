import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "../../../support/projection-support/extract-id-from-stream";
import {
  asArray,
  asStringArray,
  type FieldValue,
  loadNameMap,
} from "../../../support/projection-support/read-model-support";

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
  provider_key: string;
  external_key: string;
  selected_options: unknown;
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

async function refreshCatalogAdminCatalogItemListPage(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<BaseCatalogItemRow>(
    `SELECT * FROM catalog_items WHERE catalog_item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM catalog_admin_catalog_item_list_pages WHERE catalog_item_id = $1`, [itemId]);
    return;
  }

  const blueprintName = item.blueprint_id
    ? (await loadNameMap(db, "catalog_blueprints", "blueprint_id", "name", [item.blueprint_id])).get(item.blueprint_id)
    : undefined;

  await db.query(
    `INSERT INTO catalog_admin_catalog_item_list_pages (
      catalog_item_id,
      language_code,
      title_i18n,
      title,
      subtitle_i18n,
      subtitle,
      blueprint_id,
      blueprint,
      status,
      tags,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (catalog_item_id) DO UPDATE SET
      language_code = EXCLUDED.language_code,
      title_i18n = EXCLUDED.title_i18n,
      title = EXCLUDED.title,
      subtitle_i18n = EXCLUDED.subtitle_i18n,
      subtitle = EXCLUDED.subtitle,
      blueprint_id = EXCLUDED.blueprint_id,
      blueprint = EXCLUDED.blueprint,
      status = EXCLUDED.status,
      tags = EXCLUDED.tags,
      updated_at = EXCLUDED.updated_at`,
    [
      item.catalog_item_id,
      item.language_code,
      JSON.stringify(item.title_i18n ?? { defaultLocale: "en", values: { en: item.title } }),
      item.title,
      item.subtitle_i18n === null ? null : JSON.stringify(item.subtitle_i18n),
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
    `SELECT * FROM catalog_items WHERE catalog_item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM catalog_admin_catalog_item_detail_pages WHERE catalog_item_id = $1`, [itemId]);
    return;
  }

  const fieldValues = asArray<FieldValue>(item.field_values);
  const categoryIds = asStringArray(item.category_ids);
  const fieldIds = fieldValues.map((entry) => entry.fieldId);
  const referenceIds = fieldValues.map((entry) => referenceIdFromValue(entry.value)).filter((entry): entry is string => entry !== null);
  const externalReferencesResult = await db.query<ExternalProductReferenceRow>(
    `SELECT provider_key, external_key, selected_options, updated_at
     FROM catalog_external_product_references
     WHERE catalog_item_id = $1
     ORDER BY provider_key ASC, external_key ASC`,
    [itemId],
  );

  const [fieldNames, categoryNames, blueprintNames, references] = await Promise.all([
    loadNameMap(db, "catalog_fields", "field_id", "name", fieldIds),
    loadNameMap(db, "catalog_categories", "category_id", "name", categoryIds),
    item.blueprint_id
      ? loadNameMap(db, "catalog_blueprints", "blueprint_id", "name", [item.blueprint_id])
      : Promise.resolve(new Map<string, string>()),
    loadReferenceRecordMap(db, referenceIds),
  ]);

  const namedFieldValues = fieldValues.map((entry) => ({
    fieldId: entry.fieldId,
    fieldName: fieldNames.get(entry.fieldId) ?? entry.fieldId,
    value: entry.value,
    reference: references.get(referenceIdFromValue(entry.value) ?? "") ?? null,
  }));

  const namedCategories = categoryIds.map((categoryId) => ({
    categoryId,
    name: categoryNames.get(categoryId) ?? categoryId,
  }));
  const externalReferences = externalReferencesResult.rows.map((reference) => ({
    providerKey: reference.provider_key,
    externalKey: reference.external_key,
    selectedOptions: Array.isArray(reference.selected_options)
      ? reference.selected_options
      : [],
    updatedAt: reference.updated_at,
  }));

  await db.query(
    `INSERT INTO catalog_admin_catalog_item_detail_pages (
      catalog_item_id,
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
      external_product_references,
      tags,
      image_urls,
      product_asset_sets,
      image_fallback,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
    ON CONFLICT (catalog_item_id) DO UPDATE SET
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
      external_product_references = EXCLUDED.external_product_references,
      tags = EXCLUDED.tags,
      image_urls = EXCLUDED.image_urls,
      product_asset_sets = EXCLUDED.product_asset_sets,
      image_fallback = EXCLUDED.image_fallback,
      updated_at = EXCLUDED.updated_at`,
    [
      item.catalog_item_id,
      item.language_code,
      JSON.stringify(item.title_i18n ?? { defaultLocale: "en", values: { en: item.title } }),
      item.title,
      item.subtitle_i18n === null ? null : JSON.stringify(item.subtitle_i18n),
      item.subtitle,
      JSON.stringify(item.description_i18n ?? { defaultLocale: "en", values: { en: item.description } }),
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
      JSON.stringify(externalReferences),
      JSON.stringify(asStringArray(item.tags)),
      JSON.stringify(asStringArray(item.image_urls)),
      JSON.stringify(asArray(item.product_asset_sets)),
      item.image_fallback === null ? null : JSON.stringify(item.image_fallback),
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
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM catalog_items WHERE field_values @> $1::jsonb`,
    [JSON.stringify([{ fieldId }])],
  );

  return result.rows.map((row) => row.catalog_item_id);
}

async function findCatalogItemIdsByReferenceRecord(
  db: PgQueryable,
  referenceRecordId: string,
): Promise<string[]> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT DISTINCT catalog_item_id
     FROM catalog_items, jsonb_array_elements(field_values) AS field_value
     WHERE field_value->'value'->>'referenceId' = $1
        OR field_value->'value'->>'reference_record_id' = $1`,
    [referenceRecordId],
  );

  return result.rows.map((row) => row.catalog_item_id);
}

async function findReferenceRecordIdsByRelatedReference(
  db: PgQueryable,
  referenceRecordId: string,
): Promise<string[]> {
  const result = await db.query<{ reference_record_id: string }>(
    `SELECT DISTINCT reference_record_id
     FROM catalog_reference_records, jsonb_array_elements(relationships) AS relationship
     WHERE relationship->>'referenceId' = $1`,
    [referenceRecordId],
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
    const next = [
      ...new Set(
        (
          await Promise.all(
            frontier.map((recordId) => findReferenceRecordIdsByRelatedReference(db, recordId)),
          )
        ).flat(),
      ),
    ].filter((recordId) => !visited.has(recordId));

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

  async function refreshReferenceDependents(referenceRecordId: string) {
    const relatedRecordIds = await findReferenceRecordIdsByRelatedReferenceGraph(db, referenceRecordId);
    const itemIds = [
      ...(await findCatalogItemIdsByReferenceRecord(db, referenceRecordId)),
      ...(
        await Promise.all(
          relatedRecordIds.map((relatedRecordId) =>
            findCatalogItemIdsByReferenceRecord(db, relatedRecordId),
          ),
        )
      ).flat(),
    ];

    await refreshCatalogItemIds(db, [...new Set(itemIds)]);
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
    "catalog.catalog-item.external-product-reference-unlinked": async (event) => {
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

    "catalog.reference-record.created": async (event) => {
      await refreshReferenceDependents(event.data.referenceRecordId as string);
    },
    "catalog.reference-record.revised": async (event) => {
      await refreshReferenceDependents(extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX));
    },
    "catalog.reference-record.published": async (event) => {
      await refreshReferenceDependents(extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX));
    },
    "catalog.reference-record.deprecated": async (event) => {
      await refreshReferenceDependents(extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX));
    },
    "catalog.reference-record.archived": async (event) => {
      await refreshReferenceDependents(extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX));
    },
  };
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

  const rowsById = await loadReferenceRecordRowsByGraph(db, uniqueIds);
  const buildReference = (
    row: ReferenceRecordRow,
    depth: number,
    path: ReadonlySet<string>,
  ): ReferenceRecordRef => {
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
          reference: canExpand
            ? buildReference(related, depth + 1, nextPath)
            : undefined,
        };
      }),
      status: row.status,
    };
  };

  return new Map(
    uniqueIds.flatMap((referenceId) => {
      const row = rowsById.get(referenceId);

      return row
        ? [[row.reference_record_id, buildReference(row, 0, new Set())] as const]
        : [];
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

async function loadReferenceRecordRows(
  db: PgQueryable,
  ids: readonly string[],
): Promise<ReferenceRecordRow[]> {
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
