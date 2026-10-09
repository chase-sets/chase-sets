import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPostgresEventStore,
  eventCorePostgresSchemaSql,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { toTransportEvent } from "@chase-sets/event-core";
import { parseGlobalPosition, type EventStoreContext } from "@chase-sets/event-core/storage";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { Hono } from "hono";
import type { OrderingApiEnv } from "../../../../api";
import { createAccountPurchaseOrderRoutes, createAccountSaleOrderRoutes } from "../../api/route";
import {
  drainContextProcesses,
  eventSubscriptionSchemaSql,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  syncContextProjectionGroups,
  type MountedContextRuntimeEntry,
} from "@chase-sets/bounded-context-runtime";
import type { JsonObject } from "@chase-sets/primitives/json";
import {
  markProjectionBlockedStreamRetrying,
  recordProjectionPoisonEvent,
  resolveProjectionBlockedStream,
} from "../../../../../../infrastructure/bounded-context-runtime/subscription-store";
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
const contextNames = ["ordering", "marketplace", "fulfillment", "platform-operations"] as const;

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
    sequence = 0;
    await resetMultiContextTestSchemas(pools);
    await pools.ordering.query(orderingModule.schemaSql);
    await pools.ordering.query(eventSubscriptionSchemaSql);
    await pools.marketplace.query(marketplaceModule.schemaSql);
    await pools.marketplace.query(eventSubscriptionSchemaSql);
    await pools.fulfillment.query(eventCorePostgresSchemaSql);
    await pools["platform-operations"].query(eventCorePostgresSchemaSql);
  });

  afterEach(() => vi.useRealTimers());

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

  function createRuntime() {
    const marketplace = marketplaceModule.createServices(pools.marketplace, {});
    const ordering = orderingModule.createServices(pools.ordering, {
      inventoryCleanupAuthority: { kind: "not-mounted" },
    });
    const marketplaceNames = new Set([
      "marketplace-review-order-source-projection",
      "marketplace-review-shipment-source-projection",
      "marketplace-review-support-source-projection",
      "marketplace-review-hold-reaction",
      "marketplace-review-scoring-reaction",
      "marketplace-review-moderation-reaction",
      "marketplace-review-projection",
      "marketplace-review-hold-projection",
    ]);
    const orderingName = "ordering-order-review-opportunity-projection";
    const unavailablePool: PgTransactionalPool = {
      query: async () => {
        throw new Error("Unselected source must not be read by this scoped reproduction");
      },
      connect: async () => {
        throw new Error("Unselected source must not be read by this scoped reproduction");
      },
    };
    const active: MountedContextRuntimeEntry[] = [
      {
        contextName: "marketplace",
        module: marketplaceModule,
        services: marketplace,
        pool: pools.marketplace,
        projectionHandlerSets: marketplaceModule.projectionHandlerSets!(marketplace),
      },
      {
        contextName: "ordering",
        module: orderingModule,
        services: ordering,
        pool: pools.ordering,
        projectionHandlerSets: orderingModule.projectionHandlerSets!(ordering),
      },
    ];
    // Resolve the unmodified modules. Only the selected groups execute; other source ports reject I/O.
    const sourceNames = new Set(
      active.flatMap((entry) =>
        entry.module.buildSubscriptions!(entry.services).map((subscription) => subscription.sourceContextName),
      ),
    );
    const mountedContexts: MountedContextRuntimeEntry[] = [
      ...active,
      ...[...sourceNames]
        .filter((name) => !active.some((entry) => entry.contextName === name))
        .map((contextName) => ({
          ...active[0]!,
          contextName,
          mountRole: "source-only" as const,
          projectionHandlerSets: [],
          pool:
            contextName === "fulfillment"
              ? pools.fulfillment
              : contextName === "platform-operations"
                ? pools["platform-operations"]
                : unavailablePool,
        })),
    ];
    const allRunners = resolveModuleSubscriptions(mountedContexts);
    const selected = (target: string, name: string) =>
      target === "marketplace" ? marketplaceNames.has(name) : target === "ordering" && name === orderingName;
    const runtime = {
      mountedContexts,
      subscriptionRunners: allRunners.filter((runner) => selected(runner.targetContextName, runner.projectionName)),
      projectionGroups: resolveModuleProjectionGroups(mountedContexts, allRunners).filter((group) =>
        selected(group.targetContextName, group.projectionName),
      ),
    };
    expect(runtime.subscriptionRunners).toHaveLength(12);
    expect(
      runtime.subscriptionRunners
        .filter((runner) => runner.targetContextName === "ordering")
        .map((runner) => runner.checkpointKey)
        .sort(),
    ).toEqual(
      ["ordering", "fulfillment", "platform-operations", "marketplace"]
        .map((source) => `${orderingName}:${source}:v2`)
        .sort(),
    );
    expect(runtime.projectionGroups.find((group) => group.targetContextName === "ordering")).toMatchObject({
      projectionRevision: 2,
    });
    const drain = async () => {
      await syncContextProjectionGroups(runtime, "marketplace");
      await syncContextProjectionGroups(runtime, "ordering");
      await drainContextProcesses(runtime, { settleIdleCheckpoints: true });
    };
    return { marketplace, ordering, runtime, drain };
  }

  async function current() {
    // A labeled synthetic horizon supports handler-only SQL contract fixtures below.
    // The real empty-source producer/consumer scenario never calls this helper.
    await createPostgresEventStore({ pool: pools.marketplace }).appendToStream({
      streamId: "marketplace.diagnostic-opportunity-contract",
      expectedVersion: "no_stream",
      context: {
        tenantId: "tnt_test",
        audit: { performedByUserId: "usr_test", forAccountId: "acc_buyer" },
      } as EventStoreContext,
      events: Array.from({ length: 40 }, () => ({ eventType: "diagnostic.horizon", payload: { synthetic: true } })),
    });
    await createRuntime().drain();
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
    await pools.ordering.query("UPDATE event_projection_group_generations SET state='active'");
    await pools.ordering.query("DELETE FROM event_projection_recovery_markers");
    expect((await read()).status).toBe("unavailable");
    await pools.ordering
      .query(`INSERT INTO event_projection_recovery_markers (projection_kind, projection_key, last_global_position, updated_at)
      SELECT 'subscription', checkpoint_key, last_global_position, now() FROM event_subscription_checkpoints`);
    await handlers[reviewOpportunityFactType]!(
      event(reviewOpportunityFactType, { ...fact("3"), factSchemaVersion: 2 }),
    );
    expect((await read()).status).toBe("unavailable");
  });

  it.each(["buyer", "seller"] as const)(
    "recovers %s opportunity and opposite absence after retained blocks resolve",
    async (authorRole) => {
      const pool = pools.ordering;
      await insertOrderPage(pool, "ord_1");
      await current();
      const snapshot = fact();
      const slot = { ...snapshot.buyerToSeller!, authorRole };
      await buildOrderingReputationProjectionHandlers(pool)[reviewOpportunityFactType]!(
        event(reviewOpportunityFactType, {
          ...snapshot,
          buyerToSeller: authorRole === "buyer" ? slot : null,
          sellerToBuyer: authorRole === "seller" ? slot : null,
        }),
      );
      const author = authorRole === "buyer" ? "acc_buyer" : "acc_seller";
      const opposite = authorRole === "buyer" ? "acc_seller" : "acc_buyer";
      const expectReady = async () => {
        expect(await read(author)).toMatchObject({
          status: "ready",
          opportunity: { author_role: authorRole, submission_state: "allowed" },
        });
        expect(await read(opposite)).toEqual({ status: "ready", opportunity: null });
        expect(await read("acc_foreign")).toEqual({ status: "unavailable", opportunity: null });
      };
      const expectUnavailable = async () => {
        for (const account of [author, opposite])
          expect(await read(account)).toEqual({ status: "unavailable", opportunity: null });
      };
      await expectReady();
      const projectionName = "ordering-order-review-opportunity-projection";
      for (const sourceContextName of ["ordering", "fulfillment", "platform-operations", "marketplace"]) {
        const projectionKey = `${projectionName}:${sourceContextName}:v2`;
        for (const streamId of ["stream_recovery", "stream_unresolved_control"]) {
          await recordProjectionPoisonEvent(pool, {
            projectionKey,
            projectionName,
            targetContextName: "ordering",
            sourceContextName,
            subscriptionVersion: 2,
            streamId,
            streamVersion: 1,
            eventId: `evt_${sourceContextName}_${streamId}`,
            eventType: reviewOpportunityFactType,
            globalPosition: parseGlobalPosition("1"),
            error: new Error("Synthetic recovery fixture"),
          });
        }
        await expectUnavailable();
        await markProjectionBlockedStreamRetrying(pool, projectionKey, "stream_recovery");
        await expectUnavailable();
        await resolveProjectionBlockedStream(pool, projectionKey, "stream_recovery");
        await expectUnavailable();
        await markProjectionBlockedStreamRetrying(pool, projectionKey, "stream_unresolved_control");
        await expectUnavailable();
        await resolveProjectionBlockedStream(pool, projectionKey, "stream_unresolved_control");
        const history = await pool.query<{ stream_id: string; state: string }>(
          "SELECT stream_id, state FROM event_projection_blocked_streams WHERE projection_key = $1 ORDER BY stream_id",
          [projectionKey],
        );
        expect(history.rows).toEqual([
          { stream_id: "stream_recovery", state: "resolved" },
          { stream_id: "stream_unresolved_control", state: "resolved" },
        ]);
        await expectReady();
      }
    },
  );

  it.each([
    "checkpoint-absent",
    "recovery-absent",
    "recovery-behind",
    "group-rebuilding",
    "group-failed",
    "revision-stale",
    "blocked-stream",
    "consumer-lag",
    "missing-fact",
    "malformed-fact",
  ] as const)("retains the sale under isolated consumer guard: %s", async (guard) => {
    await insertOrderPage(pools.ordering, "ord_1");
    const { ordering, drain } = createRuntime();
    await drain();
    await buildOrderingReputationProjectionHandlers(pools.ordering)[reviewOpportunityFactType]!(
      buildTransportEvent(reviewOpportunityFactType, fact(), { globalPosition: "0" }),
    );
    expect((await read()).status).toBe("ready");
    const name = "ordering-order-review-opportunity-projection";
    const key = `${name}:marketplace:v2`;
    switch (guard) {
      case "checkpoint-absent":
        await pools.ordering.query("DELETE FROM event_subscription_checkpoints WHERE checkpoint_key=$1", [key]);
        break;
      case "recovery-absent":
        await pools.ordering.query(
          "DELETE FROM event_projection_recovery_markers WHERE projection_kind='subscription' AND projection_key=$1",
          [key],
        );
        break;
      case "recovery-behind":
        await pools.ordering.query(
          "UPDATE event_subscription_checkpoints SET last_global_position=1 WHERE checkpoint_key=$1",
          [key],
        );
        break;
      case "group-rebuilding":
      case "group-failed":
        await pools.ordering.query(
          "UPDATE event_projection_group_generations SET state=$2 WHERE target_context_name='ordering' AND projection_name=$1",
          [name, guard === "group-rebuilding" ? "rebuilding" : "failed"],
        );
        break;
      case "revision-stale":
        await pools.ordering.query(
          "UPDATE event_projection_group_revisions SET projection_revision=1 WHERE target_context_name='ordering' AND projection_name=$1",
          [name],
        );
        break;
      case "blocked-stream":
        await recordProjectionPoisonEvent(pools.ordering, {
          projectionKey: key,
          projectionName: name,
          targetContextName: "ordering",
          sourceContextName: "marketplace",
          subscriptionVersion: 2,
          streamId: "diagnostic.blocked",
          streamVersion: 1,
          eventId: "evt_guard",
          eventType: reviewOpportunityFactType,
          globalPosition: parseGlobalPosition("0"),
          error: new Error("Synthetic guard control"),
        });
        break;
      case "consumer-lag":
        await pools.ordering.query(
          "UPDATE ordering_order_review_opportunity_pages SET source_position=1 WHERE order_id='ord_1'",
        );
        break;
      case "missing-fact":
        await pools.ordering.query("DELETE FROM ordering_order_review_opportunity_pages WHERE order_id='ord_1'");
        break;
      case "malformed-fact":
        // Keep valid=true so only the structural parser can reject this row.
        await pools.ordering.query(`UPDATE ordering_order_review_opportunity_pages
          SET fact=jsonb_set(fact,'{factSchemaVersion}','2'), valid=true WHERE order_id='ord_1'`);
        break;
    }
    expect(await read()).toEqual({ status: "unavailable", opportunity: null });
    const bypasses: Partial<Record<typeof guard, readonly [string, string]>> = {
      "checkpoint-absent": ["COUNT(*) = 4", "COUNT(*) = 3"],
      "recovery-absent": [
        "JOIN event_projection_recovery_markers AS recovery",
        "LEFT JOIN event_projection_recovery_markers AS recovery",
      ],
      "recovery-behind": ["AND recovery.last_global_position >= checkpoint.last_global_position", ""],
      "group-rebuilding": ["AND generation.state = 'active'", ""],
      "group-failed": ["AND generation.state = 'active'", ""],
      "revision-stale": ["AND revision.projection_revision = 2", ""],
      "blocked-stream": ["blocked.state <> 'resolved'", "false"],
      "consumer-lag": ["checkpoint.last_global_position >= opportunity.source_position", "true"],
    };
    const bypass = bypasses[guard];
    if (bypass) {
      const mutant: PgQueryable = {
        query<Row>(sql: string, values?: readonly unknown[]) {
          expect(sql.split(bypass[0])).toHaveLength(2);
          return pools.ordering.query<Row>(sql.replace(bypass[0], bypass[1]), values);
        },
      };
      const mutantOutcome = await getOrderingOrderReviewOpportunity(mutant, {
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        now: new Date("2026-05-01T00:00:00Z"),
      });
      expect(mutantOutcome.status).toBe("ready");
      expect(() => expect(mutantOutcome).toEqual({ status: "unavailable", opportunity: null })).toThrow();
      console.info(`MUTANT_ASSERTION_RED consumer ${guard}`);
    }
    const app = new Hono<OrderingApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "ses_1",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "reputation.view", "reputation.manage"],
      });
      await next();
    });
    app.route("/account", createAccountSaleOrderRoutes(ordering.orders));
    const response = await app.request("/account/sales/ord_1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      order_id: "ord_1",
      reviewOutcome: { status: "unavailable", opportunity: null },
    });
  });

  it.each(["held", "revealed-after-deadline"] as const)(
    "preserves synthetic canonical %s facts after the deadline",
    async (state) => {
      await insertOrderPage(pools.ordering, "ord_1");
      await current();
      const original = fact();
      const snapshot: ReviewOpportunityChangedV1 = {
        ...original,
        buyerToSeller: {
          ...original.buyerToSeller!,
          held: state === "held",
          submissionState: state === "held" ? "held" : "allowed",
          activeReviewId: "rev_canonical",
          activeReviewRevealedAt: state === "held" ? null : "2026-06-02T12:00:00.000Z",
        },
      };
      await buildOrderingReputationProjectionHandlers(pools.ordering)[reviewOpportunityFactType]!(
        event(reviewOpportunityFactType, snapshot),
      );
      expect(await read("acc_buyer", new Date("2026-06-03T12:00:00Z"))).toMatchObject({
        status: "ready",
        opportunity: {
          submission_state: state === "held" ? "held" : "allowed",
          window_expired: false,
          revealed: state !== "held",
        },
      });
    },
  );

  it.each(["empty", "irrelevant-source", "complete-metadata"] as const)(
    "publishes expired withdrawn sales through real runners: %s support authority",
    async (supportAuthority) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
      const context = {
        tenantId: "tnt_test",
        audit: { performedByUserId: "usr_test", forAccountId: "acc_seller" },
      } as EventStoreContext;
      const { marketplace, ordering, runtime, drain } = createRuntime();
      const append = async (
        source: (typeof contextNames)[number],
        streamId: string,
        eventType: string,
        payload: JsonObject,
        expectedVersion: number | "no_stream" = "no_stream",
      ) =>
        createPostgresEventStore({ pool: pools[source] }).appendToStream({
          streamId,
          expectedVersion,
          context,
          events: [{ eventType, payload }],
        });
      await insertOrderPage(pools.ordering, "ord_runtime");
      await append("ordering", "ordering.order-ord_runtime", "ordering.order.created", {
        orderId: "ord_runtime",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
      });
      await append("fulfillment", "fulfillment.shipment-shp_runtime", "fulfillment.shipment.created", {
        shipmentId: "shp_runtime",
        orderId: "ord_runtime",
        createdAt: "2026-03-21T12:00:00Z",
      });
      await append(
        "fulfillment",
        "fulfillment.shipment-shp_runtime",
        "fulfillment.shipment.delivered",
        {
          shipmentId: "shp_runtime",
          deliveredAt: "2026-03-22T12:00:00Z",
        },
        1,
      );
      await append("marketplace", "marketplace.review-rev_runtime", "marketplace.review.submitted", {
        reviewId: "rev_runtime",
        orderId: "ord_runtime",
        authorAccountId: "acc_seller",
        subjectAccountId: "acc_buyer",
        authorRole: "seller",
        rating: 5,
        feedback: "withdrawn private sentinel",
        submittedAt: "2026-03-23T12:00:00Z",
        reviewWindowExpiresAt: "2026-05-21T12:00:00Z",
      });
      await append(
        "marketplace",
        "marketplace.review-rev_runtime",
        "marketplace.review.withdrawn",
        {
          reviewId: "rev_runtime",
          withdrawnAt: "2026-05-20T12:00:00Z",
        },
        1,
      );

      if (supportAuthority !== "empty") {
        // Independent synthetic horizon control, never a prerequisite for empty-source success.
        await append("platform-operations", "diagnostic.horizon-9127", "diagnostic.horizon", { synthetic: true });
      }
      if (supportAuthority === "complete-metadata") await drain();
      const readSale = (now = new Date("2026-05-22T12:00:00Z")) =>
        getOrderingOrderReviewOpportunity(pools.ordering, {
          orderId: "ord_runtime",
          authorAccountId: "acc_seller",
          now,
        });
      const app = new Hono<OrderingApiEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", {
          sessionId: "ses_1",
          tenantId: "tnt_test",
          userId: "usr_test",
          accountId: "acc_seller",
          membershipId: "mbr_1",
          roleKey: "owner",
          permissions: ["orders.view", "reputation.view", "reputation.manage"],
        });
        await next();
      });
      app.route("/account", createAccountSaleOrderRoutes(ordering.orders));

      await drain();
      const otherRunners = runtime.subscriptionRunners.filter(
        (runner) => runner.sourceContextName !== "platform-operations",
      );
      const otherCheckpointState = () =>
        Promise.all(
          otherRunners.map(
            async (runner) =>
              (
                await pools[runner.targetContextName as "ordering" | "marketplace"].query(
                  `SELECT c.checkpoint_key, c.last_global_position::text, r.last_global_position::text AS recovery,
          g.state, g.active_generation::text, v.projection_revision,
          (SELECT count(*)::int FROM event_projection_blocked_streams b
           WHERE b.projection_key=c.checkpoint_key AND b.state<>'resolved') AS blocked
         FROM event_subscription_checkpoints c
         JOIN event_projection_recovery_markers r ON r.projection_key=c.checkpoint_key AND r.projection_kind='subscription'
         JOIN event_projection_group_generations g ON g.projection_name=c.projection_name AND g.target_context_name=$2
         JOIN event_projection_group_revisions v ON v.projection_name=c.projection_name AND v.target_context_name=$2
         WHERE c.checkpoint_key=$1`,
                  [runner.checkpointKey, runner.targetContextName],
                )
              ).rows,
          ),
        );
      const otherCheckpoints = await otherCheckpointState();
      await drain();
      expect(await otherCheckpointState()).toEqual(otherCheckpoints);
      expect(otherCheckpoints).toHaveLength(7);
      for (const [index, rows] of otherCheckpoints.entries()) {
        const runner = otherRunners[index]!;
        expect(rows).toEqual([
          expect.objectContaining({
            checkpoint_key: runner.checkpointKey,
            state: "active",
            blocked: 0,
            last_global_position: runner.getStatus().sourceHeadGlobalPosition,
            recovery: runner.getStatus().sourceHeadGlobalPosition,
            projection_revision: runtime.projectionGroups.find(
              (group) =>
                group.targetContextName === runner.targetContextName && group.projectionName === runner.projectionName,
            )!.projectionRevision,
          }),
        ]);
      }

      const supportRunners = runtime.subscriptionRunners.filter(
        (runner) => runner.sourceContextName === "platform-operations",
      );
      expect(supportRunners).toHaveLength(5);
      for (const runner of supportRunners) {
        const position = supportAuthority === "empty" ? "0" : runner.getStatus().sourceHeadGlobalPosition;
        expect(runner.getStatus()).toMatchObject({
          initialized: true,
          state: "caught-up",
          lastGlobalPosition: position,
        });
        const rows = await pools[runner.targetContextName as "ordering" | "marketplace"].query(
          `SELECT c.checkpoint_key, c.last_global_position::text AS position,
          r.last_global_position::text AS recovery, r.projection_kind
         FROM event_subscription_checkpoints c
         JOIN event_projection_recovery_markers r ON r.projection_key=c.checkpoint_key
          AND r.projection_kind='subscription'
         WHERE c.checkpoint_key=$1`,
          [runner.checkpointKey],
        );
        expect(rows.rows).toEqual([
          {
            checkpoint_key: runner.checkpointKey,
            position,
            recovery: position,
            projection_kind: "subscription",
          },
        ]);
      }
      expect(
        await createPostgresEventStore({ pool: pools["platform-operations"] }).readAll({ limit: 10 }),
      ).toHaveLength(supportAuthority === "empty" ? 0 : 1);
      expect(await marketplace.reviewOpportunityPublication.run(context)).toBe(1);
      await drain();
      expect(await readSale(new Date("2026-05-20T12:00:00Z"))).toMatchObject({
        status: "ready",
        opportunity: {
          author_role: "seller",
          active_review_id: null,
          submission_state: "allowed",
          window_expired: false,
        },
      });
      const expired = {
        status: "ready",
        opportunity: {
          author_role: "seller",
          eligible_at: "2026-03-22T12:00:00.000Z",
          window_expires_at: "2026-05-21T12:00:00.000Z",
          active_review_id: null,
          submission_state: "expired",
          window_expired: true,
          hold_reason: null,
        },
      };
      expect(await readSale()).toMatchObject(expired);
      expect(await readSale()).toMatchObject(expired);
      expect(await marketplace.reviewOpportunityPublication.run(context)).toBe(0);
      const eventsBeforeDeadline = await createPostgresEventStore({ pool: pools.marketplace }).readAll({ limit: 100 });
      vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
      const allowedResponse = await app.request("/account/sales/ord_runtime");
      expect(allowedResponse.status).toBe(200);
      expect(await allowedResponse.json()).toMatchObject({
        order_id: "ord_runtime",
        reviewOutcome: {
          status: "ready",
          opportunity: {
            author_role: "seller",
            active_review_id: null,
            submission_state: "allowed",
            window_expired: false,
          },
        },
      });
      vi.setSystemTime(new Date("2026-05-22T12:00:00Z"));
      for (let load = 0; load < 2; load++) {
        const response = await app.request("/account/sales/ord_runtime");
        expect(response.status).toBe(200);
        const dto = await response.json();
        expect(dto).toMatchObject({ order_id: "ord_runtime", reviewOutcome: expired });
        expect(JSON.stringify(dto)).not.toContain("withdrawn private sentinel");
      }
      expect(await createPostgresEventStore({ pool: pools.marketplace }).readAll({ limit: 100 })).toEqual(
        eventsBeforeDeadline,
      );
      const beforeRestart = await createPostgresEventStore({ pool: pools.marketplace }).readAll({
        eventTypes: [reviewOpportunityFactType],
        limit: 10,
      });
      const restarted = createRuntime();
      await restarted.drain();
      expect(await restarted.marketplace.reviewOpportunityPublication.run(context)).toBe(0);
      expect(await restarted.marketplace.reviewOpportunityPublication.backfill()).toBe(1);
      expect(await restarted.marketplace.reviewOpportunityPublication.run(context)).toBe(1);
      await restarted.drain();
      expect(await restarted.marketplace.reviewOpportunityPublication.backfill()).toBe(0);
      expect(await restarted.marketplace.reviewOpportunityPublication.run(context)).toBe(0);
      const afterRestart = await createPostgresEventStore({ pool: pools.marketplace }).readAll({
        eventTypes: [reviewOpportunityFactType],
        limit: 10,
      });
      expect(afterRestart).toHaveLength(beforeRestart.length + 1);
      expect(await readSale()).toMatchObject(expired);
    },
  );

  it("upgrades a populated Ordering schema without deriving an opportunity from old eligibility rows", async () => {
    await resetMultiContextTestSchemas(pools);
    const previousSchema = orderingModule.schemaSql.replace(orderingOpportunitySchemaSql, "");
    expect(previousSchema).not.toContain("CREATE TABLE IF NOT EXISTS ordering_order_review_opportunity_pages");
    await pools.ordering.query(previousSchema);
    await pools.ordering.query(eventSubscriptionSchemaSql);
    await pools.marketplace.query(marketplaceModule.schemaSql);
    await pools.marketplace.query(eventSubscriptionSchemaSql);
    await pools.fulfillment.query(eventCorePostgresSchemaSql);
    await pools["platform-operations"].query(eventCorePostgresSchemaSql);
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
