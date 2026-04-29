import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
  seedMountedContextTestRuntimeIfEmpty,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createMarketplaceSeedRuntime,
  marketplaceSeedContextNames,
  marketplaceSeedLifecycleContextOrder,
  type MarketplaceSeedRuntimePools,
} from "../../payments/tests/support/marketplace-seed-test-runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseBaseUrl ? describe : describe.skip;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed fulfillment seed tests.");
  }

  return databaseBaseUrl;
}

describeWithDatabase("fulfillment seed", () => {
  let pools: MarketplaceSeedRuntimePools;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      marketplaceSeedContextNames,
      "fulfillment_seed",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls) as MarketplaceSeedRuntimePools;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  }, 120_000);

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("projects deterministic shipment lifecycle coverage", async () => {
    const runtime = createMarketplaceSeedRuntime(pools);
    await seedMountedContextTestRuntimeIfEmpty(runtime, marketplaceSeedLifecycleContextOrder);

    const shipmentStatuses = await pools.fulfillment.query<{ status: string }>(
      "SELECT status FROM fulfillment_shipment_pages ORDER BY shipment_id ASC",
    );
    expect(new Set(shipmentStatuses.rows.map((row) => row.status))).toEqual(
      new Set([
        "awaiting-package",
        "awaiting-label",
        "label-attached",
        "dispatched",
        "delivered",
        "returned",
        "exception",
      ]),
    );

    const before = await pools.fulfillment.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'fulfillment.%'",
    );
    await seedMountedContextTestRuntimeIfEmpty(runtime, marketplaceSeedLifecycleContextOrder);
    const after = await pools.fulfillment.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'fulfillment.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 120_000);
});
