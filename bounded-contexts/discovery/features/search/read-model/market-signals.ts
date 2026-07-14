import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buyerVisibleListingPredicateSql,
  buyerVisibleListingQuantitySql,
} from "../../../support/market-support/listing-visibility";

export async function refreshSearchIndexMarketSignals(db: PgQueryable, catalogItemId: string): Promise<void> {
  await db.query(
    `UPDATE discovery_search_items AS item
     SET lowest_price_amount = market.lowest_price_amount,
         visible_quantity = market.visible_quantity
     FROM (
       SELECT
         MIN(listing.price_amount::numeric) AS lowest_price_amount,
         SUM(${buyerVisibleListingQuantitySql("listing")})::integer AS visible_quantity
       FROM discovery_market_listings AS listing
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE listing.catalog_catalog_item_id = $1
         AND ${buyerVisibleListingPredicateSql("listing", "account")}
     ) AS market
     WHERE item.catalog_item_id = $1`,
    [catalogItemId],
  );
}

export async function refreshAllSearchIndexMarketSignals(db: PgQueryable): Promise<void> {
  await db.query(
    `UPDATE discovery_search_items AS item
     SET lowest_price_amount = market.lowest_price_amount,
         visible_quantity = market.visible_quantity
     FROM (
       SELECT
         listing.catalog_catalog_item_id,
         MIN(listing.price_amount::numeric) AS lowest_price_amount,
         SUM(${buyerVisibleListingQuantitySql("listing")})::integer AS visible_quantity
       FROM discovery_market_listings AS listing
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE ${buyerVisibleListingPredicateSql("listing", "account")}
       GROUP BY listing.catalog_catalog_item_id
     ) AS market
     WHERE item.catalog_item_id = market.catalog_catalog_item_id`,
  );
}
