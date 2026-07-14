import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { DiscoveryDisplayBadge } from "../../../support/client-support/contracts";
import { buildSimpleSearchQuery } from "../domain/normalization";
import type { ProductSchema } from "../../../support/client-support/contracts";
import {
  buyerVisibleListingPredicateSql,
  buyerVisibleListingQuantitySql,
} from "../../../support/market-support/listing-visibility";
import { dimensionFacetValueOrderSql, facetGroupDecisionPriority, fieldFacetValueOrderSql } from "./facet-ordering";

const FACET_VALUE_LIMIT = 50;
const FACET_GROUP_LIMIT = 10;

export type DiscoverySearchParams = {
  search?: string;
  category?: string;
  tag?: string;
  blueprintId?: string;
  language?: string;
  status?: string;
  marketActivity?: DiscoveryMarketActivityFilter;
  priceMin?: string;
  priceMax?: string;
  inStock?: boolean;
  fieldFilters?: readonly DiscoveryFieldFilter[];
  referenceFilters?: readonly DiscoveryReferenceFilter[];
  dimensionFilters?: readonly DiscoveryDimensionFilter[];
  sort?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
  includeTotal?: boolean;
};

export type DiscoveryFieldFilter = Readonly<{ fieldId: string; value: string }>;
export type DiscoveryReferenceFilter = Readonly<{ typeKey: string; referenceId: string }>;
export type DiscoveryDimensionFilter = Readonly<{ dimensionId: string; optionId: string }>;
export type DiscoveryMarketActivityFilter = "listings" | "offers" | "any";
export type DiscoveryFacetKind = "field" | "reference" | "dimension";
export type DiscoveryFacetGroup = Readonly<{
  id: string;
  kind: DiscoveryFacetKind;
  label: string;
  values: readonly DiscoveryFacetValue[];
}>;
export type DiscoveryFacetValue = Readonly<{
  id: string;
  label: string;
  count: number;
  selected: boolean;
}>;
export type ListResult<T> = {
  items: T[];
  facets: DiscoveryFacetGroup[];
  total: number | null;
  nextCursor: string | null;
};

export type DiscoverySemanticSearchItem = Readonly<{
  item: DiscoverySearchItemRow;
  similarity: number;
}>;

export type DiscoveryBulkCartPreviewLine = Readonly<{
  catalog_item_id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  image_url: string | null;
  image_srcset: string | null;
  image_loading_url: string | null;
  image_loading_alt: string | null;
  image_loading_srcset: string | null;
  product_id: string;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  quantity: number;
}>;

export type DiscoveryBulkCartPreviewSkippedItem = Readonly<{
  catalog_item_id: string;
  slug: string;
  title: string;
  reason: "product-options-required" | "invalid-product-selection";
  message: string;
}>;

export type DiscoveryBulkCartPreview = Readonly<{
  totalMatches: number | null;
  eligibleCount: number;
  skippedCount: number;
  overLimit: boolean;
  limit: number;
  lines: DiscoveryBulkCartPreviewLine[];
  skippedItems: DiscoveryBulkCartPreviewSkippedItem[];
}>;

export type DiscoverySearchItemRow = Readonly<{
  catalog_item_id: string;
  slug: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  display_badges: readonly DiscoveryDisplayBadge[];
  description_i18n: unknown;
  description: string;
  blueprint_id: string | null;
  blueprint_name: string | null;
  status: string;
  category_names: unknown;
  category_slugs: unknown;
  tags: unknown;
  image_urls: unknown;
  product_asset_sets: unknown;
  image_fallback: unknown;
  market_summary: Readonly<{
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }> | null;
  updated_at: string;
  search_rank?: string | number | null;
  search_base_match?: boolean | null;
}>;

type BaseDiscoverySearchItemRow = Omit<DiscoverySearchItemRow, "market_summary">;
type SearchIndexItemRow = BaseDiscoverySearchItemRow & {
  lowest_price_amount: string | null;
  visible_quantity: number | null;
};

async function getMarketSummariesForItems(db: PgQueryable, itemIds: readonly string[]) {
  if (itemIds.length === 0) {
    return new Map<string, DiscoverySearchItemRow["market_summary"]>();
  }

  const result = await db.query<{
    catalog_catalog_item_id: string;
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }>(
    `WITH startable_listing AS (
       SELECT
         listing.catalog_catalog_item_id,
         listing.price_amount,
         ${buyerVisibleListingQuantitySql("listing")} AS visible_quantity
       FROM discovery_market_listings AS listing
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE listing.catalog_catalog_item_id = ANY($1::text[])
         AND ${buyerVisibleListingPredicateSql("listing", "account")}
     )
     SELECT
       catalog_catalog_item_id,
       MIN(price_amount::numeric)::text AS lowest_price_amount,
       COUNT(*)::integer AS active_listing_count,
       COALESCE(SUM(visible_quantity), 0)::integer AS total_visible_quantity
     FROM startable_listing
     WHERE visible_quantity > 0
     GROUP BY catalog_catalog_item_id`,
    [itemIds],
  );

  return new Map(
    result.rows.map((row) => [
      row.catalog_catalog_item_id,
      {
        lowest_price_amount: row.lowest_price_amount,
        active_listing_count: row.active_listing_count,
        total_visible_quantity: row.total_visible_quantity,
      },
    ]),
  );
}

type SearchFilterBuildOptions = Readonly<{
  excludeFacet?: Readonly<{ kind: DiscoveryFacetKind; id: string }>;
  itemAlias?: string;
}>;

type BuiltSearchFilter = Readonly<{
  conditions: string[];
  values: unknown[];
  where: string;
  nextParamIndex: number;
  hasSearch: boolean;
  englishSearchParamIndex: number | null;
  simpleSearchParamIndex: number | null;
}>;

