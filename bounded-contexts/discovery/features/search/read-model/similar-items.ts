import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  DiscoveryImageFallback,
  DiscoveryProductAssetSet,
  DiscoverySimilarItem,
  DiscoverySimilarItemsResponse,
} from "../../../support/client-support/contracts";

export const DISCOVERY_SIMILAR_ITEMS_DEFAULT_LIMIT = 8;
export const DISCOVERY_SIMILAR_ITEMS_MAX_LIMIT = 8;
export const DISCOVERY_SIMILAR_ITEMS_CATEGORY_BONUS = 0.03;

type SimilarItemSourceRow = Readonly<{
  catalog_item_id: string;
  category_names: unknown;
  category_slugs: unknown;
  search_embedding: string | null;
}>;

type SimilarItemCandidateRow = Readonly<{
  catalog_item_id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  image_urls: unknown;
  product_asset_sets: unknown;
  image_fallback: unknown;
  semantic_similarity?: string | number;
  same_category?: boolean;
}>;

export type DiscoverySimilarItemsFilters = Readonly<{
  categorySlugs?: readonly string[];
}>;

export type FindSimilarDiscoveryItemsOptions = Readonly<{
  limit?: number;
  filters?: DiscoverySimilarItemsFilters;
  semanticEnabled?: boolean;
}>;

/**
 * Finds active item-to-item neighbors from the stored Search Embedding. The
 * source vector is read from Postgres and passed straight back to pgvector, so
 * this path never calls an embedding provider. A small same-category bonus is
 * applied after an HNSW-eligible candidate query. Missing/disabled/failing
 * semantic retrieval falls back to active peers from the source categories.
 */
export async function findSimilarDiscoveryItems(
  db: PgQueryable,
  catalogItemIdOrSlug: string,
  options: FindSimilarDiscoveryItemsOptions = {},
): Promise<DiscoverySimilarItemsResponse | null> {
  const limit = similarItemsLimit(options.limit);
  const source = await loadSimilarItemSource(db, catalogItemIdOrSlug).catch(() => null);
  if (!source) return null;

  const filterCategorySlugs = normalizeStrings(options.filters?.categorySlugs);
  const sourceCategoryNames = normalizeStrings(source.category_names);
  const sourceCategorySlugs = normalizeStrings(source.category_slugs);

  if (options.semanticEnabled !== false && source.search_embedding) {
    try {
      const semanticItems = await findSemanticNeighbors(db, source, {
        limit,
        filterCategorySlugs,
        sourceCategoryNames,
        sourceCategorySlugs,
      });
      if (semanticItems.length > 0) {
        return { items: semanticItems, count: semanticItems.length, mode: "semantic" };
      }
    } catch {
      // A vector/index failure must not make item detail unavailable.
    }
  }

  try {
    const categoryItems = await findCategoryNeighbors(db, source.catalog_item_id, {
      limit,
      categoryNames: filterCategorySlugs.length > 0 ? [] : sourceCategoryNames,
      categorySlugs: filterCategorySlugs.length > 0 ? filterCategorySlugs : sourceCategorySlugs,
    });
    return { items: categoryItems, count: categoryItems.length, mode: categoryItems.length ? "category" : "none" };
  } catch {
    return { items: [], count: 0, mode: "none" };
  }
}

async function loadSimilarItemSource(db: PgQueryable, catalogItemIdOrSlug: string) {
  const result = await db.query<SimilarItemSourceRow>(
    `SELECT catalog_item_id, category_names, category_slugs, search_embedding::text AS search_embedding
     FROM discovery_search_items
     WHERE status = 'active'
       AND (catalog_item_id = $1 OR slug = $1)
     ORDER BY (catalog_item_id = $1) DESC
     LIMIT 1`,
    [catalogItemIdOrSlug],
  );
  return result.rows[0] ?? null;
}

