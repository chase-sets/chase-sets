import type { ProjectorHandlerMap } from "../../../../contracts/event-core/projector";
import type { PgQueryable } from "../../../../contracts/event-core/postgres/types";
import { extractIdFromStreamId } from "./helpers";

type BaseComponentRow = Readonly<{
  component_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  field_rules: unknown;
  dimension_rules: unknown;
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

type BaseCategoryRow = Readonly<{
  category_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  parent_category_id: string | null;
  display_order: number;
  updated_at: string;
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

type FieldRule = Readonly<{ fieldId: string; required: boolean }>;
type DimensionRule = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedChoiceIds?: string[];
}>;
type FieldValue = Readonly<{ fieldId: string; value: unknown }>;

const COMPONENT_STREAM_PREFIX = "catalog.component-";
const BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
const CATEGORY_STREAM_PREFIX = "catalog.category-";
const ITEM_STREAM_PREFIX = "catalog.item-";
const DIMENSION_STREAM_PREFIX = "catalog.dimension-";
const FIELD_STREAM_PREFIX = "catalog.field-";

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
  ids: string[],
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

async function loadChoiceCodeMap(db: PgQueryable, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await db.query<{ choice_id: string; code: string }>(
    `SELECT choice_id, code FROM catalog_dimension_choices WHERE choice_id = ANY($1)`,
    [ids],
  );

  return new Map(result.rows.map((row) => [row.choice_id, row.code]));
}

async function refreshComponentDetailPage(db: PgQueryable, componentId: string): Promise<void> {
  const result = await db.query<BaseComponentRow>(
    `SELECT * FROM catalog_components WHERE component_id = $1`,
    [componentId],
  );

  const component = result.rows[0];

  if (!component) {
    await db.query(`DELETE FROM catalog_admin_component_detail_pages WHERE component_id = $1`, [componentId]);
    return;
  }

  const fieldRules = asArray<FieldRule>(component.field_rules);
  const dimensionRules = asArray<DimensionRule>(component.dimension_rules);
  const fieldIds = fieldRules.map((rule) => rule.fieldId);
  const dimensionIds = dimensionRules.map((rule) => rule.dimensionId);
  const choiceIds = dimensionRules.flatMap((rule) => rule.allowedChoiceIds ?? []);

  const [fieldNames, dimensionNames, choiceCodes] = await Promise.all([
    loadNameMap(db, "catalog_fields", "field_id", "name", fieldIds),
    loadNameMap(db, "catalog_dimensions", "dimension_id", "name", dimensionIds),
    loadChoiceCodeMap(db, choiceIds),
  ]);

  const namedFieldRules = fieldRules.map((rule) => ({
    fieldId: rule.fieldId,
    fieldName: fieldNames.get(rule.fieldId) ?? rule.fieldId,
    required: rule.required,
  }));

  const namedDimensionRules = dimensionRules.map((rule) => ({
    dimensionId: rule.dimensionId,
    dimensionName: dimensionNames.get(rule.dimensionId) ?? rule.dimensionId,
    required: rule.required,
    allowedChoices: (rule.allowedChoiceIds ?? []).map((choiceId) => ({
      choiceId,
      code: choiceCodes.get(choiceId) ?? choiceId,
    })),
  }));

  await db.query(
    `INSERT INTO catalog_admin_component_detail_pages (
      component_id,
      key,
      name,
      description,
      status,
      field_rules,
      dimension_rules,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (component_id) DO UPDATE SET
      key = EXCLUDED.key,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      field_rules = EXCLUDED.field_rules,
      dimension_rules = EXCLUDED.dimension_rules,
      updated_at = EXCLUDED.updated_at`,
    [
      component.component_id,
      component.key,
      component.name,
      component.description,
      component.status,
      JSON.stringify(namedFieldRules),
      JSON.stringify(namedDimensionRules),
      component.updated_at,
    ],
  );
}

async function refreshBlueprintDetailPage(db: PgQueryable, blueprintId: string): Promise<void> {
  const result = await db.query<BaseBlueprintRow>(
    `SELECT * FROM catalog_blueprints WHERE blueprint_id = $1`,
    [blueprintId],
  );

  const blueprint = result.rows[0];

  if (!blueprint) {
    await db.query(`DELETE FROM catalog_admin_blueprint_detail_pages WHERE blueprint_id = $1`, [blueprintId]);
    return;
  }

  const componentIds = asStringArray(blueprint.component_ids);
  const fieldRules = asArray<FieldRule>(blueprint.field_rules);
  const dimensionRules = asArray<DimensionRule>(blueprint.dimension_rules);
  const canonicalDimensionOrder = asStringArray(blueprint.canonical_dimension_order);
  const fieldIds = fieldRules.map((rule) => rule.fieldId);
  const dimensionIds = [...new Set([
    ...dimensionRules.map((rule) => rule.dimensionId),
    ...canonicalDimensionOrder,
  ])];
  const choiceIds = dimensionRules.flatMap((rule) => rule.allowedChoiceIds ?? []);

  const [componentNames, fieldNames, dimensionNames, choiceCodes] = await Promise.all([
    loadNameMap(db, "catalog_components", "component_id", "name", componentIds),
    loadNameMap(db, "catalog_fields", "field_id", "name", fieldIds),
    loadNameMap(db, "catalog_dimensions", "dimension_id", "name", dimensionIds),
    loadChoiceCodeMap(db, choiceIds),
  ]);

  const namedComponents = componentIds.map((id) => ({
    componentId: id,
    name: componentNames.get(id) ?? id,
  }));

  const namedFieldRules = fieldRules.map((rule) => ({
    fieldId: rule.fieldId,
    fieldName: fieldNames.get(rule.fieldId) ?? rule.fieldId,
    required: rule.required,
  }));

  const namedDimensionRules = dimensionRules.map((rule) => ({
    dimensionId: rule.dimensionId,
    dimensionName: dimensionNames.get(rule.dimensionId) ?? rule.dimensionId,
    required: rule.required,
    allowedChoices: (rule.allowedChoiceIds ?? []).map((choiceId) => ({
      choiceId,
      code: choiceCodes.get(choiceId) ?? choiceId,
    })),
  }));

  const namedCanonicalOrder = canonicalDimensionOrder.map((id) => ({
    dimensionId: id,
    dimensionName: dimensionNames.get(id) ?? id,
  }));

  await db.query(
    `INSERT INTO catalog_admin_blueprint_detail_pages (
      blueprint_id,
      key,
      name,
      description,
      status,
      components,
      field_rules,
      dimension_rules,
      canonical_dimension_order,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (blueprint_id) DO UPDATE SET
      key = EXCLUDED.key,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      components = EXCLUDED.components,
      field_rules = EXCLUDED.field_rules,
      dimension_rules = EXCLUDED.dimension_rules,
      canonical_dimension_order = EXCLUDED.canonical_dimension_order,
      updated_at = EXCLUDED.updated_at`,
    [
      blueprint.blueprint_id,
      blueprint.key,
      blueprint.name,
      blueprint.description,
      blueprint.status,
      JSON.stringify(namedComponents),
      JSON.stringify(namedFieldRules),
      JSON.stringify(namedDimensionRules),
      JSON.stringify(namedCanonicalOrder),
      blueprint.updated_at,
    ],
  );
}

async function refreshCategoryPageRow(
  db: PgQueryable,
  tableName: "catalog_admin_category_list_pages" | "catalog_admin_category_detail_pages",
  categoryId: string,
): Promise<void> {
  const result = await db.query<BaseCategoryRow>(
    `SELECT * FROM catalog_categories WHERE category_id = $1`,
    [categoryId],
  );

  const category = result.rows[0];

  if (!category) {
    await db.query(`DELETE FROM ${tableName} WHERE category_id = $1`, [categoryId]);
    return;
  }

  const parentCategoryName = category.parent_category_id
    ? (await loadNameMap(db, "catalog_categories", "category_id", "name", [category.parent_category_id])).get(category.parent_category_id)
    : undefined;

  await db.query(
    `INSERT INTO ${tableName} (
      category_id,
      key,
      name,
      description,
      status,
      parent_category_id,
      parent_category,
      display_order,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (category_id) DO UPDATE SET
      key = EXCLUDED.key,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      parent_category_id = EXCLUDED.parent_category_id,
      parent_category = EXCLUDED.parent_category,
      display_order = EXCLUDED.display_order,
      updated_at = EXCLUDED.updated_at`,
    [
      category.category_id,
      category.key,
      category.name,
      category.description,
      category.status,
      category.parent_category_id,
      category.parent_category_id && parentCategoryName
        ? JSON.stringify({ categoryId: category.parent_category_id, name: parentCategoryName })
        : null,
      category.display_order,
      category.updated_at,
    ],
  );
}

async function refreshCategoryPages(db: PgQueryable, categoryId: string): Promise<void> {
  await Promise.all([
    refreshCategoryPageRow(db, "catalog_admin_category_list_pages", categoryId),
    refreshCategoryPageRow(db, "catalog_admin_category_detail_pages", categoryId),
  ]);
}

async function refreshCatalogItemListPage(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<BaseCatalogItemRow>(
    `SELECT * FROM catalog_items WHERE item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM catalog_admin_catalog_item_list_pages WHERE item_id = $1`, [itemId]);
    return;
  }

  const blueprintName = item.blueprint_id
    ? (await loadNameMap(db, "catalog_blueprints", "blueprint_id", "name", [item.blueprint_id])).get(item.blueprint_id)
    : undefined;

  await db.query(
    `INSERT INTO catalog_admin_catalog_item_list_pages (
      item_id,
      title,
      subtitle,
      blueprint_id,
      blueprint,
      status,
      tags,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (item_id) DO UPDATE SET
      title = EXCLUDED.title,
      subtitle = EXCLUDED.subtitle,
      blueprint_id = EXCLUDED.blueprint_id,
      blueprint = EXCLUDED.blueprint,
      status = EXCLUDED.status,
      tags = EXCLUDED.tags,
      updated_at = EXCLUDED.updated_at`,
    [
      item.item_id,
      item.title,
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

async function refreshCatalogItemDetailPage(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<BaseCatalogItemRow>(
    `SELECT * FROM catalog_items WHERE item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM catalog_admin_catalog_item_detail_pages WHERE item_id = $1`, [itemId]);
    return;
  }

  const fieldValues = asArray<FieldValue>(item.field_values);
  const categoryIds = asStringArray(item.category_ids);
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

  await db.query(
    `INSERT INTO catalog_admin_catalog_item_detail_pages (
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
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      updated_at = EXCLUDED.updated_at`,
    [
      item.item_id,
      item.title,
      item.subtitle,
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
      JSON.stringify(asStringArray(item.tags)),
      JSON.stringify(asStringArray(item.image_urls)),
      item.updated_at,
    ],
  );
}

async function refreshCatalogItemPages(db: PgQueryable, itemId: string): Promise<void> {
  await Promise.all([
    refreshCatalogItemListPage(db, itemId),
    refreshCatalogItemDetailPage(db, itemId),
  ]);
}

async function refreshComponentIds(db: PgQueryable, componentIds: string[]): Promise<void> {
  await Promise.all(componentIds.map((componentId) => refreshComponentDetailPage(db, componentId)));
}

async function refreshBlueprintIds(db: PgQueryable, blueprintIds: string[]): Promise<void> {
  await Promise.all(blueprintIds.map((blueprintId) => refreshBlueprintDetailPage(db, blueprintId)));
}

async function refreshCategoryIds(db: PgQueryable, categoryIds: string[]): Promise<void> {
  await Promise.all(categoryIds.map((categoryId) => refreshCategoryPages(db, categoryId)));
}

async function refreshCatalogItemIds(db: PgQueryable, itemIds: string[]): Promise<void> {
  await Promise.all(itemIds.map((itemId) => refreshCatalogItemPages(db, itemId)));
}

async function findComponentIdsByField(db: PgQueryable, fieldId: string): Promise<string[]> {
  const result = await db.query<{ component_id: string }>(
    `SELECT component_id FROM catalog_components WHERE field_rules @> $1::jsonb`,
    [JSON.stringify([{ fieldId }])],
  );
  return result.rows.map((row) => row.component_id);
}

async function findBlueprintIdsByField(db: PgQueryable, fieldId: string): Promise<string[]> {
  const result = await db.query<{ blueprint_id: string }>(
    `SELECT blueprint_id FROM catalog_blueprints WHERE field_rules @> $1::jsonb`,
    [JSON.stringify([{ fieldId }])],
  );
  return result.rows.map((row) => row.blueprint_id);
}

async function findCatalogItemIdsByField(db: PgQueryable, fieldId: string): Promise<string[]> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items WHERE field_values @> $1::jsonb`,
    [JSON.stringify([{ fieldId }])],
  );
  return result.rows.map((row) => row.item_id);
}

async function findComponentIdsByDimension(db: PgQueryable, dimensionId: string): Promise<string[]> {
  const result = await db.query<{ component_id: string }>(
    `SELECT component_id FROM catalog_components WHERE dimension_rules @> $1::jsonb`,
    [JSON.stringify([{ dimensionId }])],
  );
  return result.rows.map((row) => row.component_id);
}

async function findBlueprintIdsByDimension(db: PgQueryable, dimensionId: string): Promise<string[]> {
  const result = await db.query<{ blueprint_id: string }>(
    `SELECT blueprint_id
     FROM catalog_blueprints
     WHERE dimension_rules @> $1::jsonb OR canonical_dimension_order @> $2::jsonb`,
    [JSON.stringify([{ dimensionId }]), JSON.stringify([dimensionId])],
  );
  return result.rows.map((row) => row.blueprint_id);
}

async function findComponentIdsByChoice(db: PgQueryable, choiceId: string): Promise<string[]> {
  const result = await db.query<{ component_id: string }>(
    `SELECT component_id
     FROM catalog_components
     WHERE EXISTS (
       SELECT 1
       FROM jsonb_array_elements(dimension_rules) AS rule
       WHERE (rule->'allowedChoiceIds') @> to_jsonb(ARRAY[$1]::text[])
     )`,
    [choiceId],
  );
  return result.rows.map((row) => row.component_id);
}

async function findBlueprintIdsByChoice(db: PgQueryable, choiceId: string): Promise<string[]> {
  const result = await db.query<{ blueprint_id: string }>(
    `SELECT blueprint_id
     FROM catalog_blueprints
     WHERE EXISTS (
       SELECT 1
       FROM jsonb_array_elements(dimension_rules) AS rule
       WHERE (rule->'allowedChoiceIds') @> to_jsonb(ARRAY[$1]::text[])
     )`,
    [choiceId],
  );
  return result.rows.map((row) => row.blueprint_id);
}

async function findBlueprintIdsByComponent(db: PgQueryable, componentId: string): Promise<string[]> {
  const result = await db.query<{ blueprint_id: string }>(
    `SELECT blueprint_id FROM catalog_blueprints WHERE component_ids @> $1::jsonb`,
    [JSON.stringify([componentId])],
  );
  return result.rows.map((row) => row.blueprint_id);
}

async function findCatalogItemIdsByBlueprint(db: PgQueryable, blueprintId: string): Promise<string[]> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items WHERE blueprint_id = $1`,
    [blueprintId],
  );
  return result.rows.map((row) => row.item_id);
}

