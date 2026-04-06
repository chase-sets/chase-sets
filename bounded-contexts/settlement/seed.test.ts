import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { module as settlementModule } from ".";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database-backed settlement seed tests.");
  }

  return databaseUrl;
}

function createPool(connectionString: string): PgTransactionalPool {
  return new pg.Pool({ connectionString, max: 1 }) as unknown as PgTransactionalPool;
}

async function recreateSchema(pool: PgTransactionalPool) {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query(settlementModule.schemaSql);
}

describeWithDatabase("settlement seed", () => {
  let pool: PgTransactionalPool;

  beforeAll(() => {
    pool = createPool(requireDatabaseUrl());
  });

  beforeEach(async () => {
    await recreateSchema(pool);
  });

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("creates deterministic wallet and payout projections", async () => {
    await settlementModule.seed?.(pool);

    const wallet = await pool.query<{
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
      available_balance_amount: "100.00",
    });

    const payoutStatuses = await pool.query<{ status: string }>(
      "SELECT status FROM settlement_payout_pages ORDER BY payout_id ASC",
    );
    expect(new Set(payoutStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["completed", "failed"]),
    );

    const before = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'settlement.%'",
    );
    await settlementModule.seed?.(pool);
    const after = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'settlement.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
