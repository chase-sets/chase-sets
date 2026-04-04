import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { composeSchemaSql } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { catalogAuthoringSchemaSql, seedCatalogDatabase } from "@chase-sets/catalog";
import { identitySchemaSql, seedIdentityDatabase } from "@chase-sets/identity";
import { inventorySchemaSql, seedInventoryDatabase } from "@chase-sets/inventory";
import { marketplaceSchemaSql, seedMarketplaceDatabase } from "@chase-sets/marketplace";
import { orderingSchemaSql, seedOrderingDatabase } from "@chase-sets/ordering";
import { paymentsSchemaSql, seedPaymentsDatabase } from "@chase-sets/payments";
import { fulfillmentSchemaSql, seedFulfillmentDatabase } from ".";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://catalog:catalog@localhost:5432/catalog";

function createPool(connectionString: string): PgTransactionalPool {
  return new pg.Pool({ connectionString }) as unknown as PgTransactionalPool;
}

async function recreateSchema(pool: PgTransactionalPool) {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query(
    composeSchemaSql([
      { schemaSql: identitySchemaSql },
      { schemaSql: catalogAuthoringSchemaSql },
      { schemaSql: inventorySchemaSql },
      { schemaSql: marketplaceSchemaSql },
      { schemaSql: orderingSchemaSql },
      { schemaSql: paymentsSchemaSql },
      { schemaSql: fulfillmentSchemaSql },
    ]),
  );
}

describe("fulfillment seed", () => {
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
    await seedPaymentsDatabase(pool);
  }, 40_000);

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("projects deterministic shipment lifecycle coverage", async () => {
    await seedFulfillmentDatabase(pool);

    const shipmentStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM fulfillment_shipment_pages ORDER BY shipment_id ASC",
    );
    expect(new Set(shipmentStatuses.rows.map((row) => row.status))).toEqual(
      new Set([
        "awaiting-label",
        "label-attached",
        "dispatched",
        "delivered",
        "returned",
        "exception",
      ]),
    );

    const before = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'fulfillment.%'",
    );
    await seedFulfillmentDatabase(pool);
    const after = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'fulfillment.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 50_000);
});

