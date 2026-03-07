import type { PgQueryable } from "../../../../contracts/event-core/postgres/types";

export type DimensionRow = Readonly<{
  dimension_id: string;
  key: string;
  name: string;
  status: string;
  updated_at: string;
}>;

export type DimensionChoiceRow = Readonly<{
  choice_id: string;
  dimension_id: string;
  code: string;
  labels: unknown;
  display_order: number;
  numeric_value: number | null;
  status: string;
}>;

export type FieldRow = Readonly<{
  field_id: string;
  key: string;
  name: string;
  status: string;
  value_type: string;
  filterable: boolean;
  searchable: boolean;
  sortable: boolean;
  updated_at: string;
}>;

export type ComponentRow = Readonly<{
  component_id: string;
  key: string;
  name: string;
  status: string;
  field_rules: unknown;
  dimension_rules: unknown;
  updated_at: string;
}>;

export type BlueprintRow = Readonly<{
  blueprint_id: string;
  key: string;
  name: string;
  status: string;
  component_ids: unknown;
  field_rules: unknown;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
  updated_at: string;
}>;

export type CategoryRow = Readonly<{
  category_id: string;
  key: string;
  name: string;
  status: string;
  parent_category_id: string | null;
  display_order: number;
  updated_at: string;
}>;

export type CatalogItemRow = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  field_values: unknown;
  category_ids: unknown;
  updated_at: string;
}>;

export async function listDimensions(db: PgQueryable) {
  const result = await db.query<DimensionRow>(
    `SELECT * FROM catalog_dimensions ORDER BY key ASC`,
  );

  return result.rows;
}

export async function getDimension(db: PgQueryable, dimensionId: string) {
  const dimResult = await db.query<DimensionRow>(
    `SELECT * FROM catalog_dimensions WHERE dimension_id = $1`,
    [dimensionId],
  );

  if (dimResult.rows.length === 0) return null;

  const choicesResult = await db.query<DimensionChoiceRow>(
    `SELECT * FROM catalog_dimension_choices WHERE dimension_id = $1 ORDER BY display_order ASC`,
    [dimensionId],
  );

  return { ...dimResult.rows[0], choices: choicesResult.rows };
}

export async function listFields(db: PgQueryable) {
  const result = await db.query<FieldRow>(
    `SELECT * FROM catalog_fields ORDER BY key ASC`,
  );

  return result.rows;
}

export async function getField(db: PgQueryable, fieldId: string) {
  const result = await db.query<FieldRow>(
    `SELECT * FROM catalog_fields WHERE field_id = $1`,
    [fieldId],
  );

  return result.rows[0] ?? null;
}

export async function listComponents(db: PgQueryable) {
  const result = await db.query<ComponentRow>(
    `SELECT * FROM catalog_components ORDER BY key ASC`,
  );

  return result.rows;
}

export async function getComponent(db: PgQueryable, componentId: string) {
  const result = await db.query<ComponentRow>(
    `SELECT * FROM catalog_components WHERE component_id = $1`,
    [componentId],
  );

  return result.rows[0] ?? null;
}

export async function listBlueprints(db: PgQueryable) {
  const result = await db.query<BlueprintRow>(
    `SELECT * FROM catalog_blueprints ORDER BY key ASC`,
  );

  return result.rows;
}

export async function getBlueprint(db: PgQueryable, blueprintId: string) {
  const result = await db.query<BlueprintRow>(
    `SELECT * FROM catalog_blueprints WHERE blueprint_id = $1`,
    [blueprintId],
  );

  return result.rows[0] ?? null;
}

export async function listCategories(db: PgQueryable, parentCategoryId?: string) {
  if (parentCategoryId) {
    const result = await db.query<CategoryRow>(
      `SELECT * FROM catalog_categories WHERE parent_category_id = $1 ORDER BY display_order ASC, key ASC`,
      [parentCategoryId],
    );

    return result.rows;
  }

  const result = await db.query<CategoryRow>(
    `SELECT * FROM catalog_categories ORDER BY display_order ASC, key ASC`,
  );

  return result.rows;
}

export async function getCategory(db: PgQueryable, categoryId: string) {
  const result = await db.query<CategoryRow>(
    `SELECT * FROM catalog_categories WHERE category_id = $1`,
    [categoryId],
  );

  return result.rows[0] ?? null;
}

export async function listCatalogItems(db: PgQueryable) {
  const result = await db.query<CatalogItemRow>(
    `SELECT * FROM catalog_items ORDER BY title ASC`,
  );

  return result.rows;
}

export async function getCatalogItem(db: PgQueryable, itemId: string) {
  const result = await db.query<CatalogItemRow>(
    `SELECT * FROM catalog_items WHERE item_id = $1`,
    [itemId],
  );

  return result.rows[0] ?? null;
}
