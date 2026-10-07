import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createPostgresEventStore, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { eventSubscriptionSchemaSql } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import {
  buildReviewOrderSourceProjectionHandlers,
  buildReviewShipmentSourceProjectionHandlers,
} from "../integrations/source/source-projection";
import { buildReviewProjectionHandlers } from "../read-model/projection";
import { buildReviewApi, type ReputationApiEnv } from "../api/http";
import { createReviewOpportunityPublication } from "../integrations/opportunity-publication/publication";
import { opportunitySourceProjections } from "../integrations/opportunity-publication/source-proof";
import {
  reviewOpportunityPublicationMigrations,
  reviewOpportunityPublicationSchemaSql,
  reviewOpportunityPublicationTriggersSql,
} from "../integrations/opportunity-publication/schema";
import { reviewOpportunityFactType } from "@chase-sets/event-core/review-opportunity-facts";

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = url ? describe : describe.skip;
const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_test", forAccountId: "acc_buyer" },
} as EventStoreContext;
const now = () => new Date("2026-05-01T00:00:00Z");

describeDb("canonical opportunity publication persistence", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(url!, ["marketplace"], "opportunity_publication");
    await ensureMultiContextTestDatabases(url!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.marketplace;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(marketplaceModule.schemaSql);
    await pool.query(eventSubscriptionSchemaSql);
    await caughtUp();
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  // Synthetic source checkpoints are explicit fixture inputs, not hosted or production evidence.
  async function caughtUp(position = "100", generation = "1") {
    for (const [name, source, version] of opportunitySourceProjections) {
      const key = `${name}:${source}:v${version}`;
      await pool.query(
        `INSERT INTO event_subscription_checkpoints
        (checkpoint_key, projection_name, source_context_name, subscription_version, last_global_position, updated_at)
        VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (checkpoint_key) DO UPDATE SET last_global_position = $5`,
        [key, name, source, version, position],
      );
      await pool.query(
        `INSERT INTO event_projection_recovery_markers (projection_kind, projection_key, last_global_position, updated_at)
        VALUES ('subscription',$1,$2,now()) ON CONFLICT (projection_kind, projection_key) DO UPDATE SET last_global_position = $2`,
        [key, position],
      );
      await pool.query(
        `INSERT INTO event_projection_group_generations (target_context_name, projection_name, active_generation, state, updated_at)
        VALUES ('marketplace',$1,$2,'active',now()) ON CONFLICT (target_context_name, projection_name) DO UPDATE
        SET active_generation=$2, state='active'`,
        [name, generation],
      );
      await pool.query(
        `INSERT INTO event_projection_group_revisions (target_context_name, projection_name, projection_revision, updated_at)
        VALUES ('marketplace',$1,$2,now()) ON CONFLICT DO NOTHING`,
        [name, name === "marketplace-review-projection" ? 2 : 1],
      );
    }
  }
  async function order(orderId = "ord_1", deliver = true) {
    const services = createMarketplaceServices(pool);
    await buildReviewOrderSourceProjectionHandlers(pool)["ordering.order.created"]!(
      buildTransportEvent("ordering.order.created", {
        orderId,
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
      }),
    );
    if (!deliver) return;
    const shipment = buildReviewShipmentSourceProjectionHandlers(pool, {
      onDeliveredShipment: services.reviews.recordDeliveredShipmentReviewEligibility,
    });
    await shipment["fulfillment.shipment.created"]!(
      buildTransportEvent("fulfillment.shipment.created", {
        shipmentId: `shp_${orderId}`,
        orderId,
        createdAt: "2026-04-01T00:00:00Z",
      }),
    );
    await shipment["fulfillment.shipment.delivered"]!(
      buildTransportEvent("fulfillment.shipment.delivered", {
        shipmentId: `shp_${orderId}`,
        deliveredAt: "2026-04-02T00:00:00Z",
      }),
    );
  }
  function publication() {
    return createReviewOpportunityPublication({ pool, eventStore: createPostgresEventStore({ pool }), now });
  }
  async function facts() {
    return createPostgresEventStore({ pool }).readAll({ eventTypes: [reviewOpportunityFactType], limit: 100 });
  }

  it("publishes both canonical directions, real reveal JSON, held feedback, withdrawal and absence without content", async () => {
    await order();
    expect(await publication().run(context)).toBe(1);
    expect((await facts()).at(-1)!.payload).toMatchObject({
      buyerToSeller: { activeReviewId: null },
      sellerToBuyer: { activeReviewId: null },
    });
    const store = createPostgresEventStore({ pool });
    const appendReview = async (type: string, payload: Record<string, string | number | null>, version: number) => {
      const stored = await store.appendToStream({
        streamId: "marketplace.review-rev_1",
        expectedVersion: version === 0 ? "no_stream" : version,
        context,
        events: [{ eventType: type, payload }],
      });
      await buildReviewProjectionHandlers(pool)[type]!(toTransportEvent(stored[0]!));
    };
    await appendReview(
      "marketplace.review.submitted",
      {
        reviewId: "rev_1",
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 5,
        feedback: "private sentinel",
        submittedAt: "2026-04-03T00:00:00Z",
        reviewWindowExpiresAt: "2026-06-01T00:00:00Z",
      },
      0,
    );
    await publication().run(context);
    expect((await facts()).at(-1)!.payload).toMatchObject({
      buyerToSeller: { activeReviewId: "rev_1", activeReviewRevealedAt: null },
    });
    await appendReview(
      "marketplace.review.revealed",
      { reviewId: "rev_1", revealedAt: "2026-04-04T00:00:00Z", revealReason: "counterpart-submitted" },
      1,
    );
    await publication().run(context);
    const revealed = (await facts()).at(-1)!.payload;
    expect(revealed).toMatchObject({ buyerToSeller: { activeReviewRevealedAt: "2026-04-04T00:00:00.000Z" } });
    expect(JSON.stringify(revealed)).not.toMatch(/private sentinel|rating|feedback|reason|response/);
    const api = new Hono<ReputationApiEnv>();
    api.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "ses_1",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["reputation.view"],
      });
      await next();
    });
    api.route("/", buildReviewApi(createMarketplaceServices(pool).reviews));
    const response = await api.request("/reviews/opportunities/orders/ord_1");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(typeof json.active_review_revealed_at).toBe("string");
    expect(new Date(json.active_review_revealed_at).toISOString()).toBe("2026-04-04T00:00:00.000Z");
    await pool.query("UPDATE marketplace_review_pages SET held = true WHERE review_id = 'rev_1'");
    await publication().run(context);
    expect((await facts()).at(-1)!.payload).toMatchObject({
      buyerToSeller: { held: true, activeReviewRevealedAt: "2026-04-04T00:00:00.000Z" },
    });
    await appendReview("marketplace.review.withdrawn", { reviewId: "rev_1", withdrawnAt: "2026-04-05T00:00:00Z" }, 2);
    await publication().run(context);
    expect((await facts()).at(-1)!.payload).toMatchObject({
      buyerToSeller: { activeReviewId: null, activeReviewRevealedAt: null },
    });
    await pool.query("DELETE FROM marketplace_review_eligibility_pages WHERE order_id = 'ord_1'");
    await publication().run(context);
    expect((await facts()).at(-1)!.payload).toMatchObject({ buyerToSeller: null, sellerToBuyer: null });
  });

  it("rolls append and acknowledgement back together, then retries without duplicate publication", async () => {
    await order();
    const store = createPostgresEventStore({ pool });
    const failing = createReviewOpportunityPublication({
      pool,
      now,
      eventStore: {
        ...store,
        async appendToStreamInTransaction(db, input) {
          await store.appendToStreamInTransaction(db, input);
          throw new Error("injected after append");
        },
      },
    });
    await expect(failing.run(context)).rejects.toThrow("injected after append");
    expect(await facts()).toHaveLength(0);
    expect(await publication().run(context)).toBe(1);
    expect(await publication().run(context)).toBe(0);
    expect(await facts()).toHaveLength(1);
  });

  it("serializes concurrent publishers and retains a refresh that races a publication", async () => {
    await order();
    const result = await Promise.all([publication().run(context), publication().run(context)]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(1);
    const before = (await facts())[0]!.payload.generation;
    await withPgTransaction(pool, async (db) => {
      await db.query("UPDATE marketplace_review_eligibility_pages SET submission_state='held' WHERE order_id='ord_1'");
      expect(await publication().run(context)).toBe(0);
    });
    expect(await publication().run(context)).toBe(1);
    const latest = (await facts()).at(-1)!.payload;
    expect(BigInt(String(latest.generation))).toBeGreaterThan(BigInt(String(before)));
    expect(latest).toMatchObject({ buyerToSeller: { held: true }, sellerToBuyer: { held: true } });
  });

  it("resumes historical backfill in bounded pages after replacement and is inert when caught up", async () => {
    await pool.query("ALTER TABLE marketplace_review_order_sources DISABLE TRIGGER review_opportunity_changed");
    await pool.query(`INSERT INTO marketplace_review_order_sources (order_id,buyer_account_id,seller_account_id,status,created_at,updated_at)
      SELECT 'ord_' || lpad(n::text,3,'0'),'acc_buyer','acc_seller','paid',now(),now() FROM generate_series(1,101) AS n`);
    await pool.query("ALTER TABLE marketplace_review_order_sources ENABLE TRIGGER review_opportunity_changed");
    expect(await publication().backfill()).toBe(100);
    expect(await publication().backfill()).toBe(1);
    expect(await publication().backfill()).toBe(0);
    expect(await publication().run(context)).toBe(100);
    expect(await publication().run(context)).toBe(1);
    expect(await publication().run(context)).toBe(0);
    await caughtUp("1000", "2");
    expect(await publication().backfill()).toBe(100);
    expect(await publication().backfill()).toBe(1);
  });

  it("refuses incomplete rebuild/recovery and upgrades every durable schema element", async () => {
    await order();
    await pool.query("DELETE FROM event_projection_recovery_markers");
    expect(await publication().run(context)).toBe(0);
    await caughtUp();
    await pool.query("UPDATE event_projection_group_generations SET state='rebuilding'");
    expect(await publication().backfill()).toBe(0);
    expect(await publication().run(context)).toBe(0);
    await caughtUp();
    for (const migration of reviewOpportunityPublicationMigrations)
      for (const sql of migration.statements) await pool.query(sql);
    expect(await publication().run(context)).toBe(1);
  });

  it("upgrades a populated pre-publication schema and backfills it without another source event", async () => {
    await resetMultiContextTestSchemas(pools);
    const previousSchema = marketplaceModule.schemaSql
      .replace(reviewOpportunityPublicationSchemaSql, "")
      .replace(reviewOpportunityPublicationTriggersSql, "");
    expect(previousSchema).not.toContain("CREATE TABLE IF NOT EXISTS marketplace_review_opportunity_work");
    await pool.query(previousSchema);
    await pool.query(eventSubscriptionSchemaSql);
    await order("ord_historical", false);
    for (const migration of reviewOpportunityPublicationMigrations)
      for (const sql of migration.statements) await pool.query(sql);
    await caughtUp();
    expect(await publication().backfill()).toBe(1);
    expect(await publication().run(context)).toBe(1);
    expect((await facts())[0]!.payload).toMatchObject({
      orderId: "ord_historical",
      buyerToSeller: null,
      sellerToBuyer: null,
    });
  });
});
