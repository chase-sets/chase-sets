import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildOrderingReputationProjectionHandlers } from "./reputation-projection";
import { getOrderingOrderReviewOpportunity } from "./reputation-queries";

type EligibilityRow = {
  order_id: string;
  author_account_id: string;
  subject_account_id: string;
  author_role: string;
  eligible_at: string;
  updated_at: string;
};

type ReviewRow = {
  review_id: string;
  order_id: string;
  author_account_id: string;
  subject_account_id: string;
  author_role: string;
  status: string;
  submitted_at: string;
  updated_at: string;
  withdrawn_at: string | null;
};

class ReputationProjectionDb implements PgQueryable {
  public readonly orders = new Map<string, { buyer_account_id: string; seller_account_id: string }>();
  public readonly accounts = new Map<string, { display_name: string | null }>();
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
  public readonly reviews = new Map<string, ReviewRow>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("SELECT buyer_account_id, seller_account_id") && sql.includes("FROM ordering_order_pages")) {
      const order = this.orders.get(String(values[0]));
      return {
        rows: order ? ([{ ...order }] as Row[]) : [],
        rowCount: order ? 1 : 0,
      };
    }

    if (sql.includes("MIN(delivered_at)") && sql.includes("ordering_order_review_shipment_sources")) {
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

    if (sql.includes("FROM ordering_order_review_support_request_sources") && sql.includes("resolved_at::text")) {
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

    if (sql.includes("INSERT INTO ordering_order_review_eligibility_pages")) {
      const [orderId, authorAccountId, subjectAccountId, authorRole, eligibleAt, updatedAt] = values.map(String);
      this.upsertEligibility({
        order_id: orderId,
        author_account_id: authorAccountId,
        subject_account_id: subjectAccountId,
        author_role: authorRole,
        eligible_at: eligibleAt,
        updated_at: updatedAt,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO ordering_order_review_shipment_sources")) {
      this.shipments.set(String(values[0]), {
        order_id: String(values[1]),
        status: "awaiting-package",
        delivered_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE ordering_order_review_shipment_sources")) {
      const shipment = this.shipments.get(String(values[0]));
      if (!shipment) {
        return { rows: [], rowCount: 0 };
      }
      shipment.status = "delivered";
      shipment.delivered_at = String(values[1]);
      return { rows: [{ order_id: shipment.order_id } as Row], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO ordering_order_review_support_request_sources")) {
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

    if (sql.includes("DELETE FROM ordering_order_review_eligibility_pages")) {
      const [orderId, authorAccountId, subjectAccountId] = values.map(String);
      this.eligibilities.delete(`${orderId}:${authorAccountId}:${subjectAccountId}`);
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO ordering_order_review_pages")) {
      const [reviewId, orderId, authorAccountId, subjectAccountId, authorRole, submittedAt] = values.map(String);
      this.reviews.set(reviewId, {
        review_id: reviewId,
        order_id: orderId,
        author_account_id: authorAccountId,
        subject_account_id: subjectAccountId,
        author_role: authorRole,
        status: "active",
        submitted_at: submittedAt,
        updated_at: submittedAt,
        withdrawn_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE ordering_order_review_pages") && sql.includes("status = 'withdrawn'")) {
      const review = this.reviews.get(String(values[0]));
      if (review) {
        review.status = "withdrawn";
        review.withdrawn_at = String(values[1]);
        review.updated_at = String(values[1]);
      }
      return { rows: [], rowCount: review ? 1 : 0 };
    }

    if (sql.includes("UPDATE ordering_order_review_pages")) {
      const review = this.reviews.get(String(values[0]));
      if (review) {
        review.updated_at = String(values[1]);
      }
      return { rows: [], rowCount: review ? 1 : 0 };
    }

    if (sql.includes("FROM ordering_order_review_eligibility_pages AS eligibility")) {
      const [orderId, authorAccountId] = values.map(String);
      const row = [...this.eligibilities.values()].find(
        (candidate) => candidate.order_id === orderId && candidate.author_account_id === authorAccountId,
      );
      const order = this.orders.get(orderId);
      if (!row || !order) {
        return { rows: [], rowCount: 0 };
      }
      const directionMatches =
        (row.author_role === "buyer" &&
          order.buyer_account_id === row.author_account_id &&
          order.seller_account_id === row.subject_account_id) ||
        (row.author_role === "seller" &&
          order.seller_account_id === row.author_account_id &&
          order.buyer_account_id === row.subject_account_id);
      if (!directionMatches) {
        return { rows: [], rowCount: 0 };
      }
      const activeReview = [...this.reviews.values()].find(
        (review) =>
          review.order_id === row.order_id &&
          review.author_account_id === row.author_account_id &&
          review.subject_account_id === row.subject_account_id &&
          review.status === "active",
      );

      return {
        rows: [
          {
            order_id: row.order_id,
            subject_account_id: row.subject_account_id,
            subject_display_name: this.accounts.get(row.subject_account_id)?.display_name ?? null,
            author_role: row.author_role,
            eligible_at: row.eligible_at,
            active_review_id: activeReview?.review_id ?? null,
          } as Row,
        ],
        rowCount: 1,
      };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }

  private upsertEligibility(row: EligibilityRow) {
    this.eligibilities.set(`${row.order_id}:${row.author_account_id}:${row.subject_account_id}`, row);
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

describe("ordering reputation opportunity projection", () => {
  it("creates buyer and seller review opportunities from delivered orders and active review events", async () => {
    const db = new ReputationProjectionDb();
    db.orders.set("ord_1", { buyer_account_id: "acc_buyer", seller_account_id: "acc_seller" });
    db.accounts.set("acc_seller", { display_name: "Seller" });
    db.accounts.set("acc_buyer", { display_name: "Buyer" });
    const handlers = buildOrderingReputationProjectionHandlers(db);

    await handlers["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        createdAt: "2026-04-02T00:00:00.000Z",
      }),
    );
    await handlers["fulfillment.shipment.delivered"]!(
      event("fulfillment.shipment.delivered", {
        shipmentId: "shp_1",
        deliveredAt: "2026-04-03T00:00:00.000Z",
      }),
    );

    await expect(
      getOrderingOrderReviewOpportunity(db, { orderId: "ord_1", authorAccountId: "acc_buyer" }),
    ).resolves.toMatchObject({
      subject_account_id: "acc_seller",
      subject_display_name: "Seller",
      author_role: "buyer",
      active_review_id: null,
    });

    await handlers["marketplace.review.submitted"]!(
      event("marketplace.review.submitted", {
        reviewId: "rev_1",
        orderId: "ord_1",
        authorAccountId: "acc_seller",
        subjectAccountId: "acc_buyer",
        authorRole: "seller",
        rating: 5,
        feedback: null,
        submittedAt: "2026-04-04T00:00:00.000Z",
      }),
    );

    await expect(
      getOrderingOrderReviewOpportunity(db, { orderId: "ord_1", authorAccountId: "acc_seller" }),
    ).resolves.toMatchObject({
      subject_account_id: "acc_buyer",
      subject_display_name: "Buyer",
      author_role: "seller",
      active_review_id: "rev_1",
    });

    await handlers["marketplace.review.withdrawn"]!(
      event("marketplace.review.withdrawn", {
        reviewId: "rev_1",
        withdrawnAt: "2026-04-05T00:00:00.000Z",
      }),
    );

    await expect(
      getOrderingOrderReviewOpportunity(db, { orderId: "ord_1", authorAccountId: "acc_seller" }),
    ).resolves.toMatchObject({
      active_review_id: null,
    });
  });

  it("suppresses and restores eligibility around support review events", async () => {
    const db = new ReputationProjectionDb();
    db.orders.set("ord_1", { buyer_account_id: "acc_buyer", seller_account_id: "acc_seller" });
    const handlers = buildOrderingReputationProjectionHandlers(db);

    await handlers["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        createdAt: "2026-04-02T00:00:00.000Z",
      }),
    );
    await handlers["fulfillment.shipment.delivered"]!(
      event("fulfillment.shipment.delivered", {
        shipmentId: "shp_1",
        deliveredAt: "2026-04-03T00:00:00.000Z",
      }),
    );

    expect(db.eligibilities.size).toBe(2);

    await handlers["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        openedAt: "2026-04-04T00:00:00.000Z",
      }),
    );
    expect(db.eligibilities.size).toBe(0);

    await handlers["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        resolution: {
          resolutionType: "support-reviewed",
          resolvedAt: "2026-04-06T00:00:00.000Z",
        },
      }),
    );

    expect(db.eligibilities.size).toBe(2);
  });

  it("does not restore review eligibility on delivery while a support request is active", async () => {
    const db = new ReputationProjectionDb();
    db.orders.set("ord_1", { buyer_account_id: "acc_buyer", seller_account_id: "acc_seller" });
    const handlers = buildOrderingReputationProjectionHandlers(db);

    await handlers["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        createdAt: "2026-04-02T00:00:00.000Z",
      }),
    );
    await handlers["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        openedAt: "2026-04-02T12:00:00.000Z",
      }),
    );

    await handlers["fulfillment.shipment.delivered"]!(
      event("fulfillment.shipment.delivered", {
        shipmentId: "shp_1",
        deliveredAt: "2026-04-03T00:00:00.000Z",
      }),
    );

    expect(db.eligibilities.size).toBe(0);
  });

  it("restores only the buyer→seller direction on refund-class resolutions", async () => {
    const db = new ReputationProjectionDb();
    db.orders.set("ord_1", { buyer_account_id: "acc_buyer", seller_account_id: "acc_seller" });
    const handlers = buildOrderingReputationProjectionHandlers(db);

    await handlers["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        createdAt: "2026-04-02T00:00:00.000Z",
      }),
    );
    await handlers["fulfillment.shipment.delivered"]!(
      event("fulfillment.shipment.delivered", {
        shipmentId: "shp_1",
        deliveredAt: "2026-04-03T00:00:00.000Z",
      }),
    );
    await handlers["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        openedAt: "2026-04-04T00:00:00.000Z",
      }),
    );
    await handlers["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        flowType: "product-not-as-described",
        resolution: {
          resolutionType: "full-refund",
          resolvedAt: "2026-04-06T00:00:00.000Z",
        },
      }),
    );

    expect(db.eligibilities.get("ord_1:acc_buyer:acc_seller")).toMatchObject({
      author_role: "buyer",
      eligible_at: "2026-04-03T00:00:00.000Z",
    });
    expect(db.eligibilities.get("ord_1:acc_seller:acc_buyer")).toBeUndefined();
  });

  it("restores buyer→seller without a delivery when a seller-caused cancellation resolves the request", async () => {
    const db = new ReputationProjectionDb();
    db.orders.set("ord_1", { buyer_account_id: "acc_buyer", seller_account_id: "acc_seller" });
    const handlers = buildOrderingReputationProjectionHandlers(db);

    await handlers["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        openedAt: "2026-04-02T12:00:00.000Z",
      }),
    );
    await handlers["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        flowType: "seller-cannot-fulfill",
        resolution: {
          resolutionType: "cancel-order",
          resolvedAt: "2026-04-04T00:00:00.000Z",
        },
      }),
    );

    expect(db.eligibilities.get("ord_1:acc_buyer:acc_seller")).toMatchObject({
      author_role: "buyer",
      eligible_at: "2026-04-04T00:00:00.000Z",
    });
    expect(db.eligibilities.get("ord_1:acc_seller:acc_buyer")).toBeUndefined();
  });

  it("restores neither direction for a consensual buyer-cancel-request cancellation", async () => {
    const db = new ReputationProjectionDb();
    db.orders.set("ord_1", { buyer_account_id: "acc_buyer", seller_account_id: "acc_seller" });
    const handlers = buildOrderingReputationProjectionHandlers(db);

    await handlers["support.support-request.opened"]!(
      event("support.support-request.opened", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        openedAt: "2026-04-02T12:00:00.000Z",
      }),
    );
    await handlers["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        flowType: "buyer-cancel-request",
        resolution: {
          resolutionType: "cancel-order",
          resolvedAt: "2026-04-04T00:00:00.000Z",
        },
      }),
    );

    expect(db.eligibilities.size).toBe(0);
  });
});
