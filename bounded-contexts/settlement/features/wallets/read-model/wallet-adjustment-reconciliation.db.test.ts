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
import { runWalletAdjustmentReconciliation } from "./wallet-adjustment-reconciliation";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }
  return databaseBaseUrl;
}

async function seedWallet(pool: PgTransactionalPool, accountId: string) {
  await pool.query(
    `INSERT INTO settlement_wallet_pages (
       account_id, currency_code, pending_balance_amount, available_balance_amount,
       total_credited_amount, total_debited_amount, updated_at
     ) VALUES ($1, 'usd', '0.00', '100.00', '100.00', '0.00', now())
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  );
}

async function seedLedgerEntry(pool: PgTransactionalPool, ledgerEntryId: string, accountId: string, amount: string) {
  await pool.query(
    `INSERT INTO settlement_ledger_entry_pages (
       ledger_entry_id, account_id, kind, direction, amount, currency_code, funds_status, posted_at, updated_at
     ) VALUES ($1, $2, 'adjustment', 'credit', $3, 'usd', 'available', now(), now())
     ON CONFLICT (ledger_entry_id) DO NOTHING`,
    [ledgerEntryId, accountId, amount],
  );
}

type SeedAdjustment = Readonly<{
  adjustmentId: string;
  status: "requested" | "approved" | "rejected" | "posted" | "reversed";
  targetAccountId: string;
  direction: "credit" | "debit";
  amount: string;
  requestedAt: string;
  approvedAt?: string | null;
  postedLedgerEntryId?: string | null;
  postedAt?: string | null;
  availableBalanceBefore?: string | null;
  availableBalanceAfter?: string | null;
  reversalOfAdjustmentId?: string | null;
  reversedByAdjustmentId?: string | null;
}>;

async function seedAdjustment(pool: PgTransactionalPool, row: SeedAdjustment) {
  await pool.query(
    `INSERT INTO settlement_wallet_adjustment_pages (
       adjustment_id, status, target_account_id, direction, amount, currency_code, reason_code,
       requested_by, requested_at, approved_by, approved_at,
       posted_ledger_entry_id, posted_at, available_balance_before, available_balance_after,
       reversal_of_adjustment_id, reversed_by_adjustment_id, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'usd', 'goodwill-cash-credit', 'usr_operator', $6, 'usr_approver', $7, $8, $9, $10, $11, $12, $13, $6)
     ON CONFLICT (adjustment_id) DO NOTHING`,
    [
      row.adjustmentId,
      row.status,
      row.targetAccountId,
      row.direction,
      row.amount,
      row.requestedAt,
      row.approvedAt ?? null,
      row.postedLedgerEntryId ?? null,
      row.postedAt ?? null,
      row.availableBalanceBefore ?? null,
      row.availableBalanceAfter ?? null,
      row.reversalOfAdjustmentId ?? null,
      row.reversedByAdjustmentId ?? null,
    ],
  );
}

describeDb("settlement wallet adjustment reconciliation persistence boundary", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(requireDatabaseBaseUrl(), contextNames, "wad_reconcile");
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
    await seedWallet(pool, "acc_target");
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("finds no findings for a clean, fully-linked, matching-ledger adjustment", async () => {
    await seedLedgerEntry(pool, "led_clean", "acc_target", "40.00");
    await seedAdjustment(pool, {
      adjustmentId: "wad_clean",
      status: "posted",
      targetAccountId: "acc_target",
      direction: "credit",
      amount: "40.00",
      requestedAt: "2026-07-13T00:00:00.000Z",
      approvedAt: "2026-07-13T00:05:00.000Z",
      postedLedgerEntryId: "led_clean",
      postedAt: "2026-07-13T00:06:00.000Z",
      availableBalanceBefore: "60.00",
      availableBalanceAfter: "100.00",
    });

    const report = await runWalletAdjustmentReconciliation(pool, { nowIso: "2026-07-13T01:00:00.000Z" });
    expect(report.scanned).toBe(1);
    expect(report.findings).toEqual([]);
    expect(report.hasMore).toBe(false);
  });

  it("detects a posted adjustment with no matching ledger entry across a real Postgres join", async () => {
    await seedAdjustment(pool, {
      adjustmentId: "wad_orphan",
      status: "posted",
      targetAccountId: "acc_target",
      direction: "credit",
      amount: "40.00",
      requestedAt: "2026-07-13T00:00:00.000Z",
      approvedAt: "2026-07-13T00:05:00.000Z",
      postedLedgerEntryId: "led_missing",
      postedAt: "2026-07-13T00:06:00.000Z",
      availableBalanceBefore: "60.00",
      availableBalanceAfter: "100.00",
    });

    const report = await runWalletAdjustmentReconciliation(pool, { nowIso: "2026-07-13T01:00:00.000Z" });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.code).toBe("posted-without-ledger-entry");
    expect(report.findings[0]?.adjustmentId).toBe("wad_orphan");
  });

  it("detects two adjustments sharing one ledger entry", async () => {
    await seedLedgerEntry(pool, "led_shared", "acc_target", "40.00");
    await seedAdjustment(pool, {
      adjustmentId: "wad_a",
      status: "posted",
      targetAccountId: "acc_target",
      direction: "credit",
      amount: "40.00",
      requestedAt: "2026-07-13T00:00:00.000Z",
      approvedAt: "2026-07-13T00:05:00.000Z",
      postedLedgerEntryId: "led_shared",
      postedAt: "2026-07-13T00:06:00.000Z",
      availableBalanceBefore: "60.00",
      availableBalanceAfter: "100.00",
    });
    await seedAdjustment(pool, {
      adjustmentId: "wad_b",
      status: "posted",
      targetAccountId: "acc_target",
      direction: "credit",
      amount: "40.00",
      requestedAt: "2026-07-13T00:01:00.000Z",
      approvedAt: "2026-07-13T00:05:00.000Z",
      postedLedgerEntryId: "led_shared",
      postedAt: "2026-07-13T00:06:00.000Z",
      availableBalanceBefore: "60.00",
      availableBalanceAfter: "100.00",
    });

    const report = await runWalletAdjustmentReconciliation(pool, { nowIso: "2026-07-13T01:00:00.000Z" });
    const codes = report.findings.map((finding) => finding.code);
    expect(codes.filter((code) => code === "duplicate-ledger-linkage")).toHaveLength(2);
  });

  it("detects an approved adjustment stuck unposted past the staleness threshold", async () => {
    await seedAdjustment(pool, {
      adjustmentId: "wad_stuck",
      status: "approved",
      targetAccountId: "acc_target",
      direction: "credit",
      amount: "10.00",
      requestedAt: "2026-07-13T00:00:00.000Z",
      approvedAt: "2026-07-13T00:05:00.000Z",
    });

    const report = await runWalletAdjustmentReconciliation(pool, {
      nowIso: "2026-07-13T01:00:00.000Z",
      thresholds: { staleApprovalMinutes: 30, stalePendingHours: 48 },
    });
    expect(report.findings.map((f) => f.code)).toContain("approved-not-posted");
  });

  it("correctly links a reversed adjustment to its posted reversal with no finding", async () => {
    await seedLedgerEntry(pool, "led_orig", "acc_target", "40.00");
    await seedLedgerEntry(pool, "led_rev", "acc_target", "40.00");
    await seedAdjustment(pool, {
      adjustmentId: "wad_orig",
      status: "reversed",
      targetAccountId: "acc_target",
      direction: "credit",
      amount: "40.00",
      requestedAt: "2026-07-13T00:00:00.000Z",
      approvedAt: "2026-07-13T00:05:00.000Z",
      postedLedgerEntryId: "led_orig",
      postedAt: "2026-07-13T00:06:00.000Z",
      availableBalanceBefore: "60.00",
      availableBalanceAfter: "100.00",
      reversedByAdjustmentId: "wad_rev",
    });
    await seedAdjustment(pool, {
      adjustmentId: "wad_rev",
      status: "posted",
      targetAccountId: "acc_target",
      direction: "debit",
      amount: "40.00",
      requestedAt: "2026-07-13T00:10:00.000Z",
      approvedAt: "2026-07-13T00:11:00.000Z",
      postedLedgerEntryId: "led_rev",
      postedAt: "2026-07-13T00:12:00.000Z",
      availableBalanceBefore: "100.00",
      availableBalanceAfter: "60.00",
      reversalOfAdjustmentId: "wad_orig",
    });

    const report = await runWalletAdjustmentReconciliation(pool, { nowIso: "2026-07-13T01:00:00.000Z" });
    expect(report.findings).toEqual([]);
  });

  it("paginates a bounded page and reports hasMore", async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedLedgerEntry(pool, `led_page_${index}`, "acc_target", "1.00");
      await seedAdjustment(pool, {
        adjustmentId: `wad_page_${index}`,
        status: "posted",
        targetAccountId: "acc_target",
        direction: "credit",
        amount: "1.00",
        requestedAt: `2026-07-13T00:0${index}:00.000Z`,
        approvedAt: `2026-07-13T00:0${index}:30.000Z`,
        postedLedgerEntryId: `led_page_${index}`,
        postedAt: `2026-07-13T00:0${index}:45.000Z`,
        availableBalanceBefore: "99.00",
        availableBalanceAfter: "100.00",
      });
    }

    const firstPage = await runWalletAdjustmentReconciliation(pool, {
      limit: 2,
      offset: 0,
      nowIso: "2026-07-13T01:00:00.000Z",
    });
    expect(firstPage.scanned).toBe(2);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await runWalletAdjustmentReconciliation(pool, {
      limit: 2,
      offset: 2,
      nowIso: "2026-07-13T01:00:00.000Z",
    });
    expect(secondPage.scanned).toBe(1);
    expect(secondPage.hasMore).toBe(false);
  });

  it("returns an empty report when no adjustments exist", async () => {
    const report = await runWalletAdjustmentReconciliation(pool, { nowIso: "2026-07-13T01:00:00.000Z" });
    expect(report).toEqual({ findings: [], scanned: 0, hasMore: false });
  });
});
