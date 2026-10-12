// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { participantStoreMatrix } from "./participant-store-matrix.test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Support participant attempt tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["platform-operations"] as const;
describeDb("PostgreSQL runtime/version matrix and barrier race/history 500/501", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let store: EventStore;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "support_participant_attempt");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    store = createPostgresEventStore({ pool: pools["platform-operations"] });
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });
  participantStoreMatrix(() => store);
});
