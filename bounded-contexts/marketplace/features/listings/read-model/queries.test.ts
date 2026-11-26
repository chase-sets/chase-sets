import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import {
  getInventoryItemSupply,
  getLockedFeeListingCohortSummary,
  getMarketSummaryForItem,
  listDueSellerAvailabilityRestores,
  listItemListings,
  listSellerInventoryItemSupply,
  listSellerListings,
  MARKETPLACE_ITEM_LISTINGS_DEFAULT_PAGE_SIZE,
} from "./queries";

type QueryCall = Readonly<{ sql: string; params: readonly unknown[] }>;

/** Every key a public Listing row may carry. Written out here so the production list cannot vouch for itself. */
const publicListingKeys = [
  "listing_id",
  "account_id",
  "catalog_catalog_item_id",
  "product_id",
  "item_title",
  "item_subtitle",
  "selected_options",
  "product_summary",
  "graded_card",
  "ship_from_code",
  "price_amount",
  "price_currency_code",
  "listing_stream_version",
  "shipping_allowance_percentage_bps",
  "max_units_per_order",
  "max_units_per_day",
  "max_units_per_customer_account",
  "status",
  "seller_display_name",
  "visible_quantity",
  "public_gallery",
] as const;

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
  evidence: [],
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
  acquisition_cost_currency_code: "CAD",
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
      lowest_price_currency_code: null,
      active_listing_count: 1,
      total_visible_quantity: 2,
    });
    expect(calls[0]?.params).toEqual(["cat_air_balloon::form:raw|condition:damaged"]);
    expect(calls[0]?.sql).toContain("listing.listing_stream_version > 0");
    expect(calls[0]?.sql).not.toContain("listing.last_stream_version");
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
    expect(calls[0]?.sql).toContain("listing.listing_stream_version > 0");
    expect(calls[0]?.sql).not.toContain("listing.last_stream_version");
    expect(calls[0]?.sql).toContain("LIMIT $2 OFFSET $3");
    expectCorrelatedActiveHoldLookup(calls);
  });

  it("returns exactly the public keys for a stored row that holds an address, fee amounts, a fingerprint and Fee Locks", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return {
          rows: [
            {
              // A whole stored row, as a reader that selected every column would hold it.
              ...listingPageRow,
              price_currency_code: "USD",
              listing_stream_version: 4,
              fee_locks: [{ lockId: "lock_air_balloon", feeBps: 0 }],
              evidence_requirements: { policyHash: "hash_air_balloon" },
              pause_reason: null,
              inventory_capacity_recovery_block: null,
              seller_display_name: "QA Seller",
              visible_quantity: 2,
            } as Row,
          ],
        };
      },
    };

    const [row] = await listItemListings(db, "cat_air_balloon::form:raw|condition:damaged");

    expect(Object.keys(row ?? {}).sort()).toEqual([...publicListingKeys].sort());
    expect(row).toEqual({
      listing_id: "lst_air_balloon",
      account_id: "acc_seller",
      catalog_catalog_item_id: "cat_air_balloon",
      product_id: "cat_air_balloon::form:raw|condition:damaged",
      item_title: "Air Balloon",
      item_subtitle: null,
      selected_options: [
        { dimensionId: "form", optionId: "raw" },
        { dimensionId: "condition", optionId: "damaged" },
      ],
      product_summary: "Form: Raw | Condition: Damaged",
      graded_card: null,
      ship_from_code: "home",
      price_amount: "21.50",
      price_currency_code: "USD",
      listing_stream_version: 4,
      shipping_allowance_percentage_bps: 0,
      max_units_per_order: null,
      max_units_per_day: null,
      max_units_per_customer_account: null,
      status: "active",
      seller_display_name: "QA Seller",
      visible_quantity: 2,
      public_gallery: [],
    });
    const serialized = JSON.stringify(row);
    for (const privateValue of [
      "200 Market Street",
      "Main bin",
      "2.15",
      "19.35",
      "fee_quote_air_balloon",
      "lock_air_balloon",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("copies a stored grade, option and photo key by key, so a field stored beside them is not returned", async () => {
    const storedAsset = (role: string) => ({
      role,
      width: 480,
      height: 640,
      density: 1,
      mediaType: "image/webp",
      storageKey: `private/key/photo_one/${role}`,
      publicUrl: `https://assets.test/photo_one/${role}.webp`,
      byteSize: 1234,
      generatedAt: "2026-07-10T00:00:00.000Z",
    });
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>() {
        return {
          rows: [
            {
              ...listingPageRow,
              price_currency_code: "USD",
              listing_stream_version: 4,
              seller_display_name: "QA Seller",
              visible_quantity: 2,
              selected_options: [{ dimensionId: "form", optionId: "graded", internalRank: 7 }],
              graded_card: {
                gradingCompany: "PSA",
                grade: "Gem Mint 10",
                certificationNumber: "12345678",
                population: {
                  populationAtGrade: 10,
                  populationHigher: 0,
                  source: "census",
                  asOf: "2026-01-01",
                  fetchedBy: "usr_private",
                },
                conditionDescriptors: ["sharp corners"],
                internalNote: "bought at a show",
              },
              evidence: [
                {
                  photoId: "photo_one",
                  originalFilename: "secret-filename.png",
                  altText: "Front",
                  slotId: "front",
                  viewKind: "front",
                  status: "active",
                  sortOrder: 0,
                  capturedAt: null,
                  uploadedAt: "2026-07-10T00:00:00.000Z",
                  assetSet: {
                    kind: "listing-photo",
                    sourceHash: "hash_private",
                    source: storedAsset("source"),
                    variants: [storedAsset("catalog-detail")],
                  },
                },
              ],
            } as Row,
          ],
        };
      },
    };

    const [row] = await listItemListings(db, "cat_air_balloon::form:raw|condition:damaged");

    expect(row?.selected_options).toEqual([{ dimensionId: "form", optionId: "graded" }]);
    expect(row?.graded_card).toEqual({
      gradingCompany: "PSA",
      grade: "Gem Mint 10",
      certificationNumber: "12345678",
      population: { populationAtGrade: 10, populationHigher: 0, source: "census", asOf: "2026-01-01" },
      conditionDescriptors: ["sharp corners"],
    });
    expect(row?.public_gallery).toEqual([
      {
        photoId: "photo_one",
        slotId: "front",
        viewKind: "front",
        altText: "Front",
        sortOrder: 0,
        assets: [
          {
            role: "catalog-detail",
            publicUrl: "https://assets.test/photo_one/catalog-detail.webp",
            width: 480,
            height: 640,
            density: 1,
          },
        ],
      },
    ]);
    const serialized = JSON.stringify(row);
    for (const privateText of [
      "internalRank",
      "internalNote",
      "fetchedBy",
      "private/key",
      "hash_private",
      "secret-filename",
      "byteSize",
    ]) {
      expect(serialized).not.toContain(privateText);
    }
  });

  it("serves a product's other Listings when one stored option or grade value has the wrong type", async () => {
    const storedRow = (listingId: string, values: Record<string, unknown>) => ({
      ...listingPageRow,
      listing_id: listingId,
      price_currency_code: "USD",
      listing_stream_version: 4,
      seller_display_name: "QA Seller",
      visible_quantity: 2,
      evidence: [],
      ...values,
    });
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>() {
        return {
          rows: [
            storedRow("lst_malformed", {
              selected_options: [
                null,
                { dimensionId: "form", optionId: { internalRank: 7 } },
                { dimensionId: "form", optionId: "graded" },
              ],
              graded_card: {
                gradingCompany: "PSA",
                grade: "Gem Mint 10",
                certificationNumber: 12345678,
                population: { populationAtGrade: "10", populationHigher: 0, source: { fetchedBy: "usr_private" } },
                conditionDescriptors: ["sharp corners", { internalNote: "bought at a show" }],
              },
            }),
            storedRow("lst_no_grade", { graded_card: { gradingCompany: "PSA", grade: { internalNote: "x" } } }),
          ] as Row[],
        };
      },
    };

    const rows = await listItemListings(db, "cat_air_balloon::form:raw|condition:damaged");

    expect(rows.map(({ listing_id }) => listing_id)).toEqual(["lst_malformed", "lst_no_grade"]);
    expect(rows[0]?.selected_options).toEqual([{ dimensionId: "form", optionId: "graded" }]);
    expect(rows[0]?.graded_card).toEqual({
      gradingCompany: "PSA",
      grade: "Gem Mint 10",
      certificationNumber: null,
      population: { populationAtGrade: null, populationHigher: 0, source: null, asOf: null },
      conditionDescriptors: ["sharp corners"],
    });
    expect(rows[1]?.graded_card).toBeNull();
    const serialized = JSON.stringify(rows);
    for (const privateText of ["internalRank", "internalNote", "fetchedBy", "12345678"]) {
      expect(serialized).not.toContain(privateText);
    }
  });

  it("selects exactly the stored columns the public Listing row is built from", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return { rows: [] as Row[] };
      },
    };

    await listItemListings(db, "cat_air_balloon::form:raw|condition:damaged");

    const sql = calls[0]?.sql ?? "";
    const selectList = sql.slice(0, sql.indexOf("FROM marketplace_listing_pages"));
    const selected = [...new Set([...selectList.matchAll(/\blisting\.(\w+)/g)].map((match) => match[1]))].sort();
    expect(selected).toEqual(
      [
        "listing_id",
        "account_id",
        "catalog_catalog_item_id",
        "product_id",
        "item_title",
        "item_subtitle",
        "selected_options",
        "product_summary",
        "graded_card",
        "ship_from_code",
        "price_amount",
        "price_currency_code",
        "listing_stream_version",
        "shipping_allowance_percentage_bps",
        "max_units_per_order",
        "max_units_per_day",
        "max_units_per_customer_account",
        "status",
        // Read to build `public_gallery` and `visible_quantity`; neither is returned as stored.
        "evidence",
        "quantity_cap",
      ].sort(),
    );
  });

  it("selects no private column for a public Listing row", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return { rows: [] as Row[] };
      },
    };

    await listItemListings(db, "cat_air_balloon::form:raw|condition:damaged");

    const sql = calls[0]?.sql ?? "";
    const selectList = sql.slice(0, sql.indexOf("FROM marketplace_listing_pages"));
    expect(selectList).toContain("listing.listing_id");
    // The join to supply reads `listing.inventory_item_id`; the select list must not.
    expect(selectList).not.toContain("inventory_item_id");
    for (const privateColumn of [
      "ship_from_address",
      "storage_location_name",
      "seller_net_unit_amount",
      "marketplace_sales_fee_unit_amount",
      "fee_quote_fingerprint",
      "fee_locks",
      "terms_schedule_id",
      "terms_agreement_id",
      "terms_resolved_at",
      "evidence_requirements",
      "pause_reason",
      "inventory_capacity_recovery_block",
    ]) {
      expect(sql).not.toContain(privateColumn);
    }
    expect(sql).not.toContain("listing.*");
    // The stored evidence is read to build the public gallery and never leaves on the row.
    expect(selectList).toContain("listing.evidence");
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

  it("getLockedFeeListingCohortSummary scopes the platform-wide 0%-locked cohort by agreement + zero fee, not any listing (#4075)", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes("date_trunc('week'")) {
          return {
            rows: [
              { week_start: "2026-06-29", listings_created_count: "3" },
              { week_start: "2026-07-06", listings_created_count: "5" },
            ] as Row[],
          };
        }
        return {
          rows: [{ listings_created_count: "8", locked_seller_account_ids: ["acc_founder_1", "acc_founder_2"] } as Row],
        };
      },
    };

    const result = await getLockedFeeListingCohortSummary(db, { from: "2026-06-25", to: "2026-07-12" });

    expect(result).toEqual({
      listingsCreatedCount: 8,
      lockedSellerAccountIds: ["acc_founder_1", "acc_founder_2"],
      weeklyListingsCreated: [
        { weekStart: "2026-06-29", listingsCreatedCount: 3 },
        { weekStart: "2026-07-06", listingsCreatedCount: 5 },
      ],
    });
    for (const call of calls) {
      expect(call.sql).toContain("terms_agreement_id IS NOT NULL");
      expect(call.sql).toContain("marketplace_sales_fee_unit_amount = 0");
      expect(call.params).toEqual(["2026-06-25", "2026-07-12"]);
    }
  });

  it("getLockedFeeListingCohortSummary returns an honest empty cohort when nothing is locked yet", async () => {
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string) {
        if (sql.includes("date_trunc('week'")) {
          return { rows: [] as Row[] };
        }
        return { rows: [{ listings_created_count: "0", locked_seller_account_ids: [] } as Row] };
      },
    };

    const result = await getLockedFeeListingCohortSummary(db, { from: "2026-06-25", to: "2026-07-12" });

    expect(result).toEqual({ listingsCreatedCount: 0, lockedSellerAccountIds: [], weeklyListingsCreated: [] });
  });

  it("listDueSellerAvailabilityRestores scopes the due-index predicate and clamps the batch limit", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return {
          rows: [
            { account_id: "acc_away_1", available_again_at: "2026-07-13T00:00:00.000Z" },
            { account_id: "acc_away_2", available_again_at: "2026-07-13T06:00:00.000Z" },
          ] as Row[],
        };
      },
    };

    const result = await listDueSellerAvailabilityRestores(db, { now: "2026-07-13T12:00:00.000Z", limit: 10_000 });

    expect(result).toEqual([
      { account_id: "acc_away_1", available_again_at: "2026-07-13T00:00:00.000Z" },
      { account_id: "acc_away_2", available_again_at: "2026-07-13T06:00:00.000Z" },
    ]);
    expect(calls[0]?.sql).toContain("status = 'unavailable'");
    expect(calls[0]?.sql).toContain("available_again_at IS NOT NULL");
    expect(calls[0]?.sql).toContain("available_again_at <= $1::timestamptz");
    expect(calls[0]?.sql).toContain("ORDER BY available_again_at ASC, account_id ASC");
    expect(calls[0]?.sql).toContain("offers_status = 'unavailable' AND offers_available_again_at IS NOT NULL");
    expect(calls[0]?.sql).toContain("offers_available_again_at <= $1::timestamptz");
    expect(calls[0]?.sql).toContain("ORDER BY offers_available_again_at ASC, account_id ASC");
    // Batch limit clamps to the documented ceiling regardless of caller input.
    expect(calls[0]?.params).toEqual(["2026-07-13T12:00:00.000Z", 500]);
  });

  it("listDueSellerAvailabilityRestores defaults to a limit of 100 when unspecified", async () => {
    const calls: QueryCall[] = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return { rows: [] as Row[] };
      },
    };

    await listDueSellerAvailabilityRestores(db, { now: "2026-07-13T12:00:00.000Z" });

    expect(calls[0]?.params).toEqual(["2026-07-13T12:00:00.000Z", 100]);
  });
});
