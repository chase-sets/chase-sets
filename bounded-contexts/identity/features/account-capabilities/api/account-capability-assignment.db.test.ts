import { afterAll, beforeAll, describe } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as identityModule } from "../../../index";
import { defineAssignmentContract } from "./assignment-contract.test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Account Capability assignment tests.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("Account Capability assignment PostgreSQL atomic audit and receipt", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "capability_assignment_9385");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  defineAssignmentContract(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.identity.query(identityModule.schemaSql);
    return createPostgresEventStore({ pool: pools.identity });
  });
});
