import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement/test-support";
import { module as settlementModule } from "../../../index";
import { createWalletRuntime, type WalletServices } from "../../wallets/api/runtime";
import type { PayoutReadinessServices } from "../../payout-readiness/api/runtime";
import { createPayoutRuntime } from "./runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;
const context = {
  tenantId: "tnt_payout_fee_concurrency" as never,
  audit: {
    performedByUserId: "usr_payout_fee_concurrency" as never,
    forAccountId: "acc_payout_fee_concurrency" as never,
  },
};

describeDb("payout-fee-concurrency real Postgres wallet interleaving", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "payout_fee_concurrency");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("payout-fee-preview uses active events, excludes failures, and rolls over at UTC month start", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T23:59:59.000Z"));
      const eventStore = createPostgresEventStore({ pool });
      const payouts = createPayoutRuntime({
        eventStore,
        checkpointStore: { loadCheckpoint: async () => "0" as never, saveCheckpoint: async () => undefined },
        db: pool,
        wallets: {
          getWallet: async () => ({
            account_id: "acc_payout_fee_concurrency",
            currency_code: "usd",
            pending_balance_amount: "0.00",
            available_balance_amount: "20.00",
            total_credited_amount: "20.00",
            total_debited_amount: "0.00",
            negative_balance_status: "in-good-standing" as const,
            negative_balance_started_at: null,
            collections_escalated_at: null,
            opened_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-31T23:59:59.000Z",
          }),
          postEntry: async () => ({ ledgerEntryId: "led_unused" as never, version: 1 }),
          listNegativeBalanceAccounts: async () => ({ items: [], total: 0 }),
        } as unknown as WalletServices,
        payoutReadiness: {
          getPayoutReadiness: async () => ({
            account_id: "acc_payout_fee_concurrency",
            status: "ready" as const,
            missing_requirements: [],
            advisory_requirements: [],
            disabled_reason: null,
            requirements_deadline: null,
            provider_reference: "acct_synthetic_payout_fee_concurrency",
            contact_email: null,
            onboarding_status: "complete",
            transfer_capability_status: "active",
            payout_capability_status: "active",
            payout_destination_status: "ready",
            payout_destination_fingerprint: null,
            payout_destination_changed_at: null,
            payout_account_dashboard: "none" as const,
            losses_collector: "application" as const,
            fees_collector: "application" as const,
            requirements_collector: "application" as const,
            updated_at: "2026-08-31T23:59:59.000Z",
          }),
        } as unknown as PayoutReadinessServices,
        moneyMovementGateway: createFakeMoneyMovementGateway(),
        policies: {
          resolvePolicy: async (definition: { policyKey: string }, input?: { at?: string }) => ({
            policyKey: definition.policyKey,
            value:
              definition.policyKey === "settlement.payout-fee"
                ? {
                    label: "Synthetic payout fee",
                    percentageBps: 0,
                    fixedAmount: "1.00",
                    firstPayoutOfMonthFixedAmount: "2.00",
                  }
                : { currencyCode: "usd", minimumAmount: "5.00", maximumAmount: "10000.00" },
            source: "policy" as const,
            documentId: "pol_synthetic_payout_fee",
            resolvedAt: input?.at ?? new Date().toISOString(),
          }),
        } as never,
      });

      await expect(
        payouts.previewPayoutRequest({ accountId: "acc_payout_fee_concurrency" as never, amount: "10.00" }, context),
      ).resolves.toMatchObject({ fee_amount: "3.00", net_amount: "7.00", is_first_payout_of_month: true });

      await eventStore.appendToStream({
        streamId: "settlement.payout-pyo_db_preview_failed",
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "settlement.payout.requested",
            payload: {
              payoutId: "pyo_db_preview_failed",
              accountId: "acc_payout_fee_concurrency",
              requestedAt: "2026-08-31T23:59:59.000Z",
            },
          },
        ],
      });
      await expect(
        payouts.previewPayoutRequest({ accountId: "acc_payout_fee_concurrency" as never, amount: "10.00" }, context),
      ).resolves.toMatchObject({ fee_amount: "1.00", net_amount: "9.00", is_first_payout_of_month: false });

      await eventStore.appendToStream({
        streamId: "settlement.payout-pyo_db_preview_failed",
        expectedVersion: 1,
        context,
        events: [{ eventType: "settlement.payout.failed", payload: { payoutId: "pyo_db_preview_failed" } }],
      });
      await expect(
        payouts.previewPayoutRequest({ accountId: "acc_payout_fee_concurrency" as never, amount: "10.00" }, context),
      ).resolves.toMatchObject({ fee_amount: "3.00", net_amount: "7.00", is_first_payout_of_month: true });

      await eventStore.appendToStream({
        streamId: "settlement.payout-pyo_db_preview_august",
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "settlement.payout.requested",
            payload: {
              payoutId: "pyo_db_preview_august",
              accountId: "acc_payout_fee_concurrency",
              requestedAt: "2026-08-31T23:59:59.999Z",
            },
          },
        ],
      });
      vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
      await expect(
        payouts.previewPayoutRequest({ accountId: "acc_payout_fee_concurrency" as never, amount: "10.00" }, context),
      ).resolves.toMatchObject({ fee_amount: "3.00", net_amount: "7.00", is_first_payout_of_month: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows only one of two concurrent requested totals beyond the available balance", async () => {
    const eventStore = createPostgresEventStore({ pool });
    const realWallets = createWalletRuntime({
      eventStore,
      checkpointStore: { loadCheckpoint: async () => "0" as never, saveCheckpoint: async () => undefined },
      db: pool,
    });
    await realWallets.postEntry(
      {
        accountId: "acc_payout_fee_concurrency" as never,
        ledgerEntryId: "led_payout_fee_concurrency_seed" as never,
        kind: "sale",
        direction: "credit",
        amount: "20.00",
        currencyCode: "usd",
        fundsStatus: "available",
        description: "Synthetic real-DB concurrency balance",
        postedAt: "2026-09-11T00:00:00.000Z",
      },
      context,
    );
    const wallets = {
      ...realWallets,
      getWallet: async () => ({
        account_id: "acc_payout_fee_concurrency",
        currency_code: "usd",
        pending_balance_amount: "0.00",
        available_balance_amount: "20.00",
        total_credited_amount: "20.00",
        total_debited_amount: "0.00",
        negative_balance_status: "in-good-standing" as const,
        negative_balance_started_at: null,
        collections_escalated_at: null,
        opened_at: "2026-09-11T00:00:00.000Z",
        updated_at: "2026-09-11T00:00:00.000Z",
      }),
    } satisfies WalletServices;
    const readiness = {
      getPayoutReadiness: async () => ({
        account_id: "acc_payout_fee_concurrency",
        status: "ready" as const,
        missing_requirements: [],
        advisory_requirements: [],
        disabled_reason: null,
        requirements_deadline: null,
        provider_reference: "acct_synthetic_payout_fee_concurrency",
        contact_email: null,
        onboarding_status: "complete",
        transfer_capability_status: "active",
        payout_capability_status: "active",
        payout_destination_status: "ready",
        payout_destination_fingerprint: null,
        payout_destination_changed_at: null,
        payout_account_dashboard: "none" as const,
        losses_collector: "application" as const,
        fees_collector: "application" as const,
        requirements_collector: "application" as const,
        updated_at: new Date().toISOString(),
      }),
    } as unknown as PayoutReadinessServices;
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: { loadCheckpoint: async () => "0" as never, saveCheckpoint: async () => undefined },
      db: pool,
      wallets,
      payoutReadiness: readiness,
      moneyMovementGateway: createFakeMoneyMovementGateway(),
    });

    const results = await Promise.all([
      payouts.requestPayout({ accountId: "acc_payout_fee_concurrency" as never, amount: "12.50" }, context),
      payouts.requestPayout({ accountId: "acc_payout_fee_concurrency" as never, amount: "12.50" }, context),
    ]);
    const active = results.filter((result) => result.payout.status !== "failed");
    const failed = results.filter((result) => result.payout.status === "failed");
    expect(active).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const walletEvents = await readCompleteStream(eventStore, {
      streamId: "settlement.wallet-acc_payout_fee_concurrency",
    });
    const payoutEntries = walletEvents
      .filter((event) => event.eventType === "settlement.wallet.ledger-entry-posted")
      .map((event) => event.payload as { payoutId?: string; ledgerEntryId: string; direction: string; amount: string })
      .filter((entry) => entry.payoutId);
    const activeEntries = payoutEntries.filter((entry) => entry.payoutId === active[0]!.payoutId);
    expect(activeEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ledgerEntryId: `led_payout_${active[0]!.payoutId}`,
          direction: "debit",
          amount: "12.21",
        }),
        expect.objectContaining({
          ledgerEntryId: `led_payout_fee_${active[0]!.payoutId}`,
          direction: "debit",
          amount: "0.29",
        }),
      ]),
    );
    const balanceEffectInCents = payoutEntries.reduce(
      (total, entry) => total + (entry.direction === "debit" ? -1 : 1) * Math.round(Number(entry.amount) * 100),
      0,
    );
    expect(balanceEffectInCents).toBe(-1250);
  });
});
