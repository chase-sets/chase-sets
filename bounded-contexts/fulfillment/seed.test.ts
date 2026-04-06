import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { composeSchemaSql } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "@chase-sets/catalog";
import { module as identityModule } from "@chase-sets/identity";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { module as orderingModule } from "@chase-sets/ordering";
import { module as paymentsModule } from "@chase-sets/payments";
import { module as fulfillmentModule } from ".";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database-backed fulfillment seed tests.");
  }

  return databaseUrl;
}

function createPool(connectionString: string): PgTransactionalPool {
  return new pg.Pool({ connectionString, max: 1 }) as unknown as PgTransactionalPool;
}

async function recreateSchema(pool: PgTransactionalPool) {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query(
    composeSchemaSql([
      identityModule,
      catalogModule,
      inventoryModule,
      marketplaceModule,
      orderingModule,
      paymentsModule,
      fulfillmentModule,
    ]),
  );
}

describeWithDatabase("fulfillment seed", () => {
  let pool: PgTransactionalPool;

  beforeAll(() => {
    pool = createPool(requireDatabaseUrl());
  });

  beforeEach(async () => {
    await recreateSchema(pool);
    await identityModule.seed?.(pool);
    await catalogModule.seed?.(pool);
    await inventoryModule.seed?.(pool);
    await marketplaceModule.seed?.(pool);
    await orderingModule.seed?.(pool);
    await paymentsModule.seed?.(pool);
  }, 40_000);

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("projects deterministic shipment lifecycle coverage", async () => {
    await fulfillmentModule.seed?.(pool);

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
    await fulfillmentModule.seed?.(pool);
    const after = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'fulfillment.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 50_000);
});
