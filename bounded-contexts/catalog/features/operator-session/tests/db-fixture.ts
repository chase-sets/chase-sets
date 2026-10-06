import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
export const describeDb = databaseBaseUrl ? describe : describe.skip;
export const keyring = { activeKeyId: "synthetic-key", keys: new Map([["synthetic-key", new Uint8Array(32).fill(7)]]) };
export const observedAt = "2026-10-01T00:00:00.000Z";
export const session = (expectedRevision: number, value = "synthetic-operator-cookie") => ({
  expectedRevision,
  value,
  observedAt,
  browserExpiresAt: null,
});

export function useOperatorSessionDatabase(suffix: string) {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], suffix);
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
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
