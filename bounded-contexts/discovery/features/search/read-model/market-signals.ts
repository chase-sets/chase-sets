import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buyerVisibleListingPredicateSql,
  buyerVisibleListingQuantitySql,
} from "../../../support/market-support/listing-visibility";

export type SearchIndexMarketSignalTable = "discovery_search_items" | "discovery_search_items_rebuild";

const refreshOneMarketSignalSql: Readonly<Record<SearchIndexMarketSignalTable, string>> = {
  discovery_search_items: `UPDATE discovery_search_items AS item
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
  discovery_search_items_rebuild: `UPDATE discovery_search_items_rebuild AS item
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
};

const refreshAllMarketSignalsSql: Readonly<Record<SearchIndexMarketSignalTable, string>> = {
  discovery_search_items: `UPDATE discovery_search_items AS item
     SET (lowest_price_amount, visible_quantity) = (
       SELECT
         MIN(listing.price_amount::numeric) AS lowest_price_amount,
         SUM(${buyerVisibleListingQuantitySql("listing")})::integer AS visible_quantity
       FROM discovery_market_listings AS listing
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE listing.catalog_catalog_item_id = item.catalog_item_id
         AND ${buyerVisibleListingPredicateSql("listing", "account")}
     )`,
  discovery_search_items_rebuild: `UPDATE discovery_search_items_rebuild AS item
     SET (lowest_price_amount, visible_quantity) = (
       SELECT
         MIN(listing.price_amount::numeric) AS lowest_price_amount,
         SUM(${buyerVisibleListingQuantitySql("listing")})::integer AS visible_quantity
       FROM discovery_market_listings AS listing
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE listing.catalog_catalog_item_id = item.catalog_item_id
         AND ${buyerVisibleListingPredicateSql("listing", "account")}
     )`,
};

export async function refreshSearchIndexMarketSignals(
  db: PgQueryable,
  catalogItemId: string,
  targetTable: SearchIndexMarketSignalTable = "discovery_search_items",
): Promise<void> {
  await db.query(refreshOneMarketSignalSql[targetTable], [catalogItemId]);
}

export async function refreshAllSearchIndexMarketSignals(
  db: PgQueryable,
  targetTable: SearchIndexMarketSignalTable = "discovery_search_items",
): Promise<void> {
  await db.query(refreshAllMarketSignalsSql[targetTable]);
}
