import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createPostgresEventStore,
  eventCorePostgresSchemaSql,
  withPgTransaction,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { parseGlobalPosition, type EventStoreContext } from "@chase-sets/event-core/storage";
import { recordProjectionPoisonEvent } from "../../../../../infrastructure/bounded-context-runtime/subscription-store";
import {
  drainContextProcesses,
  eventSubscriptionSchemaSql,
  rebuildContextProjectionGroup,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  syncContextProjectionGroups,
  type MountedContextRuntimeEntry,
} from "@chase-sets/bounded-context-runtime";
import type { JsonObject } from "@chase-sets/primitives/json";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import { buildReviewApi, type ReputationApiEnv } from "../api/http";
import { createReviewOpportunityPublication } from "../integrations/opportunity-publication/publication";
import {
  opportunitySourceProjections,
  readOpportunitySourceProof,
} from "../integrations/opportunity-publication/source-proof";
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
const contextNames = ["marketplace", "ordering", "fulfillment", "platform-operations"] as const;
const now = () => new Date("2026-05-01T00:00:00Z");

describeDb("canonical opportunity publication persistence", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(url!, contextNames, "opportunity_publication");
    await ensureMultiContextTestDatabases(url!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.marketplace;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(marketplaceModule.schemaSql);
    await pool.query(eventSubscriptionSchemaSql);
    for (const name of contextNames.filter((name) => name !== "marketplace"))
      await pools[name].query(eventCorePostgresSchemaSql);
    await caughtUp();
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  function createRuntime() {
    const services = marketplaceModule.createServices(pool, {});
    const active: MountedContextRuntimeEntry = {
      contextName: "marketplace",
      module: marketplaceModule,
      services,
      pool,
      projectionHandlerSets: marketplaceModule.projectionHandlerSets!(services),
    };
    const unavailablePool: PgTransactionalPool = {
      async query() {
        throw new Error("Unselected source must not be read");
      },
      async connect() {
        throw new Error("Unselected source must not be read");
      },
    };
    const sourceNames = new Set(marketplaceModule.buildSubscriptions!(services).map((item) => item.sourceContextName));
    const mountedContexts: MountedContextRuntimeEntry[] = [
      active,
      ...[...sourceNames]
        .filter((name) => name !== "marketplace")
        .map((contextName) => ({
          ...active,
          contextName,
          mountRole: "source-only" as const,
          projectionHandlerSets: [],
          pool: contextNames.includes(contextName as (typeof contextNames)[number])
            ? pools[contextName as (typeof contextNames)[number]]
            : unavailablePool,
        })),
    ];
    const allRunners = resolveModuleSubscriptions(mountedContexts);
    const names = new Set<string>(opportunitySourceProjections.map(([name]) => name));
    const runtime = {
      mountedContexts,
      subscriptionRunners: allRunners.filter((runner) => names.has(runner.projectionName)),
      projectionGroups: resolveModuleProjectionGroups(mountedContexts, allRunners).filter((group) =>
        names.has(group.projectionName),
      ),
    };
    expect(runtime.subscriptionRunners).toHaveLength(8);
    expect(runtime.subscriptionRunners.map((runner) => runner.checkpointKey).sort()).toEqual(
      opportunitySourceProjections.map(([name, source, version]) => `${name}:${source}:v${version}`).sort(),
    );
    return runtime;
  }
  async function caughtUp() {
    const runtime = createRuntime();
    await syncContextProjectionGroups(runtime, "marketplace");
    await drainContextProcesses(runtime, { settleIdleCheckpoints: true });
    return runtime;
  }
  async function append(
    source: (typeof contextNames)[number],
    streamId: string,
    eventType: string,
    payload: JsonObject,
    expectedVersion: number | "no_stream" = "no_stream",
  ) {
    await createPostgresEventStore({ pool: pools[source] }).appendToStream({
      streamId,
      expectedVersion,
      context,
      events: [{ eventType, payload }],
    });
  }
  async function order(orderId = "ord_1", deliver = true) {
    await append("ordering", `ordering.order-${orderId}`, "ordering.order.created", {
      orderId,
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
    });
    if (deliver) {
      await append("fulfillment", `fulfillment.shipment-shp_${orderId}`, "fulfillment.shipment.created", {
        shipmentId: `shp_${orderId}`,
        orderId,
        createdAt: "2026-04-01T00:00:00Z",
      });
      await append(
        "fulfillment",
        `fulfillment.shipment-shp_${orderId}`,
        "fulfillment.shipment.delivered",
        {
          shipmentId: `shp_${orderId}`,
          deliveredAt: "2026-04-02T00:00:00Z",
        },
        1,
      );
    }
    await caughtUp();
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
    const appendReview = async (type: string, payload: JsonObject, version: number) => {
      await append("marketplace", "marketplace.review-rev_1", type, payload, version === 0 ? "no_stream" : version);
      await caughtUp();
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
    const runtime = createRuntime();
    await syncContextProjectionGroups(runtime, "marketplace");
    await rebuildContextProjectionGroup(runtime, "marketplace", "marketplace-review-projection");
    await drainContextProcesses(runtime, { settleIdleCheckpoints: true });
    expect(await publication().backfill()).toBe(100);
    expect(await publication().backfill()).toBe(1);
  });

  it("upgrades every durable schema element without changing valid runner authority", async () => {
    await order();
    const before = await readOpportunitySourceProof(pool);
    for (const migration of reviewOpportunityPublicationMigrations)
      for (const sql of migration.statements) await pool.query(sql);
    expect(await readOpportunitySourceProof(pool)).toEqual(before);
    expect(await publication().run(context)).toBe(1);
  });

  function rewriteProofSql(rewrite: (sql: string) => string): PgTransactionalPool {
    return {
      query: (sql, values) => pool.query(rewrite(sql), values),
      async connect() {
        const client = await pool.connect();
        return {
          query: (sql, values) => client.query(rewrite(sql), values),
          release: (error) => client.release(error),
        };
      },
    };
  }

  it("uses native local v1 authority: correct query publishes; stopped #9095 projector query cannot", async () => {
    await order();
    const localKeys = opportunitySourceProjections
      .filter(([, source]) => source === "marketplace")
      .map(([name, source, version]) => `${name}:${source}:v${version}`);
    expect(
      (
        await pool.query(
          "SELECT checkpoint_key FROM event_subscription_checkpoints WHERE checkpoint_key=ANY($1) ORDER BY checkpoint_key",
          [localKeys],
        )
      ).rows,
    ).toEqual(localKeys.sort().map((checkpoint_key) => ({ checkpoint_key })));
    expect((await pool.query("SELECT 1 FROM event_projection_checkpoints")).rows).toHaveLength(0);
    const stoppedQuery = `WITH expected AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS source(name text, source text, version integer)
     ), checkpoints AS (
       SELECT checkpoint.projection_name, checkpoint.last_global_position, checkpoint.checkpoint_key,
         'subscription' AS projection_kind
       FROM event_subscription_checkpoints AS checkpoint
       JOIN expected ON expected.name = checkpoint.projection_name
        AND expected.source = checkpoint.source_context_name AND expected.version = checkpoint.subscription_version
       WHERE expected.source <> 'marketplace'
       UNION ALL
       SELECT checkpoint.projector_name, checkpoint.last_global_position, checkpoint.projector_name,
         'projector' AS projection_kind
       FROM event_projection_checkpoints AS checkpoint
       JOIN expected ON expected.name = checkpoint.projector_name AND expected.source = 'marketplace'
     )
     SELECT checkpoint.projection_name, checkpoint.last_global_position::text AS position,
       generation.active_generation::text AS generation
     FROM checkpoints AS checkpoint
     JOIN event_projection_recovery_markers AS recovery
       ON recovery.projection_kind = checkpoint.projection_kind AND recovery.projection_key = checkpoint.checkpoint_key
      AND recovery.last_global_position >= checkpoint.last_global_position
     JOIN event_projection_group_generations AS generation
       ON generation.target_context_name = 'marketplace'
      AND generation.projection_name = checkpoint.projection_name AND generation.state = 'active'
     JOIN event_projection_group_revisions AS revision
       ON revision.target_context_name = 'marketplace' AND revision.projection_name = checkpoint.projection_name
      AND revision.projection_revision = CASE WHEN checkpoint.projection_name = 'marketplace-review-projection' THEN 2 ELSE 1 END
     WHERE NOT EXISTS (
       SELECT 1 FROM event_projection_blocked_streams AS blocked
       WHERE blocked.projection_key = checkpoint.checkpoint_key AND blocked.state <> 'resolved'
     )`;
    const stopped = rewriteProofSql((text) =>
      text.includes("SELECT checkpoint.projection_name") ? stoppedQuery : text,
    );
    expect(await readOpportunitySourceProof(pool)).not.toBeNull();
    expect(await readOpportunitySourceProof(stopped)).toBeNull();
    const stoppedPublication = createReviewOpportunityPublication({
      pool: stopped,
      eventStore: createPostgresEventStore({ pool: stopped }),
      now,
    });
    expect(await stoppedPublication.backfill()).toBe(0);
    expect(await stoppedPublication.run(context)).toBe(0);
    expect(await facts()).toHaveLength(0);
    expect(await publication().run(context)).toBe(1);
  });

  it.each([
    "checkpoint-absent",
    "recovery-absent",
    "recovery-behind",
    "group-rebuilding",
    "group-failed",
    "revision-stale",
    "blocked-stream",
    "local-before-review-head",
    "reaction-before-support",
  ] as const)("refuses isolated producer guard: %s", async (guard) => {
    await order();
    if (guard === "local-before-review-head") {
      await append("marketplace", "marketplace.review-guard", "diagnostic.review-head", { synthetic: true });
      await caughtUp();
    }
    if (guard === "reaction-before-support") {
      await append("platform-operations", "diagnostic.support-frontier", "diagnostic.horizon", { synthetic: true });
      await caughtUp();
    }
    const before = await readOpportunitySourceProof(pool);
    expect(before).not.toBeNull();
    const [name, source, version] =
      opportunitySourceProjections[
        guard === "reaction-before-support" ? 3 : guard === "local-before-review-head" ? 6 : 0
      ]!;
    const key = `${name}:${source}:v${version}`;
    switch (guard) {
      case "checkpoint-absent":
        await pool.query("DELETE FROM event_subscription_checkpoints WHERE checkpoint_key=$1", [key]);
        break;
      case "recovery-absent":
        await pool.query(
          "DELETE FROM event_projection_recovery_markers WHERE projection_kind='subscription' AND projection_key=$1",
          [key],
        );
        break;
      case "recovery-behind":
        await pool.query(
          "UPDATE event_projection_recovery_markers SET last_global_position=0 WHERE projection_kind='subscription' AND projection_key=$1",
          [key],
        );
        break;
      case "group-rebuilding":
      case "group-failed":
        await pool.query(
          "UPDATE event_projection_group_generations SET state=$2 WHERE target_context_name='marketplace' AND projection_name=$1",
          [name, guard === "group-rebuilding" ? "rebuilding" : "failed"],
        );
        break;
      case "revision-stale":
        await pool.query(
          "UPDATE event_projection_group_revisions SET projection_revision=2 WHERE target_context_name='marketplace' AND projection_name=$1",
          [name],
        );
        break;
      case "blocked-stream":
        await recordProjectionPoisonEvent(pool, {
          projectionKey: key,
          projectionName: name,
          targetContextName: "marketplace",
          sourceContextName: source,
          subscriptionVersion: version,
          streamId: "diagnostic.blocked",
          streamVersion: 1,
          eventId: "evt_guard",
          eventType: "ordering.order.created",
          globalPosition: parseGlobalPosition("1"),
          error: new Error("Synthetic guard control"),
        });
        break;
      case "local-before-review-head":
      case "reaction-before-support":
        await pool.query("UPDATE event_subscription_checkpoints SET last_global_position=0 WHERE checkpoint_key=$1", [
          key,
        ]);
        break;
    }
    expect(await readOpportunitySourceProof(pool)).toBeNull();
    expect(await publication().backfill()).toBe(0);
    expect(await publication().run(context)).toBe(0);
    expect(await facts()).toHaveLength(0);
    const bypasses: Partial<Record<typeof guard, readonly [string, string]>> = {
      "checkpoint-absent": [
        "FROM event_subscription_checkpoints AS checkpoint",
        `FROM (
        SELECT checkpoint_key, projection_name, source_context_name, subscription_version, last_global_position
          FROM event_subscription_checkpoints
        UNION ALL
        SELECT recovery.projection_key, expected.name, expected.source, expected.version, recovery.last_global_position
          FROM jsonb_to_recordset($1::jsonb) AS expected(name text, source text, version integer)
          JOIN event_projection_recovery_markers recovery ON recovery.projection_kind='subscription'
            AND recovery.projection_key=expected.name || ':' || expected.source || ':v' || expected.version
         WHERE NOT EXISTS (SELECT 1 FROM event_subscription_checkpoints retained
           WHERE retained.checkpoint_key=recovery.projection_key)
        ) AS checkpoint`,
      ],
      "recovery-absent": [
        "JOIN event_projection_recovery_markers AS recovery",
        "LEFT JOIN event_projection_recovery_markers AS recovery",
      ],
      "recovery-behind": ["AND recovery.last_global_position >= checkpoint.last_global_position", ""],
      "group-rebuilding": ["AND generation.state = 'active'", ""],
      "group-failed": ["AND generation.state = 'active'", ""],
      "revision-stale": [
        "AND revision.projection_revision = CASE WHEN checkpoint.projection_name = 'marketplace-review-projection' THEN 2 ELSE 1 END",
        "",
      ],
      "blocked-stream": ["blocked.state <> 'resolved'", "false"],
      "local-before-review-head": ["WHERE stream_id LIKE 'marketplace.review-%'", "WHERE false"],
      "reaction-before-support": [
        "checkpoint.last_global_position::text AS position",
        "CASE WHEN checkpoint.projection_name='marketplace-review-support-source-projection' THEN '0' ELSE checkpoint.last_global_position::text END AS position",
      ],
    };
    const bypass = bypasses[guard];
    if (bypass) {
      let rewrites = 0;
      const mutant = rewriteProofSql((sql) => {
        if (!sql.includes(bypass[0])) return sql;
        expect(sql.split(bypass[0])).toHaveLength(2);
        rewrites++;
        return sql.replace(bypass[0], bypass[1]);
      });
      const mutantProof = await readOpportunitySourceProof(mutant);
      expect(rewrites).toBe(1);
      expect(mutantProof).not.toBeNull();
      // The same fail-closed assertion is red under this one named SQL bypass, not under a second defect.
      expect(() => expect(mutantProof).toBeNull()).toThrow();
      console.info(`MUTANT_ASSERTION_RED producer ${guard}`);
    }
  });

  it("upgrades a populated pre-publication schema and backfills it without another source event", async () => {
    await resetMultiContextTestSchemas(pools);
    const previousSchema = marketplaceModule.schemaSql
      .replace(reviewOpportunityPublicationSchemaSql, "")
      .replace(reviewOpportunityPublicationTriggersSql, "");
    expect(previousSchema).not.toContain("CREATE TABLE IF NOT EXISTS marketplace_review_opportunity_work");
    await pool.query(previousSchema);
    await pool.query(eventSubscriptionSchemaSql);
    for (const name of contextNames.filter((name) => name !== "marketplace"))
      await pools[name].query(eventCorePostgresSchemaSql);
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
