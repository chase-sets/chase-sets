import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildOrderingMarketplaceSupplyProjectionHandlers } from "./supply-projection";

type ListingInputRow = {
  listing_id: string;
  seller_account_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: string;
  product_summary: string | null;
  product_measure_snapshot: string | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  ship_from_address: string;
  price_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  quantity_cap: number;
  max_units_per_order: number | null;
  max_units_per_day: number | null;
  max_units_per_customer_account: number | null;
  seller_listing_availability_status: string;
  status: string;
  updated_at: string;
};

class ProjectionDb implements PgQueryable {
  public readonly listings = new Map<string, ListingInputRow>();
  public readonly sellerAvailability = new Map<string, string>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO ordering_market_listing_inputs")) {
      const listingId = String(values[0]);
      const existing = this.listings.get(listingId);
      this.listings.set(listingId, {
        listing_id: listingId,
        seller_account_id: String(values[1]),
        inventory_item_id: String(values[2]),
        catalog_catalog_item_id: String(values[3]),
        product_id: String(values[4]),
        item_title: values[5] === null ? null : String(values[5]),
        item_subtitle: values[6] === null ? null : String(values[6]),
        selected_options: String(values[7]),
        product_summary: values[8] === null ? null : String(values[8]),
        product_measure_snapshot: values[9] === null ? null : String(values[9]),
        storage_location_name: values[10] === null ? null : String(values[10]),
        ship_from_code: values[11] === null ? null : String(values[11]),
        ship_from_address: String(values[12]),
        price_amount: String(values[13]),
        marketplace_sales_fee_unit_amount: String(values[14]),
        seller_net_unit_amount: String(values[15]),
        shipping_allowance_percentage_bps: Number(values[16]),
        terms_schedule_id: values[17] === null ? null : String(values[17]),
        terms_agreement_id: values[18] === null ? null : String(values[18]),
        terms_resolved_at: values[19] === null ? null : String(values[19]),
        quantity_cap: Number(values[20]),
        max_units_per_order: values[21] === null ? null : Number(values[21]),
        max_units_per_day: values[22] === null ? null : Number(values[22]),
        max_units_per_customer_account: values[23] === null ? null : Number(values[23]),
        seller_listing_availability_status:
          existing?.seller_listing_availability_status ?? this.sellerAvailability.get(String(values[1])) ?? "available",
        status: "draft",
        updated_at: String(values[24]),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SET status = 'active'")) {
      const row = this.listings.get(String(values[0]));
      if (row) {
        row.status = "active";
        row.marketplace_sales_fee_unit_amount = String(values[1]);
        row.seller_net_unit_amount = String(values[2]);
        row.shipping_allowance_percentage_bps = Number(values[3]);
        row.terms_schedule_id = values[4] === null ? null : String(values[4]);
        row.terms_agreement_id = values[5] === null ? null : String(values[5]);
        row.terms_resolved_at = values[6] === null ? null : String(values[6]);
        row.updated_at = String(values[7]);
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE ordering_market_listing_inputs AS listing")) {
      const catalogItemId = String(values[0]);
      const products = JSON.parse(String(values[1])) as { productId?: unknown }[];
      let affected = 0;
      for (const row of this.listings.values()) {
        if (row.catalog_catalog_item_id !== catalogItemId) {
          continue;
        }
        const measure = products.find((product) => product?.productId === row.product_id) ?? null;
        row.product_measure_snapshot = measure ? JSON.stringify(measure) : null;
        row.updated_at = String(values[2]);
        affected += 1;
      }
      return { rows: [], rowCount: affected };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function event(type: string, streamId: string, data: Record<string, unknown>): TransportEvent {
  return {
    id: "evt_1" as never,
    type,
    streamId: streamId as never,
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
      occurredAt: "2026-05-09T00:00:00.000Z" as never,
      recordedAt: "2026-05-09T00:00:00.000Z" as never,
    },
  };
}

function createdEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return event("marketplace.listing.created", "marketplace.listing-lst_1", {
    listingId: "lst_1",
    accountId: "acc_seller",
    inventoryItemId: "inv_1",
    catalogItemId: "cat_1",
    productId: "prd_1",
    itemTitle: "Charizard",
    itemSubtitle: "Base Set",
    selectedOptions: [],
    productSummary: "Charizard - Base Set",
    productMeasureSnapshot: null,
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
    termsScheduleId: null,
    termsAgreementId: null,
    termsResolvedAt: null,
    quantityCap: 5,
    purchaseLimits: {
      maxUnitsPerOrder: null,
      maxUnitsPerDay: null,
      maxUnitsPerCustomerAccount: null,
    },
    ...overrides,
  });
}

describe("ordering marketplace supply projection", () => {
  it("keeps draft listing inputs when listing terms are not resolved until publish", async () => {
    const db = new ProjectionDb();
    const handlers = buildOrderingMarketplaceSupplyProjectionHandlers(db);

    await handlers["marketplace.listing.created"]!(createdEvent());

    expect(db.listings.get("lst_1")).toMatchObject({
      status: "draft",
      terms_resolved_at: null,
    });

    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", "marketplace.listing-lst_1", {
        marketplaceSalesFeeUnitAmount: "6.00",
        sellerNetUnitAmount: "114.00",
        shippingAllowancePercentageBps: 500,
        termsScheduleId: "terms_standard",
        termsAgreementId: "agreement_1",
        termsResolvedAt: "2026-05-09T00:01:00.000Z",
      }),
    );

    expect(db.listings.get("lst_1")).toMatchObject({
      status: "active",
      terms_schedule_id: "terms_standard",
      terms_agreement_id: "agreement_1",
      terms_resolved_at: "2026-05-09T00:01:00.000Z",
    });
  });

  it("refreshes existing listing inputs from Catalog resolved product measures", async () => {
    const db = new ProjectionDb();
    const handlers = buildOrderingMarketplaceSupplyProjectionHandlers(db);

    await handlers["marketplace.listing.created"]!(createdEvent());
    await handlers["catalog.catalog-item.product-measures-resolved"]!(
      event("catalog.catalog-item.product-measures-resolved", "catalog.product-measures-cat_1", {
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
      product_measure_snapshot: JSON.stringify({
        catalogItemId: "cat_1",
        productId: "prd_1",
        measureVersion: "pm_raw_v1",
      }),
      updated_at: "2026-05-09T00:00:00.000Z",
    });
  });
});
