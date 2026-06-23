import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
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
  quantity_cap: number;
  max_units_per_order: number | null;
  max_units_per_day: number | null;
  max_units_per_customer_account: number | null;
  listing_photos: unknown;
  status: string;
  created_at: string;
  updated_at: string;
};

class ProjectionDb implements PgQueryable {
  public readonly listings = new Map<string, ListingPageRow>();
  public readonly realtimePayloads: unknown[] = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
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

    if (sql.includes("SELECT * FROM marketplace_listing_pages WHERE listing_id = $1")) {
      const row = this.listings.get(String(values[0]));
      return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("INSERT INTO realtime_projection_outbox (")) {
      this.realtimePayloads.push(JSON.parse(String(values[4])));
      return { rows: [{ outbox_id: 1 }] as Row[], rowCount: 1 };
    }

    if (
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

function event(type: string, data: Record<string, unknown>): TransportEvent {
  return {
    id: "evt_1" as never,
    type,
    streamId: "catalog.product-measures-cat_1" as never,
    streamVersion: 1 as never,
    globalPosition: 1 as never,
    tenantId: "tnt_1" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_1" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-05-09T00:01:00.000Z" as never,
      recordedAt: "2026-05-09T00:01:00.000Z" as never,
    },
  };
}

describe("marketplace listing projection", () => {
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
});
