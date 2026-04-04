import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { catalogAuthoringSchemaSql } from "@chase-sets/catalog";
import { discoverySchemaSql } from "@chase-sets/discovery";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { fulfillmentSchemaSql } from "@chase-sets/fulfillment";
import { identitySchemaSql } from "@chase-sets/identity";
import { inventorySchemaSql } from "@chase-sets/inventory";
import { marketplaceSchemaSql } from "@chase-sets/marketplace";
import { orderingSchemaSql } from "@chase-sets/ordering";
import { paymentsSchemaSql } from "@chase-sets/payments";
import { reputationSchemaSql } from "@chase-sets/reputation";
import { settlementSchemaSql } from "@chase-sets/settlement";
import { seedMarketplaceStack } from "../src/seed-stack";
import { seedCoverageManifest } from "./seed-coverage.manifest";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://catalog:catalog@localhost:5432/catalog";

function createPool(connectionString: string): PgTransactionalPool {
  return new pg.Pool({ connectionString }) as unknown as PgTransactionalPool;
}

async function recreateSchema(pool: PgTransactionalPool) {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

  for (const schemaSql of [
    eventCorePostgresSchemaSql,
    identitySchemaSql,
    catalogAuthoringSchemaSql,
    inventorySchemaSql,
    discoverySchemaSql,
    marketplaceSchemaSql,
    orderingSchemaSql,
    fulfillmentSchemaSql,
    paymentsSchemaSql,
    reputationSchemaSql,
    settlementSchemaSql,
  ]) {
    await pool.query(schemaSql);
  }
}

describe("marketplace stack seed orchestration", () => {
  let pool: PgTransactionalPool;

  beforeAll(() => {
    pool = createPool(databaseUrl);
  });

  beforeEach(async () => {
    await recreateSchema(pool);
  }, 30_000);

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("seeds lifecycle data across the shared stack and remains idempotent", async () => {
    await seedMarketplaceStack(pool);

    const listingStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM marketplace_listing_pages ORDER BY listing_id ASC",
    );
    expect(new Set(listingStatuses.rows.map((row) => row.status))).toEqual(
      new Set(seedCoverageManifest.marketplace.listings),
    );

    const offerStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM marketplace_offer_pages ORDER BY offer_id ASC",
    );
    expect(new Set(offerStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["submitted", "accepted"]),
    );

    const orderStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM ordering_order_pages ORDER BY order_id ASC",
    );
    expect(new Set(orderStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["pending-payment", "cancelled", "ready-for-fulfillment"]),
    );

    const paymentStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM payments_payment_pages ORDER BY payment_id ASC",
    );
    expect(new Set(paymentStatuses.rows.map((row) => row.status))).toEqual(
      new Set(seedCoverageManifest.payments.payments),
    );

    const refundStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM payments_refund_pages ORDER BY refund_id ASC",
    );
    expect(new Set(refundStatuses.rows.map((row) => row.status))).toEqual(
      new Set(seedCoverageManifest.payments.refunds),
    );

    const shipmentStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM fulfillment_shipment_pages ORDER BY shipment_id ASC",
    );
    expect(new Set(shipmentStatuses.rows.map((row) => row.status))).toEqual(
      new Set(seedCoverageManifest.fulfillment.shipments),
    );

    const reviewStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM reputation_review_pages ORDER BY review_id ASC",
    );
    expect(new Set(reviewStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["active", "withdrawn"]),
    );

    const discoveryCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM discovery_search_items",
    );
    expect(Number(discoveryCount.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const wallet = await pool.query<{
      pending_balance_amount: string;
      available_balance_amount: string;
    }>(
      `SELECT pending_balance_amount, available_balance_amount
       FROM settlement_wallet_pages`,
    );
    expect(wallet.rows[0]).toMatchObject({
      pending_balance_amount: "0.00",
      available_balance_amount: "100.00",
    });

    const payoutStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM settlement_payout_pages ORDER BY payout_id ASC",
    );
    expect(new Set(payoutStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["completed", "failed"]),
    );

    const eventCountBefore = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events",
    );
    await seedMarketplaceStack(pool);
    const eventCountAfter = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events",
    );
    expect(eventCountAfter.rows[0]?.count).toBe(eventCountBefore.rows[0]?.count);
  }, 60_000);
});