function buildSearchFilter(params: DiscoverySearchParams, options: SearchFilterBuildOptions = {}): BuiltSearchFilter {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;
  const itemColumn = (name: string) => (options.itemAlias ? `${options.itemAlias}.${name}` : name);
  const outerItemIdColumn = options.itemAlias
    ? itemColumn("catalog_item_id")
    : "discovery_search_items.catalog_item_id";

  conditions.push(`${itemColumn("status")} = $${paramIndex}`);
  values.push(params.status ?? "active");
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
      `(${itemColumn("search_text")} @@ plainto_tsquery('english', $${englishSearchParamIndex}) OR ${itemColumn("search_text_simple")} @@ plainto_tsquery('simple', $${simpleSearchParamIndex}) OR EXISTS (
         SELECT 1
         FROM discovery_search_product_contents AS content
         INNER JOIN discovery_search_catalog_items AS contained_item
           ON contained_item.catalog_item_id = content.contained_catalog_item_id
          AND contained_item.status = 'active'
         WHERE content.container_catalog_item_id = ${outerItemIdColumn}
           AND (
             content.search_text @@ plainto_tsquery('english', $${englishSearchParamIndex})
             OR content.search_text_simple @@ plainto_tsquery('simple', $${simpleSearchParamIndex})
           )
       ))`,
    );
    values.push(buildSimpleSearchQuery(params.search));
    paramIndex++;
    hasSearch = true;
  }

  if (params.category) {
    conditions.push(
      `(${itemColumn("category_names")} @> $${paramIndex}::jsonb OR ${itemColumn("category_slugs")} @> $${paramIndex}::jsonb)`,
    );
    values.push(JSON.stringify([params.category]));
    paramIndex++;
  }

  if (params.tag) {
    conditions.push(`${itemColumn("tags")} @> $${paramIndex}::jsonb`);
    values.push(JSON.stringify([params.tag]));
    paramIndex++;
  }

  if (params.blueprintId) {
    conditions.push(`${itemColumn("blueprint_id")} = $${paramIndex}`);
    values.push(params.blueprintId);
    paramIndex++;
  }

  if (params.language) {
    conditions.push(`${itemColumn("language_code")} = $${paramIndex}`);
    values.push(params.language);
    paramIndex++;
  }

  if (params.priceMin !== undefined) {
    conditions.push(`${itemColumn("lowest_price_amount")} >= $${paramIndex}::numeric`);
    values.push(params.priceMin);
    paramIndex++;
  }

  if (params.priceMax !== undefined) {
    conditions.push(`${itemColumn("lowest_price_amount")} <= $${paramIndex}::numeric`);
    values.push(params.priceMax);
    paramIndex++;
  }

  if (params.inStock) {
    conditions.push(`${itemColumn("visible_quantity")} > 0`);
  }

  const dimensionFilterGroups = groupDimensionFilters(params.dimensionFilters);

  for (const [fieldId, selectedValues] of groupFieldFilters(params.fieldFilters).entries()) {
    if (options.excludeFacet?.kind === "field" && options.excludeFacet.id === fieldId) {
      continue;
    }

    conditions.push(
      `EXISTS (
         SELECT 1
         FROM jsonb_array_elements(${itemColumn("field_filter_values")}) AS facet(value)
         WHERE facet.value->>'fieldId' = $${paramIndex}
           AND facet.value->>'value' = ANY($${paramIndex + 1}::text[])
       )`,
    );
    values.push(fieldId, selectedValues);
    paramIndex += 2;
  }

  for (const [typeKey, selectedReferenceIds] of groupReferenceFilters(params.referenceFilters).entries()) {
    if (options.excludeFacet?.kind === "reference" && options.excludeFacet.id === typeKey) {
      continue;
    }

    conditions.push(
      `EXISTS (
         SELECT 1
         FROM jsonb_array_elements(${itemColumn("reference_filter_values")}) AS facet(value)
         WHERE facet.value->>'typeKey' = $${paramIndex}
           AND facet.value->>'referenceId' = ANY($${paramIndex + 1}::text[])
       )`,
    );
    values.push(typeKey, selectedReferenceIds);
    paramIndex += 2;
  }

  for (const [dimensionId, selectedOptionIds] of dimensionFilterGroups.entries()) {
    if (options.excludeFacet?.kind === "dimension" && options.excludeFacet.id === dimensionId) {
      continue;
    }

    conditions.push(
      `EXISTS (
         SELECT 1
         FROM jsonb_array_elements(${itemColumn("dimension_filter_values")}) AS facet(value)
         WHERE facet.value->>'dimensionId' = $${paramIndex}
           AND facet.value->>'optionId' = ANY($${paramIndex + 1}::text[])
       )`,
    );
    values.push(dimensionId, selectedOptionIds);
    paramIndex += 2;
  }

  if (params.marketActivity) {
    const marketActivity = buildMarketActivityFilter(
      params.marketActivity,
      itemColumn("catalog_item_id"),
      marketDimensionFilterGroups(dimensionFilterGroups, options.excludeFacet),
      paramIndex,
    );
    conditions.push(marketActivity.condition);
    values.push(...marketActivity.values);
    paramIndex += marketActivity.values.length;
  }

  return {
    conditions,
    values,
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    nextParamIndex: paramIndex,
    hasSearch,
    englishSearchParamIndex,
    simpleSearchParamIndex,
  };
}

function marketDimensionFilterGroups(
  dimensionFilters: ReadonlyMap<string, readonly string[]>,
  excludeFacet: SearchFilterBuildOptions["excludeFacet"],
): ReadonlyMap<string, readonly string[]> {
  if (excludeFacet?.kind !== "dimension") {
    return dimensionFilters;
  }

  return new Map([...dimensionFilters.entries()].filter(([dimensionId]) => dimensionId !== excludeFacet.id));
}

function buildMarketActivityFilter(
  marketActivity: DiscoveryMarketActivityFilter,
  itemIdColumn: string,
  dimensionFilters: ReadonlyMap<string, readonly string[]>,
  firstParamIndex: number,
): Readonly<{ condition: string; values: readonly string[] }> {
  const selectedOptionSqlForListings = selectedOptionMatchSql("listing", dimensionFilters, firstParamIndex);
  const selectedOptionSqlForOffers = selectedOptionMatchSql("offer", dimensionFilters, firstParamIndex);
  const values = selectedOptionMatchValues(dimensionFilters);
  const listingExists = `EXISTS (
         SELECT 1
         FROM discovery_market_listings AS listing
         INNER JOIN discovery_market_accounts AS account
           ON account.account_id = listing.account_id
         WHERE listing.catalog_catalog_item_id = ${itemIdColumn}
           AND ${buyerVisibleListingPredicateSql("listing", "account")}
           ${selectedOptionSqlForListings}
       )`;
  const offerExists = `EXISTS (
         SELECT 1
         FROM discovery_offer_demand_matches AS offer
         WHERE offer.catalog_catalog_item_id = ${itemIdColumn}
           AND offer.status = 'submitted'
           ${selectedOptionSqlForOffers}
       )`;

  switch (marketActivity) {
    case "listings":
      return { condition: listingExists, values };
    case "offers":
      return { condition: offerExists, values };
    case "any":
    default:
      return { condition: `(${listingExists} OR ${offerExists})`, values };
  }
}

function buildMarketActivityFacetSource(
  marketActivity: DiscoveryMarketActivityFilter,
  dimensionFilters: ReadonlyMap<string, readonly string[]>,
  firstParamIndex: number,
): Readonly<{ sql: string; values: readonly string[] }> {
  const selectedOptionSqlForListings = selectedOptionMatchSql("listing", dimensionFilters, firstParamIndex);
  const selectedOptionSqlForOffers = selectedOptionMatchSql("offer", dimensionFilters, firstParamIndex);
  const values = selectedOptionMatchValues(dimensionFilters);
  const listingRows = `SELECT
         'listing:' || listing.listing_id AS activity_id,
         listing.catalog_catalog_item_id,
         listing.selected_options
       FROM discovery_market_listings AS listing
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE ${buyerVisibleListingPredicateSql("listing", "account")}
         ${selectedOptionSqlForListings}`;
  const offerRows = `SELECT
         'offer:' || offer.offer_id AS activity_id,
         offer.catalog_catalog_item_id,
         offer.selected_options
       FROM discovery_offer_demand_matches AS offer
       WHERE offer.status = 'submitted'
         ${selectedOptionSqlForOffers}`;

  switch (marketActivity) {
    case "listings":
      return { sql: listingRows, values };
    case "offers":
      return { sql: offerRows, values };
    case "any":
    default:
      return { sql: `${listingRows}\n       UNION ALL\n       ${offerRows}`, values };
  }
}

