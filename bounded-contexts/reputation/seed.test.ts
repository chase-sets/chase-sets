import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { composeSchemaSql } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "@chase-sets/catalog";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { module as identityModule } from "@chase-sets/identity";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { module as orderingModule } from "@chase-sets/ordering";
import { module as paymentsModule } from "@chase-sets/payments";
import { module as reputationModule } from ".";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database-backed reputation seed tests.");
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
      reputationModule,
    ]),
  );
}

describeWithDatabase("reputation seed", () => {
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
    await fulfillmentModule.seed?.(pool);
  }, 50_000);

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("creates review lifecycle projections and summary data", async () => {
    await reputationModule.seed?.(pool);

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
    await reputationModule.seed?.(pool);
    const after = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'reputation.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 60_000);
});
