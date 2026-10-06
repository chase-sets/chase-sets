import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { toTransportEvent } from "@chase-sets/event-core";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { Hono } from "hono";
import type { OrderingApiEnv } from "../../../../api";
import { createAccountPurchaseOrderRoutes } from "../../api/route";
import { eventSubscriptionSchemaSql } from "@chase-sets/bounded-context-runtime";
import {
  reviewOpportunityFactType,
  type ReviewOpportunityChangedV1,
} from "@chase-sets/event-core/review-opportunity-facts";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as orderingModule } from "../../../../index";
import { buildOrderingReputationProjectionHandlers } from "./reputation-projection";
import { orderingOpportunitySchemaSql, orderingOpportunitySchemaMigrations } from "./opportunity-schema";
import { getOrderingOrderDeliverySummary, getOrderingOrderReviewOpportunity } from "./reputation-queries";
import { createCheckpointStore, createOrderingOrderRuntimeForTest } from "../../api/runtime-test-harness";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["ordering", "marketplace"] as const;

let sequence = 0;

function event(type: string, data: Record<string, unknown>): TransportEvent {
  sequence += 1;
  return buildTransportEvent(type, data, {
    id: `evt_${sequence}`,
    streamId: `stream_${sequence}`,
    globalPosition: String(sequence),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_buyer" },
    timing: { occurredAt: "2026-04-02T00:00:00.000Z", recordedAt: "2026-04-02T00:00:00.000Z" },
  });
}

async function insertOrderPage(pool: PgTransactionalPool, orderId: string) {
  await pool.query(
    `INSERT INTO ordering_order_pages (
       order_id,
       source_type,
       buyer_account_id,
       seller_account_id,
       shipping_option,
       item_subtotal_amount,
       shipping_base_amount,
       shipping_discount_amount,
       shipping_charge_amount,
       total_amount,
       marketplace_sales_fee_amount,
       seller_net_amount,
       terms_resolved_at,
       status
     ) VALUES ($1, 'cart-checkout', 'acc_buyer', 'acc_seller', 'standard', 10, 0, 0, 0, 10, 1, 9, now(), 'paid')`,
    [orderId],
  );
}

