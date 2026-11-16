import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as checkoutModule } from "../../../index";
import { sellListAttemptCases } from "./sell-list-attempt.test-support";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Sell List attempt proof.");
(databaseUrl ? describe : describe.skip)(
  "Sell List attempts against real PostgreSQL (lagged confirmation projection is an injected read seam)",
  () => {
    let pools: Readonly<Record<"checkout", PgTransactionalPool>>;
    beforeAll(async () => {
      const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["checkout"], "sell_list_attempt");
      await ensureMultiContextTestDatabases(databaseUrl!, urls);
      pools = createMultiContextTestPools(urls);
    });
    beforeEach(async () => {
      await resetMultiContextTestSchemas(pools);
      await bootstrapContextDatabase(checkoutModule, pools.checkout);
      await pools.checkout.query(
        "INSERT INTO checkout_catalog_items (catalog_item_id, title, status, product_schema, language_code, updated_at) VALUES ('cat_attempt', 'Synthetic Item', 'active', NULL, 'en', now())",
      );
    });
    afterAll(async () => {
      if (pools) await closeMultiContextTestPools(pools);
    });
    sellListAttemptCases(
      () => createPostgresEventStore({ pool: pools.checkout }),
      () => pools.checkout,
    );
  },
);
