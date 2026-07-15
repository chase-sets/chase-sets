import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { syncReviewEligibilityForOrder } from "./eligibility-sync";
import {
  buildReviewAccountProjectionHandlers,
  buildReviewOrderSourceProjectionHandlers,
  buildReviewShipmentSourceProjectionHandlers,
  buildReviewSupportSourceProjectionHandlers,
} from "./source-projection";

type EligibilityRow = {
  order_id: string;
  author_account_id: string;
  subject_account_id: string;
  author_role: string;
  eligible_at: string;
  effective_deadline_at: string;
  submission_state: "allowed" | "held" | "expired";
  hold_started_at: string | null;
  paused_remaining_ms: string | null;
  reminder_armed_at: string;
  reminder_notified_at: string | null;
  hold_cycle: number;
  updated_at: string;
};

class ReviewSourceProjectionDb implements PgQueryable {
  public readonly orders = new Map<
    string,
    { buyer_account_id: string; seller_account_id: string; cancelled_at: string | null }
  >();
  public readonly shipments = new Map<string, { order_id: string; status: string; delivered_at: string | null }>();
  public readonly supportRequests = new Map<
    string,
    {
      order_id: string;
      status: string;
      responsibility: string | null;
      resolution_type: string | null;
      resolved_at: string | null;
      review_directions: readonly ("buyer-to-seller" | "seller-to-buyer")[];
    }
  >();
  public readonly remedies = new Map<string, { remedy_id: string; coverage_id: string | null; remedy_kind: string }>();
  public readonly eligibilities = new Map<string, EligibilityRow>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO marketplace_review_order_sources")) {
      this.orders.set(String(values[0]), {
        buyer_account_id: String(values[1]),
        seller_account_id: String(values[2]),
        cancelled_at: null,
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

    if (sql.includes("UPDATE marketplace_review_order_sources")) {
      const order = this.orders.get(String(values[0]));
      if (!order) return { rows: [], rowCount: 0 };
      if (sql.includes("status = 'cancelled'")) order.cancelled_at = String(values[1]);
      return { rows: [], rowCount: 1 };
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
          responsibility: values[2] === null ? null : String(values[2]),
          resolution_type: String(values[3]),
          resolved_at: String(values[4]),
          review_directions: ["buyer-to-seller", "seller-to-buyer"],
        });
      } else if (sql.includes("VALUES ($1, $2, 'cancelled'")) {
        this.supportRequests.set(supportRequestId, {
          order_id: orderId,
          status: "cancelled",
          responsibility: null,
          resolution_type: null,
          resolved_at: null,
          review_directions: ["buyer-to-seller", "seller-to-buyer"],
        });
      } else {
        this.supportRequests.set(supportRequestId, {
          order_id: orderId,
          status: "open",
          responsibility: null,
          resolution_type: null,
          resolved_at: null,
          review_directions: (values[3] as readonly ("buyer-to-seller" | "seller-to-buyer")[]) ?? [
            "buyer-to-seller",
            "seller-to-buyer",
          ],
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO marketplace_review_remedy_sources")) {
      this.remedies.set(String(values[0]), {
        remedy_id: String(values[1]),
        coverage_id: values[2] === null ? null : String(values[2]),
        remedy_kind: String(values[3]),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("FROM marketplace_review_support_request_sources") && sql.includes("resolved_at::text")) {
      const orderId = String(values[0]);
      const rows = [...this.supportRequests.entries()]
        .filter(([, request]) => request.order_id === orderId)
        .map(([supportRequestId, request]) => ({
          status: request.status,
          responsibility: request.responsibility,
          resolution_type: request.resolution_type,
          resolved_at: request.resolved_at,
          remedy_id: this.remedies.get(supportRequestId)?.remedy_id ?? null,
          coverage_id: this.remedies.get(supportRequestId)?.coverage_id ?? null,
          remedy_kind: this.remedies.get(supportRequestId)?.remedy_kind ?? null,
          review_directions: request.review_directions,
        }));
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (
      sql.includes("SELECT order_id") &&
      sql.includes("FROM marketplace_review_support_request_sources") &&
      sql.includes("support_request_id = $1")
    ) {
      const request = this.supportRequests.get(String(values[0]));
      return { rows: (request ? [{ order_id: request.order_id }] : []) as Row[], rowCount: request ? 1 : 0 };
    }

    if (sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("effective_deadline_at::text")) {
      const [orderId, authorAccountId, subjectAccountId] = values.map(String);
      const eligibility = this.eligibilities.get(`${orderId}:${authorAccountId}:${subjectAccountId}`);
      return { rows: (eligibility ? [eligibility] : []) as Row[], rowCount: eligibility ? 1 : 0 };
    }

    if (sql.includes("INSERT INTO marketplace_review_eligibility_pages")) {
      const [orderId, authorAccountId, subjectAccountId, authorRole] = values.map(String);
      this.eligibilities.set(`${orderId}:${authorAccountId}:${subjectAccountId}`, {
        order_id: orderId,
        author_account_id: authorAccountId,
        subject_account_id: subjectAccountId,
        author_role: authorRole,
        eligible_at: String(values[4]),
        effective_deadline_at: String(values[5]),
        submission_state: values[6] as "allowed" | "held" | "expired",
        hold_started_at: values[7] === null ? null : String(values[7]),
        paused_remaining_ms: values[8] === null ? null : String(values[8]),
        reminder_armed_at: String(values[9]),
        reminder_notified_at: values[10] === null ? null : String(values[10]),
        hold_cycle: Number(values[11]),
        updated_at: String(values[12]),
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
  return buildTransportEvent(type, data, {
    id: `evt_${type}`,
    streamId: "stream_1",
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_buyer" },
    timing: { occurredAt: "2026-04-02T00:00:00.000Z", recordedAt: "2026-04-02T00:00:00.000Z" },
  });
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
    responsibility: unknown,
    resolvedAt: string,
  ) =>
    supportHandlers["support.support-request.resolved"]!(
      event("support.support-request.resolved", {
        supportRequestId,
        orderId,
        resolution: { resolutionType, responsibility, resolvedAt },
      }),
    );

  const cancelOrder = (orderId: string, cancelledAt: string) =>
    orderHandlers["ordering.order.cancelled"]!(event("ordering.order.cancelled", { orderId, cancelledAt }));

  return { supportHandlers, shipmentHandlers, createOrder, cancelOrder, deliverShipment, openSupport, resolveSupport };
}

describe("marketplace review source projection eligibility", () => {
  it("restores both directions after a carrier-responsible full refund", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.deliverShipment("shp_1", "ord_1", "2026-04-03T00:00:00.000Z");
    expect(db.eligibilities.size).toBe(2);

    await harness.openSupport("sup_1", "ord_1", "2026-04-04T00:00:00.000Z");
    expect([...db.eligibilities.values()].map((row) => row.submission_state)).toEqual(["held", "held"]);

    await harness.resolveSupport("sup_1", "ord_1", "full-refund", "carrier", "2026-04-06T00:00:00.000Z");

    expect(db.buyerEligibility()).toMatchObject({
      author_role: "buyer",
      eligible_at: "2026-04-03T00:00:00.000Z",
    });
    expect(db.sellerEligibility()).toMatchObject({
      author_role: "seller",
      eligible_at: "2026-04-03T00:00:00.000Z",
    });
  });

  it("correlates an out-of-order ADR 0022 remedy fact without using it as a scoring signal", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.supportHandlers["support.support-request.remedy-authorized.v1"]!(
      event("support.support-request.remedy-authorized.v1", {
        factSchemaVersion: 1,
        supportRequestId: "sup_coverage",
        remedyId: "rmd_coverage",
        coverageId: "cov_coverage",
        idempotencyKey: "remedy:coverage",
        causationId: null,
        policyVersion: "2026-07-14",
        occurredAt: "2026-04-04T00:00:00.000Z",
        remedy: { kind: "full-refund", amount: "100.00", currencyCode: "usd" },
        allocation: {
          sellerFundedAmount: "0.00",
          platformFundedAmount: "100.00",
          currencyCode: "usd",
          fundingKind: "platform-funded",
        },
        returnDirective: "no-return",
        refundTrigger: "immediate",
        reasonCode: "support-resolution",
      }),
    );
    expect(db.remedies.get("sup_coverage")).toEqual({
      remedy_id: "rmd_coverage",
      coverage_id: "cov_coverage",
      remedy_kind: "full-refund",
    });

    await harness.createOrder();
    await harness.deliverShipment("shp_1", "ord_1", "2026-04-03T00:00:00.000Z");
    await harness.openSupport("sup_coverage", "ord_1", "2026-04-04T00:00:00.000Z");
    await harness.resolveSupport("sup_coverage", "ord_1", "full-refund", "carrier", "2026-04-06T00:00:00.000Z");

    expect(db.buyerEligibility()).not.toBeNull();
    expect(db.sellerEligibility()).not.toBeNull();
  });

  it("keeps both directions eligible when a return leg delivers after a platform-responsible resolution", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.deliverShipment("shp_out", "ord_1", "2026-04-03T00:00:00.000Z");
    await harness.openSupport("sup_1", "ord_1", "2026-04-04T00:00:00.000Z");
    await harness.resolveSupport("sup_1", "ord_1", "return-for-refund", "platform", "2026-04-06T00:00:00.000Z");

    // The buyer ships the item back; the return leg delivering to the seller
    // does not change either directional disposition.
    await harness.deliverShipment("shp_return", "ord_1", "2026-04-09T00:00:00.000Z");

    expect(db.buyerEligibility()).toMatchObject({
      eligible_at: "2026-04-03T00:00:00.000Z",
    });
    expect(db.sellerEligibility()).toMatchObject({ eligible_at: "2026-04-03T00:00:00.000Z" });
  });

  it("creates buyer→seller eligibility without delivery after cancellation and explicit seller responsibility", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.openSupport("sup_1", "ord_1", "2026-04-02T12:00:00.000Z");
    await harness.resolveSupport("sup_1", "ord_1", "cancel-order", "seller", "2026-04-04T00:00:00.000Z");
    expect(db.eligibilities.size).toBe(0);

    await harness.cancelOrder("ord_1", "2026-04-05T00:00:00.000Z");

    expect(db.buyerEligibility()).toMatchObject({
      author_role: "buyer",
      eligible_at: "2026-04-05T00:00:00.000Z",
    });
    expect(db.sellerEligibility()).toBeNull();
  });

  it("creates neither direction for a buyer-responsible cancellation", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.openSupport("sup_1", "ord_1", "2026-04-02T12:00:00.000Z");
    await harness.resolveSupport("sup_1", "ord_1", "cancel-order", "buyer", "2026-04-04T00:00:00.000Z");
    await harness.cancelOrder("ord_1", "2026-04-05T00:00:00.000Z");

    expect(db.eligibilities.size).toBe(0);
  });

  it("restores both submission directions for a seller-responsible non-refund remedy", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.deliverShipment("shp_1", "ord_1", "2026-04-03T00:00:00.000Z");
    await harness.openSupport("sup_1", "ord_1", "2026-04-04T00:00:00.000Z");
    await harness.resolveSupport("sup_1", "ord_1", "replacement", "seller", "2026-04-06T00:00:00.000Z");

    expect(db.buyerEligibility()).not.toBeNull();
    expect(db.sellerEligibility()).not.toBeNull();
  });

  it("persists paused review clocks without allowing submission while a support request is open", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.createOrder();
    await harness.openSupport("sup_1", "ord_1", "2026-04-02T12:00:00.000Z");
    await harness.deliverShipment("shp_1", "ord_1", "2026-04-03T00:00:00.000Z");

    expect([...db.eligibilities.values()].map((row) => row.submission_state)).toEqual(["held", "held"]);
  });

  it("heals seller-cancellation eligibility when order lifecycle facts land after the Support resolution", async () => {
    const db = new ReviewSourceProjectionDb();
    const harness = buildHarness(db);

    await harness.openSupport("sup_1", "ord_1", "2026-04-02T12:00:00.000Z");
    await harness.resolveSupport("sup_1", "ord_1", "cancel-order", "seller", "2026-04-04T00:00:00.000Z");
    expect(db.eligibilities.size).toBe(0);

    await harness.createOrder();
    await harness.cancelOrder("ord_1", "2026-04-05T00:00:00.000Z");

    expect(db.buyerEligibility()).toMatchObject({ eligible_at: "2026-04-05T00:00:00.000Z" });
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

// #3935: the account source projection additionally mirrors a public seller
// slug (same deterministic displayName+accountId derivation discovery uses)
// so the reputation MCP tools can resolve `subjectAccountSlug` without a
// cross-context runtime dependency.
describe("marketplace review account source projection", () => {
  class ReviewAccountSourceDb implements PgQueryable {
    public readonly accounts = new Map<string, { display_name: string; slug: string | null; status: string }>();

    async query<Row = Record<string, unknown>>(
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<PgQueryResult<Row>> {
      if (sql.includes("INSERT INTO marketplace_review_account_sources")) {
        const [accountId, displayName, slug] = values.map((value) => (value === null ? null : String(value)));
        this.accounts.set(accountId as string, {
          display_name: displayName as string,
          slug: slug as string | null,
          status: sql.includes("COALESCE((SELECT status")
            ? (this.accounts.get(accountId as string)?.status ?? "active")
            : "active",
        });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    }
  }

  it("derives and stores a public seller slug when an account is created", async () => {
    const db = new ReviewAccountSourceDb();
    const handlers = buildReviewAccountProjectionHandlers(db);

    await handlers["identity.account.created"]?.(
      event("identity.account.created", {
        accountId: "acc_seller_1",
        displayName: "Card Vault",
      }),
    );

    const account = db.accounts.get("acc_seller_1");
    expect(account?.display_name).toBe("Card Vault");
    expect(account?.slug).toMatch(/^card-vault-[a-z0-9-]+$/);
  });

  it("recomputes the slug when the display name changes on profile update", async () => {
    const db = new ReviewAccountSourceDb();
    const handlers = buildReviewAccountProjectionHandlers(db);

    await handlers["identity.account.created"]?.(
      event("identity.account.created", {
        accountId: "acc_seller_1",
        displayName: "Card Vault",
      }),
    );
    const originalSlug = db.accounts.get("acc_seller_1")?.slug;

    const renameEvent = {
      ...event("identity.account.profile-updated", { displayName: "Bargain Bin" }),
      streamId: "identity.account-acc_seller_1" as never,
    };
    await handlers["identity.account.profile-updated"]?.(renameEvent);

    const account = db.accounts.get("acc_seller_1");
    expect(account?.display_name).toBe("Bargain Bin");
    expect(account?.slug).toMatch(/^bargain-bin-[a-z0-9-]+$/);
    expect(account?.slug).not.toBe(originalSlug);
  });

  it("derives the same slug for the same account id and display name every time", async () => {
    const dbA = new ReviewAccountSourceDb();
    const dbB = new ReviewAccountSourceDb();
    const createdEvent = event("identity.account.created", {
      accountId: "acc_seller_stable",
      displayName: "Stable Seller",
    });

    await buildReviewAccountProjectionHandlers(dbA)["identity.account.created"]?.(createdEvent);
    await buildReviewAccountProjectionHandlers(dbB)["identity.account.created"]?.(createdEvent);

    expect(dbA.accounts.get("acc_seller_stable")?.slug).toBe(dbB.accounts.get("acc_seller_stable")?.slug);
  });
});
