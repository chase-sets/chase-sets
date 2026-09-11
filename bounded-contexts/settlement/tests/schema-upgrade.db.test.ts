import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as settlementModule } from "../index";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("settlement schema upgrades", () => {
  let pools: Readonly<Record<"settlement", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["settlement"], "settlement_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("backfills stable hold identities outside boot-time schema SQL", async () => {
    const pool = pools.settlement;
    await bootstrapContextDatabase(settlementModule, pool);
    await pool.query("ALTER TABLE settlement_support_holds DROP COLUMN hold_id");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260718_settlement_support_holds_hold_id_convergence'",
    );
    await pool.query(`INSERT INTO settlement_support_holds (
      support_request_id, order_id, buyer_account_id, seller_account_id, flow_type,
      status, resolution_type, active, opened_at, updated_at
    ) VALUES (
      'sup_123', 'ord_123', 'acc_buyer', 'acc_seller', 'product-not-received',
      'opened', NULL, true, now(), now()
    )`);

    await bootstrapContextDatabase(settlementModule, pool);

    const hold = await pool.query<{ hold_id: string }>(
      "SELECT hold_id FROM settlement_support_holds WHERE support_request_id = 'sup_123'",
    );
    expect(hold.rows).toEqual([{ hold_id: "hold_123" }]);

    const column = await pool.query<{ is_nullable: string }>(`SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'settlement_support_holds'
        AND column_name = 'hold_id'`);
    expect(column.rows).toEqual([{ is_nullable: "NO" }]);

    const indexes = await pool.query<{ indexname: string }>(`SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'settlement_support_holds'`);
    expect(indexes.rows.map((row) => row.indexname)).toContain("settlement_support_holds_hold_id_idx");
  });

  it("backfills historical payout requested, fee, and net amounts", async () => {
    const pool = pools.settlement;
    await bootstrapContextDatabase(settlementModule, pool);
    await pool.query(
      `INSERT INTO settlement_payout_pages (
         payout_id, account_id, amount, currency_code, display_reference, status, requested_at, updated_at
       ) VALUES ('pyo_legacy_fee_backfill', 'acc_legacy_fee_backfill', 42.00, 'usd', 'PYO-LEGACY', 'completed', now(), now())`,
    );
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260911_settlement_payout_fee_amounts'",
    );

    await bootstrapContextDatabase(settlementModule, pool);

    const result = await pool.query<{
      requested_amount: string;
      fee_amount: string;
      net_amount: string;
    }>(
      `SELECT requested_amount::text, fee_amount::text, net_amount::text
       FROM settlement_payout_pages
       WHERE payout_id = 'pyo_legacy_fee_backfill'`,
    );
    expect(result.rows).toEqual([{ requested_amount: "42.00", fee_amount: "0.00", net_amount: "42.00" }]);
  });
});
