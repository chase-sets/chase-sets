import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import {
  getInventoryItemSupply,
  getMarketSummaryForItem,
  listItemListings,
  listSellerInventoryItemSupply,
  listSellerListings,
  MARKETPLACE_ITEM_LISTINGS_DEFAULT_PAGE_SIZE,
} from "./queries";

type QueryCall = Readonly<{ sql: string; params: readonly unknown[] }>;

function expectCorrelatedActiveHoldLookup(calls: readonly QueryCall[]) {
  for (const call of calls) {
    expect(call.sql).not.toContain("GROUP BY item_id");
    if (call.sql.includes("marketplace_supply_holds")) {
      expect(call.sql).toContain("LEFT JOIN LATERAL");
      expect(call.sql).toContain("supply_hold.item_id = item.item_id");
      expect(call.sql).toContain("supply_hold.status = 'active'");
    }
  }
}

const listingPageRow = {
  listing_id: "lst_air_balloon",
  account_id: "acc_seller",
  inventory_item_id: "item_air_balloon",
  catalog_catalog_item_id: "cat_air_balloon",
  product_id: "cat_air_balloon::form:raw|condition:damaged",
  item_language_code: "en",
  item_title: "Air Balloon",
  item_subtitle: null,
  selected_options: [
    { dimensionId: "form", optionId: "raw" },
    { dimensionId: "condition", optionId: "damaged" },
  ],
  product_summary: "Form: Raw | Condition: Damaged",
  product_measure_snapshot: null,
  graded_card: null,
  storage_location_name: "Main bin",
  ship_from_code: "home",
  ship_from_address: {
    name: "QA Seller",
    line1: "200 Market Street",
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
  },
  price_amount: "21.50",
  marketplace_sales_fee_unit_amount: "2.15",
  seller_net_unit_amount: "19.35",
  shipping_allowance_percentage_bps: 0,
  terms_schedule_id: null,
  terms_agreement_id: null,
  terms_resolved_at: null,
  fee_quote_fingerprint: "fee_quote_air_balloon",
  quantity_cap: 3,
  max_units_per_order: null,
  max_units_per_day: null,
  max_units_per_customer_account: null,
  listing_photos: [],
  status: "active",
  created_at: "2026-06-23T06:08:00.000Z",
  updated_at: "2026-06-23T06:08:00.000Z",
};

const inventoryItemSupplyRow = {
  item_id: "item_air_balloon",
  account_id: "acc_seller",
  catalog_catalog_item_id: "cat_air_balloon",
  product_id: "cat_air_balloon::form:raw|condition:damaged",
  item_language_code: "en",
  item_title: "Air Balloon",
  item_subtitle: null,
  selected_options: listingPageRow.selected_options,
  product_summary: listingPageRow.product_summary,
  product_measure_snapshot: null,
  graded_card: null,
  storage_location_id: "loc_main",
  storage_location_name: "Main bin",
  ship_from_code: "home",
  ship_from_address: listingPageRow.ship_from_address,
  total_quantity: 5,
  available_quantity: 2,
  acquisition_cost_amount: "10.00",
};