describeDb("ordering reputation projection SQL persistence boundary", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "ordering_reputation");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.ordering.query(orderingModule.schemaSql);
    await pools.ordering.query(eventSubscriptionSchemaSql);
    await pools.marketplace.query(marketplaceModule.schemaSql);
    await pools.marketplace.query(eventSubscriptionSchemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("composes buyer delivery from only this order's mirrored shipments without changing stored status", async () => {
    const pool = pools.ordering;
    const handlers = buildOrderingReputationProjectionHandlers(pool);
    const runtime = createOrderingOrderRuntimeForTest({
      db: pool,
      eventStore: createPostgresEventStore({ pool }),
      checkpointStore: createCheckpointStore(),
      shippingQuotePolicy: {
        quote: () => ({ shippingOption: "standard", baseAmount: "0.00", discountAmount: "0.00", chargeAmount: "0.00" }),
      },
    });
    await insertOrderPage(pool, "ord_delivery");
    await pool.query("UPDATE ordering_order_pages SET status = 'ready-for-fulfillment' WHERE order_id = $1", [
      "ord_delivery",
    ]);
    await insertOrderPage(pool, "ord_unrelated");
    const created = async (shipmentId: string, orderId = "ord_delivery") =>
      handlers["fulfillment.shipment.created"]!(
        event("fulfillment.shipment.created", { shipmentId, orderId, createdAt: "2026-04-02T00:00:00.000Z" }),
      );
    const delivered = async (shipmentId: string, deliveredAt: string) =>
      handlers["fulfillment.shipment.delivered"]!(event("fulfillment.shipment.delivered", { shipmentId, deliveredAt }));
    const firstTime = "2026-04-03T10:15:00.000Z";
    const latestTime = "2026-04-09T17:42:00.000Z";
    // A later unrelated delivery exposes a missing order predicate in either COUNT or MAX.
    await created("shp_unrelated", "ord_unrelated");
    await delivered("shp_unrelated", "2026-04-20T22:30:00.000Z");

    async function expectSummary(shipment_count: number, delivered_count: number, latest: string | null) {
      const summary = await getOrderingOrderDeliverySummary(pool, "ord_delivery");
      expect(summary.shipment_count).toBe(shipment_count);
      expect(summary.delivered_count).toBe(delivered_count);
      expect(summary.latest_delivered_at === null ? null : new Date(summary.latest_delivered_at).toISOString()).toBe(
        latest,
      );
      const purchase = await runtime.getPurchase("ord_delivery", "acc_buyer");
      expect(purchase?.delivery_summary).toEqual(summary);
      expect(purchase?.status).toBe("ready-for-fulfillment");
    }

    await expectSummary(0, 0, null);
    await created("shp_first");
    await expectSummary(1, 0, null);
    await delivered("shp_first", firstTime);
    await expectSummary(1, 1, firstTime);
    await delivered("shp_first", firstTime);
    await expectSummary(1, 1, firstTime);
    await created("shp_second");
    await expectSummary(2, 1, firstTime);
    await delivered("shp_second", latestTime);
    await expectSummary(2, 2, latestTime);
    expect(await runtime.getPurchase("ord_delivery", "acc_foreign")).toBeNull();
    expect(await runtime.getPurchase("ord_missing", "acc_buyer")).toBeNull();
    const sale = await runtime.getSale("ord_delivery", "acc_seller");
    expect(sale?.status).toBe("ready-for-fulfillment");
    expect(sale).not.toHaveProperty("delivery_summary");
    const stored = await pool.query<{ status: string }>("SELECT status FROM ordering_order_pages WHERE order_id = $1", [
      "ord_delivery",
    ]);
    expect(stored.rows).toEqual([{ status: "ready-for-fulfillment" }]);
  });

  async function current() {
    const name = "ordering-order-review-opportunity-projection";
    await pools.ordering.query(
      `INSERT INTO event_projection_group_generations
      (target_context_name,projection_name,state,updated_at) VALUES ('ordering',$1,'active',now())
      ON CONFLICT (target_context_name,projection_name) DO UPDATE SET state='active'`,
      [name],
    );
    await pools.ordering.query(
      `INSERT INTO event_projection_group_revisions
      (target_context_name,projection_name,projection_revision,updated_at) VALUES ('ordering',$1,2,now())
      ON CONFLICT (target_context_name,projection_name) DO UPDATE SET projection_revision=2`,
      [name],
    );
    for (const source of ["ordering", "fulfillment", "platform-operations", "marketplace"]) {
      const key = `${name}:${source}:v2`;
      await pools.ordering.query(
        `INSERT INTO event_subscription_checkpoints
        (checkpoint_key,projection_name,source_context_name,subscription_version,last_global_position,updated_at)
        VALUES ($1,$2,$3,2,10000,now()) ON CONFLICT (checkpoint_key) DO UPDATE SET last_global_position=10000`,
        [key, name, source],
      );
      await pools.ordering.query(
        `INSERT INTO event_projection_recovery_markers
        (projection_kind,projection_key,last_global_position,updated_at) VALUES ('subscription',$1,10000,now())
        ON CONFLICT (projection_kind,projection_key) DO UPDATE SET last_global_position=10000`,
        [key],
      );
    }
  }
  function fact(generation = "1"): ReviewOpportunityChangedV1 {
    return {
      factSchemaVersion: 1,
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      generation,
      sourceGeneration: "1",
      generatedAt: "2026-04-02T00:00:00.000Z",
      provenance: { ordering: "1000", fulfillment: "1000", support: "1000", marketplace: "1000" },
      buyerToSeller: {
        authorRole: "buyer",
        eligibleAt: "2026-04-02T00:00:00.000Z",
        effectiveDeadlineAt: "2026-06-01T00:00:00.000Z",
        submissionState: "allowed",
        held: false,
        activeReviewId: null,
        activeReviewRevealedAt: null,
      },
      sellerToBuyer: null,
    };
  }
  const read = (account = "acc_buyer", now = new Date("2026-05-01T00:00:00Z")) =>
    getOrderingOrderReviewOpportunity(pools.ordering, { orderId: "ord_1", authorAccountId: account, now });

  it("atomically replaces both directions, fences stale/duplicate delivery and retains absence across restart", async () => {
    await insertOrderPage(pools.ordering, "ord_1");
    await current();
    const handler = () => buildOrderingReputationProjectionHandlers(pools.ordering)[reviewOpportunityFactType]!;
    const first = event(reviewOpportunityFactType, fact());
    await handler()(first);
    expect(await read()).toMatchObject({
      status: "ready",
      opportunity: { author_role: "buyer", submission_state: "allowed" },
    });
    expect(await read("acc_seller")).toEqual({ status: "ready", opportunity: null });
    expect(await read("acc_foreign")).toEqual({ status: "unavailable", opportunity: null });
    const absent = event(reviewOpportunityFactType, { ...fact("2"), buyerToSeller: null });
    await Promise.all([handler()(absent), handler()(first)]);
    await handler()(absent);
    expect(await read()).toEqual({ status: "ready", opportunity: null });
    await handler()(event(reviewOpportunityFactType, fact()));
    expect(await read()).toEqual({ status: "ready", opportunity: null });
    const rows = await pools.ordering.query<{ generation: string }>(
      "SELECT generation::text AS generation FROM ordering_order_review_opportunity_pages WHERE order_id='ord_1'",
    );
    expect(rows.rows).toEqual([{ generation: "2" }]);
  });

  it("keeps current absence distinct from missing, malformed, known lag and incomplete recovery", async () => {
    await insertOrderPage(pools.ordering, "ord_1");
    await current();
    expect((await read()).status).toBe("unavailable");
    const handlers = buildOrderingReputationProjectionHandlers(pools.ordering);
    await handlers[reviewOpportunityFactType]!(event(reviewOpportunityFactType, fact()));
    await pools.ordering.query(
      `INSERT INTO ordering_order_review_opportunity_sources VALUES ('ord_1','platform-operations',1001)`,
    );
    expect((await read()).status).toBe("unavailable");
    await handlers[reviewOpportunityFactType]!(
      event(reviewOpportunityFactType, { ...fact("2"), provenance: { ...fact().provenance, support: "1001" } }),
    );
    expect((await read()).status).toBe("ready");
    await pools.ordering.query("UPDATE event_projection_group_generations SET state='rebuilding'");
    expect((await read()).status).toBe("unavailable");
    await current();
    await pools.ordering.query("DELETE FROM event_projection_recovery_markers");
    expect((await read()).status).toBe("unavailable");
    await current();
    await handlers[reviewOpportunityFactType]!(
      event(reviewOpportunityFactType, { ...fact("3"), factSchemaVersion: 2 }),
    );
    expect((await read()).status).toBe("unavailable");
  });

  it("carries a real Marketplace publication through persistent Ordering projection and the authorized HTTP DTO", async () => {
    await insertOrderPage(pools.ordering, "ord_1");
    await current();
    const marketplace = marketplaceModule.createServices(pools.marketplace);
    const subscriptions = marketplaceModule.buildSubscriptions!(marketplace);
    const sourceNames = [
      "marketplace-review-order-source-projection",
      "marketplace-review-shipment-source-projection",
      "marketplace-review-support-source-projection",
      "marketplace-review-hold-reaction",
      "marketplace-review-scoring-reaction",
      "marketplace-review-moderation-reaction",
    ];
    const sources = [
      ...subscriptions.filter((item) => sourceNames.includes(item.projectionName)),
      ...["marketplace-review-projection", "marketplace-review-hold-projection"].map((projectionName) => ({
        projectionName,
        sourceContextName: "marketplace",
        subscriptionVersion: 1,
      })),
    ];
    expect(sources).toHaveLength(8);
    // Synthetic checkpoint fixture, with the real module's subscription versions.
    for (const source of sources) {
      const name = source.projectionName;
      const key = `${name}:${source.sourceContextName}:v${source.subscriptionVersion}`;
      await pools.marketplace.query(
        `INSERT INTO event_subscription_checkpoints
        (checkpoint_key,projection_name,source_context_name,subscription_version,last_global_position,updated_at)
        VALUES ($1,$2,$3,$4,1000,now())`,
        [key, name, source.sourceContextName, source.subscriptionVersion],
      );
      await pools.marketplace.query(
        `INSERT INTO event_projection_recovery_markers
        (projection_kind,projection_key,last_global_position,updated_at) VALUES ('subscription',$1,1000,now())`,
        [key],
      );
      await pools.marketplace.query(
        `INSERT INTO event_projection_group_generations
        (target_context_name,projection_name,state,updated_at) VALUES ('marketplace',$1,'active',now())`,
        [name],
      );
      await pools.marketplace.query(
        `INSERT INTO event_projection_group_revisions
        (target_context_name,projection_name,projection_revision,updated_at) VALUES ('marketplace',$1,$2,now())`,
        [name, name === "marketplace-review-projection" ? 2 : 1],
      );
    }
    await subscriptions.find((item) => item.projectionName === "marketplace-review-order-source-projection")!.handlers[
      "ordering.order.created"
    ]!(
      event("ordering.order.created", { orderId: "ord_1", buyerAccountId: "acc_buyer", sellerAccountId: "acc_seller" }),
    );
    const context = {
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_test", forAccountId: "acc_buyer" },
    } as EventStoreContext;
    expect(await marketplace.reviewOpportunityPublication.run(context)).toBe(1);
    const store = createPostgresEventStore({ pool: pools.marketplace });
    const consumeLatest = async () => {
      const published = (await store.readAll({ eventTypes: [reviewOpportunityFactType], limit: 10 })).at(-1)!;
      await buildOrderingReputationProjectionHandlers(pools.ordering)[reviewOpportunityFactType]!(
        toTransportEvent(published),
      );
    };
    await consumeLatest();
    expect(await read()).toEqual({ status: "ready", opportunity: null });
    const shipment = subscriptions.find(
      (item) => item.projectionName === "marketplace-review-shipment-source-projection",
    )!.handlers;
    await shipment["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        createdAt: "2026-04-01T00:00:00Z",
      }),
    );
    await shipment["fulfillment.shipment.delivered"]!(
      event("fulfillment.shipment.delivered", {
        shipmentId: "shp_1",
        deliveredAt: "2026-04-02T00:00:00Z",
      }),
    );
    expect(await marketplace.reviewOpportunityPublication.run(context)).toBe(1);
    await consumeLatest();
    expect(await read()).toMatchObject({
      status: "ready",
      opportunity: { author_role: "buyer", active_review_id: null },
    });
    const runtime = createOrderingOrderRuntimeForTest({
      db: pools.ordering,
      eventStore: createPostgresEventStore({ pool: pools.ordering }),
      checkpointStore: createCheckpointStore(),
      shippingQuotePolicy: {
        quote: () => ({ shippingOption: "standard", baseAmount: "0.00", discountAmount: "0.00", chargeAmount: "0.00" }),
      },
    });
    const app = new Hono<OrderingApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "ses_1",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "reputation.view", "reputation.manage"],
      });
      await next();
    });
    app.route("/account", createAccountPurchaseOrderRoutes(runtime));
    const response = await app.request("/account/purchases/ord_1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      order_id: "ord_1",
      delivery_summary: { shipment_count: 0 },
      reviewOutcome: { status: "ready", opportunity: { author_role: "buyer", active_review_revealed_at: null } },
    });
  });

  it("upgrades a populated Ordering schema without deriving an opportunity from old eligibility rows", async () => {
    await resetMultiContextTestSchemas(pools);
    const previousSchema = orderingModule.schemaSql.replace(orderingOpportunitySchemaSql, "");
    expect(previousSchema).not.toContain("CREATE TABLE IF NOT EXISTS ordering_order_review_opportunity_pages");
    await pools.ordering.query(previousSchema);
    await pools.ordering.query(eventSubscriptionSchemaSql);
    await insertOrderPage(pools.ordering, "ord_1");
    for (const migration of orderingOpportunitySchemaMigrations)
      for (const sql of migration.statements) await pools.ordering.query(sql);
    await current();
    expect(await read()).toEqual({ status: "unavailable", opportunity: null });
    await buildOrderingReputationProjectionHandlers(pools.ordering)[reviewOpportunityFactType]!(
      event(reviewOpportunityFactType, fact()),
    );
    expect((await read()).status).toBe("ready");
  });

  it("evaluates deadline passage without new events and keeps an old quiescent snapshot current", async () => {
    await insertOrderPage(pools.ordering, "ord_1");
    await current();
    await buildOrderingReputationProjectionHandlers(pools.ordering)[reviewOpportunityFactType]!(
      event(reviewOpportunityFactType, fact()),
    );
    expect(await read()).toMatchObject({ opportunity: { submission_state: "allowed" } });
    expect(await read("acc_buyer", new Date("2026-06-01T00:00:00Z"))).toMatchObject({
      opportunity: { submission_state: "expired" },
    });
    expect(await read("acc_seller", new Date("2036-01-01T00:00:00Z"))).toEqual({ status: "ready", opportunity: null });
    expect((await pools.ordering.query("SELECT 1 FROM ordering_order_review_eligibility_pages")).rowCount).toBe(0);
  });
});
