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
import { fulfillmentSchemaSql, seedFulfillmentDatabase } from "@chase-sets/fulfillment";
import { reputationSchemaSql, seedReputationDatabase } from ".";

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
      { schemaSql: reputationSchemaSql },
    ]),
  );
}

describe("reputation seed", () => {
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
    await seedFulfillmentDatabase(pool);
  }, 50_000);

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("creates review lifecycle projections and summary data", async () => {
    await seedReputationDatabase(pool);

    const reviewStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM reputation_review_pages ORDER BY review_id ASC",
    );
    expect(new Set(reviewStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["active", "withdrawn"]),
    );

    const summary = await pool.query<{ review_count: number; average_rating: string | null }>(
      "SELECT review_count, average_rating::text AS average_rating FROM reputation_summary_pages",
    );
    expect(summary.rows[0]).toMatchObject({
      review_count: 1,
      average_rating: "5.00",
    });

    const before = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'reputation.%'",
    );
    await seedReputationDatabase(pool);
    const after = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'reputation.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 60_000);
});

