import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildCheckoutMarketplaceSellerOptionsProjectionHandlers } from "./marketplace-projection";

type SellerOptionRow = {
  listing_id: string;
  seller_account_id: string;
  product_id: string;
  catalog_catalog_item_id: string;
  price_amount: string;
  listing_quantity_cap: number;
  product_summary: string | null;
  product_measure_snapshot: string | null;
  status: string;
  updated_at: string;
  inventory_item_id: string | null;
};

/**
 * In-memory fake `PgQueryable` that interprets the projection's SQL by
 * statement shape. Mirrors the catalog projection unit test pattern.
 */
class ProjectionDb implements PgQueryable {
  public readonly options = new Map<string, SellerOptionRow>();
  public readonly recomputedInventoryItemIds: string[] = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO checkout_marketplace_seller_options")) {
      const listingId = String(values[0]);
      const existing = this.options.get(listingId);
      this.options.set(listingId, {
        listing_id: listingId,
        seller_account_id: String(values[1]),
        product_id: String(values[2]),
        catalog_catalog_item_id: String(values[3]),
        price_amount: String(values[4]),
        listing_quantity_cap: Number(values[5]),
        product_summary: values[6] === null ? null : String(values[6]),
        product_measure_snapshot: values[7] === null ? null : String(values[7]),
        status: existing?.status ?? "draft",
        updated_at: String(values[8]),
        inventory_item_id: values[9] === null ? null : String(values[9]),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SET price_amount = $2")) {
      const row = this.options.get(String(values[0]));
      if (row) {
        row.price_amount = String(values[1]);
        row.updated_at = String(values[2]);
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("SET listing_quantity_cap = $2")) {
      const row = this.options.get(String(values[0]));
      if (row) {
        row.listing_quantity_cap = Number(values[1]);
        row.updated_at = String(values[2]);
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("SET status = 'active'") && sql.includes("WHERE listing_id = $1")) {
      return this.setStatusByListing(String(values[0]), "active", String(values[1]), true);
    }

    if (sql.includes("SET status = 'paused'")) {
      return this.setStatusByListing(String(values[0]), "paused", String(values[1]));
    }

    if (sql.includes("SET status = 'withdrawn'")) {
      return this.setStatusByListing(String(values[0]), "withdrawn", String(values[1]));
    }

    if (sql.includes("SET status = 'seller-unavailable'") && sql.includes("AND status = 'active'")) {
      return this.flipSellerStatus(String(values[0]), "active", "seller-unavailable", String(values[1]));
    }

    if (sql.includes("SET status = 'active'") && sql.includes("AND status = 'seller-unavailable'")) {
      return this.flipSellerStatus(String(values[0]), "seller-unavailable", "active", String(values[1]));
    }

    if (sql.includes("UPDATE checkout_marketplace_seller_options AS option")) {
      const catalogItemId = String(values[0]);
      const products = JSON.parse(String(values[1])) as { productId?: unknown }[];
      let affected = 0;
      for (const row of this.options.values()) {
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

    // Supply-counter backfill recompute issued by listing.created. No inventory
    // supply is projected in this marketplace-only test, so it affects no rows.
    if (
      sql.includes("UPDATE checkout_marketplace_seller_options AS o") &&
      sql.includes("supply_total_quantity = supply.total_quantity")
    ) {
      this.recomputedInventoryItemIds.push(String(values[0]));
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }

  private setStatusByListing<Row>(
    listingId: string,
    status: string,
    updatedAt: string,
    returnInventoryItem = false,
  ): PgQueryResult<Row> {
    const row = this.options.get(listingId);
    if (row) {
      row.status = status;
      row.updated_at = updatedAt;
    }
    return {
      rows: row && returnInventoryItem ? ([{ inventory_item_id: row.inventory_item_id }] as Row[]) : [],
      rowCount: row ? 1 : 0,
    };
  }

  private flipSellerStatus<Row>(
    accountId: string,
    fromStatus: string,
    toStatus: string,
    updatedAt: string,
  ): PgQueryResult<Row> {
    let affected = 0;
    for (const row of this.options.values()) {
      if (row.seller_account_id === accountId && row.status === fromStatus) {
        row.status = toStatus;
        row.updated_at = updatedAt;
        affected += 1;
      }
    }
    return { rows: [], rowCount: affected };
  }
}

function event(type: string, streamId: string, data: Record<string, unknown>): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_1",
    streamId,
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    timing: { occurredAt: "2026-05-09T00:00:00.000Z", recordedAt: "2026-05-09T00:00:00.000Z" },
  });
}

function createdEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return event("marketplace.listing.created", "marketplace.listing-lst_1", {
    listingId: "lst_1",
    accountId: "acc_seller",
    inventoryItemId: "inv_1",
    catalogItemId: "cat_1",
    productId: "prd_1",
    productSummary: "Charizard — Base Set",
    productMeasureSnapshot: {
      catalogItemId: "cat_1",
      productId: "prd_1",
      measureVersion: "pm_raw_v1",
    },
    priceAmount: "120.00",
    quantityCap: 5,
    ...overrides,
  });
}

describe("checkout marketplace seller-options projection", () => {
  it("inserts a draft seller option on listing created", async () => {
    const db = new ProjectionDb();
    const handlers = buildCheckoutMarketplaceSellerOptionsProjectionHandlers(db);

    await handlers["marketplace.listing.created"]!(createdEvent());

    expect(db.options.get("lst_1")).toMatchObject({
      listing_id: "lst_1",
      seller_account_id: "acc_seller",
      product_id: "prd_1",
      catalog_catalog_item_id: "cat_1",
      price_amount: "120.00",
      listing_quantity_cap: 5,
      product_summary: "Charizard — Base Set",
      product_measure_snapshot: JSON.stringify({
        catalogItemId: "cat_1",
        productId: "prd_1",
        measureVersion: "pm_raw_v1",
      }),
      status: "draft",
      inventory_item_id: "inv_1",
    });
  });

  it("updates existing seller options from resolved catalog product measures", async () => {
    const db = new ProjectionDb();
    const handlers = buildCheckoutMarketplaceSellerOptionsProjectionHandlers(db);

    await handlers["marketplace.listing.created"]!(createdEvent({ productMeasureSnapshot: null }));
    await handlers["catalog.catalog-item.product-measures-resolved"]!(
      event("catalog.catalog-item.product-measures-resolved", "catalog.product-measures-cat_1", {
        catalogItemId: "cat_1",
        products: [
          {
            catalogItemId: "cat_1",
            productId: "prd_1",
            measureVersion: "pm_raw_v2",
          },
        ],
      }),
    );

    expect(db.options.get("lst_1")).toMatchObject({
      product_measure_snapshot: JSON.stringify({
        catalogItemId: "cat_1",
        productId: "prd_1",
        measureVersion: "pm_raw_v2",
      }),
      updated_at: "2026-05-09T00:00:00.000Z",
    });
  });

  it("updates price on price-updated", async () => {
    const db = new ProjectionDb();
    const handlers = buildCheckoutMarketplaceSellerOptionsProjectionHandlers(db);

    await handlers["marketplace.listing.created"]!(createdEvent());
    await handlers["marketplace.listing.price-updated"]!(
      event("marketplace.listing.price-updated", "marketplace.listing-lst_1", { priceAmount: "99.50" }),
    );

    expect(db.options.get("lst_1")?.price_amount).toBe("99.50");
  });

  it("updates listing quantity cap on quantity-cap-updated", async () => {
    const db = new ProjectionDb();
    const handlers = buildCheckoutMarketplaceSellerOptionsProjectionHandlers(db);

    await handlers["marketplace.listing.created"]!(createdEvent());
    await handlers["marketplace.listing.quantity-cap-updated"]!(
      event("marketplace.listing.quantity-cap-updated", "marketplace.listing-lst_1", { quantityCap: 12 }),
    );

    expect(db.options.get("lst_1")?.listing_quantity_cap).toBe(12);
  });

  it("transitions status across publish, pause, and withdraw", async () => {
    const db = new ProjectionDb();
    const handlers = buildCheckoutMarketplaceSellerOptionsProjectionHandlers(db);

    await handlers["marketplace.listing.created"]!(createdEvent());

    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", "marketplace.listing-lst_1", {}),
    );
    expect(db.options.get("lst_1")?.status).toBe("active");

    await handlers["marketplace.listing.paused"]!(event("marketplace.listing.paused", "marketplace.listing-lst_1", {}));
    expect(db.options.get("lst_1")?.status).toBe("paused");

    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", "marketplace.listing-lst_1", {}),
    );
    expect(db.options.get("lst_1")?.status).toBe("active");

    await handlers["marketplace.listing.withdrawn"]!(
      event("marketplace.listing.withdrawn", "marketplace.listing-lst_1", {}),
    );
    expect(db.options.get("lst_1")?.status).toBe("withdrawn");
  });

