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

export type NamedEntityRefRow = Readonly<{
  categoryId?: string;
  blueprintId?: string;
  componentId?: string;
  dimensionId?: string;
  fieldId?: string;
  name: string;
}>;

export type NamedChoiceRefRow = Readonly<{
  choiceId: string;
  code: string;
}>;

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

export type ComponentDetailRow = Readonly<{
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

export type BlueprintDetailRow = Readonly<{
  blueprint_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  components: unknown;
  field_rules: unknown;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
  updated_at: string;
}>;

export type CategoryListRow = Readonly<{
  category_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  parent_category_id: string | null;
  parent_category: unknown;
  display_order: number;
  updated_at: string;
}>;

export type CategoryDetailRow = CategoryListRow;

export type CatalogItemListRow = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  blueprint: unknown;
  status: string;
  tags: unknown;
  updated_at: string;
}>;

export type CatalogItemDetailRow = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint_id: string | null;
  blueprint: unknown;
  status: string;
  field_values: unknown;
  categories: unknown;
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
    const likeClauses = searchColumns.map((column) => `${column} ILIKE $${paramIndex}`);
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

  return {
    items: listResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

export async function listDimensions(db: PgQueryable, params: ListParams = {}): Promise<ListResult<DimensionRow>> {
  const query = buildFilteredQuery("catalog_dimensions", params, ["key", "name"], "key ASC");
  return executeListQuery<DimensionRow>(db, query.countSql, query.listSql, query.values);
}

export async function getDimension(db: PgQueryable, dimensionId: string) {
  const dimensionResult = await db.query<DimensionRow>(
    `SELECT * FROM catalog_dimensions WHERE dimension_id = $1`,
    [dimensionId],
  );

  if (dimensionResult.rows.length === 0) {
    return null;
  }

  const choicesResult = await db.query<DimensionChoiceRow>(
    `SELECT * FROM catalog_dimension_choices WHERE dimension_id = $1 ORDER BY display_order ASC`,
    [dimensionId],
  );

  return { ...dimensionResult.rows[0], choices: choicesResult.rows };
}

export async function listFields(db: PgQueryable, params: ListParams = {}): Promise<ListResult<FieldRow>> {
  const query = buildFilteredQuery("catalog_fields", params, ["key", "name"], "key ASC");
  return executeListQuery<FieldRow>(db, query.countSql, query.listSql, query.values);
}

export async function getField(db: PgQueryable, fieldId: string) {
  const result = await db.query<FieldRow>(
    `SELECT * FROM catalog_fields WHERE field_id = $1`,
    [fieldId],
  );

  return result.rows[0] ?? null;
}

export async function listComponents(db: PgQueryable, params: ListParams = {}): Promise<ListResult<ComponentRow>> {
  const query = buildFilteredQuery("catalog_components", params, ["key", "name"], "key ASC");
  return executeListQuery<ComponentRow>(db, query.countSql, query.listSql, query.values);
}

export async function getComponentDetail(db: PgQueryable, componentId: string) {
  const result = await db.query<ComponentDetailRow>(
    `SELECT * FROM catalog_admin_component_detail_pages WHERE component_id = $1`,
    [componentId],
  );

  return result.rows[0] ?? null;
}

export async function listBlueprints(db: PgQueryable, params: ListParams = {}): Promise<ListResult<BlueprintRow>> {
  const query = buildFilteredQuery("catalog_blueprints", params, ["key", "name"], "key ASC");
  return executeListQuery<BlueprintRow>(db, query.countSql, query.listSql, query.values);
}

export async function getBlueprintDetail(db: PgQueryable, blueprintId: string) {
  const result = await db.query<BlueprintDetailRow>(
    `SELECT * FROM catalog_admin_blueprint_detail_pages WHERE blueprint_id = $1`,
    [blueprintId],
  );

  return result.rows[0] ?? null;
}

export async function listCategories(
  db: PgQueryable,
  params: ListParams & { parentCategoryId?: string } = {},
): Promise<ListResult<CategoryListRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];

  if (params.parentCategoryId) {
    extraConditions.push(`parent_category_id = $1`);
    extraValues.push(params.parentCategoryId);
  }

  const query = buildFilteredQuery(
    "catalog_admin_category_list_pages",
    params,
    ["key", "name"],
    "display_order ASC, key ASC",
    extraConditions,
    extraValues,
  );

  return executeListQuery<CategoryListRow>(db, query.countSql, query.listSql, query.values);
}

export async function getCategoryDetail(db: PgQueryable, categoryId: string) {
  const result = await db.query<CategoryDetailRow>(
    `SELECT * FROM catalog_admin_category_detail_pages WHERE category_id = $1`,
    [categoryId],
  );

  return result.rows[0] ?? null;
}

export async function listCatalogItems(
  db: PgQueryable,
  params: ListParams & { blueprintId?: string; tag?: string } = {},
): Promise<ListResult<CatalogItemListRow>> {
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

  const query = buildFilteredQuery(
    "catalog_admin_catalog_item_list_pages",
    params,
    ["title", "subtitle"],
    "title ASC",
    extraConditions,
    extraValues,
  );

  return executeListQuery<CatalogItemListRow>(db, query.countSql, query.listSql, query.values);
}

export async function getCatalogItemDetail(db: PgQueryable, itemId: string) {
  const result = await db.query<CatalogItemDetailRow>(
    `SELECT * FROM catalog_admin_catalog_item_detail_pages WHERE item_id = $1`,
    [itemId],
  );

  return result.rows[0] ?? null;
}
