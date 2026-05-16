import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { normalizeSimpleSearchText } from "../domain/normalization";

export type DiscoverySearchParams = {
  search?: string;
  category?: string;
  tag?: string;
  blueprintId?: string;
  language?: string;
  status?: string;
  fieldFilters?: readonly DiscoveryFieldFilter[];
  dimensionFilters?: readonly DiscoveryDimensionFilter[];
  sort?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
  includeTotal?: boolean;
};

export type DiscoveryFieldFilter = Readonly<{ fieldId: string; value: string }>;
export type DiscoveryDimensionFilter = Readonly<{ dimensionId: string; optionId: string }>;
export type DiscoveryFacetKind = "field" | "dimension";
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

export type DiscoverySearchItemRow = Readonly<{
  catalog_item_id: string;
  slug: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
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
  market_summary: Readonly<{
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }> | null;
  updated_at: string;
  search_rank?: string | number | null;
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
    catalog_catalog_item_id: string;
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }>(
    `SELECT
       listing.catalog_catalog_item_id,
       MIN(listing.price_amount)::text AS lowest_price_amount,
       COUNT(*)::integer AS active_listing_count,
       COALESCE(SUM(listing.quantity_cap), 0)::integer AS total_visible_quantity
     FROM discovery_market_listings AS listing
     INNER JOIN discovery_market_accounts AS account
       ON account.account_id = listing.account_id
     WHERE listing.status = 'active'
       AND account.seller_listing_availability_status = 'available'
       AND listing.catalog_catalog_item_id = ANY($1::text[])
     GROUP BY listing.catalog_catalog_item_id`,
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

function buildSearchFilter(
  params: DiscoverySearchParams,
  options: SearchFilterBuildOptions = {},
): BuiltSearchFilter {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  conditions.push(`status = $${paramIndex}`);
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
      `(search_text @@ plainto_tsquery('english', $${englishSearchParamIndex}) OR search_text_simple @@ plainto_tsquery('simple', $${simpleSearchParamIndex}))`,
    );
    values.push(normalizeSimpleSearchText(params.search));
    paramIndex++;
    hasSearch = true;
  }

  if (params.category) {
    conditions.push(`(category_names @> $${paramIndex}::jsonb OR category_slugs @> $${paramIndex}::jsonb)`);
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

  if (params.language) {
    conditions.push(`language_code = $${paramIndex}`);
    values.push(params.language);
    paramIndex++;
  }

  for (const [fieldId, selectedValues] of groupFieldFilters(params.fieldFilters).entries()) {
    if (options.excludeFacet?.kind === "field" && options.excludeFacet.id === fieldId) {
      continue;
    }

    conditions.push(
      `EXISTS (
         SELECT 1
         FROM jsonb_array_elements(field_filter_values) AS facet(value)
         WHERE facet.value->>'fieldId' = $${paramIndex}
           AND facet.value->>'value' = ANY($${paramIndex + 1}::text[])
       )`,
    );
    values.push(fieldId, selectedValues);
    paramIndex += 2;
  }

  for (const [dimensionId, selectedOptionIds] of groupDimensionFilters(params.dimensionFilters).entries()) {
    if (options.excludeFacet?.kind === "dimension" && options.excludeFacet.id === dimensionId) {
      continue;
    }

    conditions.push(
      `EXISTS (
         SELECT 1
         FROM jsonb_array_elements(dimension_filter_values) AS facet(value)
         WHERE facet.value->>'dimensionId' = $${paramIndex}
           AND facet.value->>'optionId' = ANY($${paramIndex + 1}::text[])
       )`,
    );
    values.push(dimensionId, selectedOptionIds);
    paramIndex += 2;
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
    case "relevance":
    default:
      if (hasSearch) {
        rankExpression = `(ts_rank(search_text, plainto_tsquery('english', $${englishSearchParamIndex})) + ts_rank(search_text_simple, plainto_tsquery('simple', $${simpleSearchParamIndex})))`;
        orderBy = `${rankExpression} DESC, title ASC, catalog_item_id ASC`;
        if (cursor) {
          cursorCondition = `(${rankExpression}, title, catalog_item_id) < ($${paramIndex}::real, $${paramIndex + 1}, $${paramIndex + 2})`;
          values.push(cursor.rank, cursor.title, cursor.id);
          paramIndex += 3;
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
  const listValues = useLegacyOffset
    ? [...values, limit, offset]
    : [...values, limit + 1];
  const listLimitSql = useLegacyOffset
    ? `LIMIT $${values.length + 1} OFFSET $${values.length + 2}`
    : `LIMIT $${values.length + 1}`;
  const selectRank = rankExpression ? `, ${rankExpression} AS search_rank` : "";

  const countPromise = params.includeTotal || useLegacyOffset
    ? db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM discovery_search_items ${where}`, values.slice(0, values.length - (cursorCondition ? cursorValueCount(params.sort, hasSearch) : 0)))
    : Promise.resolve({ rows: [] });
  const listSql = `SELECT catalog_item_id, slug, language_code, title_i18n, title, subtitle_i18n, subtitle, description_i18n, description, blueprint_id, blueprint_name, status, category_names, category_slugs, tags, image_urls, product_asset_sets, updated_at${selectRank}
    FROM discovery_search_items ${whereWithCursor}
    ORDER BY ${orderBy}
    ${listLimitSql}`;

  const [countResult, listResult] = await Promise.all([
    countPromise,
    db.query<BaseDiscoverySearchItemRow & { search_rank?: string | number | null }>(listSql, listValues),
  ]);
  const rows = useLegacyOffset ? listResult.rows : listResult.rows.slice(0, limit);
  const lastRow = rows.at(-1);
  const hasNextPage = !useLegacyOffset && listResult.rows.length > limit;

  const marketSummaries = await getMarketSummariesForItems(
    db,
    rows.map((row) => row.catalog_item_id),
  );
  const facets = await loadSearchFacets(db, params);

  return {
    items: rows.map((row) => ({
      ...row,
      market_summary: marketSummaries.get(row.catalog_item_id) ?? null,
    })),
    facets,
    total: countResult.rows[0]?.count
      ? Number.parseInt(countResult.rows[0].count, 10)
      : null,
    nextCursor: hasNextPage && lastRow ? encodeSearchCursor(lastRow) : null,
  };
}

type FacetSummaryRow = Readonly<{
  kind: DiscoveryFacetKind;
  id: string;
  label: string;
  coverage: string | number;
  distinct_count: string | number;
}>;

async function loadSearchFacets(
  db: PgQueryable,
  params: DiscoverySearchParams,
): Promise<DiscoveryFacetGroup[]> {
  const filter = buildSearchFilter(params);
  const selectedFields = groupFieldFilters(params.fieldFilters);
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
      GROUP BY facet.value->>'fieldId'
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
    .filter((row) => Number(row.distinct_count) > 0);
  const chosen = new Map<string, FacetSummaryRow>();

  for (const summary of topSummaries) {
    if (
      (summary.kind === "field" && selectedFields.has(summary.id)) ||
      (summary.kind === "dimension" && selectedDimensions.has(summary.id))
    ) {
      chosen.set(facetKey(summary.kind, summary.id), summary);
    }
  }

  for (const summary of topSummaries) {
    if (chosen.size >= 5) {
      break;
    }
    chosen.set(facetKey(summary.kind, summary.id), summary);
  }

  const groups: DiscoveryFacetGroup[] = [];
  for (const summary of chosen.values()) {
    const values = summary.kind === "field"
      ? await loadFieldFacetValues(db, params, summary.id, selectedFields.get(summary.id) ?? [])
      : await loadDimensionFacetValues(db, params, summary.id, selectedDimensions.get(summary.id) ?? []);

    if (values.length > 0) {
      groups.push({
        id: summary.id,
        kind: summary.kind,
        label: summary.label,
        values,
      });
    }
  }

  return groups.sort((left, right) => {
    const leftSummary = chosen.get(facetKey(left.kind, left.id));
    const rightSummary = chosen.get(facetKey(right.kind, right.id));
    return Number(rightSummary?.coverage ?? 0) - Number(leftSummary?.coverage ?? 0) ||
      Number(rightSummary?.distinct_count ?? 0) - Number(leftSummary?.distinct_count ?? 0) ||
      left.label.localeCompare(right.label) ||
      left.id.localeCompare(right.id);
  });
}

async function loadFieldFacetValues(
  db: PgQueryable,
  params: DiscoverySearchParams,
  fieldId: string,
  selectedValues: readonly string[],
): Promise<DiscoveryFacetValue[]> {
  const filter = buildSearchFilter(params, { excludeFacet: { kind: "field", id: fieldId } });
  const result = await db.query<{
    value: string;
    label: string;
    count: number;
  }>(
    `SELECT
       facet.value->>'value' AS value,
       MAX(facet.value->>'valueLabel') AS label,
       COUNT(DISTINCT item.catalog_item_id)::integer AS count
     FROM discovery_search_items AS item
     CROSS JOIN LATERAL jsonb_array_elements(item.field_filter_values) AS facet(value)
     ${filter.where}
       AND facet.value->>'fieldId' = $${filter.nextParamIndex}
     GROUP BY facet.value->>'value'
     ORDER BY count DESC, label ASC, value ASC
     LIMIT 8`,
    [...filter.values, fieldId],
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
  const filter = buildSearchFilter(params, { excludeFacet: { kind: "dimension", id: dimensionId } });
  const result = await db.query<{
    option_id: string;
    label: string;
    count: number;
  }>(
    `SELECT
       facet.value->>'optionId' AS option_id,
       MAX(facet.value->>'optionLabel') AS label,
       COUNT(DISTINCT item.catalog_item_id)::integer AS count
     FROM discovery_search_items AS item
     CROSS JOIN LATERAL jsonb_array_elements(item.dimension_filter_values) AS facet(value)
     ${filter.where}
       AND facet.value->>'dimensionId' = $${filter.nextParamIndex}
     GROUP BY facet.value->>'optionId'
     ORDER BY count DESC, label ASC, option_id ASC
     LIMIT 8`,
    [...filter.values, dimensionId],
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

  return Math.min(100, Math.max(1, Math.trunc(limit as number)));
}

function clampOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset ?? Number.NaN)) {
    return 0;
  }

  return Math.min(1_000, Math.max(0, Math.trunc(offset as number)));
}

function cursorValueCount(sort: string | undefined, hasSearch: boolean): number {
  return (sort === "relevance" || sort === undefined) && hasSearch ? 3 : 2;
}

function encodeSearchCursor(row: BaseDiscoverySearchItemRow & { search_rank?: string | number | null }): string {
  return Buffer.from(
    JSON.stringify({
      id: row.catalog_item_id,
      title: row.title,
      updatedAt: row.updated_at,
      rank: Number(row.search_rank ?? 0),
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
    };
  } catch {
    return null;
  }
}
