import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as settlementModule } from "../../../index";
import { getLedgerSaleCreditTotalForMonth } from "./queries";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;

describeDb("settlement getLedgerSaleCreditTotalForMonth SQL persistence boundary", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "settlement_ledger_sale_credit_total",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(settlementModule.schemaSql);
    await pool.query(
      `INSERT INTO settlement_wallet_pages (
         account_id, currency_code, pending_balance_amount, available_balance_amount,
         total_credited_amount, total_debited_amount, opened_at, updated_at
       ) VALUES ('acc_seller_1', 'usd', 0, 0, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function postLedgerEntry(params: {
    ledgerEntryId: string;
    kind: string;
    direction: string;
    amount: string;
    postedAt: string;
  }) {
    await pool.query(
      `INSERT INTO settlement_ledger_entry_pages (
         ledger_entry_id, account_id, kind, direction, amount, currency_code, funds_status,
         order_id, payment_id, payout_id, description, posted_at, available_at, updated_at
       ) VALUES ($1, 'acc_seller_1', $2, $3, $4, 'usd', 'available', NULL, NULL, NULL, NULL, $5, $5, $5)`,
      [params.ledgerEntryId, params.kind, params.direction, params.amount, params.postedAt],
    );
  }

  it("sums only 'sale' credits posted within the requested calendar month", async () => {
    await postLedgerEntry({
      ledgerEntryId: "led_1",
      kind: "sale",
      direction: "credit",
      amount: "45.00",
      postedAt: "2026-07-01T09:00:00.000Z",
    });
    await postLedgerEntry({
      ledgerEntryId: "led_2",
      kind: "sale",
      direction: "credit",
      amount: "15.00",
      postedAt: "2026-07-31T23:59:59.000Z",
    });
    // Excluded: wrong kind (rebate, not sale).
    await postLedgerEntry({
      ledgerEntryId: "led_3",
      kind: "rebate",
      direction: "credit",
      amount: "1000.00",
      postedAt: "2026-07-15T00:00:00.000Z",
    });
    // Excluded: wrong direction (a sale-kind debit, e.g. a correction).
    await postLedgerEntry({
      ledgerEntryId: "led_4",
      kind: "sale",
      direction: "debit",
      amount: "1000.00",
      postedAt: "2026-07-15T00:00:00.000Z",
    });
    // Excluded: outside the requested month.
    await postLedgerEntry({
      ledgerEntryId: "led_5",
      kind: "sale",
      direction: "credit",
      amount: "1000.00",
      postedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(await getLedgerSaleCreditTotalForMonth(pool, { yearMonth: "2026-07" })).toBe("60.00");
    expect(await getLedgerSaleCreditTotalForMonth(pool, { yearMonth: "2026-09" })).toBe("0.00");
  });
});
