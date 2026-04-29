import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
  seedMountedContextTestRuntimeIfEmpty,
} from "@chase-sets/bounded-context-runtime/test-support";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
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
    throw new Error("TEST_DATABASE_URL is required for database-backed settlement seed tests.");
  }

  return databaseBaseUrl;
}

describeWithDatabase("settlement seed", () => {
  let pools: MarketplaceSeedRuntimePools;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      marketplaceSeedContextNames,
      "settlement_seed",
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

  it("creates deterministic wallet and payout projections", async () => {
    const runtime = createMarketplaceSeedRuntime(pools);
    await seedMountedContextTestRuntimeIfEmpty(runtime, marketplaceSeedLifecycleContextOrder);

    const wallet = await pools.settlement.query<{
      pending_balance_amount: string;
      available_balance_amount: string;
    }>(
      `SELECT pending_balance_amount, available_balance_amount
       FROM settlement_wallet_pages
       WHERE account_id = $1`,
      [identitySeedIds.seller.accountId],
    );
    expect(wallet.rows[0]).toMatchObject({
      pending_balance_amount: "0.00",
      available_balance_amount: "26.49",
    });

    const payoutStatuses = await pools.settlement.query<{ status: string }>(
      "SELECT status FROM settlement_payout_pages ORDER BY payout_id ASC",
    );
    expect(new Set(payoutStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["completed", "failed"]),
    );

    const before = await pools.settlement.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'settlement.%'",
    );
    await seedMountedContextTestRuntimeIfEmpty(runtime, marketplaceSeedLifecycleContextOrder);
    const after = await pools.settlement.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'settlement.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 120_000);
});