function selectedOptionMatchSql(
  alias: string,
  dimensionFilters: ReadonlyMap<string, readonly string[]>,
  firstParamIndex: number,
): string {
  const dimensionClauses: string[] = [];
  let paramIndex = firstParamIndex;

  for (const optionIds of dimensionFilters.values()) {
    const optionClauses = optionIds.map(() => `${alias}.selected_options @> $${paramIndex++}::jsonb`);
    if (optionClauses.length > 0) {
      dimensionClauses.push(`(${optionClauses.join(" OR ")})`);
    }
  }

  return dimensionClauses.length > 0 ? `AND ${dimensionClauses.join(" AND ")}` : "";
}

function selectedOptionMatchValues(dimensionFilters: ReadonlyMap<string, readonly string[]>): string[] {
  return [...dimensionFilters.entries()].flatMap(([dimensionId, optionIds]) =>
    optionIds.map((optionId) => JSON.stringify([{ dimensionId, optionId }])),
  );
}

function groupFieldFilters(filters: readonly DiscoveryFieldFilter[] | undefined): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const filter of filters ?? []) {
    const fieldId = filter.fieldId.trim();
    const value = normalizeFilterParamValue(filter.value);
    if (!fieldId || !value) {
      continue;
    }

    grouped.set(fieldId, uniqueValues([...(grouped.get(fieldId) ?? []), value]));
  }

  return grouped;
}

function groupReferenceFilters(filters: readonly DiscoveryReferenceFilter[] | undefined): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const filter of filters ?? []) {
    const typeKey = filter.typeKey.trim();
    const referenceId = normalizeFilterParamValue(filter.referenceId);
    if (!typeKey || !referenceId) {
      continue;
    }

    grouped.set(typeKey, uniqueValues([...(grouped.get(typeKey) ?? []), referenceId]));
  }

  return grouped;
}

