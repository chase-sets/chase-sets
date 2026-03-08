import type { PgQueryable } from "../../../../contracts/event-core/postgres/types";

export type ListParams = {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

export type ListResult<T> = {
  items: T[];
  total: number;
};

export type DimensionRow = Readonly<{
  dimension_id: string;
  key: string;
  name: string;
  description: string;
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
  description: string;
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
  description: string;
  status: string;
  field_rules: unknown;
  dimension_rules: unknown;
  updated_at: string;
}>;

export type BlueprintRow = Readonly<{
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

export type CategoryRow = Readonly<{
  category_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  parent_category_id: string | null;
  display_order: number;
  updated_at: string;
}>;

export type CatalogItemRow = Readonly<{
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

function buildFilteredQuery(
  baseTable: string,
  params: ListParams,
  searchColumns: string[],
  orderBy: string,
  extraConditions: string[] = [],
  extraValues: unknown[] = [],
): { countSql: string; listSql: string; values: unknown[] } {
  const conditions = [...extraConditions];
  const values = [...extraValues];
  let paramIndex = extraValues.length + 1;

  if (params.status) {
    conditions.push(`status = $${paramIndex}`);
    values.push(params.status);
    paramIndex++;
  }

  if (params.search) {
    const likeClauses = searchColumns.map((col) => `${col} ILIKE $${paramIndex}`);
    conditions.push(`(${likeClauses.join(" OR ")})`);
    values.push(`%${params.search}%`);
    paramIndex++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  return {
    countSql: `SELECT COUNT(*) as count FROM ${baseTable} ${where}`,
    listSql: `SELECT * FROM ${baseTable} ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
    values,
  };
}

async function executeListQuery<T>(db: PgQueryable, countSql: string, listSql: string, values: unknown[]): Promise<ListResult<T>> {
  const [countResult, listResult] = await Promise.all([
    db.query<{ count: string }>(countSql, values),
    db.query<T>(listSql, values),
  ]);

  return { items: listResult.rows, total: parseInt(countResult.rows[0].count) };
}

export async function listDimensions(db: PgQueryable, params: ListParams = {}): Promise<ListResult<DimensionRow>> {
  const q = buildFilteredQuery("catalog_dimensions", params, ["key", "name"], "key ASC");
  return executeListQuery<DimensionRow>(db, q.countSql, q.listSql, q.values);
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

export async function listFields(db: PgQueryable, params: ListParams = {}): Promise<ListResult<FieldRow>> {
  const q = buildFilteredQuery("catalog_fields", params, ["key", "name"], "key ASC");
  return executeListQuery<FieldRow>(db, q.countSql, q.listSql, q.values);
}

export async function getField(db: PgQueryable, fieldId: string) {
  const result = await db.query<FieldRow>(
    `SELECT * FROM catalog_fields WHERE field_id = $1`,
    [fieldId],
  );

  return result.rows[0] ?? null;
}

export async function listComponents(db: PgQueryable, params: ListParams = {}): Promise<ListResult<ComponentRow>> {
  const q = buildFilteredQuery("catalog_components", params, ["key", "name"], "key ASC");
  return executeListQuery<ComponentRow>(db, q.countSql, q.listSql, q.values);
}

export async function getComponent(db: PgQueryable, componentId: string) {
  const result = await db.query<ComponentRow>(
    `SELECT * FROM catalog_components WHERE component_id = $1`,
    [componentId],
  );

  return result.rows[0] ?? null;
}

export async function listBlueprints(db: PgQueryable, params: ListParams = {}): Promise<ListResult<BlueprintRow>> {
  const q = buildFilteredQuery("catalog_blueprints", params, ["key", "name"], "key ASC");
  return executeListQuery<BlueprintRow>(db, q.countSql, q.listSql, q.values);
}

export async function getBlueprint(db: PgQueryable, blueprintId: string) {
  const result = await db.query<BlueprintRow>(
    `SELECT * FROM catalog_blueprints WHERE blueprint_id = $1`,
    [blueprintId],
  );

  return result.rows[0] ?? null;
}

export async function listCategories(
  db: PgQueryable,
  params: ListParams & { parentCategoryId?: string } = {},
): Promise<ListResult<CategoryRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];

  if (params.parentCategoryId) {
    extraConditions.push(`parent_category_id = $1`);
    extraValues.push(params.parentCategoryId);
  }

  const q = buildFilteredQuery("catalog_categories", params, ["key", "name"], "display_order ASC, key ASC", extraConditions, extraValues);
  return executeListQuery<CategoryRow>(db, q.countSql, q.listSql, q.values);
}

export async function getCategory(db: PgQueryable, categoryId: string) {
  const result = await db.query<CategoryRow>(
    `SELECT * FROM catalog_categories WHERE category_id = $1`,
    [categoryId],
  );

  return result.rows[0] ?? null;
}

export async function listCatalogItems(
  db: PgQueryable,
  params: ListParams & { blueprintId?: string; tag?: string } = {},
): Promise<ListResult<CatalogItemRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];
  let paramIndex = 1;

  if (params.blueprintId) {
    extraConditions.push(`blueprint_id = $${paramIndex}`);
    extraValues.push(params.blueprintId);
    paramIndex++;
  }

  if (params.tag) {
    extraConditions.push(`tags @> $${paramIndex}::jsonb`);
    extraValues.push(JSON.stringify([params.tag]));
    paramIndex++;
  }

  const q = buildFilteredQuery("catalog_items", params, ["title", "subtitle"], "title ASC", extraConditions, extraValues);
  return executeListQuery<CatalogItemRow>(db, q.countSql, q.listSql, q.values);
}

export async function getCatalogItem(db: PgQueryable, itemId: string) {
  const result = await db.query<CatalogItemRow>(
    `SELECT * FROM catalog_items WHERE item_id = $1`,
    [itemId],
  );

  return result.rows[0] ?? null;
}

export type NameEntry = Readonly<{ id: string; name: string }>;

export async function resolveFieldNames(db: PgQueryable, fieldIds: string[]): Promise<NameEntry[]> {
  if (fieldIds.length === 0) return [];
  const result = await db.query<{ field_id: string; name: string }>(
    `SELECT field_id, name FROM catalog_fields WHERE field_id = ANY($1)`,
    [fieldIds],
  );
  return result.rows.map((row) => ({ id: row.field_id, name: row.name }));
}

export async function resolveDimensionNames(db: PgQueryable, dimensionIds: string[]): Promise<NameEntry[]> {
  if (dimensionIds.length === 0) return [];
  const result = await db.query<{ dimension_id: string; name: string }>(
    `SELECT dimension_id, name FROM catalog_dimensions WHERE dimension_id = ANY($1)`,
    [dimensionIds],
  );
  return result.rows.map((row) => ({ id: row.dimension_id, name: row.name }));
}

export async function resolveComponentNames(db: PgQueryable, componentIds: string[]): Promise<NameEntry[]> {
  if (componentIds.length === 0) return [];
  const result = await db.query<{ component_id: string; name: string }>(
    `SELECT component_id, name FROM catalog_components WHERE component_id = ANY($1)`,
    [componentIds],
  );
  return result.rows.map((row) => ({ id: row.component_id, name: row.name }));
}

export async function resolveBlueprintNames(db: PgQueryable, blueprintIds: string[]): Promise<NameEntry[]> {
  if (blueprintIds.length === 0) return [];
  const result = await db.query<{ blueprint_id: string; name: string }>(
    `SELECT blueprint_id, name FROM catalog_blueprints WHERE blueprint_id = ANY($1)`,
    [blueprintIds],
  );
  return result.rows.map((row) => ({ id: row.blueprint_id, name: row.name }));
}

export async function resolveCategoryNames(db: PgQueryable, categoryIds: string[]): Promise<NameEntry[]> {
  if (categoryIds.length === 0) return [];
  const result = await db.query<{ category_id: string; name: string }>(
    `SELECT category_id, name FROM catalog_categories WHERE category_id = ANY($1)`,
    [categoryIds],
  );
  return result.rows.map((row) => ({ id: row.category_id, name: row.name }));
}

export async function resolveChoiceCodes(db: PgQueryable, choiceIds: string[]): Promise<NameEntry[]> {
  if (choiceIds.length === 0) return [];
  const result = await db.query<{ choice_id: string; code: string }>(
    `SELECT choice_id, code FROM catalog_dimension_choices WHERE choice_id = ANY($1)`,
    [choiceIds],
  );
  return result.rows.map((row) => ({ id: row.choice_id, name: row.code }));
}
