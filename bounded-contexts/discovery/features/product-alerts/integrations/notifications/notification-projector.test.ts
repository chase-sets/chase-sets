import { describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { projectMarketplaceEventToProductAlertNotifications } from "./notification-projector";

type Row = Record<string, unknown>;

class ProductAlertProjectionDb implements PgQueryable {
  public readonly alerts = new Map<string, Row>();
  public readonly activities = new Map<string, Row>();
  public readonly accounts = new Map<string, Row>();
  public readonly notifications = new Set<string>();

  async query<T = Row>(sql: string, values: readonly unknown[] = []): Promise<PgQueryResult<T>> {
    if (sql.includes("SELECT") && sql.includes("FROM discovery_product_alert_market_activity")) {
      const row = this.activities.get(String(values[0]));
      const account = row ? this.accounts.get(String(row.owner_account_id)) : null;
      const listingAvailability = account?.seller_listing_availability_status ?? "available";
      return {
        rows: (row ? [{ ...row, seller_listing_availability_status: listingAvailability }] : []) as T[],
        rowCount: row ? 1 : 0,
      };
    }

    if (sql.includes("INSERT INTO discovery_product_alert_market_activity")) {
      this.activities.set(String(values[0]), {
        activity_id: values[0],
        market_side: sql.includes("$1, 'offer'") ? "offer" : "listing",
        owner_account_id: values[1],
        catalog_catalog_item_id: values[2],
        product_id: values[3],
        selected_options: JSON.parse(String(values[4])),
        item_title: values[5],
        item_subtitle: values[6],
        product_summary: values[7],
        price_amount: values[8],
        quantity: values[9],
        status: sql.includes("'submitted'") ? "submitted" : "draft",
        created_at: values[10],
        updated_at: values[10],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE discovery_product_alert_market_activity")) {
      const current = this.activities.get(String(values[0])) ?? {};
      if (sql.includes("price_amount = $2")) {
        this.activities.set(String(values[0]), {
          ...current,
          price_amount: values[1],
          updated_at: values[2],
        });
      } else if (sql.includes("quantity = $2")) {
        this.activities.set(String(values[0]), {
          ...current,
          quantity: values[1],
          updated_at: values[2],
        });
      } else if (sql.includes("status = 'active'")) {
        this.activities.set(String(values[0]), {
          ...current,
          status: "active",
          updated_at: values[1],
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("FROM discovery_product_alert_pages")) {
      const rows = [...this.alerts.values()].filter(
        (alert) => alert.status === "active" && alert.market_side === values[0] && alert.product_id === values[1],
      );
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (sql.includes("INSERT INTO discovery_product_alert_match_notifications")) {
      const key = `${values[0]}:${values[1]}:${values[2]}`;
      if (this.notifications.has(key)) {
        return { rows: [], rowCount: 0 };
      }
      this.notifications.add(key);
      return { rows: [{ inserted: 1 }] as T[], rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function marketplaceEvent(type: string, data: Record<string, unknown>): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${type}`,
    streamId: "marketplace.listing-lst_1",
    globalPosition: "1",
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    trace: { traceId: "trace_1" },
    timing: { occurredAt: "2026-05-09T00:00:00.000Z", recordedAt: "2026-05-09T00:00:00.000Z" },
  });
}

describe("Product Alert notification projector", () => {
  it("notifies a listing subscriber when a draft listing becomes active below threshold", async () => {
    const db = new ProductAlertProjectionDb();
    const outbox = { enqueueNotification: vi.fn(async (_input: { message: { title: string } }) => undefined) };
    db.alerts.set("pal_1", {
      alert_id: "pal_1",
      account_id: "acc_watcher",
      market_side: "listing",
      product_id: "cat_1::raw",
      threshold_amount: "20.00",
      status: "active",
    });

    await projectMarketplaceEventToProductAlertNotifications(
      db,
      outbox,
      marketplaceEvent("marketplace.listing.created", {
        listingId: "lst_1",
        accountId: "acc_seller",
        catalogItemId: "cat_1",
        productId: "cat_1::raw",
        selectedOptions: [],
        itemTitle: "Charizard",
        itemSubtitle: null,
        productSummary: "Raw",
        priceAmount: "18.00",
        quantityCap: 1,
      }),
    );
    await projectMarketplaceEventToProductAlertNotifications(
      db,
      outbox,
      marketplaceEvent("marketplace.listing.published", {}),
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(outbox.enqueueNotification.mock.calls[0]?.[0].message).toMatchObject({
      messageType: "discovery.product-alert.listing",
      title: "Product Alert: Charizard",
    });
  });

  it("emits limited offer demand notifications without buyer details", async () => {
    const db = new ProductAlertProjectionDb();
    const outbox = { enqueueNotification: vi.fn(async (_input: { message: { title: string } }) => undefined) };
    db.alerts.set("pal_2", {
      alert_id: "pal_2",
      account_id: "acc_seller",
      market_side: "offer",
      product_id: "cat_1::raw",
      threshold_amount: "10.00",
      status: "active",
    });

    await projectMarketplaceEventToProductAlertNotifications(
      db,
      outbox,
      marketplaceEvent("marketplace.offer.submitted", {
        offerId: "off_1",
        buyerAccountId: "acc_buyer",
        catalogItemId: "cat_1",
        productId: "cat_1::raw",
        selectedOptions: [],
        itemTitle: "Charizard",
        itemSubtitle: null,
        productSummary: "Raw",
        priceAmount: "12.00",
        quantityRequested: 1,
      }),
    );

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    const message = outbox.enqueueNotification.mock.calls[0]?.[0].message;
    expect(message.title).toBe("Product Alert: demand for Charizard");
    expect(JSON.stringify(message)).not.toContain("acc_buyer");
  });

  it("does not notify listing subscribers while the seller's listings are unavailable", async () => {
    const db = new ProductAlertProjectionDb();
    const outbox = { enqueueNotification: vi.fn(async (_input: { message: { title: string } }) => undefined) };
    db.alerts.set("pal_3", {
      alert_id: "pal_3",
      account_id: "acc_watcher",
      market_side: "listing",
      product_id: "cat_1::raw",
      threshold_amount: "20.00",
      status: "active",
    });
    db.accounts.set("acc_seller", {
      account_id: "acc_seller",
      seller_listing_availability_status: "unavailable",
    });

    await projectMarketplaceEventToProductAlertNotifications(
      db,
      outbox,
      marketplaceEvent("marketplace.listing.created", {
        listingId: "lst_1",
        accountId: "acc_seller",
        catalogItemId: "cat_1",
        productId: "cat_1::raw",
        selectedOptions: [],
        itemTitle: "Charizard",
        itemSubtitle: null,
        productSummary: "Raw",
        priceAmount: "18.00",
        quantityCap: 1,
      }),
    );
    await projectMarketplaceEventToProductAlertNotifications(
      db,
      outbox,
      marketplaceEvent("marketplace.listing.published", {}),
    );

    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });
});
