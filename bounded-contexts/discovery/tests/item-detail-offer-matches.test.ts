import { describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildDiscoveryMarketProjectionHandlers } from "../support/market-support/projection";
import {
  getDiscoveryItemDetail,
  getDiscoveryItemDetailSellerOverlay,
} from "../features/item-detail/read-model/queries";

function createEvent(type: string, data: Record<string, unknown>, recordedAt: string) {
  return buildTransportEvent(type, data, {
    streamId: "marketplace.offer-offer_charizard",
    streamVersion: 1,
    globalPosition: "1",
    timing: { occurredAt: recordedAt, recordedAt },
  });
}

describe("item detail offer matches", () => {
  it("projects public review feedback comments for account feedback pages", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    } satisfies PgQueryable;
    const handlers = buildDiscoveryMarketProjectionHandlers(db);

    await handlers["marketplace.review.submitted"]?.(
      createEvent(
        "marketplace.review.submitted",
        {
          reviewId: "rev_1",
          orderId: "ord_1",
          authorAccountId: "acc_buyer",
          subjectAccountId: "acc_seller",
          authorRole: "buyer",
          rating: 5,
          feedback: "Packed well and shipped quickly.",
          submittedAt: "2026-05-12T00:00:00.000Z",
        },
        "2026-05-12T00:00:00.000Z",
      ),
    );

    expect(calls[0].sql).toContain("feedback");
    expect(calls[0].params).toEqual([
      "rev_1",
      "ord_1",
      "acc_buyer",
      "acc_seller",
      "buyer",
      5,
      "Packed well and shipped quickly.",
      "2026-05-12T00:00:00.000Z",
      "included",
      "normal-completion",
      "resolution-aware-v1",
      "[]",
      null,
    ]);
  });

  it("removes held reviews from public reputation and restores them after release", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return {
          rows: sql.includes("UPDATE discovery_market_account_reviews") ? [{ subject_account_id: "acc_seller" }] : [],
        };
      },
    } satisfies PgQueryable;
    const handlers = buildDiscoveryMarketProjectionHandlers(db);

    await handlers["marketplace.review-hold.placed"]?.(
      createEvent(
        "marketplace.review-hold.placed",
        {
          orderId: "ord_1",
          heldDirections: ["buyer-to-seller", "seller-to-buyer"],
          lifecycleAt: "2026-05-13T00:00:00.000Z",
        },
        "2026-05-13T00:00:00.000Z",
      ),
    );
    await handlers["marketplace.review-hold.released"]?.(
      createEvent(
        "marketplace.review-hold.released",
        {
          orderId: "ord_1",
          heldDirections: [],
          lifecycleAt: "2026-05-14T00:00:00.000Z",
        },
        "2026-05-14T00:00:00.000Z",
      ),
    );

    const holdUpdates = calls.filter(({ sql }) => sql.includes("UPDATE discovery_market_account_reviews"));
    expect(holdUpdates.map(({ params }) => params)).toEqual([
      ["ord_1", ["buyer-to-seller", "seller-to-buyer"], "2026-05-13T00:00:00.000Z"],
      ["ord_1", [], "2026-05-14T00:00:00.000Z"],
    ]);
    const reputationRefreshes = calls.filter(({ sql }) => sql.includes("INSERT INTO discovery_market_accounts"));
    expect(reputationRefreshes).toHaveLength(2);
    expect(reputationRefreshes.every(({ sql }) => sql.includes("AND held = false"))).toBe(true);
  });

  it("projects submitted and accepted offers into the public discovery market table", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    } satisfies PgQueryable;
    const handlers = buildDiscoveryMarketProjectionHandlers(db);

    await handlers["marketplace.offer.submitted"]?.(
      createEvent(
        "marketplace.offer.submitted",
        {
          offerId: "offer_charizard",
          buyerAccountId: "buyer_1",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::raw",
          itemTitle: "Charizard",
          itemSubtitle: "Base Set",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Raw",
          priceAmount: "350.00",
          quantityRequested: 1,
        },
        "2026-04-28T00:00:00.000Z",
      ),
    );
    await handlers["marketplace.offer.accepted"]?.(
      createEvent(
        "marketplace.offer.accepted",
        {
          offerId: "offer_charizard",
          sellerAccountId: "seller_1",
          acceptedAt: "2026-04-28T01:00:00.000Z",
        },
        "2026-04-28T01:00:00.000Z",
      ),
    );

    expect(calls[0].sql).toContain("INSERT INTO discovery_offer_demand_matches");
    expect(calls[0].params).toEqual([
      "offer_charizard",
      "buyer_1",
      "cat_charizard",
      "cat_charizard::raw",
      "Charizard",
      "Base Set",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
      "Raw",
      "350.00",
      1,
      "submitted",
      null,
      null,
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:00.000Z",
    ]);
    const acceptedOfferUpdate = calls.find(
      (call) => call.sql.includes("UPDATE discovery_offer_demand_matches") && call.sql.includes("accepted_at"),
    );
    expect(acceptedOfferUpdate?.params).toEqual([
      "accepted",
      "seller_1",
      "2026-04-28T01:00:00.000Z",
      "2026-04-28T01:00:00.000Z",
      "offer_charizard",
    ]);
  });

  it("projects checkout-start availability evidence into public market listings", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    } satisfies PgQueryable;
    const handlers = buildDiscoveryMarketProjectionHandlers(db);

    await handlers["catalog.catalog-item.product-measures-resolved"]?.(
      createEvent(
        "catalog.catalog-item.product-measures-resolved",
        {
          catalogItemId: "cat_charizard",
          products: [{ productId: "cat_charizard::raw", weightOz: 4 }],
        },
        "2026-04-28T00:00:00.000Z",
      ),
    );
    await handlers["inventory.item.created"]?.({
      ...createEvent(
        "inventory.item.created",
        { itemId: "itm_charizard", totalQuantity: 3 },
        "2026-04-28T00:01:00.000Z",
      ),
      streamId: "inventory.item-itm_charizard",
    });

    expect(calls[0].sql).toContain("DELETE FROM discovery_market_product_measures");
    expect(calls[1].sql).toContain("INSERT INTO discovery_market_product_measures");
    expect(calls[2].sql).toContain("UPDATE discovery_market_listings AS listing");
    expect(calls[2].sql).toContain("product_measure_snapshot");
    expect(calls[3].sql).toContain("INSERT INTO discovery_market_supply_items");
    expect(calls[4].sql).toContain("UPDATE discovery_market_listings AS listing");
    expect(calls[4].sql).toContain("supply_total_quantity = supply.total_quantity");
    expect(calls[4].sql).toContain("active_held_quantity = COALESCE(holds.held_quantity, 0)");
  });

  it("projects seller overlay support rows from Inventory and Checkout events", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    } satisfies PgQueryable;
    const handlers = buildDiscoveryMarketProjectionHandlers(db);

    await handlers["inventory.storage-location.created"]?.(
      createEvent(
        "inventory.storage-location.created",
        {
          storageLocationId: "stl_listing",
          accountId: "acc_seller",
          name: "Listing stock",
          shipFromCode: "LISTING-STOCK",
          shipFromAddress: { country: "US" },
        },
        "2026-04-28T00:00:00.000Z",
      ),
    );
    await handlers["checkout.sell-list.line-added"]?.({
      ...createEvent(
        "checkout.sell-list.line-added",
        {
          sellerAccountId: "acc_seller",
          lineId: "sll_offer",
          lineType: "selected-offer",
          offerId: "offer_charizard",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::raw",
          quantity: 1,
        },
        "2026-04-28T00:01:00.000Z",
      ),
      streamId: "checkout.sell-list-acc_seller",
    });

    expect(calls[0].sql).toContain("INSERT INTO discovery_market_supply_locations");
    expect(calls[0].params).toEqual([
      "stl_listing",
      "acc_seller",
      "Listing stock",
      "LISTING-STOCK",
      JSON.stringify({ country: "US" }),
      "2026-04-28T00:00:00.000Z",
    ]);
    expect(calls[1].sql).toContain("INSERT INTO discovery_item_detail_sell_list_lines");
    expect(calls[1].params).toEqual([
      "acc_seller",
      "sll_offer",
      "selected-offer",
      "offer_charizard",
      "cat_charizard",
      "cat_charizard::raw",
      1,
      "2026-04-28T00:01:00.000Z",
    ]);
  });

  it("returns seller item-detail overlays from Discovery-owned local projections", async () => {
    const queries: string[] = [];
    const db = {
      query: async (sql: string) => {
        queries.push(sql);

        if (sql.includes("WITH seller_listing")) {
          return {
            rows: [
              {
                offer_id: "offer_charizard",
                buyer_account_id: "buyer_1",
                buyer_display_name: "Ash Ketchum",
                catalog_catalog_item_id: "cat_charizard",
                product_id: "cat_charizard::raw",
                item_title: "Charizard",
                item_subtitle: "Base Set",
                selected_options: [{ dimensionId: "form", optionId: "raw" }],
                product_summary: "Raw",
                price_amount: "350.00",
                quantity_requested: 1,
                status: "submitted",
                accepted_seller_account_id: null,
                accepted_at: null,
                buyer_slug: "ash-ketchum",
                buyer_average_rating: null,
                buyer_review_count: 0,
                seller_available_quantity: 2,
                can_fulfill: true,
                in_sell_list: true,
                created_at: "2026-04-28T00:00:00.000Z",
                updated_at: "2026-04-28T00:00:00.000Z",
              },
            ],
          };
        }

        if (sql.includes("FROM discovery_market_supply_items AS supply")) {
          return {
            rows: [
              {
                item_id: "itm_charizard",
                catalog_catalog_item_id: "cat_charizard",
                product_id: "cat_charizard::raw",
                item_title: "Charizard",
                item_subtitle: "Base Set",
                selected_options: [{ dimensionId: "form", optionId: "raw" }],
                product_summary: "Raw",
                storage_location_name: "Listing stock",
                ship_from_code: "LISTING-STOCK",
                available_quantity: 2,
              },
            ],
          };
        }

        if (sql.includes("SELECT EXISTS")) {
          return { rows: [{ exists: true }] };
        }

        if (sql.includes("WHERE listing.listing_id = $1")) {
          return {
            rows: [
              {
                listing_id: "lst_charizard",
                listing_slug: "charizard-lst",
                product_slug: "charizard-raw",
                account_id: "acc_seller",
                inventory_item_id: "itm_charizard",
                catalog_catalog_item_id: "cat_charizard",
                catalog_item_slug: "charizard-base-set",
                product_id: "cat_charizard::raw",
                item_title: "Charizard",
                item_subtitle: "Base Set",
                selected_options: [{ dimensionId: "form", optionId: "raw" }],
                product_summary: "Raw",
                storage_location_name: "Listing stock",
                ship_from_code: "LISTING-STOCK",
                price_amount: "380.00",
                shipping_allowance_percentage_bps: 500,
                quantity_cap: 2,
                max_units_per_order: null,
                max_units_per_day: null,
                max_units_per_customer_account: null,
                status: "draft",
                seller_slug: "fresh-seller",
                seller_display_name: "Fresh Seller",
                seller_listing_availability_status: "available",
                seller_listing_availability_reason_category: null,
                seller_listing_available_again_on: null,
                seller_average_rating: null,
                seller_review_count: 0,
                visible_quantity: 2,
                created_at: "2026-04-28T00:00:00.000Z",
                updated_at: "2026-04-28T00:00:00.000Z",
              },
            ],
          };
        }

        return { rows: [] };
      },
    } satisfies PgQueryable;

    const overlay = await getDiscoveryItemDetailSellerOverlay(db, {
      accountId: "acc_seller",
      catalogItemId: "cat_charizard",
      selectedListingId: "lst_charizard",
    });

    expect(overlay.accountOfferMatches).toEqual([
      expect.objectContaining({
        offer_id: "offer_charizard",
        in_sell_list: true,
        can_fulfill: true,
        acceptance_terms: null,
      }),
    ]);
    expect(overlay.sellerInventoryItems).toEqual([
      expect.objectContaining({
        item_id: "itm_charizard",
        storage_location_name: "Listing stock",
        available_quantity: 2,
      }),
    ]);
    expect(overlay.hasListingStockLocation).toBe(true);
    expect(overlay.selectedSellerListing).toEqual(expect.objectContaining({ listing_id: "lst_charizard" }));
    expect(queries.join("\n")).toContain("discovery_item_detail_sell_list_lines");
    expect(queries.join("\n")).toContain("discovery_market_supply_locations");
  });

  it("returns submitted public offer demand on item detail payloads", async () => {
    const offerQueries: string[] = [];
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM discovery_item_detail_pages")) {
          return {
            rows: [
              {
                catalog_item_id: "cat_charizard",
                title: "Charizard",
                subtitle: "Base Set",
                description: "Classic card",
                blueprint_id: null,
                blueprint: null,
                status: "active",
                field_values: [],
                categories: [],
                tags: [],
                image_urls: [],
                product_asset_sets: [],
                image_fallback: null,
                product_schema: null,
                updated_at: "2026-04-28T00:00:00.000Z",
              },
            ],
          };
        }

        if (sql.includes("MIN(price_amount::numeric)::text")) {
          return {
            rows: [
              {
                lowest_price_amount: null,
                active_listing_count: 0,
                total_visible_quantity: 0,
              },
            ],
          };
        }

        if (sql.includes("FROM discovery_market_listings")) {
          return { rows: [] };
        }

        if (sql.includes("FROM discovery_offer_demand_matches")) {
          offerQueries.push(sql);
          return {
            rows: [
              {
                offer_id: "offer_charizard",
                buyer_account_id: "buyer_1",
                buyer_display_name: "Ash Ketchum",
                catalog_catalog_item_id: "cat_charizard",
                product_id: "cat_charizard::raw",
                item_title: "Charizard",
                item_subtitle: "Base Set",
                selected_options: [{ dimensionId: "form", optionId: "raw" }],
                product_summary: "Raw",
                price_amount: "350.00",
                quantity_requested: 1,
                status: "submitted",
                accepted_seller_account_id: null,
                accepted_at: null,
                created_at: "2026-04-28T00:00:00.000Z",
                updated_at: "2026-04-28T00:00:00.000Z",
              },
            ],
          };
        }

        return { rows: [] };
      },
    } satisfies PgQueryable;

    const item = await getDiscoveryItemDetail(db, "cat_charizard");

    expect(item?.offer_demand_matches).toEqual([
      expect.objectContaining({
        offer_id: "offer_charizard",
        buyer_display_name: "Ash Ketchum",
        status: "submitted",
        accepted_seller_account_id: null,
      }),
    ]);
    expect(offerQueries[0]).toContain("offer.status = 'submitted'");
    expect(offerQueries[0]).not.toContain("offer.status IN ('submitted', 'accepted')");
    expect(offerQueries[0]).toContain("offer.offer_id");
    expect(offerQueries[0]).not.toContain("offer.*");
    expect(offerQueries[0]).toContain("LIMIT 25");
  });

  it("summarizes only checkout-startable listings on item detail payloads", async () => {
    const marketQueries: string[] = [];
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM discovery_item_detail_pages")) {
          return {
            rows: [
              {
                catalog_item_id: "cat_charizard",
                title: "Charizard",
                subtitle: "Base Set",
                description: "Classic card",
                blueprint_id: null,
                blueprint: null,
                status: "active",
                field_values: [],
                categories: [],
                tags: [],
                image_urls: [],
                product_asset_sets: [],
                image_fallback: null,
                product_schema: null,
                updated_at: "2026-04-28T00:00:00.000Z",
              },
            ],
          };
        }

        if (sql.includes("FROM discovery_market_listings")) {
          marketQueries.push(sql);
          if (sql.includes("MIN(price_amount::numeric)::text")) {
            return {
              rows: [
                {
                  lowest_price_amount: "380.00",
                  active_listing_count: 1,
                  total_visible_quantity: 2,
                },
              ],
            };
          }

          return {
            rows: [
              {
                listing_id: "lst_ready",
                listing_slug: "charizard-lst_ready",
                product_slug: "charizard-product",
                account_id: "acc_seller",
                inventory_item_id: "itm_1",
                catalog_catalog_item_id: "cat_charizard",
                product_id: "cat_charizard::raw",
                item_title: "Charizard",
                item_subtitle: "Base Set",
                selected_options: [{ dimensionId: "form", optionId: "raw" }],
                product_summary: "Raw",
                product_measure_snapshot: { productId: "cat_charizard::raw", weightOz: 4 },
                storage_location_name: "Vault",
                ship_from_code: "STL",
                price_amount: "380.00",
                shipping_allowance_percentage_bps: 500,
                quantity_cap: 3,
                max_units_per_order: null,
                max_units_per_day: null,
                max_units_per_customer_account: null,
                supply_total_quantity: 3,
                active_held_quantity: 1,
                status: "active",
                seller_slug: "fresh-seller",
                seller_display_name: "Fresh Seller",
                seller_average_rating: null,
                seller_review_count: 0,
                visible_quantity: 2,
                created_at: "2026-04-28T00:00:00.000Z",
                updated_at: "2026-04-28T00:00:00.000Z",
              },
            ],
          };
        }

        if (sql.includes("FROM discovery_offer_demand_matches")) {
          return { rows: [] };
        }

        return { rows: [] };
      },
    } satisfies PgQueryable;

    const item = await getDiscoveryItemDetail(db, "cat_charizard");

    expect(item?.market_summary).toEqual({
      lowest_price_amount: "380.00",
      active_listing_count: 1,
      total_visible_quantity: 2,
    });
    expect(item?.market_listings).toEqual([
      expect.objectContaining({
        listing_id: "lst_ready",
        visible_quantity: 2,
      }),
    ]);
    expect(JSON.stringify(item?.market_listings)).not.toContain("product_measure_snapshot");
    expect(marketQueries[0]).toContain("listing.product_measure_snapshot IS NOT NULL");
    expect(marketQueries[0]).toContain("COALESCE(listing.supply_total_quantity, listing.quantity_cap)");
    expect(marketQueries[0]).toContain("COALESCE(listing.active_held_quantity, 0)");
    expect(marketQueries[1]).toContain("listing.product_measure_snapshot IS NOT NULL");
    expect(marketQueries[1]).toContain("WHERE visible_quantity > 0");
    expect(marketQueries[1]).toContain("listing.listing_id");
    expect(marketQueries[1]).not.toContain("listing.*");
    expect(marketQueries[1]).not.toContain("SELECT *");
    expect(marketQueries[1]).toContain("LIMIT 25");
  });
});
