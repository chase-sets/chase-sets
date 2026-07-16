import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { MoneyMovementGateway } from "@chase-sets/money-movement";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as settlementModule } from "../../../index";
import { createLiabilityReconciliationRuntime } from "../api/runtime";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;

/** A gateway stub whose only exercised method is the platform-balance read. */
function gatewayWithBalance(availableAmount: string): MoneyMovementGateway {
  return {
    providerName: "fake",
    retrievePlatformBalance: async () => ({ currencyCode: "usd", availableAmount }),
  } as unknown as MoneyMovementGateway;
}

describeDb("settlement liability reconciliation persistence boundary", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "liability_reconciliation");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  async function seedWallet(accountId: string, available: string, pending: string) {
    await pool.query(
      `INSERT INTO settlement_wallet_pages (
         account_id, currency_code, pending_balance_amount, available_balance_amount,
         total_credited_amount, total_debited_amount, opened_at, updated_at
       ) VALUES ($1, 'usd', $2, $3, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      [accountId, pending, available],
    );
  }

  async function seedPayout(payoutId: string, accountId: string, amount: string, status: string) {
    await pool.query(
      `INSERT INTO settlement_payout_pages (
         payout_id, account_id, amount, currency_code, status, requested_at, updated_at
       ) VALUES ($1, $2, $3, 'usd', $4, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
      [payoutId, accountId, amount, status],
    );
  }

  it("sums wallet liabilities and in-flight payout demand, and reports ok when the provider covers them", async () => {
    await seedWallet("acc_1", "600.00", "150.00");
    await seedWallet("acc_2", "250.00", "0.00");
    await seedPayout("pyo_inflight", "acc_1", "100.00", "in-transit");
    await seedPayout("pyo_requested", "acc_2", "50.00", "requested");
    // Excluded from in-flight demand: a completed payout is no longer an obligation.
    await seedPayout("pyo_done", "acc_2", "999.00", "completed");

    const runtime = createLiabilityReconciliationRuntime({
      db: pool,
      // liabilities 1000.00 + in-flight demand 150.00 = 1150.00
      moneyMovementGateway: gatewayWithBalance("1150.00"),
    });

    const result = await runtime.reconcileLedgerAgainstProvider({ currencyCode: "usd" });
    expect(result.walletLiabilityAmount).toBe("1000.00");
    expect(result.inFlightPayoutDemandAmount).toBe("150.00");
    expect(result.expectedObligationAmount).toBe("1150.00");
    expect(result.driftAmount).toBe("0.00");
    expect(result.status).toBe("ok");

    const runs = await runtime.listReconciliationRuns({ limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.expected_obligation_amount).toBe("1150.00");
  });

  it("flags an injected divergence when the provider balance falls short of the obligation", async () => {
    await seedWallet("acc_1", "1000.00", "0.00");
    await seedPayout("pyo_inflight", "acc_1", "250.00", "in-transit");

    const runtime = createLiabilityReconciliationRuntime({
      db: pool,
      // Obligation is 1250.00 but the provider only holds 1200.00 — a $50 leak.
      moneyMovementGateway: gatewayWithBalance("1200.00"),
    });

    const result = await runtime.reconcileLedgerAgainstProvider({ currencyCode: "usd" });
    expect(result.expectedObligationAmount).toBe("1250.00");
    expect(result.driftAmount).toBe("-50.00");
    expect(result.status).toBe("shortfall-alarm");

    const runs = await runtime.listReconciliationRuns({ limit: 10 });
    expect(runs[0]?.status).toBe("shortfall-alarm");
    expect(runs[0]?.drift_amount).toBe("-50.00");
  });
});
