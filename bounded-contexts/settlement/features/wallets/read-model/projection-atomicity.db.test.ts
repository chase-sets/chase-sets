import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as settlementModule } from "../../../index";
import { buildWalletProjectionHandlers } from "./projection";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;

const accountId = "acc_seller_atomicity";
const ledgerEntryId = "led_atomicity_1";

// A single 'available' sale credit: it moves available_balance_amount and
// total_credited_amount by +40.00 exactly once when its entry is first inserted.
const ledgerEntryPosted = {
  id: "evt_posted_atomicity_1",
  type: "settlement.wallet.ledger-entry-posted",
  data: {
    accountId,
    ledgerEntryId,
    kind: "sale",
    direction: "credit",
    amount: "40.00",
    currencyCode: "usd",
    fundsStatus: "available",
    orderId: null,
    paymentId: null,
    payoutId: null,
    description: null,
    postedAt: "2026-07-10T02:00:00.000Z",
  },
} as const;

describeDb("settlement wallet projection atomicity (entry + balance commit together)", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "wallet_projection_atomicity",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
    await pool.query(
      `INSERT INTO settlement_wallet_pages (
         account_id, currency_code, pending_balance_amount, available_balance_amount,
         total_credited_amount, total_debited_amount, opened_at, updated_at
       ) VALUES ($1, 'usd', 0, 0, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      [accountId],
    );
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  // Mirror the projector runner (subscriptions.ts): run the handler inside one
  // BEGIN/…/COMMIT on a single connection, handing that transaction-scoped
  // connection to the handler as context.db. `outcome: "crash"` rolls back
  // instead of committing — standing in for a process crash after the handler
  // ran but before the projection transaction (and its checkpoint) committed.
  async function applyPosted(outcome: "commit" | "crash"): Promise<void> {
    const handler = buildWalletProjectionHandlers(pool)[ledgerEntryPosted.type];
    if (!handler) {
      throw new Error("Missing ledger-entry-posted projection handler.");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await handler(ledgerEntryPosted as never, { db: client as PgQueryable });
      await client.query(outcome === "commit" ? "COMMIT" : "ROLLBACK");
    } finally {
      client.release();
    }
  }

  async function readWallet(): Promise<{ available: string; credited: string }> {
    const result = await pool.query<{ available: string; credited: string }>(
      `SELECT available_balance_amount::text AS available,
              total_credited_amount::text AS credited
       FROM settlement_wallet_pages WHERE account_id = $1`,
      [accountId],
    );
    return result.rows[0]!;
  }

  async function ledgerEntryExists(): Promise<boolean> {
    const result = await pool.query(`SELECT 1 FROM settlement_ledger_entry_pages WHERE ledger_entry_id = $1`, [
      ledgerEntryId,
    ]);
    return (result.rowCount ?? result.rows.length) > 0;
  }

  it("rolls the entry insert back together with the balance update when the projection transaction does not commit", async () => {
    await applyPosted("crash");

    // The pre-fix handler wrote the entry insert on the pool (auto-commit), so it
    // survived a rollback and permanently stranded the skipped balance delta.
    // With the transaction-scoped context.db, entry insert and balance update
    // share one transaction: a rollback leaves neither behind, so there is
    // nothing to strand.
    expect(await ledgerEntryExists()).toBe(false);
    const afterCrash = await readWallet();
    expect(afterCrash.available).toBe("0.00");
    expect(afterCrash.credited).toBe("0.00");
  });

  it("applies the balance delta on retry after a crash, and never double-applies on redelivery", async () => {
    // Attempt 1 crashes after the handler ran: atomic rollback, nothing persists.
    await applyPosted("crash");
    expect(await ledgerEntryExists()).toBe(false);

    // Retry (redelivery of the same event) applies entry + balance together — the
    // delta is NOT skipped forever.
    await applyPosted("commit");
    expect(await ledgerEntryExists()).toBe(true);
    const afterRetry = await readWallet();
    expect(afterRetry.available).toBe("40.00");
    expect(afterRetry.credited).toBe("40.00");

    // A further full redelivery must not double-apply: ON CONFLICT DO NOTHING
    // makes the entry insert a no-op (rowCount === 0), the handler returns before
    // the balance update, and the delta stays applied exactly once.
    await applyPosted("commit");
    const afterRedelivery = await readWallet();
    expect(afterRedelivery.available).toBe("40.00");
    expect(afterRedelivery.credited).toBe("40.00");
  });
});
