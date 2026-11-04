import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { module as catalogModule } from "../../../index";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("product contents runtime db", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "catalog_product_contents_runtime");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await pool.query(catalogModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools({ catalog: pool });
  });

  it("product contents append/projection interleaving", async () => {
    const eventStore = createPostgresEventStore({ pool });
    const context = {
      tenantId: "tnt_product_contents" as never,
      audit: { performedByUserId: "usr_product_contents" as never, forAccountId: "acc_product_contents" as never },
    };
    const streamId = "catalog.product-contents-cat_db_race";
    await eventStore.appendToStream({ streamId, expectedVersion: "no_stream", context, events: [] });
    await expect(
      eventStore.appendToStream({
        streamId,
        expectedVersion: 0,
        context,
        events: [{ eventType: "catalog.product-contents.resolved", payload: {} }],
      }),
    ).resolves.toHaveLength(1);
    await expect(
      eventStore.appendToStream({
        streamId,
        expectedVersion: 0,
        context,
        events: [{ eventType: "catalog.product-contents.resolved", payload: {} }],
      }),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
  });
});