describe("marketplace listing read-model queries", () => {
  it("keeps inventory supply availability results while using correlated active hold lookups", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return { rows: [inventoryItemSupplyRow as Row] };
      },
    };

    const result = await getInventoryItemSupply(db, "item_air_balloon", "acc_seller");

    expect(result).toMatchObject({
      item_id: "item_air_balloon",
      available_quantity: 2,
    });
    expect(calls[0]?.params).toEqual(["item_air_balloon", "acc_seller"]);
    expectCorrelatedActiveHoldLookup(calls);
  });

  it("keeps seller inventory list/count results while avoiding whole-table hold aggregates", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: "1" } as Row] };
        }
        return { rows: [inventoryItemSupplyRow as Row] };
      },
    };

    const result = await listSellerInventoryItemSupply(db, {
      accountId: "acc_seller",
      catalogItemId: "cat_air_balloon",
      limit: 25,
      offset: 50,
    });

    expect(result).toMatchObject({
      total: 1,
      items: [{ item_id: "item_air_balloon", available_quantity: 2 }],
    });
    expect(calls.map((call) => call.params)).toEqual([
      ["acc_seller", "cat_air_balloon"],
      ["acc_seller", "cat_air_balloon", 25, 50],
    ]);
    expectCorrelatedActiveHoldLookup(calls);
  });

  it("keeps market summary results while avoiding whole-table hold aggregates", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return {
          rows: [
            {
              lowest_price_amount: "21.50",
              active_listing_count: "1",
              total_visible_quantity: "2",
            } as Row,
          ],
        };
      },
    };

    const result = await getMarketSummaryForItem(db, "cat_air_balloon::form:raw|condition:damaged");

    expect(result).toEqual({
      lowest_price_amount: "21.50",
      active_listing_count: 1,
      total_visible_quantity: 2,
    });
    expect(calls[0]?.params).toEqual(["cat_air_balloon::form:raw|condition:damaged"]);
    expectCorrelatedActiveHoldLookup(calls);
  });

  it("caps item listings with explicit columns and the documented default page size", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return {
          rows: [
            {
              ...listingPageRow,
              seller_display_name: "QA Seller",
              visible_quantity: 2,
            } as Row,
          ],
        };
      },
    };

    const result = await listItemListings(db, "cat_air_balloon::form:raw|condition:damaged");

    expect(result).toMatchObject([
      {
        listing_id: "lst_air_balloon",
        seller_display_name: "QA Seller",
        visible_quantity: 2,
      },
    ]);
    expect(calls[0]?.params).toEqual([
      "cat_air_balloon::form:raw|condition:damaged",
      MARKETPLACE_ITEM_LISTINGS_DEFAULT_PAGE_SIZE,
      0,
    ]);
    expect(calls[0]?.sql).not.toContain("listing.*");
    expect(calls[0]?.sql).toContain("listing.listing_id");
    expect(calls[0]?.sql).toContain("LIMIT $2 OFFSET $3");
    expectCorrelatedActiveHoldLookup(calls);
  });

  it("bounds custom item listing page sizes", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return { rows: [] as Row[] };
      },
    };

    await listItemListings(db, "cat_air_balloon::form:raw|condition:damaged", {
      limit: 1_000,
      offset: -10,
    });

    expect(calls[0]?.params).toEqual(["cat_air_balloon::form:raw|condition:damaged", 100, 0]);
  });

  it("scopes seller listings to account only when no status filter or search is applied", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: "1" } as Row] };
        }
        return { rows: [listingPageRow as Row] };
      },
    };

    await listSellerListings(db, { accountId: "acc_seller" });

    expect(calls[0]?.params).toEqual(["acc_seller"]);
    expect(calls[0]?.sql).not.toContain("status =");
    expect(calls[0]?.sql).not.toContain("ILIKE");
    expect(calls[1]?.params).toEqual(["acc_seller", 50, 0]);
  });

  it("filters seller listings by status and title search", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: "1" } as Row] };
        }
        return { rows: [listingPageRow as Row] };
      },
    };

    await listSellerListings(db, {
      accountId: "acc_seller",
      status: "paused",
      search: "Air",
      limit: 25,
      offset: 0,
    });

    expect(calls[0]?.sql).toContain("status = $2");
    expect(calls[0]?.sql).toContain("item_title ILIKE $3");
    expect(calls[0]?.params).toEqual(["acc_seller", "paused", "%Air%"]);
    expect(calls[1]?.params).toEqual(["acc_seller", "paused", "%Air%", 25, 0]);
  });

  it("ignores an unrecognized status filter value", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: "0" } as Row] };
        }
        return { rows: [] as Row[] };
      },
    };

    await listSellerListings(db, { accountId: "acc_seller", status: "not-a-real-status" });

    expect(calls[0]?.params).toEqual(["acc_seller"]);
    expect(calls[0]?.sql).not.toContain("status =");
  });
});
