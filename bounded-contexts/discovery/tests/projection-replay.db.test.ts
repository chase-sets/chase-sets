import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapContextDatabase,
  createProjectionAwarePool,
  createSubscriptionRunner,
  drainSubscriptionRunners,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as discovery } from "../index";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}

const contextNames = ["catalog", "discovery"] as const;
const itemCount = 300;
const projectionNames = new Set(["discovery-item-detail-projection", "discovery-search-item-projection"]);

describe.skipIf(!databaseUrl)("Discovery Catalog replay", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, contextNames, "discovery_replay");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase({ contextName: "catalog", schemaSql: "" }, pools.catalog);

    const catalog = createPostgresEventStore({ pool: pools.catalog });
    for (let index = 1; index <= itemCount; index++) {
      const itemId = `item_${String(index).padStart(3, "0")}`;
      await catalog.appendToStream({
        streamId: `catalog.item-${itemId}`,
        expectedVersion: "no_stream",
        context: {
          tenantId: "tenant_test" as never,
          audit: { performedByUserId: "user_test" as never, forAccountId: "account_test" as never },
        },
        events: [
          {
            eventType: "catalog.catalog-item.created",
            payload: { itemId, languageCode: "en", title: `Card ${index}`, description: "Collectible card" },
          },
          { eventType: "catalog.catalog-item.field-value-set", payload: { fieldId: "collector", value: index } },
          { eventType: "catalog.catalog-item.tags-set", payload: { tags: ["foil", "first-edition"] } },
          {
            eventType: "catalog.catalog-item.image-urls-set",
            payload: { imageUrls: [`https://example.invalid/${itemId}`] },
          },
          { eventType: "catalog.catalog-item.published", payload: {} },
        ],
      });
    }
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function replay(oneEventAtATime: boolean) {
    await resetMultiContextTestSchemas({ discovery: pools.discovery });
    await bootstrapContextDatabase(discovery, pools.discovery);

    let statements = 0;
    let checkpoints = 0;
    const rawPool = pools.discovery;
    const pool: PgTransactionalPool = {
      query<Row>(sql: string, values?: readonly unknown[]) {
        statements++;
        return rawPool.query<Row>(sql, values);
      },
      async connect() {
        const client = await rawPool.connect();
        return {
          release: client.release.bind(client),
          query<Row>(sql: string, values?: readonly unknown[]) {
            statements++;
            if (sql.startsWith("WITH saved_checkpoint AS")) checkpoints++;
            return client.query<Row>(sql, values);
          },
        };
      },
    };
    const services = discovery.createServices(createProjectionAwarePool(pool), {});
    const runners = discovery.buildSubscriptions!(services)
      .filter((subscription) => projectionNames.has(subscription.projectionName))
      .map((subscription) =>
        createSubscriptionRunner(
          "discovery",
          pool,
          pools.catalog,
          oneEventAtATime ? { ...subscription, checkpointBatchSize: 1 } : subscription,
        ),
      );

    expect(runners).toHaveLength(projectionNames.size);
    const start = performance.now();
    await drainSubscriptionRunners(runners);
    const elapsedMs = Math.round(performance.now() - start);
    for (const runner of runners) {
      expect(runner.getStatus()).toMatchObject({ outstandingEventCount: "0", poisonEventCount: 0 });
    }
    return {
      elapsedMs,
      statements,
      checkpoints,
      search: (await rawPool.query("SELECT * FROM discovery_search_items ORDER BY catalog_item_id")).rows,
      terms: (await rawPool.query("SELECT * FROM discovery_search_item_identity_terms ORDER BY catalog_item_id, term"))
        .rows,
      details: (await rawPool.query("SELECT * FROM discovery_item_detail_pages ORDER BY catalog_item_id")).rows,
    };
  }

  it("checkpoints in batches without changing the projected rows", async () => {
    const single = await replay(true);
    const batched = await replay(false);
    for (const [name, { elapsedMs, statements, checkpoints }] of Object.entries({ single, batched })) {
      console.log(
        `${name}: ${itemCount} items in ${elapsedMs}ms, ${statements} statements, ${checkpoints} checkpoints`,
      );
    }

    expect(batched.search).toHaveLength(itemCount);
    expect(batched.search).toEqual(single.search);
    expect(batched.terms).toEqual(single.terms);
    expect(batched.details).toEqual(single.details);
    expect(batched.checkpoints).toBeLessThan(single.checkpoints / 10);
    expect(batched.statements).toBeLessThan(single.statements / 2);
  });
});