function groupDimensionFilters(filters: readonly DiscoveryDimensionFilter[] | undefined): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const filter of filters ?? []) {
    const dimensionId = filter.dimensionId.trim();
    const optionId = filter.optionId.trim();
    if (!dimensionId || !optionId) {
      continue;
    }

    grouped.set(dimensionId, uniqueValues([...(grouped.get(dimensionId) ?? []), optionId]));
  }

  return grouped;
}

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeFilterParamValue(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export async function searchDiscoveryItems(
  db: PgQueryable,
  params: DiscoverySearchParams = {},
  options: Readonly<{ loadFacets?: boolean; loadMarketSummaries?: boolean }> = {},
): Promise<ListResult<DiscoverySearchItemRow>> {
  const baseFilter = buildSearchFilter(params);
  const conditions = [...baseFilter.conditions];
  const values = [...baseFilter.values];
  let paramIndex = baseFilter.nextParamIndex;
  const where = baseFilter.where;
  const hasSearch = baseFilter.hasSearch;
  const englishSearchParamIndex = baseFilter.englishSearchParamIndex;
  const simpleSearchParamIndex = baseFilter.simpleSearchParamIndex;

  let rankExpression: string | null = null;
  let baseMatchExpression: string | null = null;
  let orderBy: string;
  let cursorCondition: string | null = null;
  const cursor = decodeSearchCursor(params.cursor);
  switch (params.sort) {
    case "title_asc":
      orderBy = "title ASC, catalog_item_id ASC";
      if (cursor) {
        cursorCondition = `(title, catalog_item_id) > ($${paramIndex}, $${paramIndex + 1})`;
        values.push(cursor.title, cursor.id);
        paramIndex += 2;
      }
      break;
    case "title_desc":
      orderBy = "title DESC, catalog_item_id DESC";
      if (cursor) {
        cursorCondition = `(title, catalog_item_id) < ($${paramIndex}, $${paramIndex + 1})`;
        values.push(cursor.title, cursor.id);
        paramIndex += 2;
      }
      break;
    case "newest":
      orderBy = "updated_at DESC, catalog_item_id DESC";
      if (cursor) {
        cursorCondition = `(updated_at, catalog_item_id) < ($${paramIndex}::timestamptz, $${paramIndex + 1})`;
        values.push(cursor.updatedAt, cursor.id);
        paramIndex += 2;
      }
      break;
    case "price_asc":
      orderBy = "lowest_price_amount ASC NULLS LAST, catalog_item_id ASC";
      if (cursor) {
        if (cursor.lowestPriceAmount === null) {
          cursorCondition = `lowest_price_amount IS NULL AND catalog_item_id > $${paramIndex}`;
          values.push(cursor.id);
          paramIndex++;
        } else {
          cursorCondition = `(lowest_price_amount > $${paramIndex}::numeric OR (lowest_price_amount = $${paramIndex}::numeric AND catalog_item_id > $${paramIndex + 1}) OR lowest_price_amount IS NULL)`;
          values.push(cursor.lowestPriceAmount, cursor.id);
          paramIndex += 2;
        }
      }
      break;
    case "price_desc":
      orderBy = "lowest_price_amount DESC NULLS LAST, catalog_item_id DESC";
      if (cursor) {
        if (cursor.lowestPriceAmount === null) {
          cursorCondition = `lowest_price_amount IS NULL AND catalog_item_id < $${paramIndex}`;
          values.push(cursor.id);
          paramIndex++;
        } else {
          cursorCondition = `(lowest_price_amount < $${paramIndex}::numeric OR (lowest_price_amount = $${paramIndex}::numeric AND catalog_item_id < $${paramIndex + 1}) OR lowest_price_amount IS NULL)`;
          values.push(cursor.lowestPriceAmount, cursor.id);
          paramIndex += 2;
        }
      }
      break;
    case "relevance":
    default:
      if (hasSearch) {
        baseMatchExpression = `(search_text @@ plainto_tsquery('english', $${englishSearchParamIndex}) OR search_text_simple @@ plainto_tsquery('simple', $${simpleSearchParamIndex}))`;
        const baseRankExpression = `(ts_rank(search_text, plainto_tsquery('english', $${englishSearchParamIndex})) + ts_rank(search_text_simple, plainto_tsquery('simple', $${simpleSearchParamIndex})))`;
        const contentRankExpression = `COALESCE((
          SELECT MAX((ts_rank(content.search_text, plainto_tsquery('english', $${englishSearchParamIndex})) + ts_rank(content.search_text_simple, plainto_tsquery('simple', $${simpleSearchParamIndex}))) * content.content_type_search_weight::real)
          FROM discovery_search_product_contents AS content
          INNER JOIN discovery_search_catalog_items AS contained_item
            ON contained_item.catalog_item_id = content.contained_catalog_item_id
           AND contained_item.status = 'active'
          WHERE content.container_catalog_item_id = discovery_search_items.catalog_item_id
        ), 0)`;
        rankExpression = `(${baseRankExpression} + (${contentRankExpression} * 0.20))`;
        orderBy = `${baseMatchExpression} DESC, ${rankExpression} DESC, title ASC, catalog_item_id ASC`;
        if (cursor) {
          cursorCondition = `(${baseMatchExpression}::integer, ${rankExpression}, title, catalog_item_id) < ($${paramIndex}::integer, $${paramIndex + 1}::real, $${paramIndex + 2}, $${paramIndex + 3})`;
          values.push(cursor.baseMatch ? 1 : 0, cursor.rank, cursor.title, cursor.id);
          paramIndex += 4;
        }
      } else {
        orderBy = "title ASC, catalog_item_id ASC";
        if (cursor) {
          cursorCondition = `(title, catalog_item_id) > ($${paramIndex}, $${paramIndex + 1})`;
          values.push(cursor.title, cursor.id);
          paramIndex += 2;
        }
      }
      break;
  }

  if (cursorCondition) {
    conditions.push(cursorCondition);
  }

  const whereWithCursor = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);
  const useLegacyOffset = offset > 0;
  const listValues = useLegacyOffset ? [...values, limit, offset] : [...values, limit + 1];
  const listLimitSql = useLegacyOffset
    ? `LIMIT $${values.length + 1} OFFSET $${values.length + 2}`
    : `LIMIT $${values.length + 1}`;
  const selectRank = rankExpression ? `, ${rankExpression} AS search_rank` : "";
  const selectBaseMatch = baseMatchExpression ? `, ${baseMatchExpression} AS search_base_match` : "";

  const countPromise =
    params.includeTotal || useLegacyOffset
      ? db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM discovery_search_items ${where}`,
          values.slice(0, values.length - (cursorCondition ? cursorValueCount(params.sort, hasSearch, cursor) : 0)),
        )
      : Promise.resolve({ rows: [] });
  const listSql = `SELECT catalog_item_id, slug, language_code, title_i18n, title, subtitle_i18n, subtitle, display_badges, description_i18n, description, blueprint_id, blueprint_name, status, category_names, category_slugs, tags, image_urls, product_asset_sets, image_fallback, lowest_price_amount::text AS lowest_price_amount, visible_quantity, updated_at${selectRank}${selectBaseMatch}
    FROM discovery_search_items ${whereWithCursor}
    ORDER BY ${orderBy}
    ${listLimitSql}`;

  const [countResult, listResult] = await Promise.all([
    countPromise,
    db.query<SearchIndexItemRow & { search_rank?: string | number | null }>(listSql, listValues),
  ]);
  const rows = useLegacyOffset ? listResult.rows : listResult.rows.slice(0, limit);
  const lastRow = rows.at(-1);
  const hasNextPage = !useLegacyOffset && listResult.rows.length > limit;

  const marketSummaries =
    options.loadMarketSummaries === false
      ? new Map<string, DiscoverySearchItemRow["market_summary"]>()
      : await getMarketSummariesForItems(
          db,
          rows.map((row) => row.catalog_item_id),
        );
  const facets = options.loadFacets === false || params.cursor ? [] : await loadSearchFacets(db, params);

  return {
    items: rows.map(({ lowest_price_amount: _lowestPriceAmount, visible_quantity: _visibleQuantity, ...row }) => ({
      ...row,
      market_summary: marketSummaries.get(row.catalog_item_id) ?? null,
    })),
    facets,
    total: countResult.rows[0]?.count ? Number.parseInt(countResult.rows[0].count, 10) : null,
    nextCursor: hasNextPage && lastRow ? encodeSearchCursor(lastRow) : null,
  };
}

/**
 * Structured set-code + collector-number resolution: a precise btree point
 * lookup against the denormalized `set_code`/`card_number` columns,
 * composed with the caller's ordinary filters (category, language, blueprint,
 * facets, market activity) but never with `params.search` — the raw structured
 * query text ("SV04 123/182") is not indexed lexeme-for-lexeme, so ANDing it in
 * would spuriously suppress an exact natural-key match. Callers try this first
 * and fall back to `searchDiscoveryItems` when it returns no rows (see
 * read-model/hybrid-retrieval.ts).
 */
export async function searchDiscoveryItemsByNaturalKey(
  db: PgQueryable,
  naturalKey: Readonly<{ setCode: string; cardNumber: string }>,
  params: DiscoverySearchParams = {},
  options: Readonly<{ loadMarketSummaries?: boolean }> = {},
): Promise<ListResult<DiscoverySearchItemRow>> {
  const filter = buildSearchFilter({ ...params, search: undefined });
  const setCodeParamIndex = filter.nextParamIndex;
  const cardNumberParamIndex = setCodeParamIndex + 1;
  const conditions = [
    ...filter.conditions,
    `set_code = $${setCodeParamIndex}`,
    `card_number = $${cardNumberParamIndex}`,
  ];
  const values = [...filter.values, naturalKey.setCode, naturalKey.cardNumber];
  const limit = clampLimit(params.limit);
  const listValues = [...values, limit];

  const listSql = `SELECT catalog_item_id, slug, language_code, title_i18n, title, subtitle_i18n, subtitle, display_badges, description_i18n, description, blueprint_id, blueprint_name, status, category_names, category_slugs, tags, image_urls, product_asset_sets, image_fallback, updated_at
    FROM discovery_search_items
    WHERE ${conditions.join(" AND ")}
    ORDER BY title ASC, catalog_item_id ASC
    LIMIT $${listValues.length}`;
  const listResult = await db.query<BaseDiscoverySearchItemRow>(listSql, listValues);
  const marketSummaries =
    options.loadMarketSummaries === false
      ? new Map<string, DiscoverySearchItemRow["market_summary"]>()
      : await getMarketSummariesForItems(
          db,
          listResult.rows.map((row) => row.catalog_item_id),
        );

  return {
    items: listResult.rows.map((row) => ({
      ...row,
      market_summary: marketSummaries.get(row.catalog_item_id) ?? null,
    })),
    facets: [],
    total: listResult.rows.length,
    nextCursor: null,
  };
}

export async function searchDiscoverySemanticItems(
  db: PgQueryable,
  params: DiscoverySearchParams,
  queryEmbedding: readonly number[],
  options: Readonly<{ limit?: number; minimumSimilarity?: number; loadMarketSummaries?: boolean }> = {},
): Promise<DiscoverySemanticSearchItem[]> {
  if (queryEmbedding.length !== 1_024 || queryEmbedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Discovery semantic query embedding must contain 1024 finite values.");
  }

  const filter = buildSearchFilter(
    { ...params, search: undefined, cursor: undefined, offset: undefined, includeTotal: false },
    { itemAlias: "item" },
  );
  const vectorParamIndex = filter.nextParamIndex;
  const minimumSimilarityParamIndex = vectorParamIndex + 1;
  const limitParamIndex = vectorParamIndex + 2;
  const distanceExpression = `item.search_embedding <#> $${vectorParamIndex}::halfvec(1024)`;
  const conditions = [
    ...filter.conditions,
    "item.search_embedding IS NOT NULL",
    `-(${distanceExpression}) >= $${minimumSimilarityParamIndex}`,
  ];
  const values = [
    ...filter.values,
    halfVectorLiteral(queryEmbedding),
    options.minimumSimilarity ?? 0.52,
    Math.min(200, Math.max(1, Math.trunc(options.limit ?? 24))),
  ];
  const result = await db.query<BaseDiscoverySearchItemRow & { semantic_similarity: string | number }>(
    `SELECT item.catalog_item_id, item.slug, item.language_code, item.title_i18n, item.title,
            item.subtitle_i18n, item.subtitle, item.description_i18n, item.description,
            item.display_badges,
            item.blueprint_id, item.blueprint_name, item.status, item.category_names,
            item.category_slugs, item.tags, item.image_urls, item.product_asset_sets,
            item.image_fallback, item.updated_at, -(${distanceExpression}) AS semantic_similarity
     FROM discovery_search_items AS item
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${distanceExpression} ASC, item.title ASC, item.catalog_item_id ASC
     LIMIT $${limitParamIndex}`,
    values,
  );
  const marketSummaries =
    options.loadMarketSummaries === false
      ? new Map<string, DiscoverySearchItemRow["market_summary"]>()
      : await getMarketSummariesForItems(
          db,
          result.rows.map((row) => row.catalog_item_id),
        );

  return result.rows.map((row) => ({
    item: {
      ...row,
      market_summary: marketSummaries.get(row.catalog_item_id) ?? null,
    },
    similarity: Number(row.semantic_similarity),
  }));
}

