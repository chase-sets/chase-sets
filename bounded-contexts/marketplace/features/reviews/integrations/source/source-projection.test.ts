import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { syncReviewEligibilityForOrder } from "./eligibility-sync";
import {
  buildReviewOrderSourceProjectionHandlers,
  buildReviewShipmentSourceProjectionHandlers,
  buildReviewSupportSourceProjectionHandlers,
} from "./source-projection";

type EligibilityRow = {
  order_id: string;
  author_account_id: string;
  subject_account_id: string;
  author_role: string;
  resolution_context: string | null;
  eligible_at: string;
  updated_at: string;
};

class ReviewSourceProjectionDb implements PgQueryable {
  public readonly orders = new Map<string, { buyer_account_id: string; seller_account_id: string }>();
  public readonly shipments = new Map<string, { order_id: string; status: string; delivered_at: string | null }>();
  public readonly supportRequests = new Map<
    string,
    {
      order_id: string;
      status: string;
      resolution_type: string | null;
      flow_type: string | null;
      resolved_at: string | null;
    }
  >();
  public readonly eligibilities = new Map<string, EligibilityRow>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO marketplace_review_order_sources")) {
      this.orders.set(String(values[0]), {
        buyer_account_id: String(values[1]),
        seller_account_id: String(values[2]),
      });
      return { rows: [], rowCount: 1 };
    }

    if (
      sql.includes("SELECT buyer_account_id, seller_account_id") &&
      sql.includes("marketplace_review_order_sources")
    ) {
      const order = this.orders.get(String(values[0]));
      return {
        rows: order ? ([{ ...order }] as Row[]) : [],
        rowCount: order ? 1 : 0,
      };
    }

    if (sql.includes("MIN(delivered_at)") && sql.includes("marketplace_review_shipment_sources")) {
      const orderId = String(values[0]);
      const deliveredAts = [...this.shipments.values()]
        .filter((shipment) => shipment.order_id === orderId && shipment.delivered_at !== null)
        .map((shipment) => String(shipment.delivered_at))
        .sort();
      return {
        rows: [{ delivered_at: deliveredAts[0] ?? null } as Row],
        rowCount: 1,
      };
    }

    if (sql.includes("INSERT INTO marketplace_review_shipment_sources")) {
      this.shipments.set(String(values[0]), {
        order_id: String(values[1]),
        status: "awaiting-package",
        delivered_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE marketplace_review_shipment_sources")) {
      const shipment = this.shipments.get(String(values[0]));
      if (!shipment) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("status = 'delivered'")) {
        shipment.status = "delivered";
        shipment.delivered_at = String(values[1]);
      } else if (sql.includes("status = 'returned'")) {
        shipment.status = "returned";
      } else if (sql.includes("status = 'dispatched'")) {
        shipment.status = "dispatched";
      } else {
        shipment.status = "exception";
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO marketplace_review_support_request_sources")) {
      const supportRequestId = String(values[0]);
      const orderId = String(values[1]);
      if (sql.includes("VALUES ($1, $2, 'resolved'")) {
        this.supportRequests.set(supportRequestId, {
          order_id: orderId,
          status: "resolved",
          resolution_type: String(values[2]),
          flow_type: values[3] === null ? null : String(values[3]),
          resolved_at: String(values[4]),
        });
      } else if (sql.includes("VALUES ($1, $2, 'cancelled'")) {
        this.supportRequests.set(supportRequestId, {
          order_id: orderId,
          status: "cancelled",
          resolution_type: null,
          flow_type: null,
          resolved_at: null,
        });
      } else {
        this.supportRequests.set(supportRequestId, {
          order_id: orderId,
          status: "open",
          resolution_type: null,
          flow_type: null,
          resolved_at: null,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("FROM marketplace_review_support_request_sources") && sql.includes("resolved_at::text")) {
      const orderId = String(values[0]);
      const rows = [...this.supportRequests.values()]
        .filter((request) => request.order_id === orderId)
        .map((request) => ({
          status: request.status,
          resolution_type: request.resolution_type,
          flow_type: request.flow_type,
          resolved_at: request.resolved_at,
        }));
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (sql.includes("INSERT INTO marketplace_review_eligibility_pages")) {
      const [orderId, authorAccountId, subjectAccountId, authorRole] = values.map(String);
      this.eligibilities.set(`${orderId}:${authorAccountId}:${subjectAccountId}`, {
        order_id: orderId,
        author_account_id: authorAccountId,
        subject_account_id: subjectAccountId,
        author_role: authorRole,
        resolution_context: values[4] === null ? null : String(values[4]),
        eligible_at: String(values[5]),
        updated_at: String(values[6]),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("DELETE FROM marketplace_review_eligibility_pages")) {
      const [orderId, authorAccountId, subjectAccountId] = values.map(String);
      this.eligibilities.delete(`${orderId}:${authorAccountId}:${subjectAccountId}`);
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }

  buyerEligibility(orderId = "ord_1", buyer = "acc_buyer", seller = "acc_seller") {
    return this.eligibilities.get(`${orderId}:${buyer}:${seller}`) ?? null;
  }

  sellerEligibility(orderId = "ord_1", buyer = "acc_buyer", seller = "acc_seller") {
    return this.eligibilities.get(`${orderId}:${seller}:${buyer}`) ?? null;
  }
}

function event(type: string, data: Record<string, unknown>): TransportEvent {
  return {
    id: `evt_${type}` as never,
    type,
    streamId: "stream_1" as never,
    streamVersion: 1 as never,
    globalPosition: 1 as never,
    tenantId: "tnt_1" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_buyer" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-04-02T00:00:00.000Z" as never,
      recordedAt: "2026-04-02T00:00:00.000Z" as never,
    },
  };
}

function buildHarness(db: ReviewSourceProjectionDb) {
  const supportHandlers = buildReviewSupportSourceProjectionHandlers(db);
  const orderHandlers = buildReviewOrderSourceProjectionHandlers(db);
  const shipmentHandlers = buildReviewShipmentSourceProjectionHandlers(db, {
    // Mirrors the runtime's recordDeliveredShipmentReviewEligibility wiring.
    onDeliveredShipment: async ({ shipmentId, deliveredAt }) => {
      const shipment = db.shipments.get(shipmentId);
      if (shipment?.status === "delivered") {
        await syncReviewEligibilityForOrder(db, shipment.order_id, deliveredAt);
      }
    },
  });

  const createOrder = (orderId = "ord_1", buyer = "acc_buyer", seller = "acc_seller") =>
    orderHandlers["ordering.order.created"]!(
      event("ordering.order.created", { orderId, buyerAccountId: buyer, sellerAccountId: seller }),
    );
  const deliverShipment = async (shipmentId: string, orderId: string, deliveredAt: string) => {
    await shipmentHandlers["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", { shipmentId, orderId, createdAt: "2026-04-02T00:00:00.000Z" }),
    );
    await shipmentHandlers["fulfillment.shipment.delivered"]!(
      event("fulfillment.shipment.delivered", { shipmentId, deliveredAt }),
    );
  };
  const openSupport = (supportRequestId: string, orderId: string, openedAt: string) =>
    supportHandlers["support.support-request.opened"]!(
      event("support.support-request.opened", { supportRequestId, orderId, openedAt }),
    );
  const resolveSupport = (
    supportRequestId: string,
    orderId: string,
    resolutionType: string,
    flowType: string,
    resolvedAt: string,
  ) =>
    supportHandlers["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId,
        orderId,
        flowType,
        resolution: { resolutionType, resolvedAt },
      }),
    );

  return { supportHandlers, shipmentHandlers, createOrder, deliverShipment, openSupport, resolveSupport };
}

describe("marketplace review source projection eligibility", () => {
  it("restores buyer→seller eligibility with the refund marker on a full-refund resolution and keeps seller→buyer suppressed", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.deliverShipment("shp_1", "ord_1", "2026-04-03T00:00:00.000Z");
    expect(db.eligibilities.size).toBe(2);

    await harness.openSupport("sup_1", "ord_1", "2026-04-04T00:00:00.000Z");
    expect(db.eligibilities.size).toBe(0);

    await harness.resolveSupport(
      "sup_1",
      "ord_1",
      "full-refund",
      "product-not-as-described",
      "2026-04-06T00:00:00.000Z",
    );

    expect(db.buyerEligibility()).toMatchObject({
      author_role: "buyer",
      resolution_context: "resolved-via-refund",
      eligible_at: "2026-04-03T00:00:00.000Z",
    });
    expect(db.sellerEligibility()).toBeNull();
  });

  it("keeps seller→buyer suppressed when the return leg of a return-for-refund delivers after resolution", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.deliverShipment("shp_out", "ord_1", "2026-04-03T00:00:00.000Z");
    await harness.openSupport("sup_1", "ord_1", "2026-04-04T00:00:00.000Z");
    await harness.resolveSupport("sup_1", "ord_1", "return-for-refund", "return-request", "2026-04-06T00:00:00.000Z");

    // The buyer ships the item back; the return leg delivering to the seller
    // must not re-open the retaliation lane.
    await harness.deliverShipment("shp_return", "ord_1", "2026-04-09T00:00:00.000Z");

    expect(db.buyerEligibility()).toMatchObject({
      resolution_context: "resolved-via-refund",
      eligible_at: "2026-04-03T00:00:00.000Z",
    });
    expect(db.sellerEligibility()).toBeNull();
  });

  it("restores buyer→seller without a delivery when the seller could not fulfill (cancel-order, seller-caused)", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.openSupport("sup_1", "ord_1", "2026-04-02T12:00:00.000Z");
    await harness.resolveSupport("sup_1", "ord_1", "cancel-order", "seller-cannot-fulfill", "2026-04-04T00:00:00.000Z");

    expect(db.buyerEligibility()).toMatchObject({
      author_role: "buyer",
      resolution_context: "resolved-via-refund",
      eligible_at: "2026-04-04T00:00:00.000Z",
    });
    expect(db.sellerEligibility()).toBeNull();
  });

  it("restores neither direction for a consensual buyer-cancel-request cancellation", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.openSupport("sup_1", "ord_1", "2026-04-02T12:00:00.000Z");
    await harness.resolveSupport("sup_1", "ord_1", "cancel-order", "buyer-cancel-request", "2026-04-04T00:00:00.000Z");

    expect(db.eligibilities.size).toBe(0);
  });

  it("restores both directions without a marker on benign resolutions", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.deliverShipment("shp_1", "ord_1", "2026-04-03T00:00:00.000Z");
    await harness.openSupport("sup_1", "ord_1", "2026-04-04T00:00:00.000Z");
    await harness.resolveSupport("sup_1", "ord_1", "no-action", "product-not-received", "2026-04-06T00:00:00.000Z");

    expect(db.buyerEligibility()).toMatchObject({ resolution_context: null });
    expect(db.sellerEligibility()).toMatchObject({ resolution_context: null });
  });

  it("does not restore eligibility on delivery while a support request is open", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.openSupport("sup_1", "ord_1", "2026-04-02T12:00:00.000Z");
    await harness.deliverShipment("shp_1", "ord_1", "2026-04-03T00:00:00.000Z");

    expect(db.eligibilities.size).toBe(0);
  });

  it("heals refund-restored eligibility when the order source lands after the resolution (replay race)", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.openSupport("sup_1", "ord_1", "2026-04-02T12:00:00.000Z");
    await harness.resolveSupport("sup_1", "ord_1", "cancel-order", "seller-cannot-fulfill", "2026-04-04T00:00:00.000Z");
    expect(db.eligibilities.size).toBe(0);

    await harness.createOrder();

    expect(db.buyerEligibility()).toMatchObject({ resolution_context: "resolved-via-refund" });
    expect(db.sellerEligibility()).toBeNull();
  });

  it("creates both eligibility directions for a guest-checkout order keyed to the guest's account", async () => {
    // Guest checkout creates a real account up front and the order's
    // buyer_account_id is that account. Claiming the guest order later
    // (identity's grantGuestAccountForAuth) attaches sign-in credentials to
    // the SAME account id — it never re-keys — so the account-keyed
    // eligibility rows written at delivery already belong to the claimed
    // account. This pins that both directions exist for the guest account.
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder("ord_guest", "acc_guest", "acc_seller");
    await harness.deliverShipment("shp_guest", "ord_guest", "2026-04-03T00:00:00.000Z");

    expect(db.buyerEligibility("ord_guest", "acc_guest", "acc_seller")).toMatchObject({
      author_account_id: "acc_guest",
      author_role: "buyer",
    });
    expect(db.sellerEligibility("ord_guest", "acc_guest", "acc_seller")).toMatchObject({
      subject_account_id: "acc_guest",
      author_role: "seller",
    });
  });
});
