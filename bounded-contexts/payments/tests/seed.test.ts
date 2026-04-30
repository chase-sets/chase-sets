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
} from "./support/marketplace-seed-test-runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseBaseUrl ? describe : describe.skip;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed payments seed tests.");
  }

  return databaseBaseUrl;
}

describeWithDatabase("payments seed", () => {
  let pools: MarketplaceSeedRuntimePools;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      marketplaceSeedContextNames,
      "payments_seed",
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

  it("creates deterministic payment and refund lifecycle projections", async () => {
    const runtime = createMarketplaceSeedRuntime(pools);
    await seedMountedContextTestRuntimeIfEmpty(runtime, marketplaceSeedLifecycleContextOrder);

    const paymentStatuses = await pools.payments.query<{ status: string }>(
      "SELECT status FROM payments_payment_pages ORDER BY payment_id ASC",
    );
    expect(new Set(paymentStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["pending-confirmation", "captured", "failed", "cancelled"]),
    );

    const refundStatuses = await pools.payments.query<{ status: string }>(
      "SELECT status FROM payments_refund_pages ORDER BY refund_id ASC",
    );
    expect(new Set(refundStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["issued", "failed"]),
    );

    const readyOrders = await pools.ordering.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM ordering_order_pages WHERE status = 'ready-for-fulfillment'",
    );
    expect(Number(readyOrders.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const checkoutCartLines = await pools.checkout.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM checkout_cart_line_pages",
    );
    expect(Number(checkoutCartLines.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const checkoutSessions = await pools.checkout.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM checkout_session_pages WHERE session_id = 'chk_seed_started_cart'",
    );
    expect(Number(checkoutSessions.rows[0]?.count ?? 0)).toBe(1);

    const before = await pools.payments.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'payments.%'",
    );
    await seedMountedContextTestRuntimeIfEmpty(runtime, marketplaceSeedLifecycleContextOrder);
    const after = await pools.payments.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'payments.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 120_000);
});
