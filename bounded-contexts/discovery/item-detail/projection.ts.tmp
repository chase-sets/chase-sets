import type { ProjectorHandlerMap } from "../../../../contracts/event-core/projector";
import type { PgQueryable } from "../../../../contracts/event-core/postgres/types";
import { asArray, asStringArray, extractIdFromStreamId, loadNameMap } from "./helpers";

const ITEM_STREAM_PREFIX = "catalog.item-";
const BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
const CATEGORY_STREAM_PREFIX = "catalog.category-";

type FieldValue = Readonly<{ fieldId: string; value: unknown }>;
type DimensionRule = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedChoiceIds?: string[];
}>;

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

type BaseBlueprintRow = Readonly<{
  blueprint_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  component_ids: unknown;
  field_rules: unknown;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
  updated_at: string;
}>;

type ChoiceDetailRow = Readonly<{
  choice_id: string;
  code: string;
  labels: unknown;
}>;

async function buildVersionSchema(db: PgQueryable, blueprintId: string): Promise<unknown | null> {
  const blueprintResult = await db.query<BaseBlueprintRow>(
    `SELECT * FROM catalog_blueprints WHERE blueprint_id = $1`,
    [blueprintId],
  );

  const blueprint = blueprintResult.rows[0];

  if (!blueprint) {
    return null;
  }

  const dimensionRules = asArray<DimensionRule>(blueprint.dimension_rules);
  const canonicalDimensionOrder = asStringArray(blueprint.canonical_dimension_order);

  const allDimensionIds = [...new Set([
    ...dimensionRules.map((rule) => rule.dimensionId),
    ...canonicalDimensionOrder,
  ])];

  const allChoiceIds = dimensionRules.flatMap((rule) => rule.allowedChoiceIds ?? []);

  const [dimensionNames, choiceDetails] = await Promise.all([
    loadNameMap(db, "catalog_dimensions", "dimension_id", "name", allDimensionIds),
    allChoiceIds.length > 0
      ? db.query<ChoiceDetailRow>(
          `SELECT choice_id, code, labels FROM catalog_dimension_choices WHERE choice_id = ANY($1)`,
          [allChoiceIds],
        ).then((result) => result.rows)
      : Promise.resolve([] as ChoiceDetailRow[]),
  ]);

  const choiceDetailMap = new Map(choiceDetails.map((row) => [row.choice_id, row]));

  const namedCanonicalOrder = canonicalDimensionOrder.map((id) => ({
    dimensionId: id,
    dimensionName: dimensionNames.get(id) ?? id,
  }));

  const dimensions = dimensionRules.map((rule) => ({
    dimensionId: rule.dimensionId,
    dimensionName: dimensionNames.get(rule.dimensionId) ?? rule.dimensionId,
    required: rule.required,
    allowedChoices: (rule.allowedChoiceIds ?? []).map((choiceId) => {
      const detail = choiceDetailMap.get(choiceId);
      return {
        choiceId,
        code: detail?.code ?? choiceId,
        labels: detail?.labels ?? [],
      };
    }),
  }));

  return {
    canonicalDimensionOrder: namedCanonicalOrder,
    dimensions,
  };
}

async function refreshDiscoveryItemDetailPage(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<BaseCatalogItemRow>(
    `SELECT * FROM catalog_items WHERE item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM marketplace_item_detail_pages WHERE item_id = $1`, [itemId]);
    return;
  }

  const fieldValues = asArray<FieldValue>(item.field_values);
  const categoryIds = asStringArray(item.category_ids);
  const tags = asStringArray(item.tags);
  const imageUrls = asStringArray(item.image_urls);
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

  const namedCategories = categoryIds.map((id) => ({
    categoryId: id,
    name: categoryNames.get(id) ?? id,
  }));

  const blueprintJson = item.blueprint_id
    ? JSON.stringify({
        blueprintId: item.blueprint_id,
        name: blueprintNames.get(item.blueprint_id) ?? item.blueprint_id,
      })
    : null;

  const versionSchema = item.blueprint_id
    ? await buildVersionSchema(db, item.blueprint_id)
    : null;

  await db.query(
    `INSERT INTO marketplace_item_detail_pages (
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
      version_schema,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      version_schema = EXCLUDED.version_schema,
      updated_at = EXCLUDED.updated_at`,
    [
      item.item_id,
      item.title,
      item.subtitle,
      item.description,
      item.blueprint_id,
      blueprintJson,
      item.status,
      JSON.stringify(namedFieldValues),
      JSON.stringify(namedCategories),
      JSON.stringify(tags),
      JSON.stringify(imageUrls),
      versionSchema ? JSON.stringify(versionSchema) : null,
      item.updated_at,
    ],
  );
}

async function refreshItemsByBlueprint(db: PgQueryable, blueprintId: string): Promise<void> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items WHERE blueprint_id = $1`,
    [blueprintId],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoveryItemDetailPage(db, row.item_id)));
}

async function refreshItemsByCategory(db: PgQueryable, categoryId: string): Promise<void> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items WHERE category_ids @> $1::jsonb`,
    [JSON.stringify([categoryId])],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoveryItemDetailPage(db, row.item_id)));
}

async function refreshAllItems(db: PgQueryable): Promise<void> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items`,
  );

  await Promise.all(result.rows.map((row) => refreshDiscoveryItemDetailPage(db, row.item_id)));
}

export function buildDiscoveryItemDetailProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.created": async (event) => {
      await refreshDiscoveryItemDetailPage(db, event.data.itemId as string);
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      await refreshDiscoveryItemDetailPage(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.field-value-set": async (event) => {
      await refreshDiscoveryItemDetailPage(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.field-value-cleared": async (event) => {
      await refreshDiscoveryItemDetailPage(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      await refreshDiscoveryItemDetailPage(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.category-removed": async (event) => {
      await refreshDiscoveryItemDetailPage(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.published": async (event) => {
      await refreshDiscoveryItemDetailPage(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      await refreshDiscoveryItemDetailPage(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.tags-set": async (event) => {
      await refreshDiscoveryItemDetailPage(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.image-urls-set": async (event) => {
      await refreshDiscoveryItemDetailPage(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.retired": async (event) => {
      await refreshDiscoveryItemDetailPage(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.archived": async (event) => {
      await refreshDiscoveryItemDetailPage(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },

    "catalog.blueprint.revised": async (event) => {
      await refreshItemsByBlueprint(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.dimensions-set": async (event) => {
      await refreshItemsByBlueprint(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.version-rules-set": async (event) => {
      await refreshItemsByBlueprint(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.published": async (event) => {
      await refreshItemsByBlueprint(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },

    "catalog.category.revised": async (event) => {
      await refreshItemsByCategory(db, extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX));
    },

    "catalog.dimension.revised": async () => {
      await refreshAllItems(db);
    },
    "catalog.dimension.choice-added": async () => {
      await refreshAllItems(db);
    },
    "catalog.dimension.choice-revised": async () => {
      await refreshAllItems(db);
    },
  };
}
