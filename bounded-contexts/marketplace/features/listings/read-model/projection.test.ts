import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildMarketplaceListingProjectionHandlers } from "./projection";

type ListingPageRow = {
  listing_id: string;
  account_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  product_measure_snapshot: unknown;
  graded_card: unknown;
  storage_location_name: string | null;
  ship_from_code: string | null;
  ship_from_address: unknown;
  price_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  fee_quote_fingerprint: string;
  fee_locks: unknown;
  quantity_cap: number;
  max_units_per_order: number | null;
  max_units_per_day: number | null;
  max_units_per_customer_account: number | null;
  listing_photos: unknown;
  status: string;
  created_at: string;
  updated_at: string;
};

type SellerListingAvailabilityPageRow = {
  account_id: string;
  status: string;
  disabled_reason_category: string | null;
  available_again_on: string | null;
  available_again_at: string | null;
  disabled_at: string | null;
  enabled_at: string | null;
  away_window_starts_at: string | null;
  away_window_ends_at: string | null;
  away_window_reason_category: string | null;
  updated_at: string;
};

type SellerOrderCapacityPageRow = {
  account_id: string;
  max_open_orders: number | null;
  updated_at: string;
};

class ProjectionDb implements PgQueryable {
  public readonly listings = new Map<string, ListingPageRow>();
  public readonly sellerListingAvailability = new Map<string, SellerListingAvailabilityPageRow>();
  public readonly sellerOrderCapacity = new Map<string, SellerOrderCapacityPageRow>();
  public readonly realtimePayloads: unknown[] = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO marketplace_listing_pages (")) {
      const row = listingPage({
        listing_id: String(values[0]),
        account_id: String(values[1]),
        inventory_item_id: String(values[2]),
        catalog_catalog_item_id: String(values[3]),
        product_id: String(values[4]),
        item_language_code: values[5] === null ? null : String(values[5]),
        item_title: values[6] === null ? null : String(values[6]),
        item_subtitle: values[7] === null ? null : String(values[7]),
        selected_options: JSON.parse(String(values[8])),
        product_summary: values[9] === null ? null : String(values[9]),
        product_measure_snapshot: values[10] === null ? null : JSON.parse(String(values[10])),
        graded_card: values[11] === null ? null : JSON.parse(String(values[11])),
        storage_location_name: values[12] === null ? null : String(values[12]),
        ship_from_code: values[13] === null ? null : String(values[13]),
        ship_from_address: JSON.parse(String(values[14])),
        price_amount: String(values[15]),
        marketplace_sales_fee_unit_amount: String(values[16]),
        seller_net_unit_amount: String(values[17]),
        shipping_allowance_percentage_bps: Number(values[18]),
        terms_schedule_id: values[19] === null ? null : String(values[19]),
        terms_agreement_id: values[20] === null ? null : String(values[20]),
        terms_resolved_at: values[21] === null ? null : String(values[21]),
        fee_quote_fingerprint: String(values[22]),
        fee_locks: JSON.parse(String(values[23])),
        quantity_cap: Number(values[24]),
        max_units_per_order: values[25] === null ? null : Number(values[25]),
        max_units_per_day: values[26] === null ? null : Number(values[26]),
        max_units_per_customer_account: values[27] === null ? null : Number(values[27]),
        listing_photos: JSON.parse(String(values[28])),
        status: "draft",
        created_at: String(values[29]),
        updated_at: String(values[29]),
      });

      this.listings.set(row.listing_id, row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE marketplace_listing_pages AS listing")) {
      const catalogItemId = String(values[0]);
      const products = JSON.parse(String(values[1])) as { productId?: unknown }[];
      const updated: { listing_id: string }[] = [];

      for (const row of this.listings.values()) {
        if (row.catalog_catalog_item_id !== catalogItemId) {
          continue;
        }
        row.product_measure_snapshot = products.find((product) => product?.productId === row.product_id) ?? null;
        row.updated_at = String(values[2]);
        updated.push({ listing_id: row.listing_id });
      }

      return { rows: updated as Row[], rowCount: updated.length };
    }

    if (sql.includes("UPDATE marketplace_listing_pages") && sql.includes("SET status = 'active'")) {
      const row = this.listings.get(String(values[0]));
      if (!row) {
        return { rows: [], rowCount: 0 };
      }

      row.status = "active";
      row.updated_at = String(values[1]);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SELECT * FROM marketplace_listing_pages WHERE listing_id = $1")) {
      const row = this.listings.get(String(values[0]));
      return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("INSERT INTO marketplace_seller_listing_availability_pages (") && sql.includes("'unavailable'")) {
      const row: SellerListingAvailabilityPageRow = {
        account_id: String(values[0]),
        status: "unavailable",
        disabled_reason_category: values[1] === null ? null : String(values[1]),
        available_again_on: values[2] === null ? null : String(values[2]),
        available_again_at: values[3] === null ? null : String(values[3]),
        disabled_at: String(values[4]),
        enabled_at: null,
        // A disable (manual or scheduled) consumes any pending Away Window.
        away_window_starts_at: null,
        away_window_ends_at: null,
        away_window_reason_category: null,
        updated_at: String(values[5]),
      };
      this.sellerListingAvailability.set(row.account_id, row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO marketplace_seller_listing_availability_pages (") && sql.includes("'available'")) {
      const row: SellerListingAvailabilityPageRow = {
        account_id: String(values[0]),
        status: "available",
        disabled_reason_category: null,
        available_again_on: null,
        available_again_at: null,
        disabled_at: null,
        enabled_at: String(values[1]),
        away_window_starts_at: null,
        away_window_ends_at: null,
        away_window_reason_category: null,
        updated_at: String(values[2]),
      };
      this.sellerListingAvailability.set(row.account_id, row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO marketplace_seller_order_capacity_pages (") && sql.includes("VALUES ($1, $2, $3)")) {
      const row: SellerOrderCapacityPageRow = {
        account_id: String(values[0]),
        max_open_orders: Number(values[1]),
        updated_at: String(values[2]),
      };
      this.sellerOrderCapacity.set(row.account_id, row);
      return { rows: [], rowCount: 1 };
    }

    if (
      sql.includes("INSERT INTO marketplace_seller_order_capacity_pages (") &&
      sql.includes("VALUES ($1, NULL, $2)")
    ) {
      const row: SellerOrderCapacityPageRow = {
        account_id: String(values[0]),
        max_open_orders: null,
        updated_at: String(values[1]),
      };
      this.sellerOrderCapacity.set(row.account_id, row);
      return { rows: [], rowCount: 1 };
    }

    // The Away Window scheduled/cancelled handlers issue a partial upsert
    // that only ever touches the away_window_* columns and never mentions
    // a status literal -- distinct from the disable/enable branches above.
    if (
      sql.includes("INSERT INTO marketplace_seller_listing_availability_pages (") &&
      sql.includes("away_window_starts_at") &&
      !sql.includes("'unavailable'") &&
      !sql.includes("'available'")
    ) {
      const accountId = String(values[0]);
      const existing = this.sellerListingAvailability.get(accountId);
      const isCancel = sql.includes("VALUES ($1, NULL, NULL, NULL, $2)");
      const row: SellerListingAvailabilityPageRow = {
        account_id: accountId,
        status: existing?.status ?? "available",
        disabled_reason_category: existing?.disabled_reason_category ?? null,
        available_again_on: existing?.available_again_on ?? null,
        available_again_at: existing?.available_again_at ?? null,
        disabled_at: existing?.disabled_at ?? null,
        enabled_at: existing?.enabled_at ?? null,
        away_window_starts_at: isCancel ? null : values[1] === null ? null : String(values[1]),
        away_window_ends_at: isCancel ? null : values[2] === null ? null : String(values[2]),
        away_window_reason_category: isCancel ? null : values[3] === null ? null : String(values[3]),
        updated_at: String(isCancel ? values[1] : values[4]),
      };
      this.sellerListingAvailability.set(row.account_id, row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO realtime_projection_outbox (")) {
      this.realtimePayloads.push(JSON.parse(String(values[4])));
      return { rows: [{ outbox_id: 1 }] as Row[], rowCount: 1 };
    }

    if (
      sql.includes("SELECT pg_advisory_xact_lock") ||
      sql.includes("realtime_projection_outbox_topics") ||
      sql.includes("realtime_projection_topic_heads") ||
      sql.includes("SELECT pg_notify")
    ) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function listingPage(overrides: Partial<ListingPageRow> = {}): ListingPageRow {
  return {
    listing_id: "lst_1",
    account_id: "acc_seller",
    inventory_item_id: "inv_1",
    catalog_catalog_item_id: "cat_1",
    product_id: "prd_1",
    item_language_code: "en",
    item_title: "Charizard",
    item_subtitle: "Base Set",
    selected_options: [],
    product_summary: "Raw",
    product_measure_snapshot: null,
    graded_card: null,
    storage_location_name: "Vault",
    ship_from_code: "VAULT",
    ship_from_address: {
      name: "Vault",
      line1: "1 Main",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    },
    price_amount: "120.00",
    marketplace_sales_fee_unit_amount: "6.00",
    seller_net_unit_amount: "114.00",
    shipping_allowance_percentage_bps: 500,
    terms_schedule_id: null,
    terms_agreement_id: null,
    terms_resolved_at: null,
    fee_quote_fingerprint: "fee_1",
    fee_locks: [],
    quantity_cap: 1,
    max_units_per_order: null,
    max_units_per_day: null,
    max_units_per_customer_account: null,
    listing_photos: [],
    status: "active",
    created_at: "2026-05-09T00:00:00.000Z",
    updated_at: "2026-05-09T00:00:00.000Z",
    ...overrides,
  };
}

const productMeasureSnapshot = {
  catalogItemId: "cat_1",
  productId: "prd_1",
  selectedOptions: [],
  measureVersion: "pm_test_v1",
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.01,
  unitWeightOunces: 0.1,
  physicalFlags: ["raw-card"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "measured",
} as const;

function listingCreatedData(overrides: Record<string, unknown> = {}) {
  return {
    listingId: "lst_1",
    accountId: "acc_seller",
    inventoryItemId: "inv_1",
    catalogItemId: "cat_1",
    productId: "prd_1",
    itemLanguageCode: "en",
    itemTitle: "Charizard",
    itemSubtitle: "Base Set",
    selectedOptions: [],
    productSummary: "Raw",
    productMeasureSnapshot,
    gradedCard: null,
    storageLocationName: "Vault",
    shipFromCode: "VAULT",
    shipFromAddress: {
      name: "Vault",
      line1: "1 Main",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    },
    priceAmount: "120.00",
    marketplaceSalesFeeUnitAmount: "6.00",
    sellerNetUnitAmount: "114.00",
    shippingAllowancePercentageBps: 500,
    termsScheduleId: "cts_default",
    termsAgreementId: null,
    termsResolvedAt: "2026-05-09T00:00:00.000Z",
    feeQuoteFingerprint: "fee_1",
    feeLocks: [],
    quantityCap: 1,
    purchaseLimits: {
      maxUnitsPerOrder: null,
      maxUnitsPerDay: null,
      maxUnitsPerCustomerAccount: null,
    },
    listingPhotos: [],
    ...overrides,
  };
}

function listingPublishedData() {
  return {};
}

function event(
  type: string,
  data: Record<string, unknown>,
  streamId = "catalog.product-measures-cat_1",
): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_1",
    streamId,
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    timing: { occurredAt: "2026-05-09T00:01:00.000Z", recordedAt: "2026-05-09T00:01:00.000Z" },
  });
}

describe("marketplace listing projection", () => {
  it("creates seller listing pages from listing created events", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["marketplace.listing.created"]!(
      event("marketplace.listing.created", listingCreatedData(), "marketplace.listing-lst_1"),
    );

    expect(db.listings.get("lst_1")).toMatchObject({
      listing_id: "lst_1",
      status: "draft",
      product_measure_snapshot: productMeasureSnapshot,
    });
  });

  it("publishes existing seller listing pages", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["marketplace.listing.created"]!(
      event("marketplace.listing.created", listingCreatedData(), "marketplace.listing-lst_1"),
    );
    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", listingPublishedData(), "marketplace.listing-lst_1"),
    );

    expect(db.listings.get("lst_1")).toMatchObject({
      status: "active",
      marketplace_sales_fee_unit_amount: "6.00",
      seller_net_unit_amount: "114.00",
      fee_quote_fingerprint: "fee_1",
    });
  });

  it("fails listing lifecycle events when the seller listing row is missing", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await expect(
      handlers["marketplace.listing.published"]!(
        event("marketplace.listing.published", listingPublishedData(), "marketplace.listing-missing"),
      ),
    ).rejects.toThrow("Cannot project marketplace.listing.published for missing marketplace listing missing.");
  });

  it("refreshes existing listing product measures from Catalog resolved-measure facts", async () => {
    const db = new ProjectionDb();
    db.listings.set("lst_1", listingPage());
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["catalog.catalog-item.product-measures-resolved"]!(
      event("catalog.catalog-item.product-measures-resolved", {
        catalogItemId: "cat_1",
        products: [
          {
            catalogItemId: "cat_1",
            productId: "prd_1",
            measureVersion: "pm_raw_v1",
          },
        ],
      }),
    );

    expect(db.listings.get("lst_1")).toMatchObject({
      product_measure_snapshot: {
        catalogItemId: "cat_1",
        productId: "prd_1",
        measureVersion: "pm_raw_v1",
      },
      updated_at: "2026-05-09T00:01:00.000Z",
    });
    expect(db.realtimePayloads[0]).toMatchObject({
      kind: "projection.patch",
      context: "marketplace",
      projection: "marketplace-listing-projection",
      topics: ["account:acc_seller:listings"],
      changes: [
        expect.objectContaining({
          op: "upsert",
          entity: "marketplace.sellerListing",
          id: "lst_1",
          value: expect.objectContaining({
            listing_id: "lst_1",
            product_measure_snapshot: {
              catalogItemId: "cat_1",
              productId: "prd_1",
              measureVersion: "pm_raw_v1",
            },
          }),
        }),
      ],
    });
  });

  it("projects the authoritative resume instant onto the seller listing availability page", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["marketplace.seller-listing-availability.disabled"]!(
      event(
        "marketplace.seller-listing-availability.disabled",
        {
          accountId: "acc_seller",
          reasonCategory: "travel",
          availableAgainOn: "2026-07-20",
          availableAgainAt: "2026-07-20T05:00:00.000Z",
          disabledAt: "2026-07-13T12:00:00.000Z",
        },
        "marketplace.seller-listing-availability-acc_seller",
      ),
    );

    expect(db.sellerListingAvailability.get("acc_seller")).toMatchObject({
      account_id: "acc_seller",
      status: "unavailable",
      disabled_reason_category: "travel",
      available_again_on: "2026-07-20",
      available_again_at: "2026-07-20T05:00:00.000Z",
    });
  });

  it("projects legacy disabled events with no availableAgainAt payload key as a null column, existing rows unaffected", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["marketplace.seller-listing-availability.disabled"]!(
      event(
        "marketplace.seller-listing-availability.disabled",
        {
          accountId: "acc_seller",
          reasonCategory: "audit",
          availableAgainOn: "2026-06-01",
          disabledAt: "2026-05-13T12:00:00.000Z",
          // No `availableAgainAt` key -- matches a pre-migration stored event.
        },
        "marketplace.seller-listing-availability-acc_seller",
      ),
    );

    expect(db.sellerListingAvailability.get("acc_seller")).toMatchObject({
      status: "unavailable",
      available_again_on: "2026-06-01",
      available_again_at: null,
    });
  });

  it("clears the resume instant when availability is re-enabled", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["marketplace.seller-listing-availability.disabled"]!(
      event(
        "marketplace.seller-listing-availability.disabled",
        {
          accountId: "acc_seller",
          reasonCategory: "travel",
          availableAgainOn: "2026-07-20",
          availableAgainAt: "2026-07-20T05:00:00.000Z",
          disabledAt: "2026-07-13T12:00:00.000Z",
        },
        "marketplace.seller-listing-availability-acc_seller",
      ),
    );
    await handlers["marketplace.seller-listing-availability.enabled"]!(
      event(
        "marketplace.seller-listing-availability.enabled",
        {
          accountId: "acc_seller",
          enabledAt: "2026-07-14T00:00:00.000Z",
        },
        "marketplace.seller-listing-availability-acc_seller",
      ),
    );

    expect(db.sellerListingAvailability.get("acc_seller")).toMatchObject({
      status: "available",
      available_again_on: null,
      available_again_at: null,
      enabled_at: "2026-07-14T00:00:00.000Z",
    });
  });

