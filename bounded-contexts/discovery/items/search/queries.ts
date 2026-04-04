import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { normalizeSimpleSearchText } from "./normalization";

export type DiscoverySearchParams = {
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

export type DiscoverySearchItemRow = Readonly<{
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
  market_summary: Readonly<{
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }> | null;
  updated_at: string;
}>;

type BaseDiscoverySearchItemRow = Omit<DiscoverySearchItemRow, "market_summary">;

async function getMarketSummariesForItems(
  db: PgQueryable,
  itemIds: readonly string[],
) {
  if (itemIds.length === 0) {
    return new Map<string, DiscoverySearchItemRow["market_summary"]>();
  }

  const result = await db.query<{
    catalog_item_id: string;
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }>(
    `SELECT
       catalog_item_id,
       MIN(price_amount)::text AS lowest_price_amount,
       COUNT(*)::integer AS active_listing_count,
       COALESCE(SUM(quantity_cap), 0)::integer AS total_visible_quantity
     FROM discovery_market_listings
     WHERE status = 'active'
       AND catalog_item_id = ANY($1::text[])
     GROUP BY catalog_item_id`,
    [itemIds],
  );

  return new Map(
    result.rows.map((row) => [
      row.catalog_item_id,
      {
        lowest_price_amount: row.lowest_price_amount,
        active_listing_count: row.active_listing_count,
        total_visible_quantity: row.total_visible_quantity,
      },
    ]),
  );
}

export async function searchDiscoveryItems(
  db: PgQueryable,
  params: DiscoverySearchParams = {},
): Promise<ListResult<DiscoverySearchItemRow>> {
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

  const countSql = `SELECT COUNT(*) AS count FROM discovery_search_items ${where}`;
  const listSql = `SELECT item_id, title, subtitle, description, blueprint_id, blueprint_name, status, category_names, tags, image_urls, updated_at
    FROM discovery_search_items ${where}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`;

  const [countResult, listResult] = await Promise.all([
    db.query<{ count: string }>(countSql, values),
    db.query<BaseDiscoverySearchItemRow>(listSql, values),
  ]);

  const marketSummaries = await getMarketSummariesForItems(
    db,
    listResult.rows.map((row) => row.item_id),
  );

  return {
    items: listResult.rows.map((row) => ({
      ...row,
      market_summary: marketSummaries.get(row.item_id) ?? null,
    })),
    total: Number.parseInt(countResult.rows[0].count, 10),
  };
}