async function findCategoryChildren(db: PgQueryable, categoryId: string): Promise<string[]> {
  const result = await db.query<{ category_id: string }>(
    `SELECT category_id FROM catalog_categories WHERE parent_category_id = $1`,
    [categoryId],
  );
  return result.rows.map((row) => row.category_id);
}

async function findCatalogItemIdsByCategory(db: PgQueryable, categoryId: string): Promise<string[]> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM catalog_items WHERE category_ids @> $1::jsonb`,
    [JSON.stringify([categoryId])],
  );
  return result.rows.map((row) => row.item_id);
}

export function buildAdminPageProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  async function refreshFieldDependents(fieldId: string): Promise<void> {
    const [componentIds, blueprintIds, itemIds] = await Promise.all([
      findComponentIdsByField(db, fieldId),
      findBlueprintIdsByField(db, fieldId),
      findCatalogItemIdsByField(db, fieldId),
    ]);

    await Promise.all([
      refreshComponentIds(db, componentIds),
      refreshBlueprintIds(db, blueprintIds),
      refreshCatalogItemIds(db, itemIds),
    ]);
  }

  async function refreshDimensionDependents(dimensionId: string): Promise<void> {
    const [componentIds, blueprintIds] = await Promise.all([
      findComponentIdsByDimension(db, dimensionId),
      findBlueprintIdsByDimension(db, dimensionId),
    ]);

    await Promise.all([
      refreshComponentIds(db, componentIds),
      refreshBlueprintIds(db, blueprintIds),
    ]);
  }

  async function refreshChoiceDependents(choiceId: string): Promise<void> {
    const [componentIds, blueprintIds] = await Promise.all([
      findComponentIdsByChoice(db, choiceId),
      findBlueprintIdsByChoice(db, choiceId),
    ]);

    await Promise.all([
      refreshComponentIds(db, componentIds),
      refreshBlueprintIds(db, blueprintIds),
    ]);
  }

  async function refreshBlueprintDependents(blueprintId: string): Promise<void> {
    const itemIds = await findCatalogItemIdsByBlueprint(db, blueprintId);

    await Promise.all([
      refreshBlueprintDetailPage(db, blueprintId),
      refreshCatalogItemIds(db, itemIds),
    ]);
  }

  async function refreshCategoryDependents(categoryId: string): Promise<void> {
    const [childIds, itemIds] = await Promise.all([
      findCategoryChildren(db, categoryId),
      findCatalogItemIdsByCategory(db, categoryId),
    ]);

    await Promise.all([
      refreshCategoryPages(db, categoryId),
      refreshCategoryIds(db, childIds),
      refreshCatalogItemIds(db, itemIds),
    ]);
  }

  async function refreshComponentAndBlueprintDependents(componentId: string): Promise<void> {
    const blueprintIds = await findBlueprintIdsByComponent(db, componentId);

    await Promise.all([
      refreshComponentDetailPage(db, componentId),
      refreshBlueprintIds(db, blueprintIds),
    ]);
  }

  return {
    "catalog.component.created": async (event) => {
      await refreshComponentDetailPage(db, event.data.componentId as string);
    },
    "catalog.component.field-rule-added": async (event) => {
      await refreshComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.field-rule-removed": async (event) => {
      await refreshComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.dimension-rule-added": async (event) => {
      await refreshComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.dimension-rule-removed": async (event) => {
      await refreshComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.rules-configured": async (event) => {
      await refreshComponentAndBlueprintDependents(extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.activated": async (event) => {
      await refreshComponentAndBlueprintDependents(extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.deprecated": async (event) => {
      await refreshComponentAndBlueprintDependents(extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.archived": async (event) => {
      await refreshComponentAndBlueprintDependents(extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },

    "catalog.blueprint.created": async (event) => {
      await refreshBlueprintDetailPage(db, event.data.blueprintId as string);
    },
    "catalog.blueprint.revised": async (event) => {
      await refreshBlueprintDependents(extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.component-attached": async (event) => {
      await refreshBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.component-detached": async (event) => {
      await refreshBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.fields-set": async (event) => {
      await refreshBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.dimensions-set": async (event) => {
      await refreshBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.version-rules-set": async (event) => {
      await refreshBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
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
      await refreshCategoryPages(db, event.data.categoryId as string);
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

    "catalog.catalog-item.created": async (event) => {
      await refreshCatalogItemPages(db, event.data.itemId as string);
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      await refreshCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.field-value-set": async (event) => {
      await refreshCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.field-value-cleared": async (event) => {
      await refreshCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      await refreshCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.category-removed": async (event) => {
      await refreshCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.published": async (event) => {
      await refreshCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      await refreshCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.tags-set": async (event) => {
      await refreshCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.image-urls-set": async (event) => {
      await refreshCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.retired": async (event) => {
      await refreshCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
    },
    "catalog.catalog-item.archived": async (event) => {
      await refreshCatalogItemPages(db, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX));
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

    "catalog.dimension.created": async (event) => {
      await refreshDimensionDependents(event.data.dimensionId as string);
    },
    "catalog.dimension.revised": async (event) => {
      await refreshDimensionDependents(extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX));
    },
    "catalog.dimension.choice-added": async (event) => {
      await refreshChoiceDependents(event.data.choiceId as string);
    },
    "catalog.dimension.choice-revised": async (event) => {
      await refreshChoiceDependents(event.data.choiceId as string);
    },
    "catalog.dimension.choices-reordered": async () => {
      // Choice order is not rendered in admin page projections.
    },
    "catalog.dimension.choice-deprecated": async (event) => {
      await refreshChoiceDependents(event.data.choiceId as string);
    },
    "catalog.dimension.choice-reactivated": async (event) => {
      await refreshChoiceDependents(event.data.choiceId as string);
    },
    "catalog.dimension.activated": async (event) => {
      await refreshDimensionDependents(extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX));
    },
    "catalog.dimension.deprecated": async (event) => {
      await refreshDimensionDependents(extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX));
    },
    "catalog.dimension.archived": async (event) => {
      await refreshDimensionDependents(extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX));
    },
  };
}
