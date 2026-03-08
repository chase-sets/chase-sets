import type { PgQueryable } from "../../../../contracts/event-core/postgres/types";
import { normalizeSimpleSearchText } from "./search-normalization";

export type MarketplaceSearchParams = {
  search?: string;
  category?: string;
  tag?: string;
  blueprintId?: string;
  status?: string;
  sort?: string;
  limit?: number;
  offset?: number;
};

export type ListResult<T> = { items: T[]; total: number };

export type MarketplaceSearchItemRow = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint_id: string | null;
  blueprint_name: string | null;
  status: string;
  category_names: unknown;
  tags: unknown;
  image_urls: unknown;
  updated_at: string;
}>;

export type MarketplaceItemDetailRow = Readonly<{
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
  version_schema: unknown;
  updated_at: string;
}>;

export type MarketplaceCategoryRow = Readonly<{
  category_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  parent_category_id: string | null;
  parent_category: unknown;
  display_order: number;
  item_count: number;
  updated_at: string;
}>;

export async function searchMarketplaceItems(
  db: PgQueryable,
  params: MarketplaceSearchParams = {},
): Promise<ListResult<MarketplaceSearchItemRow>> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  const status = params.status ?? "active";
  conditions.push(`status = $${paramIndex}`);
  values.push(status);
  paramIndex++;

  let hasSearch = false;
  let englishSearchParamIndex: number | null = null;
  let simpleSearchParamIndex: number | null = null;

  if (params.search) {
    englishSearchParamIndex = paramIndex;
    values.push(params.search);
    paramIndex++;
    simpleSearchParamIndex = paramIndex;
    conditions.push(
      `(search_text @@ plainto_tsquery('english', $${englishSearchParamIndex}) OR search_text_simple @@ plainto_tsquery('simple', $${simpleSearchParamIndex}))`,
    );
    values.push(normalizeSimpleSearchText(params.search));
    paramIndex++;
    hasSearch = true;
  }

  if (params.category) {
    conditions.push(`category_names @> $${paramIndex}::jsonb`);
    values.push(JSON.stringify([params.category]));
    paramIndex++;
  }

  if (params.tag) {
    conditions.push(`tags @> $${paramIndex}::jsonb`);
    values.push(JSON.stringify([params.tag]));
    paramIndex++;
  }

  if (params.blueprintId) {
    conditions.push(`blueprint_id = $${paramIndex}`);
    values.push(params.blueprintId);
    paramIndex++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let orderBy: string;

  switch (params.sort) {
    case "title_asc":
      orderBy = "title ASC";
      break;
    case "title_desc":
      orderBy = "title DESC";
      break;
    case "newest":
      orderBy = "updated_at DESC";
      break;
    case "relevance":
    default:
      orderBy = hasSearch
        ? `(ts_rank(search_text, plainto_tsquery('english', $${englishSearchParamIndex})) + ts_rank(search_text_simple, plainto_tsquery('simple', $${simpleSearchParamIndex}))) DESC, title ASC`
        : "title ASC";
      break;
  }

  if ((params.sort === "relevance" || params.sort === undefined) && hasSearch) {
    orderBy = `(ts_rank(search_text, plainto_tsquery('english', $${englishSearchParamIndex})) + ts_rank(search_text_simple, plainto_tsquery('simple', $${simpleSearchParamIndex}))) DESC, title ASC`;
  }

  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const countSql = `SELECT COUNT(*) AS count FROM marketplace_search_items ${where}`;
  const listSql = `SELECT item_id, title, subtitle, description, blueprint_id, blueprint_name, status, category_names, tags, image_urls, updated_at
    FROM marketplace_search_items ${where}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`;

  const [countResult, listResult] = await Promise.all([
    db.query<{ count: string }>(countSql, values),
    db.query<MarketplaceSearchItemRow>(listSql, values),
  ]);

  return {
    items: listResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

export async function getMarketplaceItemDetail(
  db: PgQueryable,
  itemId: string,
): Promise<MarketplaceItemDetailRow | null> {
  const result = await db.query<MarketplaceItemDetailRow>(
    `SELECT * FROM marketplace_item_detail_pages WHERE item_id = $1`,
    [itemId],
  );

  return result.rows[0] ?? null;
}

export async function listMarketplaceCategories(
  db: PgQueryable,
  params: { parentCategoryId?: string; status?: string } = {},
): Promise<MarketplaceCategoryRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  const status = params.status ?? "active";
  conditions.push(`status = $${paramIndex}`);
  values.push(status);
  paramIndex++;

  if (params.parentCategoryId) {
    conditions.push(`parent_category_id = $${paramIndex}`);
    values.push(params.parentCategoryId);
    paramIndex++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db.query<MarketplaceCategoryRow>(
    `SELECT * FROM marketplace_categories ${where} ORDER BY display_order ASC`,
    values,
  );

  return result.rows;
}
