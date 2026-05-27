import { describe, expect, it } from "vitest";
import { reconcileRepresentativeDiscoveryMarketState } from "../support/market-support/representative-commerce-state";

type QueryCall = readonly [string, readonly unknown[] | undefined];

describe("discovery representative commerce state", () => {
  it("reconciles selected representative marketplace facts without replaying the full projection", async () => {
    const discoveryQueries: QueryCall[] = [];
    const discoveryDb = {
      async query<T>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
        discoveryQueries.push([sql, values]);
        return { rows: [] };
      },
    };
    const marketplaceQueries: QueryCall[] = [];
    const marketplaceDb = {
      async query<T>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
        marketplaceQueries.push([sql, values]);
        if (sql.includes("FROM marketplace_listing_pages")) {
          return {
            rows: [
              {
                listing_id: "lst_repr_1",
                account_id: "acc_seller",
                inventory_item_id: "inv_1",
                catalog_catalog_item_id: "cat_1",
                product_id: "prd_1",
                item_title: "2026 Test Card",
                item_subtitle: "Parallel",
                selected_options: [{ dimensionId: "condition", optionId: "raw" }],
                product_summary: "Condition: Raw",
                storage_location_name: "Listing stock",
                ship_from_code: "US-IL",
                price_amount: "9.99",
                shipping_allowance_percentage_bps: 500,
                quantity_cap: 2,
                max_units_per_order: 1,
                max_units_per_day: null,
                max_units_per_customer_account: 1,
                status: "active",
                created_at: "2026-05-27T00:00:00.000Z",
                updated_at: "2026-05-27T00:00:00.000Z",
              },
            ] as T[],
          };
        }
        if (sql.includes("FROM marketplace_offer_pages")) {
          return {
            rows: [
              {
                offer_id: "off_repr_1",
                buyer_account_id: "acc_buyer",
                catalog_catalog_item_id: "cat_1",
                product_id: "prd_1",
                item_title: "2026 Test Card",
                item_subtitle: "Parallel",
                selected_options: [{ dimensionId: "condition", optionId: "raw" }],
                product_summary: "Condition: Raw",
                price_amount: "7.75",
                quantity_requested: 1,
                status: "accepted",
                accepted_seller_account_id: "acc_seller",
                accepted_at: "2026-05-27T00:05:00.000Z",
                created_at: "2026-05-27T00:00:00.000Z",
                updated_at: "2026-05-27T00:05:00.000Z",
              },
            ] as T[],
          };
        }
        if (sql.includes("FROM marketplace_account_pages")) {
          return {
            rows: [
              marketplaceAccount("acc_seller", "Representative Seller"),
              marketplaceAccount("acc_buyer", "Representative Buyer"),
            ] as T[],
          };
        }
        return { rows: [] };
      },
    };

    const result = await reconcileRepresentativeDiscoveryMarketState(
      { discoveryDb, marketplaceDb },
      { listingIds: ["lst_repr_1", "lst_repr_1"], offerIds: ["off_repr_1"] },
    );

    expect(result).toEqual({ accountCount: 2, listingCount: 1, offerCount: 1 });
    expect(String(marketplaceQueries[0]?.[0])).toContain("FROM marketplace_listing_pages");
    expect(marketplaceQueries[0]?.[1]).toEqual([["lst_repr_1"]]);
    expect(String(marketplaceQueries[1]?.[0])).toContain("FROM marketplace_offer_pages");
    expect(marketplaceQueries[1]?.[1]).toEqual([["off_repr_1"]]);
    expect(discoveryQueries.some(([sql]) => sql.includes("INSERT INTO discovery_market_accounts"))).toBe(true);
    expect(discoveryQueries.some(([sql]) => sql.includes("INSERT INTO discovery_market_listings"))).toBe(true);
    expect(discoveryQueries.some(([sql]) => sql.includes("INSERT INTO discovery_offer_demand_matches"))).toBe(true);
  });
});

function marketplaceAccount(accountId: string, displayName: string) {
  return {
    account_id: accountId,
    display_name: displayName,
    status: "active",
    average_rating: "4.80",
    review_count: 5,
    rating_1_count: 0,
    rating_2_count: 0,
    rating_3_count: 0,
    rating_4_count: 1,
    rating_5_count: 4,
    reputation_updated_at: "2026-05-27T00:00:00.000Z",
    seller_listing_availability_status: "available",
    seller_listing_availability_reason_category: null,
    seller_listing_available_again_on: null,
    updated_at: "2026-05-27T00:00:00.000Z",
  };
}