async function findSemanticNeighbors(
  db: PgQueryable,
  source: SimilarItemSourceRow,
  options: Readonly<{
    limit: number;
    filterCategorySlugs: readonly string[];
    sourceCategoryNames: readonly string[];
    sourceCategorySlugs: readonly string[];
  }>,
): Promise<DiscoverySimilarItem[]> {
  const candidateLimit = Math.min(32, options.limit * 4);
  const categoryFilterSql = options.filterCategorySlugs.length > 0 ? "AND category_slugs ?| $6::text[]" : "";
  const values: unknown[] = [
    source.search_embedding,
    source.catalog_item_id,
    options.sourceCategorySlugs,
    options.sourceCategoryNames,
    candidateLimit,
  ];
  if (options.filterCategorySlugs.length > 0) values.push(options.filterCategorySlugs);

  const result = await db.query<SimilarItemCandidateRow>(
    `SELECT catalog_item_id, slug, title, subtitle, image_urls, product_asset_sets, image_fallback,
            -(search_embedding <#> $1::halfvec(1024)) AS semantic_similarity,
            (category_slugs ?| $3::text[] OR category_names ?| $4::text[]) AS same_category
     FROM discovery_search_items
     WHERE status = 'active'
       AND catalog_item_id <> $2
       AND search_embedding IS NOT NULL
       ${categoryFilterSql}
     ORDER BY search_embedding <#> $1::halfvec(1024), title ASC, catalog_item_id ASC
     LIMIT $5`,
    values,
  );

  return result.rows
    .map((row) => ({
      row,
      score: Number(row.semantic_similarity) + (row.same_category ? DISCOVERY_SIMILAR_ITEMS_CATEGORY_BONUS : 0),
    }))
    .sort((left, right) => right.score - left.score || compareCandidateRows(left.row, right.row))
    .slice(0, options.limit)
    .map(({ row }) => similarItemFromRow(row));
}

async function findCategoryNeighbors(
  db: PgQueryable,
  sourceCatalogItemId: string,
  options: Readonly<{ limit: number; categoryNames: readonly string[]; categorySlugs: readonly string[] }>,
): Promise<DiscoverySimilarItem[]> {
  if (options.categorySlugs.length === 0 && options.categoryNames.length === 0) return [];

  const result = await db.query<SimilarItemCandidateRow>(
    `SELECT catalog_item_id, slug, title, subtitle, image_urls, product_asset_sets, image_fallback
     FROM discovery_search_items
     WHERE status = 'active'
       AND catalog_item_id <> $1
       AND (category_slugs ?| $2::text[] OR category_names ?| $3::text[])
     ORDER BY title ASC, catalog_item_id ASC
     LIMIT $4`,
    [sourceCatalogItemId, options.categorySlugs, options.categoryNames, options.limit],
  );
  return result.rows.map(similarItemFromRow);
}

function similarItemFromRow(row: SimilarItemCandidateRow): DiscoverySimilarItem {
  return {
    catalog_item_id: row.catalog_item_id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    image_urls: normalizeStrings(row.image_urls),
    product_asset_sets: Array.isArray(row.product_asset_sets)
      ? (row.product_asset_sets as DiscoveryProductAssetSet[])
      : [],
    image_fallback:
      row.image_fallback && typeof row.image_fallback === "object"
        ? (row.image_fallback as DiscoveryImageFallback)
        : null,
  };
}

function similarItemsLimit(value: number | undefined) {
  if (!Number.isFinite(value ?? Number.NaN)) return DISCOVERY_SIMILAR_ITEMS_DEFAULT_LIMIT;
  return Math.min(DISCOVERY_SIMILAR_ITEMS_MAX_LIMIT, Math.max(1, Math.trunc(value as number)));
}

function normalizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0))];
}

function compareCandidateRows(left: SimilarItemCandidateRow, right: SimilarItemCandidateRow) {
  return left.title.localeCompare(right.title) || left.catalog_item_id.localeCompare(right.catalog_item_id);
}
