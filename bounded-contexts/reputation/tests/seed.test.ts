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
    throw new Error("TEST_DATABASE_URL is required for database-backed reputation seed tests.");
  }

  return databaseBaseUrl;
}

describeWithDatabase("reputation seed", () => {
  let pools: MarketplaceSeedRuntimePools;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      marketplaceSeedContextNames,
      "reputation_seed",
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

  it("creates review lifecycle projections and summary data", async () => {
    const runtime = createMarketplaceSeedRuntime(pools);
    await seedMountedContextTestRuntimeIfEmpty(runtime, marketplaceSeedLifecycleContextOrder);

    const reviewStatuses = await pools.reputation.query<{ status: string }>(
      "SELECT status FROM reputation_review_pages ORDER BY review_id ASC",
    );
    expect(new Set(reviewStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["active", "withdrawn"]),
    );

    const summary = await pools.reputation.query<{
      review_count: number;
      average_rating: string | null;
    }>(
      "SELECT review_count, average_rating::text AS average_rating FROM review_summary_pages",
    );
    expect(summary.rows[0]).toMatchObject({
      review_count: 1,
      average_rating: "5.00",
    });

    const before = await pools.reputation.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'reputation.%'",
    );
    await seedMountedContextTestRuntimeIfEmpty(runtime, marketplaceSeedLifecycleContextOrder);
    const after = await pools.reputation.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'reputation.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 120_000);
});