export async function hydrateDiscoverySearchItemMarketSummaries(
  db: PgQueryable,
  items: readonly DiscoverySearchItemRow[],
): Promise<DiscoverySearchItemRow[]> {
  const marketSummaries = await getMarketSummariesForItems(
    db,
    items.map((item) => item.catalog_item_id),
  );
  return items.map((item) => ({
    ...item,
    market_summary: marketSummaries.get(item.catalog_item_id) ?? null,
  }));
}

type ProductSchemaRow = Readonly<{
  dimension_id: string;
  dimension_name: string;
  value_kind: "unordered" | "ordered" | "numeric";
  required: boolean;
  allowed_option_ids: unknown;
  applies_when: unknown;
  dimension_display_order: number;
  option_id: string | null;
  option_code: string | null;
  option_label: string | null;
  option_display_order: number | null;
  numeric_value: string | number | null;
}>;

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function assetVariantString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const text = record[key];
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

function assetVariantNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const number = Number((value as Record<string, unknown>)[key]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function productAssetRoleImage(
  item: Pick<DiscoverySearchItemRow, "image_urls" | "product_asset_sets">,
  role: "thumbnail" | "search-card" | "catalog-detail",
) {
  for (const assetSet of jsonArray<Record<string, unknown>>(item.product_asset_sets)) {
    const variants = jsonArray<unknown>(assetSet.variants)
      .filter((variant) => assetVariantString(variant, "role") === role)
      .sort((left, right) => (assetVariantNumber(left, "width") ?? 0) - (assetVariantNumber(right, "width") ?? 0));
    const oneX = variants.find((variant) => assetVariantNumber(variant, "density") === 1) ?? variants[0] ?? null;

    if (oneX) {
      const src = assetVariantString(oneX, "publicUrl");
      if (src) {
        const srcSet = variants
          .map((variant) => {
            const publicUrl = assetVariantString(variant, "publicUrl");
            const width = assetVariantNumber(variant, "width");
            return publicUrl && width ? `${publicUrl} ${width}w` : null;
          })
          .filter((entry): entry is string => entry !== null)
          .join(", ");

        return {
          src,
          srcSet: srcSet || null,
        };
      }
    }
  }

  return {
    src: stringArray(item.image_urls)[0] ?? null,
    srcSet: null,
  };
}

async function loadProductSchemasForBlueprints(
  db: PgQueryable,
  blueprintIds: readonly string[],
): Promise<Map<string, ProductSchema>> {
  const uniqueBlueprintIds = [...new Set(blueprintIds.filter(Boolean))];
  if (uniqueBlueprintIds.length === 0) {
    return new Map();
  }

  const result = await db.query<ProductSchemaRow & { blueprint_id: string }>(
    `SELECT
       rule.blueprint_id,
       rule.dimension_id,
       dimension.name AS dimension_name,
       dimension.value_kind,
       rule.required,
       rule.allowed_option_ids,
       rule.applies_when,
       rule.display_order AS dimension_display_order,
       option.option_id,
       option.code AS option_code,
       option.label AS option_label,
       option.display_order AS option_display_order,
       option.numeric_value
     FROM discovery_search_catalog_blueprint_dimensions AS rule
     INNER JOIN discovery_search_catalog_dimensions AS dimension
       ON dimension.dimension_id = rule.dimension_id
     LEFT JOIN LATERAL jsonb_array_elements_text(rule.allowed_option_ids) WITH ORDINALITY AS allowed(option_id, allowed_order)
       ON true
     LEFT JOIN discovery_search_catalog_dimension_options AS option
       ON option.option_id = allowed.option_id
      AND option.dimension_id = rule.dimension_id
      AND option.status = 'active'
     WHERE rule.blueprint_id = ANY($1::text[])
     ORDER BY rule.blueprint_id ASC, rule.display_order ASC, allowed.allowed_order ASC, option.display_order ASC, option.label ASC`,
    [uniqueBlueprintIds],
  );

  const byBlueprint = new Map<string, ProductSchemaRow[]>();
  for (const row of result.rows) {
    byBlueprint.set(row.blueprint_id, [...(byBlueprint.get(row.blueprint_id) ?? []), row]);
  }

  const schemas = new Map<string, ProductSchema>();
  for (const [blueprintId, rows] of byBlueprint.entries()) {
    const byDimension = new Map<string, ProductSchema["dimensions"][number]>();
    for (const row of rows) {
      const existing = byDimension.get(row.dimension_id);
      const allowedOptions =
        row.option_id && row.option_label
          ? [
              {
                optionId: row.option_id,
                code: row.option_code ?? row.option_id,
                label: row.option_label,
                displayOrder: row.option_display_order ?? 0,
                numericValue: row.numeric_value === null ? null : Number(row.numeric_value),
              },
            ]
          : [];
      byDimension.set(row.dimension_id, {
        dimensionId: row.dimension_id,
        dimensionName: row.dimension_name,
        valueKind: row.value_kind,
        required: row.required,
        appliesWhen: jsonArray<{ dimensionId: string; optionIds: string[] }>(row.applies_when),
        allowedOptions: [...(existing?.allowedOptions ?? []), ...allowedOptions],
      });
    }

    const dimensions = [...byDimension.values()];
    schemas.set(blueprintId, {
      canonicalDimensionOrder: dimensions.map((dimension) => ({
        dimensionId: dimension.dimensionId,
        dimensionName: dimension.dimensionName,
      })),
      dimensions,
    });
  }

  return schemas;
}

function selectedOptionMap(filters: readonly DiscoveryDimensionFilter[] | undefined) {
  const grouped = groupDimensionFilters(filters);
  const selected = new Map<string, string>();
  for (const [dimensionId, optionIds] of grouped.entries()) {
    if (optionIds.length === 1) {
      selected.set(dimensionId, optionIds[0]);
    }
  }
  return selected;
}

function isSchemaDimensionActive(
  dimension: ProductSchema["dimensions"][number],
  selections: ReadonlyMap<string, string>,
) {
  return dimension.appliesWhen.every((clause) => {
    const selectedOptionId = selections.get(clause.dimensionId);
    return selectedOptionId !== undefined && clause.optionIds.includes(selectedOptionId);
  });
}

function resolvePreviewLine(
  item: DiscoverySearchItemRow,
  schema: ProductSchema | null,
  selections: ReadonlyMap<string, string>,
): DiscoveryBulkCartPreviewLine | DiscoveryBulkCartPreviewSkippedItem {
  const thumbnailImage = productAssetRoleImage(item, "thumbnail");

  if (!schema || schema.dimensions.length === 0) {
    return {
      catalog_item_id: item.catalog_item_id,
      slug: item.slug,
      title: item.title,
      subtitle: item.subtitle,
      image_url: thumbnailImage.src,
      image_srcset: thumbnailImage.srcSet,
      image_loading_url: null,
      image_loading_alt: null,
      image_loading_srcset: null,
      product_id: `${item.catalog_item_id}::`,
      selected_options: [],
      product_summary: null,
      quantity: 1,
    };
  }

  const selectedOptions: { dimensionId: string; optionId: string }[] = [];
  const productSummaryParts: string[] = [];
  for (const order of schema.canonicalDimensionOrder) {
    const dimension = schema.dimensions.find((entry) => entry.dimensionId === order.dimensionId);
    if (!dimension || !isSchemaDimensionActive(dimension, selections)) {
      continue;
    }

    const selectedOptionId = selections.get(dimension.dimensionId);
    if (!selectedOptionId) {
      if (dimension.required) {
        return {
          catalog_item_id: item.catalog_item_id,
          slug: item.slug,
          title: item.title,
          reason: "product-options-required",
          message: `${dimension.dimensionName} is required before this item can be added.`,
        };
      }
      continue;
    }

    const option = dimension.allowedOptions.find((candidate) => candidate.optionId === selectedOptionId);
    if (!option) {
      return {
        catalog_item_id: item.catalog_item_id,
        slug: item.slug,
        title: item.title,
        reason: "invalid-product-selection",
        message: `${dimension.dimensionName} does not match this item.`,
      };
    }

    selectedOptions.push({ dimensionId: dimension.dimensionId, optionId: option.optionId });
    productSummaryParts.push(`${dimension.dimensionName}: ${option.label || option.code}`);
  }

  const selectedRecord = Object.fromEntries(selectedOptions.map((entry) => [entry.dimensionId, entry.optionId]));

  return {
    catalog_item_id: item.catalog_item_id,
    slug: item.slug,
    title: item.title,
    subtitle: item.subtitle,
    image_url: thumbnailImage.src,
    image_srcset: thumbnailImage.srcSet,
    image_loading_url: null,
    image_loading_alt: null,
    image_loading_srcset: null,
    product_id: `${item.catalog_item_id}::${schema.canonicalDimensionOrder
      .map((entry) => `${entry.dimensionId}:${selectedRecord[entry.dimensionId] ?? "-"}`)
      .join("|")}`,
    selected_options: selectedOptions,
    product_summary: productSummaryParts.length > 0 ? productSummaryParts.join(", ") : null,
    quantity: 1,
  };
}

export async function previewBulkAddSearchResults(
  db: PgQueryable,
  params: DiscoverySearchParams = {},
  limit = 250,
): Promise<DiscoveryBulkCartPreview> {
  const result = await searchDiscoveryItems(
    db,
    {
      ...params,
      limit: limit + 1,
      offset: 0,
      cursor: undefined,
      includeTotal: true,
    },
    { loadFacets: false },
  );
  const items = result.items.slice(0, limit);
  const schemas = await loadProductSchemasForBlueprints(
    db,
    items.map((item) => item.blueprint_id).filter((id): id is string => Boolean(id)),
  );
  const selections = selectedOptionMap(params.dimensionFilters);
  const lines: DiscoveryBulkCartPreviewLine[] = [];
  const skippedItems: DiscoveryBulkCartPreviewSkippedItem[] = [];

  for (const item of items) {
    const resolved = resolvePreviewLine(
      item,
      item.blueprint_id ? (schemas.get(item.blueprint_id) ?? null) : null,
      selections,
    );
    if ("product_id" in resolved) {
      lines.push(resolved);
    } else {
      skippedItems.push(resolved);
    }
  }

  return {
    totalMatches: result.total,
    eligibleCount: lines.length,
    skippedCount: skippedItems.length,
    overLimit: (result.total ?? result.items.length) > limit,
    limit,
    lines,
    skippedItems,
  };
}

type FacetSummaryRow = Readonly<{
  kind: DiscoveryFacetKind;
  id: string;
  label: string;
  coverage: string | number;
  distinct_count: string | number;
}>;

async function loadSearchFacets(db: PgQueryable, params: DiscoverySearchParams): Promise<DiscoveryFacetGroup[]> {
  const filter = buildSearchFilter(params, { itemAlias: "item" });
  const selectedFields = groupFieldFilters(params.fieldFilters);
  const selectedReferences = groupReferenceFilters(params.referenceFilters);
  const selectedDimensions = groupDimensionFilters(params.dimensionFilters);
  const summarySql = `
    SELECT *
    FROM (
      SELECT
        'field'::text AS kind,
        facet.value->>'fieldId' AS id,
        MAX(facet.value->>'label') AS label,
        COUNT(DISTINCT item.catalog_item_id)::integer AS coverage,
        COUNT(DISTINCT facet.value->>'value')::integer AS distinct_count
      FROM discovery_search_items AS item
      CROSS JOIN LATERAL jsonb_array_elements(item.field_filter_values) AS facet(value)
      ${filter.where}
        AND COALESCE(facet.value->>'valueType', '') <> 'reference'
      GROUP BY facet.value->>'fieldId'
      UNION ALL
      SELECT
        'reference'::text AS kind,
        facet.value->>'typeKey' AS id,
        MAX(facet.value->>'label') AS label,
        COUNT(DISTINCT item.catalog_item_id)::integer AS coverage,
        COUNT(DISTINCT facet.value->>'referenceId')::integer AS distinct_count
      FROM discovery_search_items AS item
      CROSS JOIN LATERAL jsonb_array_elements(item.reference_filter_values) AS facet(value)
      ${filter.where}
      GROUP BY facet.value->>'typeKey'
      UNION ALL
      SELECT
        'dimension'::text AS kind,
        facet.value->>'dimensionId' AS id,
        MAX(facet.value->>'label') AS label,
        COUNT(DISTINCT item.catalog_item_id)::integer AS coverage,
        COUNT(DISTINCT facet.value->>'optionId')::integer AS distinct_count
      FROM discovery_search_items AS item
      CROSS JOIN LATERAL jsonb_array_elements(item.dimension_filter_values) AS facet(value)
      ${filter.where}
      GROUP BY facet.value->>'dimensionId'
    ) AS summaries
    WHERE id IS NOT NULL
      AND label IS NOT NULL
      AND distinct_count > 0
    ORDER BY coverage DESC, distinct_count DESC, label ASC, id ASC`;
  const summaryResult = await db.query<FacetSummaryRow>(summarySql, filter.values);
  const topSummaries = summaryResult.rows
    .filter((row) => Number(row.coverage) > 0)
    .filter((row) => Number(row.distinct_count) > 0)
    .sort(compareFacetSummaries);
  const chosen = new Map<string, FacetSummaryRow>();

  for (const summary of topSummaries) {
    if (
      (summary.kind === "field" && selectedFields.has(summary.id)) ||
      (summary.kind === "reference" && selectedReferences.has(summary.id)) ||
      (summary.kind === "dimension" && selectedDimensions.has(summary.id))
    ) {
      chosen.set(facetKey(summary.kind, summary.id), summary);
    }
  }

  for (const summary of topSummaries) {
    if (chosen.size >= FACET_GROUP_LIMIT) {
      break;
    }
    chosen.set(facetKey(summary.kind, summary.id), summary);
  }

  const groups = (
    await Promise.all(
      [...chosen.values()].map(async (summary): Promise<DiscoveryFacetGroup | null> => {
        const values =
          summary.kind === "field"
            ? await loadFieldFacetValues(db, params, summary.id, selectedFields.get(summary.id) ?? [])
            : summary.kind === "reference"
              ? await loadReferenceFacetValues(db, params, summary.id, selectedReferences.get(summary.id) ?? [])
              : await loadDimensionFacetValues(db, params, summary.id, selectedDimensions.get(summary.id) ?? []);

        return values.length > 0
          ? {
              id: summary.id,
              kind: summary.kind,
              label: summary.label,
              values,
            }
          : null;
      }),
    )
  ).filter((group): group is DiscoveryFacetGroup => group !== null);

  return groups.sort((left, right) => {
    const leftSummary = chosen.get(facetKey(left.kind, left.id));
    const rightSummary = chosen.get(facetKey(right.kind, right.id));
    return compareFacetSummaries(leftSummary, rightSummary);
  });
}

function compareFacetSummaries(left: FacetSummaryRow | undefined, right: FacetSummaryRow | undefined): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }

  return (
    facetGroupDecisionPriority(right) - facetGroupDecisionPriority(left) ||
    Number(right.coverage) - Number(left.coverage) ||
    Number(right.distinct_count) - Number(left.distinct_count) ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id)
  );
}

