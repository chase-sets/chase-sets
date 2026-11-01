import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as settlementModule } from "../../../index";
import { buildPayoutSummary } from "./payout-summary";
import { listPayoutSummaryRows } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("settlement payout summary SQL", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<"settlement", PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["settlement"], "payout_summary");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function insertPayout(payoutId: string, accountId: string, status: string, updatedAt: string) {
    await pool.query(
      `INSERT INTO settlement_payout_pages (
         payout_id, account_id, amount, requested_amount, fee_amount, net_amount, currency_code,
         status, requested_at, updated_at
       ) VALUES ($1, $2, 10.00, 10.00, 0.00, 10.00, 'usd', $3, $4, $4)`,
      [payoutId, accountId, status, updatedAt],
    );
  }

  it("keeps the summary account-scoped", async () => {
    await insertPayout("acct-1-payout", "acct-1", "failed", "2026-10-29T02:00:00.000Z");
    await insertPayout("acct-2-payout", "acct-2", "failed", "2026-10-29T03:00:00.000Z");
    const result = await listPayoutSummaryRows(pool, "acct-1");
    expect(result.items.map((row) => row.payout_id)).toEqual(["acct-1-payout"]);
    expect(result.total).toBe(1);
  });

  it("includes the failed payout at actionable position 60", async () => {
    await insertPayout("failed-tail", "acct-1", "failed", "2026-10-29T11:00:00.000Z");
    // Newer requested rows stay fresh at evaluatedAt, so the failed tail is the only blocked row.
    for (let index = 0; index < 59; index += 1) {
      const second = String(index).padStart(2, "0");
      await insertPayout(`requested-${second}`, "acct-1", "requested", `2026-10-29T11:50:${second}.000Z`);
    }

    const result = await listPayoutSummaryRows(pool, "acct-1");
    const summary = buildPayoutSummary({
      ...result,
      availability: { can_request: true, unavailable_reasons: [], unavailable_reason_details: [] },
      evaluatedAt: "2026-10-29T12:00:00.000Z",
    });

    expect(result.completeness).toEqual({ kind: "complete", total: 60 });
    expect(result.items.map((row) => row.payout_id)).toEqual([
      ...Array.from({ length: 59 }, (_, index) => `requested-${String(58 - index).padStart(2, "0")}`),
      "failed-tail",
    ]);
    expect(summary.blocked_payouts.map((row) => row.payout_id)).toEqual(["failed-tail"]);
  });

  it("excludes completed history from the actionable set and bounds it at the cap", async () => {
    for (let index = 0; index < 59; index += 1) {
      await insertPayout(
        `paid-${index}`,
        "acct-1",
        "completed",
        `2026-10-29T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      );
    }
    await insertPayout("failed-after-history", "acct-1", "failed", "2026-10-30T00:00:00.000Z");
    const result = await listPayoutSummaryRows(pool, "acct-1");
    expect(result.completeness).toEqual({ kind: "complete", total: 1 });
    expect(result.items.map((row) => row.payout_id)).toEqual(["failed-after-history"]);

    for (let index = 0; index < 250; index += 1) {
      await insertPayout(
        `requested-${index}`,
        "acct-1",
        "requested",
        `2026-11-01T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      );
    }
    const bounded = await listPayoutSummaryRows(pool, "acct-1");
    expect(bounded.completeness.kind).toBe("bounded-incomplete");
    expect(bounded.total).toBe(251);
  });
});