  it("projects a seller order capacity cap being set", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["marketplace.seller-order-capacity.set"]!(
      event(
        "marketplace.seller-order-capacity.set",
        { accountId: "acc_seller", maxOpenOrders: 5 },
        "marketplace.seller-order-capacity-acc_seller",
      ),
    );

    expect(db.sellerOrderCapacity.get("acc_seller")).toEqual({
      account_id: "acc_seller",
      max_open_orders: 5,
      updated_at: "2026-05-09T00:01:00.000Z",
    });
  });

  it("projects a changed seller order capacity cap by overwriting the page", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["marketplace.seller-order-capacity.set"]!(
      event(
        "marketplace.seller-order-capacity.set",
        { accountId: "acc_seller", maxOpenOrders: 5 },
        "marketplace.seller-order-capacity-acc_seller",
      ),
    );
    await handlers["marketplace.seller-order-capacity.set"]!(
      event(
        "marketplace.seller-order-capacity.set",
        { accountId: "acc_seller", maxOpenOrders: 8 },
        "marketplace.seller-order-capacity-acc_seller",
      ),
    );

    expect(db.sellerOrderCapacity.get("acc_seller")).toMatchObject({ max_open_orders: 8 });
  });

  it("projects a seller order capacity cap being cleared back to unlimited", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["marketplace.seller-order-capacity.set"]!(
      event(
        "marketplace.seller-order-capacity.set",
        { accountId: "acc_seller", maxOpenOrders: 5 },
        "marketplace.seller-order-capacity-acc_seller",
      ),
    );
    await handlers["marketplace.seller-order-capacity.cleared"]!(
      event(
        "marketplace.seller-order-capacity.cleared",
        { accountId: "acc_seller" },
        "marketplace.seller-order-capacity-acc_seller",
      ),
    );

    expect(db.sellerOrderCapacity.get("acc_seller")).toMatchObject({
      account_id: "acc_seller",
      max_open_orders: null,
    });
  });

  it("projects a scheduled away window onto the seller listing availability page", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["marketplace.seller-listing-availability.away-window-scheduled"]!(
      event(
        "marketplace.seller-listing-availability.away-window-scheduled",
        {
          accountId: "acc_seller",
          startsAt: "2026-07-20T05:00:00.000Z",
          endsAt: "2026-07-27T05:00:00.000Z",
          reasonCategory: "travel",
          scheduledAt: "2026-07-13T12:00:00.000Z",
        },
        "marketplace.seller-listing-availability-acc_seller",
      ),
    );

    expect(db.sellerListingAvailability.get("acc_seller")).toMatchObject({
      account_id: "acc_seller",
      status: "available",
      away_window_starts_at: "2026-07-20T05:00:00.000Z",
      away_window_ends_at: "2026-07-27T05:00:00.000Z",
      away_window_reason_category: "travel",
    });
  });

  it("clears the pending away window when it is cancelled", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["marketplace.seller-listing-availability.away-window-scheduled"]!(
      event(
        "marketplace.seller-listing-availability.away-window-scheduled",
        {
          accountId: "acc_seller",
          startsAt: "2026-07-20T05:00:00.000Z",
          endsAt: "2026-07-27T05:00:00.000Z",
          reasonCategory: "travel",
          scheduledAt: "2026-07-13T12:00:00.000Z",
        },
        "marketplace.seller-listing-availability-acc_seller",
      ),
    );
    await handlers["marketplace.seller-listing-availability.away-window-cancelled"]!(
      event(
        "marketplace.seller-listing-availability.away-window-cancelled",
        {
          accountId: "acc_seller",
          cancelledAt: "2026-07-14T12:00:00.000Z",
        },
        "marketplace.seller-listing-availability-acc_seller",
      ),
    );

    expect(db.sellerListingAvailability.get("acc_seller")).toMatchObject({
      status: "available",
      away_window_starts_at: null,
      away_window_ends_at: null,
      away_window_reason_category: null,
    });
  });

  it("clears the pending away window's columns when the disable that consumes it is projected", async () => {
    const db = new ProjectionDb();
    const handlers = buildMarketplaceListingProjectionHandlers(db);

    await handlers["marketplace.seller-listing-availability.away-window-scheduled"]!(
      event(
        "marketplace.seller-listing-availability.away-window-scheduled",
        {
          accountId: "acc_seller",
          startsAt: "2026-07-20T05:00:00.000Z",
          endsAt: "2026-07-27T05:00:00.000Z",
          reasonCategory: "travel",
          scheduledAt: "2026-07-13T12:00:00.000Z",
        },
        "marketplace.seller-listing-availability-acc_seller",
      ),
    );
    await handlers["marketplace.seller-listing-availability.disabled"]!(
      event(
        "marketplace.seller-listing-availability.disabled",
        {
          accountId: "acc_seller",
          reasonCategory: "travel",
          availableAgainOn: "2026-07-27",
          availableAgainAt: "2026-07-27T05:00:00.000Z",
          disabledAt: "2026-07-20T05:00:00.000Z",
          disabledBy: "scheduled",
        },
        "marketplace.seller-listing-availability-acc_seller",
      ),
    );

    expect(db.sellerListingAvailability.get("acc_seller")).toMatchObject({
      status: "unavailable",
      away_window_starts_at: null,
      away_window_ends_at: null,
      away_window_reason_category: null,
    });
  });
});
