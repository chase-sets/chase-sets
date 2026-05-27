import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createMarketplaceSlug, rememberSlugRedirect } from "../runtime-support/slugs";

export type DiscoveryRepresentativeMarketStateInput = Readonly<{
  listingIds: readonly string[];
  offerIds: readonly string[];
}>;

export type DiscoveryRepresentativeMarketStateServices = Readonly<{
  discoveryDb: Pick<PgQueryable, "query">;
  marketplaceDb: Pick<PgQueryable, "query">;
}>;

export type DiscoveryRepresentativeMarketStateResult = Readonly<{
  accountCount: number;
  listingCount: number;
  offerCount: number;
}>;

type MarketplaceAccountRow = Readonly<{
  account_id: string;
  display_name: string;
  status: string;
  average_rating: string | null;
  review_count: number;
  rating_1_count: number;
  rating_2_count: number;
  rating_3_count: number;
  rating_4_count: number;
  rating_5_count: number;
  reputation_updated_at: string | Date | null;
  seller_listing_availability_status: "available" | "unavailable";
  seller_listing_availability_reason_category: string | null;
  seller_listing_available_again_on: string | Date | null;
  updated_at: string | Date;
}>;

type MarketplaceListingRow = Readonly<{
  listing_id: string;
  account_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  shipping_allowance_percentage_bps: number;
  quantity_cap: number;
  max_units_per_order: number | null;
  max_units_per_day: number | null;
  max_units_per_customer_account: number | null;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}>;

type MarketplaceOfferRow = Readonly<{
  offer_id: string;
  buyer_account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  price_amount: string;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}>;

export async function reconcileRepresentativeDiscoveryMarketState(
  services: DiscoveryRepresentativeMarketStateServices,
  input: DiscoveryRepresentativeMarketStateInput,
): Promise<DiscoveryRepresentativeMarketStateResult> {
  const listingIds = uniqueTextValues(input.listingIds);
  const offerIds = uniqueTextValues(input.offerIds);
  const [listings, offers] = await Promise.all([
    loadMarketplaceListings(services.marketplaceDb, listingIds),
    loadMarketplaceOffers(services.marketplaceDb, offerIds),
  ]);
  const accountIds = uniqueTextValues([
    ...listings.map((listing) => listing.account_id),
    ...offers.map((offer) => offer.buyer_account_id),
    ...offers.flatMap((offer) => (offer.accepted_seller_account_id ? [offer.accepted_seller_account_id] : [])),
  ]);

  await reconcileAccounts(services, accountIds);
  await reconcileListings(services.discoveryDb, listings);
  await reconcileOffers(services.discoveryDb, offers);

  return {
    accountCount: accountIds.length,
    listingCount: listings.length,
    offerCount: offers.length,
  };
}

