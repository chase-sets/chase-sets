import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  getProductMarketStatsSnapshot,
  getProductRollupSeries,
  type MarketStateSnapshotPoint,
  type ProductMarketAggregate,
  type ProductRollupSeriesPoint,
} from "../../market-rollups/read-model/queries";
import { PUBLIC_MARKET_PAGE_HISTORY_WINDOW_DAYS } from "../../market-rollups/read-model/rollup-policy";

/**
 * The public market pages read layer: the SEO-facing serving
 * contract over Pricing's already-public-safe surfaces (the catalog item's
 * title/subtitle/slug, and the market-rollups query API). Every field
 * returned here is safe to render on an unauthenticated, search-indexed
 * page -- no account identifiers, no buyer/seller attribution ever appear
 * anywhere in this module (see the privacy test in
 * ../tests/public-market-pages.test.ts).
 */

export type PricingPublicCatalogItem = Readonly<{
  catalogItemId: string;
  title: string;
  subtitle: string | null;
  slug: string;
}>;

/**
 * Resolves a public market page's catalog item by slug (the canonical
 * public address) or, defensively, by raw catalogItemId. Only 'active'
 * (published) catalog items resolve -- draft/archived items 404, matching
 * discovery's item-detail publication gate.
 */
export async function getPricingCatalogItemBySlugOrId(
  db: PgQueryable,
  slugOrId: string,
): Promise<PricingPublicCatalogItem | null> {
  const trimmed = slugOrId.trim();
  if (!trimmed) {
    return null;
  }

  const result = await db.query<{
    catalog_item_id: string;
    title: string;
    subtitle: string | null;
    slug: string | null;
  }>(
    `SELECT catalog_item_id, title, subtitle, slug
     FROM pricing_catalog_item_inputs
     WHERE status = 'active' AND (slug = $1 OR catalog_item_id = $1)
     LIMIT 1`,
    [trimmed],
  );

  const row = result.rows[0];
  if (!row || !row.slug) {
    return null;
  }

  return {
    catalogItemId: row.catalog_item_id,
    title: row.title,
    subtitle: row.subtitle,
    slug: row.slug,
  };
}

/**
 * The most-traded resolved product for a catalog item (highest combined
 * 30d/90d trade count on the Product Market Aggregate), falling back to the
 * product with the most active listings when the item has no trade history
 * yet. This is the "primary" product a per-catalog-item public page charts;
 * a full per-condition breakdown needs Catalog's dimension/option labels,
 * which Pricing does not project today -- see the PR description for the
 * explicit scope note.
 */
export async function getPrimaryTradedProductId(db: PgQueryable, catalogItemId: string): Promise<string | null> {
  const traded = await db.query<{ product_id: string }>(
    `SELECT product_id
     FROM pricing_product_market_aggregates
     WHERE catalog_catalog_item_id = $1
     ORDER BY (trade_count_30d + trade_count_90d) DESC, product_id ASC
     LIMIT 1`,
    [catalogItemId],
  );
  if (traded.rows[0]) {
    return traded.rows[0].product_id;
  }

  const listed = await db.query<{ product_id: string }>(
    `SELECT product_id
     FROM pricing_market_listing_inputs
     WHERE catalog_catalog_item_id = $1 AND status = 'active'
     GROUP BY product_id
     ORDER BY COUNT(*) DESC, product_id ASC
     LIMIT 1`,
    [catalogItemId],
  );

  return listed.rows[0]?.product_id ?? null;
}

export type PublicMarketPageData = Readonly<{
  catalogItemId: string;
  title: string;
  subtitle: string | null;
  slug: string;
  productId: string | null;
  series: readonly ProductRollupSeriesPoint[];
  aggregate: ProductMarketAggregate | null;
  marketState: MarketStateSnapshotPoint | null;
}>;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Composes the full public market page payload for one catalog item: the
 * publication-gated catalog item identity, its most-traded product's
 * trailing rollup series (PUBLIC_MARKET_PAGE_HISTORY_WINDOW_DAYS), and its
 * current stats snapshot (last-sold, 30/90-day medians, market state).
 * Returns null when the slug/id does not resolve to a published catalog
 * item (the route 404s). A resolved item with no market activity yet still
 * renders, with `productId: null` and empty series/stats -- DS chart
 * primitives already render an "insufficient data" state for that case.
 */
export async function getPublicMarketPageData(
  db: PgQueryable,
  slugOrId: string,
  options: Readonly<{ now?: Date }> = {},
): Promise<PublicMarketPageData | null> {
  const catalogItem = await getPricingCatalogItemBySlugOrId(db, slugOrId);
  if (!catalogItem) {
    return null;
  }

  const productId = await getPrimaryTradedProductId(db, catalogItem.catalogItemId);
  if (!productId) {
    return { ...catalogItem, productId: null, series: [], aggregate: null, marketState: null };
  }

  const now = options.now ?? new Date();
  const to = isoDate(now);
  const from = isoDate(new Date(now.getTime() - PUBLIC_MARKET_PAGE_HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000));

  const [series, stats] = await Promise.all([
    getProductRollupSeries(db, { catalogItemId: catalogItem.catalogItemId, productId, from, to }),
    getProductMarketStatsSnapshot(db, { catalogItemId: catalogItem.catalogItemId, productId }),
  ]);

  return {
    ...catalogItem,
    productId,
    series,
    aggregate: stats.aggregate,
    marketState: stats.marketState,
  };
}

export type PublicMarketPageSitemapEntry = Readonly<{ slug: string; updatedAt: string }>;

/**
 * Slugs for indexable public market pages -- catalog items with at least
 * one recorded trade -- ordered most-recently-active first. Feeds the
 * public-web sitemap once indexing is enabled (m97 owns that flip).
 */
export async function listPublicMarketPageSlugs(
  db: PgQueryable,
  options: Readonly<{ limit?: number }> = {},
): Promise<readonly PublicMarketPageSitemapEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 5000, 1), 50000);

  const result = await db.query<{ slug: string; updated_at: Date }>(
    `SELECT catalog_item.slug AS slug, MAX(aggregate.updated_at) AS updated_at
     FROM pricing_catalog_item_inputs AS catalog_item
     INNER JOIN pricing_product_market_aggregates AS aggregate
       ON aggregate.catalog_catalog_item_id = catalog_item.catalog_item_id
     WHERE catalog_item.status = 'active' AND catalog_item.slug IS NOT NULL
     GROUP BY catalog_item.slug
     ORDER BY MAX(aggregate.updated_at) DESC
     LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({ slug: row.slug, updatedAt: new Date(row.updated_at).toISOString() }));
}
