import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { seedContextRuntimeIfEmpty } from "../src/context-lifecycle.generated";
import { createContextRuntime } from "../src/context-runtime.generated";
import { createFakePaymentProcessorGateway } from "../src/payment-processor";
import { seedCoverageManifest } from "./seed-coverage.manifest";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseBaseUrl ? describe : describe.skip;
const seedSellerAccountId = "acc_seed_demo_account";
const contextNames = [
  "catalog",
  "discovery",
  "fulfillment",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "pricing",
  "reputation",
  "settlement",
] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed marketplace seed tests.");
  }

  return databaseBaseUrl;
}

describeWithDatabase("marketplace stack seed orchestration", () => {
  let databaseUrls: Readonly<Record<(typeof contextNames)[number], string>>;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "marketplace_seed_stack",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  }, 30_000);

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("seeds lifecycle data across the shared stack and remains idempotent", async () => {
    const runtime = createContextRuntime(pools, {
      processorGateway: createFakePaymentProcessorGateway(),
    });
    await seedContextRuntimeIfEmpty(pools, runtime);

    const listingStatuses = await pools.marketplace.query<{ status: string }>(
      "SELECT status FROM marketplace_listing_pages ORDER BY listing_id ASC",
    );
    expect(new Set(listingStatuses.rows.map((row) => row.status))).toEqual(
      new Set(seedCoverageManifest.marketplace.listings),
    );

    const offerStatuses = await pools.marketplace.query<{ status: string }>(
      "SELECT status FROM marketplace_offer_pages ORDER BY offer_id ASC",
    );
    expect(new Set(offerStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["submitted", "accepted"]),
    );

    const orderStatuses = await pools.ordering.query<{ status: string }>(
      "SELECT status FROM ordering_order_pages ORDER BY order_id ASC",
    );
    expect(new Set(orderStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["pending-payment", "cancelled", "ready-for-fulfillment"]),
    );

    const paymentStatuses = await pools.payments.query<{ status: string }>(
      "SELECT status FROM payments_payment_pages ORDER BY payment_id ASC",
    );
    expect(new Set(paymentStatuses.rows.map((row) => row.status))).toEqual(
      new Set(seedCoverageManifest.payments.payments),
    );

    const refundStatuses = await pools.payments.query<{ status: string }>(
      "SELECT status FROM payments_refund_pages ORDER BY refund_id ASC",
    );
    expect(new Set(refundStatuses.rows.map((row) => row.status))).toEqual(
      new Set(seedCoverageManifest.payments.refunds),
    );

    const shipmentStatuses = await pools.fulfillment.query<{ status: string }>(
      "SELECT status FROM fulfillment_shipment_pages ORDER BY shipment_id ASC",
    );
    expect(new Set(shipmentStatuses.rows.map((row) => row.status))).toEqual(
      new Set(seedCoverageManifest.fulfillment.shipments),
    );

    const reviewStatuses = await pools.reputation.query<{ status: string }>(
      "SELECT status FROM reputation_review_pages ORDER BY review_id ASC",
    );
    expect(new Set(reviewStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["active", "withdrawn"]),
    );

    const discoveryCount = await pools.discovery.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM discovery_search_items",
    );
    expect(Number(discoveryCount.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const wallet = await pools.settlement.query<{
      pending_balance_amount: string;
      available_balance_amount: string;
    }>(
      `SELECT pending_balance_amount, available_balance_amount
       FROM settlement_wallet_pages
       WHERE account_id = $1`,
      [seedSellerAccountId],
    );
    expect(wallet.rows[0]).toBeDefined();
    expect(Number(wallet.rows[0]?.available_balance_amount ?? -1)).toBeGreaterThanOrEqual(0);
    expect(Number(wallet.rows[0]?.pending_balance_amount ?? -1)).toBeGreaterThanOrEqual(0);

    const payoutStatuses = await pools.settlement.query<{ status: string }>(
      "SELECT status FROM settlement_payout_pages ORDER BY payout_id ASC",
    );
    expect(new Set(payoutStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["completed", "failed"]),
    );

    const eventCountBefore = await pools.marketplace.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events",
    );
    await seedContextRuntimeIfEmpty(pools, runtime);
    const eventCountAfter = await pools.marketplace.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events",
    );
    expect(eventCountAfter.rows[0]?.count).toBe(eventCountBefore.rows[0]?.count);
  }, 60_000);
});