  it("recomputes joined supply when a listing is published", async () => {
    const db = new ProjectionDb();
    const handlers = buildCheckoutMarketplaceSellerOptionsProjectionHandlers(db);

    await handlers["marketplace.listing.created"]!(createdEvent({ inventoryItemId: "inv_supply" }));
    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", "marketplace.listing-lst_1", {}),
    );

    expect(db.options.get("lst_1")).toMatchObject({ status: "active", inventory_item_id: "inv_supply" });
    expect(db.recomputedInventoryItemIds).toEqual(["inv_supply", "inv_supply"]);
  });

  it("gates and restores a seller's active rows on availability disabled/enabled", async () => {
    const db = new ProjectionDb();
    const handlers = buildCheckoutMarketplaceSellerOptionsProjectionHandlers(db);

    // Two active listings for the seller, plus a third active listing for a different seller.
    await handlers["marketplace.listing.created"]!(createdEvent({ listingId: "lst_1" }));
    await handlers["marketplace.listing.created"]!(createdEvent({ listingId: "lst_2" }));
    await handlers["marketplace.listing.created"]!(createdEvent({ listingId: "lst_other", accountId: "acc_other" }));
    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", "marketplace.listing-lst_1", {}),
    );
    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", "marketplace.listing-lst_2", {}),
    );
    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", "marketplace.listing-lst_other", {}),
    );
    // A paused listing for the seller stays paused through the availability gate.
    await handlers["marketplace.listing.created"]!(createdEvent({ listingId: "lst_paused" }));
    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", "marketplace.listing-lst_paused", {}),
    );
    await handlers["marketplace.listing.paused"]!(
      event("marketplace.listing.paused", "marketplace.listing-lst_paused", {}),
    );

    await handlers["marketplace.seller-listing-availability.disabled"]!(
      event("marketplace.seller-listing-availability.disabled", "marketplace.seller-listing-availability-acc_seller", {
        accountId: "acc_seller",
      }),
    );

    expect(db.options.get("lst_1")?.status).toBe("seller-unavailable");
    expect(db.options.get("lst_2")?.status).toBe("seller-unavailable");
    expect(db.options.get("lst_paused")?.status).toBe("paused");
    expect(db.options.get("lst_other")?.status).toBe("active");

    await handlers["marketplace.seller-listing-availability.enabled"]!(
      event("marketplace.seller-listing-availability.enabled", "marketplace.seller-listing-availability-acc_seller", {
        accountId: "acc_seller",
      }),
    );

    expect(db.options.get("lst_1")?.status).toBe("active");
    expect(db.options.get("lst_2")?.status).toBe("active");
    expect(db.options.get("lst_paused")?.status).toBe("paused");
    expect(db.options.get("lst_other")?.status).toBe("active");
  });
});