async function loadReferenceFacetValues(
  db: PgQueryable,
  params: DiscoverySearchParams,
  typeKey: string,
  selectedReferenceIds: readonly string[],
): Promise<DiscoveryFacetValue[]> {
  const filter = buildSearchFilter(params, { excludeFacet: { kind: "reference", id: typeKey }, itemAlias: "item" });
  const orderBy = fieldFacetValueOrderSql({
    sortKind: "sort_kind",
    sortValue: "sort_value",
    sortNumber: "sort_number",
    count: "count",
    label: "label",
    id: "reference_id",
  });
  const result = await db.query<{
    reference_id: string;
    label: string;
    count: number;
  }>(
    `WITH facet_values AS (
       SELECT
         facet.value->>'referenceId' AS reference_id,
         MAX(facet.value->>'referenceLabel') AS label,
         COUNT(DISTINCT item.catalog_item_id)::integer AS count,
         MAX(facet.value->>'sortKind') AS sort_kind,
         MAX(facet.value->>'sortValue') AS sort_value,
         MAX(NULLIF(facet.value->>'sortValue', '')::numeric) FILTER (WHERE facet.value->>'sortKind' = 'number-desc') AS sort_number,
         BOOL_OR(facet.value->>'referenceId' = ANY($${filter.nextParamIndex + 1}::text[])) AS selected
       FROM discovery_search_items AS item
       CROSS JOIN LATERAL jsonb_array_elements(item.reference_filter_values) AS facet(value)
       ${filter.where}
         AND facet.value->>'typeKey' = $${filter.nextParamIndex}
       GROUP BY facet.value->>'referenceId'
     ),
     ranked AS (
       SELECT *, ROW_NUMBER() OVER (ORDER BY selected DESC, ${orderBy}) AS facet_rank
       FROM facet_values
     )
     SELECT reference_id, label, count
     FROM ranked
     WHERE selected OR facet_rank <= ${FACET_VALUE_LIMIT}
     ORDER BY selected DESC, ${orderBy}`,
    [...filter.values, typeKey, selectedReferenceIds],
  );

  return result.rows.map((row) => ({
    id: row.reference_id,
    label: row.label,
    count: Number(row.count),
    selected: selectedReferenceIds.includes(row.reference_id),
  }));
}

