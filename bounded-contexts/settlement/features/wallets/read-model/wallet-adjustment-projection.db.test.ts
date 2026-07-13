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
import { buildWalletAdjustmentProjectionHandlers } from "./wallet-adjustment-projection";
import {
  getWalletAdjustment,
  listIncompleteWalletAdjustments,
  listWalletAdjustments,
} from "./wallet-adjustment-queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }
  return databaseBaseUrl;
}

const adjustmentId = "wad_replay_1";

const lifecycle = [
  {
    type: "settlement.wallet-adjustment.requested",
    data: {
      adjustmentId,
      targetAccountId: "acc_seller",
      direction: "credit",
      amount: "40.00",
      currencyCode: "usd",
      reasonCode: "goodwill-cash-credit",
      explanation: null,
      evidenceReferences: ["case-1"],
      reversalOfAdjustmentId: null,
      requestedBy: "usr_requester",
      requestedAt: "2026-07-10T00:00:00.000Z",
      selfBenefiting: false,
    },
  },
  {
    type: "settlement.wallet-adjustment.approved",
    data: {
      adjustmentId,
      approvedBy: "usr_approver",
      approvedAt: "2026-07-10T01:00:00.000Z",
      controls: {
        highValueCreditThresholdAmount: "500.00",
        highValueDebitThresholdAmount: "500.00",
        recentAuthMaxAgeMinutes: 15,
      },
      elevationRequired: false,
      elevationReasons: [],
      elevationApprovedBy: null,
      createsOrIncreasesNegativeBalance: false,
      reversalAfterFundsSettled: false,
    },
  },
  {
    type: "settlement.wallet-adjustment.posted",
    data: {
      adjustmentId,
      ledgerEntryId: "led_replay_1",
      postedAt: "2026-07-10T02:00:00.000Z",
      availableBalanceBefore: "10.00",
      availableBalanceAfter: "50.00",
    },
  },
] as const;

describeDb("settlement wallet adjustment projection persistence boundary", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "wallet_adjustment",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
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

  async function replay(times: number) {
    const handlers = buildWalletAdjustmentProjectionHandlers(pool);
    for (let i = 0; i < times; i += 1) {
      for (const event of lifecycle) {
        await handlers[event.type]?.(event as never, {} as never);
      }
    }
  }

  it("reconstructs the adjustment and its ledger linkage, idempotently under replay", async () => {
    await replay(2);

    const row = await getWalletAdjustment(pool, adjustmentId);
    expect(row?.status).toBe("posted");
    expect(row?.amount).toBe("40.00");
    expect(row?.reason_code).toBe("goodwill-cash-credit");
    expect(row?.posted_ledger_entry_id).toBe("led_replay_1");
    expect(row?.available_balance_before).toBe("10.00");
    expect(row?.available_balance_after).toBe("50.00");
    expect(row?.high_value_credit_threshold_amount).toBe("500.00");
    expect(row?.recent_auth_max_age_minutes).toBe(15);
    expect(row?.evidence_references).toEqual(["case-1"]);

    const list = await listWalletAdjustments(pool, { targetAccountId: "acc_seller" });
    expect(list.total).toBe(1);
    expect(list.items).toHaveLength(1);
  });

  it("keeps an approved-but-unposted adjustment observable as incomplete, then clears it once posted", async () => {
    const handlers = buildWalletAdjustmentProjectionHandlers(pool);
    await handlers["settlement.wallet-adjustment.requested"]?.(lifecycle[0] as never, {} as never);
    await handlers["settlement.wallet-adjustment.approved"]?.(lifecycle[1] as never, {} as never);

    const incompleteBefore = await listIncompleteWalletAdjustments(pool);
    expect(incompleteBefore.map((entry) => entry.adjustment_id)).toContain(adjustmentId);

    await handlers["settlement.wallet-adjustment.posted"]?.(lifecycle[2] as never, {} as never);
    const incompleteAfter = await listIncompleteWalletAdjustments(pool);
    expect(incompleteAfter.map((entry) => entry.adjustment_id)).not.toContain(adjustmentId);
  });
});
