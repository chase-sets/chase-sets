import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  composeModuleSchemaSql,
  createCheckpointKey,
  createProjectionAwarePool,
  createSubscriptionRunner,
  loadSubscriptionCheckpoint,
} from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { savedListReadModelSchemaSql } from "../../read-model/schema";
import { buildSavedListCatalogProjectionHandlers } from "./projection";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("Collections catalog publication on the real mirror schema", () => {
  const contextNames = ["catalog", "collections"] as const;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, contextNames, "collections_catalog");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(composeModuleSchemaSql({ schemaSql: "" }));
    await pools.collections.query(composeModuleSchemaSql({ schemaSql: savedListReadModelSchemaSql }));
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("applies eight published blueprints, reaches the source head and records no poisons", async () => {
    let recordedAt = "2026-05-09T00:00:00.000Z";
    const store = createPostgresEventStore({ pool: pools.catalog, now: () => recordedAt as never });
    const context = {
      tenantId: "tnt_catalog" as never,
      audit: { performedByUserId: "usr_catalog" as never, forAccountId: "acc_catalog" as never },
    };
    const handlers = buildSavedListCatalogProjectionHandlers(createProjectionAwarePool(pools.collections));
    const subscription = {
      subscriptionName: "collections-catalog-product-projection",
      sourceContextName: "catalog",
      projectionName: "collections-catalog-product-projection",
      subscriptionVersion: 1,
      handlers,
      eventTypes: Object.keys(handlers),
    };
    const runner = createSubscriptionRunner("collections", pools.collections, pools.catalog, subscription);
    const createdAt = recordedAt;
    for (let index = 1; index <= 8; index += 1) {
      await store.appendToStream({
        streamId: `catalog.blueprint-bp_${index}`,
        expectedVersion: "no_stream",
        context,
        events: [{ eventType: "catalog.blueprint.created", payload: { blueprintId: `bp_${index}`, name: "Card" } }],
      });
    }
    await runner.runOnce();
    recordedAt = "2026-05-10T00:00:00.000Z";
    for (let index = 1; index <= 8; index += 1) {
      await store.appendToStream({
        streamId: `catalog.blueprint-bp_${index}`,
        expectedVersion: 1,
        context,
        events: [{ eventType: "catalog.blueprint.revised", payload: { name: `Card ${index}` } }],
      });
    }
    await runner.runOnce();
    expect(
      (
        await pools.collections.query(
          "SELECT name, updated_at FROM collections_catalog_blueprints ORDER BY blueprint_id",
        )
      ).rows,
    ).toEqual(
      Array.from({ length: 8 }, (_, index) => ({ name: `Card ${index + 1}`, updated_at: new Date(recordedAt) })),
    );
    await pools.collections.query(
      `INSERT INTO collections_catalog_items (catalog_item_id, blueprint_id, updated_at)
      VALUES ('assigned', 'bp_1', $1), ('other', 'bp_other', $1)`,
      [createdAt],
    );
    recordedAt = "2026-05-11T00:00:00.000Z";
    for (let index = 1; index <= 8; index += 1) {
      await store.appendToStream({
        streamId: `catalog.blueprint-bp_${index}`,
        expectedVersion: 2,
        context,
        events: [{ eventType: "catalog.blueprint.published", payload: {} }],
      });
    }
    await runner.runOnce();
    expect(
      (
        await pools.catalog.query(
          "SELECT count(*)::int AS count FROM event_store_events WHERE event_type = 'catalog.blueprint.published'",
        )
      ).rows,
    ).toEqual([{ count: 8 }]);
    const head = (
      await pools.catalog.query<{ head: string }>("SELECT max(global_position)::text AS head FROM event_store_events")
    ).rows[0]!.head;
    expect(head).toBe("24");
    expect(await loadSubscriptionCheckpoint(pools.collections, createCheckpointKey(subscription))).toBe(head);
    expect(
      (await pools.collections.query("SELECT event_type, error_message FROM event_projection_poison_events")).rows,
    ).toEqual([]);
    expect((await pools.collections.query("SELECT * FROM event_projection_blocked_streams")).rows).toEqual([]);
    expect(
      (
        await pools.collections.query(
          "SELECT blueprint_id, name, updated_at FROM collections_catalog_blueprints ORDER BY blueprint_id",
        )
      ).rows,
    ).toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        blueprint_id: `bp_${index + 1}`,
        name: `Card ${index + 1}`,
        updated_at: new Date(recordedAt),
      })),
    );
    expect(
      (
        await pools.collections.query(
          "SELECT catalog_item_id, product_schema, updated_at FROM collections_catalog_items ORDER BY catalog_item_id",
        )
      ).rows,
    ).toEqual([
      {
        catalog_item_id: "assigned",
        product_schema: { canonicalDimensionOrder: [], dimensions: [] },
        updated_at: new Date(createdAt),
      },
      { catalog_item_id: "other", product_schema: null, updated_at: new Date(createdAt) },
    ]);
    await runner.runOnce();
    expect(await loadSubscriptionCheckpoint(pools.collections, createCheckpointKey(subscription))).toBe(head);
  });
});
