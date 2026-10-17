import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { module as catalogModule } from "@chase-sets/catalog";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
export const describeDb = databaseBaseUrl || process.env.CI ? describe : describe.skip;
export function database(suffix: string) {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  beforeAll(async () => {
    if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for operator-session DB proofs.");
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl, ["catalog"], suffix);
    await ensureMultiContextTestDatabases(databaseBaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  return () => pools.catalog;
}
