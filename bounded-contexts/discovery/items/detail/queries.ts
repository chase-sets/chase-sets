import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type DiscoveryItemDetailRow = Readonly<{
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
  market_summary: Readonly<{
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }> | null;
  market_listings: readonly Readonly<{
    listing_id: string;
    account_id: string;
    inventory_record_id: string;
    catalog_item_id: string;
    item_title: string | null;
    item_subtitle: string | null;
    version_selection: readonly { dimensionId: string; choiceId: string }[];
    version_summary: string | null;
    condition: string;
    storage_location_name: string | null;
    ship_from_code: string | null;
    price_amount: string;
    quantity_cap: number;
    status: string;
    seller_display_name: string | null;
    visible_quantity: number;
    created_at: string;
    updated_at: string;
  }>[];
  updated_at: string;
}>;

type BaseDiscoveryItemDetailRow = Omit<
  DiscoveryItemDetailRow,
  "market_summary" | "market_listings"
>;

async function marketplaceListingsAvailable(db: PgQueryable) {
  const result = await db.query<{ exists: string | null }>(
    "SELECT to_regclass('public.marketplace_listing_pages')::text AS exists",
  );

  return Boolean(result.rows[0]?.exists);
}

async function identityAccountsAvailable(db: PgQueryable) {
  const result = await db.query<{ exists: string | null }>(
    "SELECT to_regclass('public.identity_accounts')::text AS exists",
  );

  return Boolean(result.rows[0]?.exists);
}

export async function getDiscoveryItemDetail(
  db: PgQueryable,
  itemId: string,
): Promise<DiscoveryItemDetailRow | null> {
  const result = await db.query<BaseDiscoveryItemDetailRow>(
    `SELECT * FROM discovery_item_detail_pages WHERE item_id = $1`,
    [itemId],
  );

  const item = result.rows[0] ?? null;
  if (!item) {
    return null;
  }

  if (!(await marketplaceListingsAvailable(db))) {
    return {
      ...item,
      market_summary: null,
      market_listings: [] as DiscoveryItemDetailRow["market_listings"],
    };
  }

  const summaryResult = await db.query<{
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }>(
    `SELECT
       MIN(price_amount)::text AS lowest_price_amount,
       COUNT(*)::integer AS active_listing_count,
       COALESCE(SUM(quantity_cap), 0)::integer AS total_visible_quantity
     FROM marketplace_listing_pages
     WHERE catalog_item_id = $1
       AND status = 'active'`,
    [itemId],
  );

  const includeSellerNames = await identityAccountsAvailable(db);
  const listingSql = includeSellerNames
    ? `SELECT
         listing.*,
         account.display_name AS seller_display_name,
         listing.quantity_cap AS visible_quantity
       FROM marketplace_listing_pages AS listing
       LEFT JOIN identity_accounts AS account
         ON account.account_id = listing.account_id
       WHERE listing.catalog_item_id = $1
         AND listing.status = 'active'
       ORDER BY listing.price_amount ASC, listing.updated_at DESC, listing.listing_id ASC`
    : `SELECT
         listing.*,
         NULL::text AS seller_display_name,
         listing.quantity_cap AS visible_quantity
       FROM marketplace_listing_pages AS listing
       WHERE listing.catalog_item_id = $1
         AND listing.status = 'active'
       ORDER BY listing.price_amount ASC, listing.updated_at DESC, listing.listing_id ASC`;

  const listingsResult = await db.query<
    Omit<DiscoveryItemDetailRow["market_listings"][number], "version_selection"> & {
      version_selection: unknown;
    }
  >(listingSql, [itemId]);

  const summaryRow = summaryResult.rows[0];
  const marketSummary =
    summaryRow && summaryRow.active_listing_count > 0
      ? {
          lowest_price_amount: summaryRow.lowest_price_amount,
          active_listing_count: summaryRow.active_listing_count,
          total_visible_quantity: summaryRow.total_visible_quantity,
        }
      : null;

  return {
    ...item,
    market_summary: marketSummary,
    market_listings: listingsResult.rows.map((row) => ({
      ...row,
      version_selection: Array.isArray(row.version_selection)
        ? row.version_selection
        : [],
    })),
  };
}