function uniqueTextValues(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

async function loadMarketplaceListings(
  db: Pick<PgQueryable, "query">,
  listingIds: readonly string[],
): Promise<readonly MarketplaceListingRow[]> {
  if (listingIds.length === 0) {
    return [];
  }

  const result = await db.query<MarketplaceListingRow>(
    `SELECT
       listing.listing_id,
       listing.account_id,
       listing.inventory_item_id,
       listing.catalog_catalog_item_id,
       listing.product_id,
       listing.item_title,
       listing.item_subtitle,
       listing.selected_options,
       listing.product_summary,
       listing.storage_location_name,
       listing.ship_from_code,
       listing.price_amount::text AS price_amount,
       listing.shipping_allowance_percentage_bps,
       listing.quantity_cap,
       listing.max_units_per_order,
       listing.max_units_per_day,
       listing.max_units_per_customer_account,
       listing.status,
       listing.created_at::text AS created_at,
       listing.updated_at::text AS updated_at
     FROM marketplace_listing_pages AS listing
     WHERE listing.listing_id = ANY($1::text[])
     ORDER BY listing.updated_at DESC, listing.listing_id ASC`,
    [listingIds],
  );

  return result.rows;
}

async function loadMarketplaceOffers(
  db: Pick<PgQueryable, "query">,
  offerIds: readonly string[],
): Promise<readonly MarketplaceOfferRow[]> {
  if (offerIds.length === 0) {
    return [];
  }

  const result = await db.query<MarketplaceOfferRow>(
    `SELECT
       offer.offer_id,
       offer.buyer_account_id,
       offer.catalog_catalog_item_id,
       offer.product_id,
       offer.item_title,
       offer.item_subtitle,
       offer.selected_options,
       offer.product_summary,
       offer.price_amount::text AS price_amount,
       offer.quantity_requested,
       offer.status,
       offer.accepted_seller_account_id,
       offer.accepted_at::text AS accepted_at,
       offer.created_at::text AS created_at,
       offer.updated_at::text AS updated_at
     FROM marketplace_offer_pages AS offer
     WHERE offer.offer_id = ANY($1::text[])
     ORDER BY offer.updated_at DESC, offer.offer_id ASC`,
    [offerIds],
  );

  return result.rows;
}

async function reconcileAccounts(
  services: DiscoveryRepresentativeMarketStateServices,
  accountIds: readonly string[],
): Promise<void> {
  if (accountIds.length === 0) {
    return;
  }

  const marketplaceResult = await services.marketplaceDb.query<MarketplaceAccountRow>(
    `SELECT
       account.account_id,
       account.display_name,
       account.status,
       account.average_rating::text AS average_rating,
       account.review_count,
       account.rating_1_count,
       account.rating_2_count,
       account.rating_3_count,
       account.rating_4_count,
       account.rating_5_count,
       account.reputation_updated_at::text AS reputation_updated_at,
       COALESCE(availability.status, 'available') AS seller_listing_availability_status,
       availability.disabled_reason_category AS seller_listing_availability_reason_category,
       availability.available_again_on::text AS seller_listing_available_again_on,
       GREATEST(account.updated_at, COALESCE(availability.updated_at, account.updated_at))::text AS updated_at
     FROM marketplace_account_pages AS account
     LEFT JOIN marketplace_seller_listing_availability_pages AS availability
       ON availability.account_id = account.account_id
     WHERE account.account_id = ANY($1::text[])`,
    [accountIds],
  );
  const marketplaceAccounts = new Map(marketplaceResult.rows.map((row) => [row.account_id, row]));

  for (const accountId of accountIds) {
    const marketplace = marketplaceAccounts.get(accountId);
    const displayName = marketplace?.display_name ?? accountId;
    const updatedAt = toIsoText(marketplace?.updated_at ?? new Date().toISOString());
    const sellerSlug = createMarketplaceSlug([displayName], accountId);
    const current = await services.discoveryDb.query<{ seller_slug: string | null }>(
      `SELECT seller_slug FROM discovery_market_accounts WHERE account_id = $1`,
      [accountId],
    );

    await services.discoveryDb.query(
      `INSERT INTO discovery_market_accounts (
         account_id,
         seller_slug,
         seller_display_name,
         seller_listing_availability_status,
         seller_listing_availability_reason_category,
         seller_listing_available_again_on,
         status,
         average_rating,
         review_count,
         rating_1_count,
         rating_2_count,
         rating_3_count,
         rating_4_count,
         rating_5_count,
         reputation_updated_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15::timestamptz, $16)
       ON CONFLICT (account_id) DO UPDATE SET
         seller_slug = EXCLUDED.seller_slug,
         seller_display_name = EXCLUDED.seller_display_name,
         seller_listing_availability_status = EXCLUDED.seller_listing_availability_status,
         seller_listing_availability_reason_category = EXCLUDED.seller_listing_availability_reason_category,
         seller_listing_available_again_on = EXCLUDED.seller_listing_available_again_on,
         status = EXCLUDED.status,
         average_rating = EXCLUDED.average_rating,
         review_count = EXCLUDED.review_count,
         rating_1_count = EXCLUDED.rating_1_count,
         rating_2_count = EXCLUDED.rating_2_count,
         rating_3_count = EXCLUDED.rating_3_count,
         rating_4_count = EXCLUDED.rating_4_count,
         rating_5_count = EXCLUDED.rating_5_count,
         reputation_updated_at = EXCLUDED.reputation_updated_at,
         updated_at = EXCLUDED.updated_at`,
      [
        accountId,
        sellerSlug,
        displayName,
        marketplace?.seller_listing_availability_status ?? "available",
        marketplace?.seller_listing_availability_reason_category ?? null,
        toNullableIsoText(marketplace?.seller_listing_available_again_on ?? null),
        marketplace?.status ?? "active",
        marketplace?.average_rating ?? null,
        marketplace?.review_count ?? 0,
        marketplace?.rating_1_count ?? 0,
        marketplace?.rating_2_count ?? 0,
        marketplace?.rating_3_count ?? 0,
        marketplace?.rating_4_count ?? 0,
        marketplace?.rating_5_count ?? 0,
        toNullableIsoText(marketplace?.reputation_updated_at ?? null),
        updatedAt,
      ],
    );
    await rememberSlugRedirect(services.discoveryDb as PgQueryable, {
      entityKind: "account",
      entityId: accountId,
      previousSlug: current.rows[0]?.seller_slug,
      nextSlug: sellerSlug,
      updatedAt,
    });
  }
}

async function reconcileListings(
  db: Pick<PgQueryable, "query">,
  listings: readonly MarketplaceListingRow[],
): Promise<void> {
  for (const listing of listings) {
    const listingSlug = createMarketplaceSlug(
      [listing.item_title, listing.item_subtitle, listing.product_summary],
      listing.listing_id,
    );
    const productSlug = createMarketplaceSlug(
      [listing.item_title, listing.item_subtitle, listing.product_summary],
      listing.product_id,
    );
    const updatedAt = toIsoText(listing.updated_at);
    const current = await db.query<{
      listing_slug: string | null;
      product_slug: string | null;
    }>(
      `SELECT listing_slug, product_slug
       FROM discovery_market_listings
       WHERE listing_id = $1`,
      [listing.listing_id],
    );

    await db.query(
      `INSERT INTO discovery_market_listings (
         listing_id,
         listing_slug,
         product_slug,
         account_id,
         inventory_item_id,
         catalog_catalog_item_id,
         product_id,
         item_title,
         item_subtitle,
         selected_options,
         product_summary,
         storage_location_name,
         ship_from_code,
         price_amount,
         shipping_allowance_percentage_bps,
         quantity_cap,
         max_units_per_order,
         max_units_per_day,
         max_units_per_customer_account,
         status,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
       )
       ON CONFLICT (listing_id) DO UPDATE SET
         listing_slug = EXCLUDED.listing_slug,
         product_slug = EXCLUDED.product_slug,
         account_id = EXCLUDED.account_id,
         inventory_item_id = EXCLUDED.inventory_item_id,
         catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
         product_id = EXCLUDED.product_id,
         item_title = EXCLUDED.item_title,
         item_subtitle = EXCLUDED.item_subtitle,
         selected_options = EXCLUDED.selected_options,
         product_summary = EXCLUDED.product_summary,
         storage_location_name = EXCLUDED.storage_location_name,
         ship_from_code = EXCLUDED.ship_from_code,
         price_amount = EXCLUDED.price_amount,
         shipping_allowance_percentage_bps = EXCLUDED.shipping_allowance_percentage_bps,
         quantity_cap = EXCLUDED.quantity_cap,
         max_units_per_order = EXCLUDED.max_units_per_order,
         max_units_per_day = EXCLUDED.max_units_per_day,
         max_units_per_customer_account = EXCLUDED.max_units_per_customer_account,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      [
        listing.listing_id,
        listingSlug,
        productSlug,
        listing.account_id,
        listing.inventory_item_id,
        listing.catalog_catalog_item_id,
        listing.product_id,
        listing.item_title,
        listing.item_subtitle,
        selectedOptionsJson(listing.selected_options),
        listing.product_summary,
        listing.storage_location_name,
        listing.ship_from_code,
        listing.price_amount,
        listing.shipping_allowance_percentage_bps,
        listing.quantity_cap,
        listing.max_units_per_order,
        listing.max_units_per_day,
        listing.max_units_per_customer_account,
        listing.status,
        toIsoText(listing.created_at),
        updatedAt,
      ],
    );
    await rememberSlugRedirect(db as PgQueryable, {
      entityKind: "listing",
      entityId: listing.listing_id,
      previousSlug: current.rows[0]?.listing_slug,
      nextSlug: listingSlug,
      updatedAt,
    });
    await rememberSlugRedirect(db as PgQueryable, {
      entityKind: "product",
      entityId: listing.product_id,
      previousSlug: current.rows[0]?.product_slug,
      nextSlug: productSlug,
      updatedAt,
    });
  }
}

async function reconcileOffers(db: Pick<PgQueryable, "query">, offers: readonly MarketplaceOfferRow[]): Promise<void> {
  for (const offer of offers) {
    await db.query(
      `INSERT INTO discovery_offer_demand_matches (
         offer_id,
         buyer_account_id,
         catalog_catalog_item_id,
         product_id,
         item_title,
         item_subtitle,
         selected_options,
         product_summary,
         price_amount,
         quantity_requested,
         status,
         accepted_seller_account_id,
         accepted_at,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::timestamptz, $14, $15
       )
       ON CONFLICT (offer_id) DO UPDATE SET
         buyer_account_id = EXCLUDED.buyer_account_id,
         catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
         product_id = EXCLUDED.product_id,
         item_title = EXCLUDED.item_title,
         item_subtitle = EXCLUDED.item_subtitle,
         selected_options = EXCLUDED.selected_options,
         product_summary = EXCLUDED.product_summary,
         price_amount = EXCLUDED.price_amount,
         quantity_requested = EXCLUDED.quantity_requested,
         status = EXCLUDED.status,
         accepted_seller_account_id = EXCLUDED.accepted_seller_account_id,
         accepted_at = EXCLUDED.accepted_at,
         updated_at = EXCLUDED.updated_at`,
      [
        offer.offer_id,
        offer.buyer_account_id,
        offer.catalog_catalog_item_id,
        offer.product_id,
        offer.item_title,
        offer.item_subtitle,
        selectedOptionsJson(offer.selected_options),
        offer.product_summary,
        offer.price_amount,
        offer.quantity_requested,
        offer.status,
        offer.accepted_seller_account_id,
        toNullableIsoText(offer.accepted_at),
        toIsoText(offer.created_at),
        toIsoText(offer.updated_at),
      ],
    );
  }
}

function selectedOptionsJson(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function toIsoText(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIsoText(value: string | Date | null): string | null {
  return value === null ? null : toIsoText(value);
}