async function loadFieldFacetValues(
  db: PgQueryable,
  params: DiscoverySearchParams,
  fieldId: string,
  selectedValues: readonly string[],
): Promise<DiscoveryFacetValue[]> {
  const filter = buildSearchFilter(params, { excludeFacet: { kind: "field", id: fieldId }, itemAlias: "item" });
  const orderBy = fieldFacetValueOrderSql({
    sortKind: "sort_kind",
    sortValue: "sort_value",
    sortNumber: "sort_number",
    count: "count",
    label: "label",
    id: "value",
  });
  const result = await db.query<{
    value: string;
    label: string;
    count: number;
  }>(
    `WITH facet_values AS (
       SELECT
         facet.value->>'value' AS value,
         MAX(facet.value->>'valueLabel') AS label,
         COUNT(DISTINCT item.catalog_item_id)::integer AS count,
         MAX(facet.value->>'sortKind') AS sort_kind,
         MAX(facet.value->>'sortValue') AS sort_value,
         MAX(NULLIF(facet.value->>'sortValue', '')::numeric) FILTER (WHERE facet.value->>'sortKind' = 'number-desc') AS sort_number,
         BOOL_OR(facet.value->>'value' = ANY($${filter.nextParamIndex + 1}::text[])) AS selected
       FROM discovery_search_items AS item
       CROSS JOIN LATERAL jsonb_array_elements(item.field_filter_values) AS facet(value)
       ${filter.where}
         AND facet.value->>'fieldId' = $${filter.nextParamIndex}
       GROUP BY facet.value->>'value'
     ),
     ranked AS (
       SELECT *, ROW_NUMBER() OVER (ORDER BY selected DESC, ${orderBy}) AS facet_rank
       FROM facet_values
     )
     SELECT value, label, count
     FROM ranked
     WHERE selected OR facet_rank <= ${FACET_VALUE_LIMIT}
     ORDER BY selected DESC, ${orderBy}`,
    [...filter.values, fieldId, selectedValues],
  );

  return result.rows.map((row) => ({
    id: row.value,
    label: row.label,
    count: Number(row.count),
    selected: selectedValues.includes(row.value),
  }));
}

