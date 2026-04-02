import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { catalogAuthoringSchemaSql, seedCatalogDatabase } from "@chase-sets/catalog-authoring";
import { identitySchemaSql, seedIdentityDatabase } from "@chase-sets/identity";
import { inventorySchemaSql, seedInventoryDatabase } from "@chase-sets/inventory";
import { marketplaceSchemaSql, seedMarketplaceDatabase } from "@chase-sets/marketplace-context";
import { orderingSchemaSql, seedOrderingDatabase } from "@chase-sets/ordering";
import { paymentsSchemaSql, seedPaymentsDatabase } from ".";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://catalog:catalog@localhost:5432/catalog";

function createPool(connectionString: string): PgTransactionalPool {
  return new pg.Pool({ connectionString }) as unknown as PgTransactionalPool;
}

async function recreateSchema(pool: PgTransactionalPool) {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query(
    [
      identitySchemaSql,
      catalogAuthoringSchemaSql,
      inventorySchemaSql,
      marketplaceSchemaSql,
      orderingSchemaSql,
      paymentsSchemaSql,
    ].join("\n\n"),
  );
}

describe("payments seed", () => {
  let pool: PgTransactionalPool;

  beforeAll(() => {
    pool = createPool(databaseUrl);
  });

  beforeEach(async () => {
    await recreateSchema(pool);
    await seedIdentityDatabase(pool);
    await seedCatalogDatabase(pool);
    await seedInventoryDatabase(pool);
    await seedMarketplaceDatabase(pool);
    await seedOrderingDatabase(pool);
  }, 30_000);

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("creates deterministic payment and refund lifecycle projections", async () => {
    await seedPaymentsDatabase(pool);

    const paymentStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM payments_payment_pages ORDER BY payment_id ASC",
    );
    expect(new Set(paymentStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["pending-confirmation", "captured", "failed", "cancelled"]),
    );

    const refundStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM payments_refund_pages ORDER BY refund_id ASC",
    );
    expect(new Set(refundStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["issued", "failed"]),
    );

    const readyOrders = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM ordering_order_pages WHERE status = 'ready-for-fulfillment'",
    );
    expect(Number(readyOrders.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const before = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'payments.%'",
    );
    await seedPaymentsDatabase(pool);
    const after = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'payments.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 40_000);
});