async function loadDimensionFacetValues(
  db: PgQueryable,
  params: DiscoverySearchParams,
  dimensionId: string,
  selectedOptionIds: readonly string[],
): Promise<DiscoveryFacetValue[]> {
  const filter = buildSearchFilter(params, { excludeFacet: { kind: "dimension", id: dimensionId }, itemAlias: "item" });
  const activityDimensionFilters = marketDimensionFilterGroups(groupDimensionFilters(params.dimensionFilters), {
    kind: "dimension",
    id: dimensionId,
  });
  const orderBy = dimensionFacetValueOrderSql({
    valueKind: "value_kind",
    numericValue: "numeric_value",
    displayOrder: "display_order",
    count: "count",
    label: "label",
    id: "option_id",
  });

  if (params.marketActivity) {
    const activitySource = buildMarketActivityFacetSource(
      params.marketActivity,
      activityDimensionFilters,
      filter.nextParamIndex + 2,
    );
    const result = await db.query<{
      option_id: string;
      label: string;
      count: number;
    }>(
      `WITH facet_values AS (
       SELECT
         facet.value->>'optionId' AS option_id,
         MAX(facet.value->>'optionLabel') AS label,
         MAX(facet.value->>'valueKind') AS value_kind,
         MIN(NULLIF(facet.value->>'displayOrder', '')::integer) AS display_order,
         MAX(NULLIF(facet.value->>'numericValue', '')::numeric) AS numeric_value,
         BOOL_OR(facet.value->>'optionId' = ANY($${filter.nextParamIndex + 1}::text[])) AS selected
       FROM discovery_search_items AS item
       CROSS JOIN LATERAL jsonb_array_elements(item.dimension_filter_values) AS facet(value)
       ${filter.where}
         AND facet.value->>'dimensionId' = $${filter.nextParamIndex}
       GROUP BY facet.value->>'optionId'
     ),
     market_activity AS (
       ${activitySource.sql}
     ),
     market_counts AS (
       SELECT
         selected_option.value->>'optionId' AS option_id,
         COUNT(DISTINCT activity.activity_id)::integer AS count
       FROM market_activity AS activity
       INNER JOIN discovery_search_items AS item
         ON item.catalog_item_id = activity.catalog_catalog_item_id
       CROSS JOIN LATERAL jsonb_array_elements(activity.selected_options) AS selected_option(value)
       ${filter.where}
         AND selected_option.value->>'dimensionId' = $${filter.nextParamIndex}
       GROUP BY selected_option.value->>'optionId'
     ),
     counted AS (
       SELECT
         facet_values.option_id,
         facet_values.label,
         COALESCE(market_counts.count, 0)::integer AS count,
         facet_values.value_kind,
         facet_values.display_order,
         facet_values.numeric_value,
         facet_values.selected
       FROM facet_values
       LEFT JOIN market_counts
         ON market_counts.option_id = facet_values.option_id
     ),
     ranked AS (
       SELECT
         counted.*,
         ROW_NUMBER() OVER (ORDER BY counted.selected DESC, ${orderBy}) AS facet_rank
       FROM counted
     )
     SELECT option_id, label, count
     FROM ranked
     WHERE selected OR (count > 0 AND facet_rank <= ${FACET_VALUE_LIMIT})
     ORDER BY selected DESC, ${orderBy}`,
      [...filter.values, dimensionId, selectedOptionIds, ...activitySource.values],
    );

    return result.rows.map((row) => ({
      id: row.option_id,
      label: row.label,
      count: Number(row.count),
      selected: selectedOptionIds.includes(row.option_id),
    }));
  }

  const result = await db.query<{
    option_id: string;
    label: string;
    count: number;
  }>(
    `WITH facet_values AS (
       SELECT
         facet.value->>'optionId' AS option_id,
         MAX(facet.value->>'optionLabel') AS label,
         COUNT(DISTINCT item.catalog_item_id)::integer AS count,
         MAX(facet.value->>'valueKind') AS value_kind,
         MIN(NULLIF(facet.value->>'displayOrder', '')::integer) AS display_order,
         MAX(NULLIF(facet.value->>'numericValue', '')::numeric) AS numeric_value,
         BOOL_OR(facet.value->>'optionId' = ANY($${filter.nextParamIndex + 1}::text[])) AS selected
       FROM discovery_search_items AS item
       CROSS JOIN LATERAL jsonb_array_elements(item.dimension_filter_values) AS facet(value)
       ${filter.where}
         AND facet.value->>'dimensionId' = $${filter.nextParamIndex}
       GROUP BY facet.value->>'optionId'
     ),
     ranked AS (
       SELECT *, ROW_NUMBER() OVER (ORDER BY selected DESC, ${orderBy}) AS facet_rank
       FROM facet_values
     )
     SELECT option_id, label, count
     FROM ranked
     WHERE selected OR facet_rank <= ${FACET_VALUE_LIMIT}
     ORDER BY selected DESC, ${orderBy}`,
    [...filter.values, dimensionId, selectedOptionIds],
  );

  return result.rows.map((row) => ({
    id: row.option_id,
    label: row.label,
    count: Number(row.count),
    selected: selectedOptionIds.includes(row.option_id),
  }));
}

function facetKey(kind: DiscoveryFacetKind, id: string): string {
  return `${kind}:${id}`;
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? Number.NaN)) {
    return 50;
  }

  return Math.min(200, Math.max(1, Math.trunc(limit as number)));
}

function clampOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset ?? Number.NaN)) {
    return 0;
  }

  return Math.min(1_000, Math.max(0, Math.trunc(offset as number)));
}

function cursorValueCount(
  sort: string | undefined,
  hasSearch: boolean,
  cursor: ReturnType<typeof decodeSearchCursor>,
): number {
  if (sort === "price_asc" || sort === "price_desc") {
    return cursor?.lowestPriceAmount === null ? 1 : 2;
  }

  return (sort === "relevance" || sort === undefined) && hasSearch ? 4 : 2;
}

function encodeSearchCursor(row: SearchIndexItemRow & { search_rank?: string | number | null }): string {
  return Buffer.from(
    JSON.stringify({
      id: row.catalog_item_id,
      title: row.title,
      updatedAt: row.updated_at,
      rank: Number(row.search_rank ?? 0),
      baseMatch: Boolean(row.search_base_match),
      lowestPriceAmount: row.lowest_price_amount,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeSearchCursor(cursor: string | undefined) {
  if (!cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const value = parsed as Record<string, unknown>;
    return {
      id: String(value.id ?? ""),
      title: String(value.title ?? ""),
      updatedAt: String(value.updatedAt ?? ""),
      rank: Number(value.rank ?? 0),
      baseMatch: Boolean(value.baseMatch),
      lowestPriceAmount:
        typeof value.lowestPriceAmount === "string" && value.lowestPriceAmount.length > 0
          ? value.lowestPriceAmount
          : null,
    };
  } catch {
    return null;
  }
}

function halfVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}
