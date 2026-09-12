import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createWalletRuntime } from "../../wallets/api/runtime";
import type { WalletServices } from "../../wallets/api/runtime";
import { createPayoutRuntime } from "./runtime";
import type { PayoutReadinessServices } from "../../payout-readiness/api/runtime";
import type { MoneyMovementGateway } from "@chase-sets/money-movement";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement/test-support";
import { SettlementDomainError } from "../../../support/runtime-support/common";
import type { SettlementPayoutFeePolicyValue } from "../domain/payout-policy";

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_seller" as never,
  },
};

async function seedAvailableWallet(wallets: ReturnType<typeof createWalletRuntime>, amount = "20.00") {
  await wallets.postEntry(
    {
      accountId: "acc_seller" as never,
      ledgerEntryId: `led_seed_${amount}` as never,
      kind: "sale",
      direction: "credit",
      amount,
      currencyCode: "usd",
      fundsStatus: "available",
      description: "Seed available balance",
      postedAt: "2026-04-01T00:00:00.000Z",
    },
    context,
  );
}

function createPayoutReadiness(
  status: "not-started" | "pending" | "ready" | "restricted",
  options: Readonly<{
    updatedAt?: string | null;
    missingRequirements?: readonly string[];
    payoutDestinationChangedAt?: string | null;
    refreshProviderReadiness?: PayoutReadinessServices["refreshProviderReadiness"];
  }> = {},
) {
  const readiness = (updatedAt: string | null = options.updatedAt ?? new Date().toISOString()) => ({
    account_id: "acc_seller",
    status,
    missing_requirements: options.missingRequirements ?? (status === "ready" ? [] : ["provider-onboarding"]),
    provider_reference: "acct_test",
    onboarding_status: status === "ready" ? "complete" : "pending",
    transfer_capability_status: status === "ready" ? "active" : "pending",
    payout_capability_status: status === "ready" ? "active" : "pending",
    payout_destination_status: status === "ready" ? "ready" : "missing",
    payout_destination_fingerprint: "ba_test:bank_account:US:usd:4242:verified",
    payout_destination_changed_at: options.payoutDestinationChangedAt ?? null,
    payout_account_dashboard: "none",
    losses_collector: "application",
    fees_collector: "application",
    requirements_collector: "application",
    updated_at: updatedAt,
  });

  return {
    getPayoutReadiness: async () => readiness(),
    refreshProviderReadiness:
      options.refreshProviderReadiness ??
      (async () => ({
        ...readiness(new Date().toISOString()),
        status: "ready",
        missing_requirements: [],
        onboarding_status: "complete",
        transfer_capability_status: "active",
        payout_capability_status: "active",
        payout_destination_status: "ready",
      })),
  } as unknown as PayoutReadinessServices;
}

function createSyntheticPlatformBalanceGateway(availableAmount: string): MoneyMovementGateway {
  return {
    ...createFakeMoneyMovementGateway(),
    providerName: "synthetic-cent-math-control",
    async retrievePlatformBalance(input) {
      return { currencyCode: input.currencyCode, availableAmount };
    },
  };
}

function createPayoutArithmeticRuntime(
  options: Readonly<{
    walletAvailableAmount?: string;
    walletPendingAmount?: string;
    supportHoldAmount?: string;
    spendHoldAmount?: string;
    platformAvailableAmount?: string;
    inTransitAmounts?: readonly string[];
    feePolicy?: SettlementPayoutFeePolicyValue;
    moneyMovementGateway?: MoneyMovementGateway;
  }> = {},
) {
  const { eventStore, readAllEvents } = createInMemoryEventStore();
  const payoutRequestIdempotency = new Map<
    string,
    { payout_id: string; requested_amount: string; currency_code: string }
  >();
  let afterIdempotencyReservation: (() => Promise<void>) | null = null;
  const db = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("settlement_payout_request_idempotency")) {
        const key = `${String(values?.[0])}:${String(values?.[1])}`;
        const existing = payoutRequestIdempotency.get(key);
        if (sql.includes("DELETE FROM settlement_payout_request_idempotency")) {
          const payoutId = String(values?.[2]);
          const streamId = String(values?.[3]);
          const streamExists = readAllEvents().some((event) => event.streamId === streamId);
          if (existing?.payout_id === payoutId && !streamExists) {
            payoutRequestIdempotency.delete(key);
            return { rows: [{ payout_id: payoutId }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO settlement_payout_request_idempotency")) {
          if (existing) {
            return { rows: [{ ...existing, reserved: false }], rowCount: 1 };
          }
          const inserted = {
            payout_id: String(values?.[2]),
            requested_amount: String(values?.[3]),
            currency_code: String(values?.[4]),
          };
          payoutRequestIdempotency.set(key, inserted);
          if (afterIdempotencyReservation) {
            const hook = afterIdempotencyReservation;
            afterIdempotencyReservation = null;
            await hook();
          }
          return { rows: [{ ...inserted, reserved: true }], rowCount: 1 };
        }
        return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
      }
      if (sql.includes("COUNT(*) FILTER")) {
        return {
          rows: [
            {
              failed_payout_count: "0",
              stale_requested_payout_count: "0",
              in_transit_payout_count: "0",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM settlement_wallet_spend_holds")) {
        return { rows: [{ amount: options.spendHoldAmount ?? "0.00" }], rowCount: 1 };
      }
      if (sql.includes("FROM settlement_ledger_entry_pages entry")) {
        return { rows: [{ amount: options.supportHoldAmount ?? "0.00" }], rowCount: 1 };
      }
      if (sql.includes("FROM settlement_payout_pages")) {
        const rows = (options.inTransitAmounts ?? []).map((amount, index) => ({
          payout_id: `pyo_synthetic_cent_math_${index}`,
          account_id: "acc_synthetic_cent_math",
          amount,
          currency_code: "usd",
          status: "in-transit",
          updated_at: "2026-08-24T00:00:00.000Z",
        }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const wallets = {
    getWallet: vi.fn(async () => ({
      account_id: "acc_seller",
      currency_code: "usd",
      pending_balance_amount: options.walletPendingAmount ?? "0.00",
      available_balance_amount: options.walletAvailableAmount ?? "20.00",
      total_credited_amount: "20.00",
      total_debited_amount: "0.00",
      negative_balance_status: "in-good-standing",
      negative_balance_started_at: null,
      collections_escalated_at: null,
      opened_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:00:00.000Z",
    })),
    postEntry: vi.fn(),
    listNegativeBalanceAccounts: vi.fn(async () => ({ items: [], total: 0 })),
  };
  const payouts = createPayoutRuntime({
    eventStore,
    checkpointStore: createCheckpointStore(),
    db: db as never,
    wallets: wallets as unknown as WalletServices,
    payoutReadiness: createPayoutReadiness("ready"),
    moneyMovementGateway:
      options.moneyMovementGateway ??
      createSyntheticPlatformBalanceGateway(options.platformAvailableAmount ?? "999999.00"),
    ...(options.feePolicy
      ? {
          policies: {
            resolvePolicy: async (definition: { policyKey: string }, input?: { at?: string }) => ({
              policyKey: definition.policyKey,
              value:
                definition.policyKey === "settlement.payout-fee"
                  ? options.feePolicy
                  : { currencyCode: "usd", minimumAmount: "5.00", maximumAmount: "10000.00" },
              source: "policy",
              documentId: "pol_synthetic_payout_fee",
              resolvedAt: input?.at ?? new Date().toISOString(),
            }),
          } as never,
        }
      : {}),
  });

  return {
    payouts,
    readAllEvents,
    wallets,
    db,
    payoutRequestIdempotency,
    setAfterIdempotencyReservation(hook: () => Promise<void>) {
      afterIdempotencyReservation = hook;
    },
  };
}

async function expectNamedSettlementRejection(promise: Promise<unknown>, message: string) {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(SettlementDomainError);
  expect(rejection).toMatchObject({ name: "SettlementDomainError", message });
}

function createPayoutProviderOperationDb(payoutRows: () => Record<string, unknown>[]) {
  const operations = new Map<string, Record<string, unknown>>();
  const processedProviderEvents = new Set<string>();
  const db = {
    query: async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM settlement_wallet_pages")) {
        return {
          rows: [
            {
              account_id: "acc_seller",
              currency_code: "usd",
              pending_balance_amount: "0.00",
              available_balance_amount: "20.00",
              total_credited_amount: "20.00",
              total_debited_amount: "0.00",
              opened_at: "2026-04-02T00:00:00.000Z",
              updated_at: "2026-04-02T00:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      }

      if (sql.includes("INSERT INTO settlement_provider_operations")) {
        operations.set(String(values?.[0]), {
          operation_key: values?.[0],
          provider_name: values?.[1],
          operation_kind: values?.[2],
          account_id: values?.[3],
          payout_id: values?.[4],
          idempotency_key: values?.[5],
          request_json: JSON.parse(String(values?.[6] ?? "{}")),
          status: "pending",
          provider_object_reference: null,
          error_message: null,
          created_at: values?.[7],
          updated_at: values?.[7],
          completed_at: null,
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("UPDATE settlement_provider_operations") && sql.includes("status = 'succeeded'")) {
        const existing = operations.get(String(values?.[0]));
        if (existing) {
          operations.set(String(values?.[0]), {
            ...existing,
            status: "succeeded",
            provider_object_reference: values?.[1],
            error_message: null,
            completed_at: values?.[2],
            updated_at: values?.[2],
          });
        }
        return { rows: [], rowCount: existing ? 1 : 0 };
      }

      if (sql.includes("UPDATE settlement_provider_operations") && sql.includes("status = 'failed'")) {
        const existing = operations.get(String(values?.[0]));
        if (existing?.status === "pending") {
          operations.set(String(values?.[0]), {
            ...existing,
            status: "failed",
            error_message: values?.[1],
            completed_at: values?.[2],
            updated_at: values?.[2],
          });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("FROM settlement_provider_operations")) {
        if (sql.includes("WHERE payout_id = $1")) {
          return {
            rows: [...operations.values()].filter((operation) => operation.payout_id === values?.[0]),
            rowCount: operations.size,
          };
        }
      }

      if (sql.includes("settlement_money_movement_webhook_events")) {
        const providerEventId = String(values?.[0] ?? "");
        if (sql.includes("SELECT provider_event_id")) {
          return {
            rows: processedProviderEvents.has(providerEventId) ? [{ provider_event_id: providerEventId }] : [],
            rowCount: processedProviderEvents.has(providerEventId) ? 1 : 0,
          };
        }
        processedProviderEvents.add(providerEventId);
        return { rows: [{ provider_event_id: providerEventId }], rowCount: 1 };
      }

      if (sql.includes("INSERT INTO settlement_provider_idempotency_keys")) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("FROM settlement_payout_pages")) {
        const rows = payoutRows();
        if (sql.includes("WHERE provider_payout_reference = $1")) {
          const matched = rows.filter((row) => row.provider_payout_reference === values?.[0]);
          return { rows: matched, rowCount: matched.length };
        }
        if (sql.includes("WHERE payout_id = (")) {
          const operation = [...operations.values()].find((entry) => entry.provider_object_reference === values?.[0]);
          const matched = rows.filter((row) => row.payout_id === operation?.payout_id);
          return { rows: matched, rowCount: matched.length };
        }
        if (values?.[0] && values?.[1] && sql.includes("AND account_id = $2")) {
          const matched = rows.filter((row) => row.payout_id === values[0] && row.account_id === values[1]);
          return { rows: matched, rowCount: matched.length };
        }
        return { rows, rowCount: rows.length };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  return { db, operations };
}

describe("settlement payout runtime", () => {
  it("settlement payout money consolidation preserves in-range and negative results", async () => {
    const schedules = [
      {
        walletAvailableAmount: "100.00",
        supportHoldAmount: "30.00",
        spendHoldAmount: "20.00",
        available: "50.00",
        estimated: "45.00",
      },
      {
        walletAvailableAmount: "10.00",
        supportHoldAmount: "30.00",
        spendHoldAmount: "20.00",
        available: "-40.00",
        estimated: "0.00",
      },
      {
        walletAvailableAmount: "-5.00",
        supportHoldAmount: "0.00",
        spendHoldAmount: "0.00",
        available: "-5.00",
        estimated: "0.00",
      },
      {
        walletAvailableAmount: "0.00",
        supportHoldAmount: "0.01",
        spendHoldAmount: "0.00",
        available: "-0.01",
        estimated: "0.00",
      },
      {
        walletAvailableAmount: "9999999999.99",
        supportHoldAmount: "0.00",
        spendHoldAmount: "0.00",
        available: "9999999999.99",
        estimated: "9999999994.99",
      },
    ] as const;

    for (const schedule of schedules) {
      const { payouts } = createPayoutArithmeticRuntime(schedule);
      const preview = await payouts.previewPayoutRequest({ accountId: "acc_seller" as never, amount: "5.00" }, context);
      expect(preview.available_balance_amount, JSON.stringify(schedule)).toBe(schedule.available);
      expect(preview.estimated_wallet_balance_after, JSON.stringify(schedule)).toBe(schedule.estimated);
    }
  });

  it("payout-fee-preview quotes first UTC-month payout, subsequent payout, failed-first retry, and month rollover", async () => {
    vi.useFakeTimers();
    const feePolicy = {
      label: "Synthetic payout fee",
      percentageBps: 0,
      fixedAmount: "1.00",
      firstPayoutOfMonthFixedAmount: "2.00",
    } as const;
    try {
      vi.setSystemTime(new Date("2026-08-31T23:59:59.000Z"));
      const activeRuntime = createPayoutArithmeticRuntime({ feePolicy });
      const firstPreview = await activeRuntime.payouts.previewPayoutRequest(
        { accountId: "acc_seller" as never, amount: "10.00" },
        context,
      );
      expect(firstPreview).toMatchObject({
        requested_amount: "10.00",
        fee_amount: "3.00",
        net_amount: "7.00",
        monthly_active_fee_amount: "2.00",
        is_first_payout_of_month: true,
        fee_policy_version: "pol_synthetic_payout_fee",
      });
      expect(firstPreview.fee_lines).toEqual([
        { code: "payout-fee", label: "Synthetic payout fee", amount: "1.00" },
        { code: "monthly-active-fee", label: "First payout of the month", amount: "2.00" },
      ]);

      await activeRuntime.payouts.requestPayout({ accountId: "acc_seller" as never, amount: "10.00" }, context);
      const secondPreview = await activeRuntime.payouts.previewPayoutRequest(
        { accountId: "acc_seller" as never, amount: "10.00" },
        context,
      );
      expect(secondPreview).toMatchObject({
        fee_amount: "1.00",
        net_amount: "9.00",
        monthly_active_fee_amount: "0.00",
        is_first_payout_of_month: false,
      });

      vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
      await expect(
        activeRuntime.payouts.previewPayoutRequest({ accountId: "acc_seller" as never, amount: "10.00" }, context),
      ).resolves.toMatchObject({ fee_amount: "3.00", net_amount: "7.00", is_first_payout_of_month: true });

      const fakeGateway = createFakeMoneyMovementGateway();
      const failedRuntime = createPayoutArithmeticRuntime({
        feePolicy,
        moneyMovementGateway: {
          ...fakeGateway,
          async transferPlatformBalanceToConnectedAccount() {
            throw Object.assign(new Error("Synthetic terminal decline."), {
              statusCode: 400,
              code: "invalid_transfer",
            });
          },
        },
      });
      const failed = await failedRuntime.payouts.requestPayout(
        { accountId: "acc_seller" as never, amount: "10.00" },
        context,
      );
      expect(failed.payout.status).toBe("failed");
      await expect(
        failedRuntime.payouts.previewPayoutRequest({ accountId: "acc_seller" as never, amount: "10.00" }, context),
      ).resolves.toMatchObject({ fee_amount: "3.00", net_amount: "7.00", is_first_payout_of_month: true });

      const belowFeeRuntime = createPayoutArithmeticRuntime({
        feePolicy: { ...feePolicy, fixedAmount: "5.00", firstPayoutOfMonthFixedAmount: "0.00" },
      });
      await expect(
        belowFeeRuntime.payouts.previewPayoutRequest({ accountId: "acc_seller" as never, amount: "5.00" }, context),
      ).resolves.toMatchObject({
        fee_amount: "5.00",
        net_amount: "0.00",
        can_request: false,
        unavailable_reasons: ["payout-amount-below-fee"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("payout-fee-concurrency serializes two first-of-month requests through one month stream", async () => {
    const runtime = createPayoutArithmeticRuntime({
      feePolicy: {
        label: "Synthetic payout fee",
        percentageBps: 0,
        fixedAmount: "1.00",
        firstPayoutOfMonthFixedAmount: "2.00",
      },
    });

    const results = await Promise.all([
      runtime.payouts.requestPayout({ accountId: "acc_seller" as never, amount: "10.00" }, context),
      runtime.payouts.requestPayout({ accountId: "acc_seller" as never, amount: "10.00" }, context),
    ]);

    expect(results.map((result) => result.payout.fee_amount).sort()).toEqual(["1.00", "3.00"]);
    expect(
      runtime.readAllEvents().filter((event) => event.eventType === "settlement.payout.monthly-baseline-recorded"),
    ).toHaveLength(1);
  });

  it("payout-fee-request-once replays an idempotent request without a second net or fee debit", async () => {
    const runtime = createPayoutArithmeticRuntime();
    const first = await runtime.payouts.requestPayout(
      { accountId: "acc_seller" as never, amount: "12.50", idempotencyKey: "payout-fee-once" },
      context,
    );
    const replay = await runtime.payouts.requestPayout(
      { accountId: "acc_seller" as never, amount: "12.50", idempotencyKey: "payout-fee-once" },
      context,
    );

    expect(replay).toEqual(first);
    expect(runtime.wallets.postEntry).toHaveBeenCalledTimes(2);
    expect(runtime.wallets.postEntry.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({
        ledgerEntryId: `led_payout_${first.payoutId}`,
        kind: "payout",
        direction: "debit",
        amount: "12.21",
      }),
      expect.objectContaining({
        ledgerEntryId: `led_payout_fee_${first.payoutId}`,
        kind: "fee",
        direction: "debit",
        amount: "0.29",
      }),
    ]);
  });

  it("releases only its own absent reservation after a monthly fee increase rejects before append", async () => {
    const runtime = createPayoutArithmeticRuntime({
      feePolicy: {
        label: "Synthetic monthly-race payout fee",
        percentageBps: 0,
        fixedAmount: "1.00",
        firstPayoutOfMonthFixedAmount: "6.00",
      },
    });
    const first = await runtime.payouts.requestPayout({ accountId: "acc_seller" as never, amount: "10.00" }, context);
    runtime.setAfterIdempotencyReservation(async () => {
      await runtime.payouts.failPayout(
        {
          payoutId: first.payoutId,
          accountId: "acc_seller",
          netAmount: first.payout.net_amount,
          feeAmount: first.payout.fee_amount,
          currencyCode: "usd",
        },
        context,
      );
    });

    await expect(
      runtime.payouts.requestPayout(
        { accountId: "acc_seller" as never, amount: "5.50", idempotencyKey: "synthetic-month-race" },
        context,
      ),
    ).rejects.toThrow("Payout requested amount must exceed the payout fee.");
    expect(runtime.payoutRequestIdempotency.size).toBe(0);
    await expect(
      runtime.payouts.requestPayout(
        { accountId: "acc_seller" as never, amount: "5.50", idempotencyKey: "synthetic-month-race" },
        context,
      ),
    ).rejects.toThrow("Requested payout amount must exceed the payout fee.");
    expect(runtime.payoutRequestIdempotency.size).toBe(0);
  });

  it("does not remove a competing owner while cleaning up a rejected pre-append reservation", async () => {
    const runtime = createPayoutArithmeticRuntime({
      feePolicy: {
        label: "Synthetic competing-owner payout fee",
        percentageBps: 0,
        fixedAmount: "1.00",
        firstPayoutOfMonthFixedAmount: "6.00",
      },
    });
    const first = await runtime.payouts.requestPayout({ accountId: "acc_seller" as never, amount: "10.00" }, context);
    runtime.setAfterIdempotencyReservation(async () => {
      runtime.payoutRequestIdempotency.set("acc_seller:synthetic-competing-owner", {
        payout_id: "pyo_synthetic_competing_owner",
        requested_amount: "5.50",
        currency_code: "usd",
      });
      await runtime.payouts.failPayout(
        {
          payoutId: first.payoutId,
          accountId: "acc_seller",
          netAmount: first.payout.net_amount,
          feeAmount: first.payout.fee_amount,
          currencyCode: "usd",
        },
        context,
      );
    });

    await expect(
      runtime.payouts.requestPayout(
        { accountId: "acc_seller" as never, amount: "5.50", idempotencyKey: "synthetic-competing-owner" },
        context,
      ),
    ).rejects.toThrow("Payout requested amount must exceed the payout fee.");
    expect(runtime.payoutRequestIdempotency.get("acc_seller:synthetic-competing-owner")?.payout_id).toBe(
      "pyo_synthetic_competing_owner",
    );
  });

  it("omits zero fee postings and reverses only the existing net debit", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const reservations = new Map<string, { payout_id: string; requested_amount: string; currency_code: string }>();
    const db = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes("settlement_payout_request_idempotency")) {
          const key = `${String(values?.[0])}:${String(values?.[1])}`;
          const existing = reservations.get(key);
          if (sql.includes("INSERT INTO settlement_payout_request_idempotency")) {
            if (existing) return { rows: [{ ...existing, reserved: false }], rowCount: 1 };
            const inserted = {
              payout_id: String(values?.[2]),
              requested_amount: String(values?.[3]),
              currency_code: String(values?.[4]),
            };
            reservations.set(key, inserted);
            return { rows: [{ ...inserted, reserved: true }], rowCount: 1 };
          }
          return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
        }
        if (sql.includes("COUNT(*) FILTER")) {
          return {
            rows: [{ failed_payout_count: "0", stale_requested_payout_count: "0", in_transit_payout_count: "0" }],
            rowCount: 1,
          };
        }
        if (sql.includes("COALESCE(SUM")) return { rows: [{ amount: "0.00" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    const realWallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    await seedAvailableWallet(realWallets, "100.00");
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets: {
        ...realWallets,
        getWallet: async () => ({
          account_id: "acc_seller",
          currency_code: "usd",
          pending_balance_amount: "0.00",
          available_balance_amount: "100.00",
          total_credited_amount: "100.00",
          total_debited_amount: "0.00",
          negative_balance_status: "in-good-standing" as const,
          negative_balance_started_at: null,
          collections_escalated_at: null,
          opened_at: "2026-09-11T00:00:00.000Z",
          updated_at: "2026-09-11T00:00:00.000Z",
        }),
      },
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      policies: {
        resolvePolicy: async (definition: { policyKey: string }, input?: { at?: string }) => ({
          policyKey: definition.policyKey,
          value:
            definition.policyKey === "settlement.payout-fee"
              ? {
                  label: "Synthetic zero payout fee",
                  percentageBps: 0,
                  fixedAmount: "0.00",
                  firstPayoutOfMonthFixedAmount: "0.00",
                }
              : { currencyCode: "usd", minimumAmount: "5.00", maximumAmount: "10000.00" },
          source: "policy" as const,
          documentId: "pol_synthetic_zero_payout_fee",
          resolvedAt: input?.at ?? new Date().toISOString(),
        }),
      } as never,
    });

    const first = await payouts.requestPayout(
      { accountId: "acc_seller" as never, amount: "10.00", idempotencyKey: "synthetic-zero-fee" },
      context,
    );
    expect(first.payout).toMatchObject({
      status: "in-transit",
      requested_amount: "10.00",
      fee_amount: "0.00",
      net_amount: "10.00",
      provider_payout_reference: expect.any(String),
    });
    await expect(
      payouts.requestPayout(
        { accountId: "acc_seller" as never, amount: "10.00", idempotencyKey: "synthetic-zero-fee" },
        context,
      ),
    ).resolves.toEqual(first);

    await payouts.failPayout(
      {
        payoutId: first.payoutId,
        accountId: "acc_seller",
        netAmount: "10.00",
        feeAmount: "0.00",
        currencyCode: "usd",
        failureReason: "Synthetic zero-fee failure",
      },
      context,
    );
    const payoutEntries = readAllEvents()
      .filter(
        (event) =>
          event.eventType === "settlement.wallet.ledger-entry-posted" &&
          (event.payload as { payoutId?: string }).payoutId === first.payoutId,
      )
      .map((event) => event.payload);
    expect(payoutEntries).toEqual([
      expect.objectContaining({ kind: "payout", direction: "debit", amount: "10.00" }),
      expect.objectContaining({ kind: "payout-reversal", direction: "credit", amount: "10.00" }),
    ]);
  });

  it("settlement payout nested subtraction fails closed on signed range overflow", async () => {
    const overflow = {
      walletAvailableAmount: "0.00",
      supportHoldAmount: "9999999999.99",
      spendHoldAmount: "9999999999.99",
    } as const;
    const previewRuntime = createPayoutArithmeticRuntime(overflow);
    await expectNamedSettlementRejection(
      previewRuntime.payouts.previewPayoutRequest({ accountId: "acc_seller" as never, amount: "5.00" }, context),
      "Payout available balance must be a valid signed decimal.",
    );
    expect(previewRuntime.readAllEvents()).toHaveLength(0);

    const requestRuntime = createPayoutArithmeticRuntime(overflow);
    await expectNamedSettlementRejection(
      requestRuntime.payouts.requestPayout({ accountId: "acc_seller" as never, amount: "5.00" }, context),
      "Payout available balance must be a valid signed decimal.",
    );
    expect(requestRuntime.readAllEvents()).toHaveLength(0);
    expect(requestRuntime.wallets.postEntry).not.toHaveBeenCalled();
  });

  it("payout preview unavailable reasons are unchanged after money consolidation", async () => {
    const { payouts } = createPayoutArithmeticRuntime({
      walletAvailableAmount: "-5.00",
      walletPendingAmount: "10.00",
    });

    const preview = await payouts.previewPayoutRequest({ accountId: "acc_seller" as never, amount: "10.00" }, context);

    expect(preview.available_balance_amount).toBe("-5.00");
    expect(preview.unavailable_reasons).toEqual([
      "no-available-wallet-balance",
      "negative-balance-active",
      "payout-release-hold-active",
      "amount-exceeds-available-balance",
    ]);
  });

  it("platform balance accepts a signed negative amount and rejects malformed or out-of-range amounts with a named domain error", async () => {
    const negativeRuntime = createPayoutArithmeticRuntime({
      platformAvailableAmount: "-12.34",
      inTransitAmounts: ["55.00"],
    });
    await expect(negativeRuntime.payouts.getPlatformBalanceForecast()).resolves.toMatchObject({
      available_amount: "-12.34",
      pending_payout_demand_amount: "55.00",
      forecast_after_pending_demand_amount: "-67.34",
    });
    const negativePreview = await negativeRuntime.payouts.previewPayoutRequest(
      { accountId: "acc_seller" as never, amount: "5.00" },
      context,
    );
    expect(negativePreview.platform_available_amount).toBe("-12.34");
    expect(negativePreview.unavailable_reasons).toContain("platform-balance-insufficient");
    await expectNamedSettlementRejection(
      negativeRuntime.payouts.requestPayout({ accountId: "acc_seller" as never, amount: "5.00" }, context),
      "Platform balance is too low for this payout.",
    );
    expect(negativeRuntime.readAllEvents()).toHaveLength(0);
    expect(negativeRuntime.wallets.postEntry).not.toHaveBeenCalled();

    for (const availableAmount of ["abc", "10000000000000.00", "-10000000000000.00"]) {
      const forecastRuntime = createPayoutArithmeticRuntime({ platformAvailableAmount: availableAmount });
      await expectNamedSettlementRejection(
        forecastRuntime.payouts.getPlatformBalanceForecast(),
        "Platform available amount must be a valid signed decimal.",
      );

      const previewRuntime = createPayoutArithmeticRuntime({ platformAvailableAmount: availableAmount });
      await expectNamedSettlementRejection(
        previewRuntime.payouts.previewPayoutRequest({ accountId: "acc_seller" as never, amount: "5.00" }, context),
        "Platform available amount must be a valid signed decimal.",
      );

      const requestRuntime = createPayoutArithmeticRuntime({ platformAvailableAmount: availableAmount });
      await expectNamedSettlementRejection(
        requestRuntime.payouts.requestPayout({ accountId: "acc_seller" as never, amount: "5.00" }, context),
        "Platform available amount must be a valid signed decimal.",
      );
      expect(requestRuntime.readAllEvents()).toHaveLength(0);
      expect(requestRuntime.wallets.postEntry).not.toHaveBeenCalled();
    }
  });

  it("platform balance forecast keeps every operand aggregate and result canonical", async () => {
    const validRuntime = createPayoutArithmeticRuntime({
      platformAvailableAmount: "100.00",
      inTransitAmounts: ["0.00", "55.00"],
    });
    await expect(validRuntime.payouts.getPlatformBalanceForecast()).resolves.toMatchObject({
      available_amount: "100.00",
      pending_payout_demand_amount: "55.00",
      forecast_after_pending_demand_amount: "45.00",
    });

    const malformedRowRuntime = createPayoutArithmeticRuntime({ inTransitAmounts: ["abc"] });
    await expectNamedSettlementRejection(
      malformedRowRuntime.payouts.getPlatformBalanceForecast(),
      "In-transit payout amount must be a valid decimal.",
    );

    const aggregateOverflowRuntime = createPayoutArithmeticRuntime({
      inTransitAmounts: ["9999999999.99", "9999999999.99"],
    });
    await expectNamedSettlementRejection(
      aggregateOverflowRuntime.payouts.getPlatformBalanceForecast(),
      "Pending payout demand amount must be a valid decimal.",
    );

    const forecastOverflowRuntime = createPayoutArithmeticRuntime({
      platformAvailableAmount: "-9999999999.99",
      inTransitAmounts: ["0.01"],
    });
    await expectNamedSettlementRejection(
      forecastOverflowRuntime.payouts.getPlatformBalanceForecast(),
      "Platform balance forecast must be a valid signed decimal.",
    );
  });

  it("turns a duplicate command with a stale expected version into a typed conflict", async () => {
    const { eventStore } = createInMemoryEventStore();
    const input = {
      streamId: "settlement.payout-conflict",
      expectedVersion: "no_stream" as const,
      context,
      events: [{ eventType: "settlement.payout.requested", payload: {} }],
    };

    await eventStore.appendToStream(input);
    await expect(eventStore.appendToStream(input)).rejects.toMatchObject({
      code: "concurrency_conflict",
      details: { currentVersion: 1 },
    });
  });

  it("records provider-health checks as settlement operation liveness telemetry", async () => {
    const operationEvents: Record<string, unknown>[] = [];
    const payouts = createPayoutRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      checkpointStore: createCheckpointStore(),
      db: {} as never,
      wallets: {} as never,
      payoutReadiness: {} as never,
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: {
        record: (event) => {
          operationEvents.push(event);
        },
      },
    });

    const health = await payouts.getProviderHealth();

    expect(health).toMatchObject({
      provider_name: "fake",
      adapter_mode: "fake",
    });
    expect(operationEvents).toEqual([
      expect.objectContaining({
        kind: "provider-health-checked",
        providerName: "fake",
      }),
    ]);
    expect(operationEvents[0]?.occurredAt).toEqual(expect.any(String));
  });

  it("issue-6299-acceptance-control reverses a payout whose debit committed beyond 500 wallet events", async () => {
    const { eventStore, readAllEvents, streams } = createInMemoryEventStore();
    let payoutRow: Record<string, unknown> | null = null;

    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        if (sql.includes("FROM settlement_payout_pages")) {
          return {
            rows: payoutRow ? [payoutRow] : [],
            rowCount: payoutRow ? 1 : 0,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };

    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
    });
    await seedAvailableWallet(wallets);
    const walletStreamId = "settlement.wallet-acc_seller";
    const fillerCount = 500 - (streams.get(walletStreamId)?.length ?? 0);
    await eventStore.appendToStream({
      streamId: walletStreamId,
      expectedVersion: streams.get(walletStreamId)?.length ?? 0,
      context,
      events: Array.from({ length: fillerCount }, (_, index) => ({
        eventType: "settlement.wallet.ledger-entry-posted",
        payload: {
          accountId: "acc_seller",
          ledgerEntryId: `led_pagination_${index}`,
          kind: "sale",
          direction: "credit",
          amount: "0.01",
          currencyCode: "usd",
          fundsStatus: "available",
          orderId: null,
          paymentId: null,
          payoutId: null,
          description: "Pagination control",
          postedAt: "2026-04-01T00:00:00.000Z",
        },
      })),
    });

    const requested = await payouts.requestPayout(
      {
        accountId: "acc_seller" as never,
        amount: "12.50",
        destinationReference: "bank_123",
        note: "Weekly payout",
      },
      context,
    );

    expect(requested.payout).toMatchObject({
      payout_id: requested.payoutId,
      account_id: "acc_seller",
      requested_amount: "12.50",
      fee_amount: "0.29",
      net_amount: "12.21",
      status: "in-transit",
      provider_transfer_reference: expect.any(String),
      provider_payout_reference: expect.any(String),
      version: requested.version,
    });

    payoutRow = {
      payout_id: requested.payoutId,
      account_id: "acc_seller",
      amount: "12.50",
      currency_code: "usd",
      destination_reference: "bank_123",
      note: "Weekly payout",
      status: "requested",
      requested_at: "2026-04-02T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
      sent_at: null,
      completed_at: null,
      failed_at: null,
      failure_reason: null,
    };

    await payouts.failPayout(
      {
        payoutId: requested.payoutId,
        accountId: "acc_seller",
        failureReason: "Bank rejected transfer",
        failedAt: "2026-04-02T01:00:00.000Z",
      },
      context,
    );

    const payoutEvents = readAllEvents().filter((event) => event.eventType.startsWith("settlement.payout."));
    const walletEntryEvents = readAllEvents().filter(
      (event) =>
        event.eventType === "settlement.wallet.ledger-entry-posted" &&
        (event.payload as { payoutId?: string }).payoutId === requested.payoutId,
    );

    expect(payoutEvents.map((event) => event.eventType)).toEqual([
      "settlement.payout.monthly-baseline-recorded",
      "settlement.payout.monthly-request-counted",
      "settlement.payout.requested",
      "settlement.payout.provider-references-recorded",
      "settlement.payout.provider-references-recorded",
      "settlement.payout.in-transit-recorded",
      "settlement.payout.monthly-request-released",
      "settlement.payout.failed",
    ]);
    expect(walletEntryEvents).toHaveLength(4);
    expect(
      readAllEvents().find(
        (event) =>
          event.eventType === "settlement.wallet.ledger-entry-posted" &&
          (event.payload as { kind?: string }).kind === "payout",
      )?.streamVersion,
    ).toBe(501);
    expect(walletEntryEvents[0]?.payload).toMatchObject({
      kind: "payout",
      direction: "debit",
      amount: "12.21",
    });
    expect(walletEntryEvents[1]?.payload).toMatchObject({
      kind: "fee",
      direction: "debit",
      amount: "0.29",
    });
    expect(walletEntryEvents[2]?.payload).toMatchObject({
      kind: "payout-reversal",
      direction: "credit",
      amount: "12.21",
    });
    expect(walletEntryEvents[3]?.payload).toMatchObject({
      kind: "fee",
      direction: "credit",
      amount: "0.29",
    });
  });

  it("requires step-up for payout requests inside the payout destination cooling window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };
    const wallets = {
      getWallet: vi.fn(async () => ({
        account_id: "acc_seller",
        currency_code: "usd",
        pending_balance_amount: "0.00",
        available_balance_amount: "20.00",
        negative_balance_status: "in-good-standing",
      })),
      postEntry: vi.fn(async () => ({ ledgerEntryId: "led_test", version: 1 })),
    };
    const sensitiveActionVerifier = vi.fn(async (input: { token: string }) => input.token === "fresh-step-up");
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets: wallets as never,
      payoutReadiness: createPayoutReadiness("ready", {
        payoutDestinationChangedAt: "2026-06-02T09:00:00.000Z",
      }),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      sensitiveActionVerifier,
    });

    const preview = await payouts.previewPayoutRequest({ accountId: "acc_seller" as never, amount: "12.50" }, context);
    expect(preview.can_request).toBe(false);
    expect(preview.unavailable_reasons).toContain("payout-destination-cooling-period");
    await expect(payouts.requestPayout({ accountId: "acc_seller" as never, amount: "12.50" }, context)).rejects.toThrow(
      "Confirm it is you before requesting a payout",
    );
    await expect(
      payouts.requestPayout(
        {
          accountId: "acc_seller" as never,
          amount: "12.50",
          actorUserId: "usr_seller",
          sensitiveActionToken: "fresh-step-up",
        },
        context,
      ),
    ).resolves.toMatchObject({ payout: { status: "in-transit" } });
    expect(sensitiveActionVerifier).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        userId: "usr_seller",
        token: "fresh-step-up",
        purpose: "payout-request",
      }),
    );
    vi.useRealTimers();
  });

  it("honors the payout destination cooling window kill switch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets: {
        getWallet: vi.fn(async () => ({
          account_id: "acc_seller",
          currency_code: "usd",
          pending_balance_amount: "0.00",
          available_balance_amount: "20.00",
          negative_balance_status: "in-good-standing",
        })),
        postEntry: vi.fn(async () => ({ ledgerEntryId: "led_test", version: 1 })),
      } as never,
      payoutReadiness: createPayoutReadiness("ready", {
        payoutDestinationChangedAt: "2026-06-02T09:00:00.000Z",
      }),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      payoutDestinationFrictionPolicy: { enabled: false },
    });

    const preview = await payouts.previewPayoutRequest({ accountId: "acc_seller" as never, amount: "12.50" }, context);
    expect(preview.unavailable_reasons).not.toContain("payout-destination-cooling-period");
    await expect(
      payouts.requestPayout({ accountId: "acc_seller" as never, amount: "12.50" }, context),
    ).resolves.toMatchObject({ payout: { status: "in-transit" } });
    vi.useRealTimers();
  });

  it("blocks payouts while available seller funds are tied to active support holds", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        if (sql.includes("COALESCE(SUM(entry.amount)")) {
          return { rows: [{ amount: "12.00" }], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
    });

    const preview = await payouts.previewPayoutRequest(
      {
        accountId: "acc_seller" as never,
        amount: "10.00",
      },
      context,
    );

    expect(preview.can_request).toBe(false);
    expect(preview.available_balance_amount).toBe("8.00");
    expect(preview.unavailable_reasons).toContain("support-hold-active");
    await expect(
      payouts.requestPayout(
        {
          accountId: "acc_seller" as never,
          amount: "10.00",
        },
        context,
      ),
    ).rejects.toThrow("Open support requests must be resolved");
  });

  it("pauses payout requests while the wallet has a negative balance", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("COUNT(*) FILTER")) {
          return {
            rows: [
              {
                failed_payout_count: "0",
                stale_requested_payout_count: "0",
                in_transit_payout_count: "0",
              },
            ],
          };
        }
        if (sql.includes("COALESCE(SUM(entry.amount)")) {
          return { rows: [{ amount: "0.00" }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const wallets = {
      getWallet: vi.fn(async () => ({
        account_id: "acc_seller",
        currency_code: "usd",
        pending_balance_amount: "0.00",
        available_balance_amount: "-12.00",
        total_credited_amount: "0.00",
        total_debited_amount: "12.00",
        negative_balance_status: "negative",
        negative_balance_started_at: "2026-04-02T00:02:00.000Z",
        collections_escalated_at: null,
        opened_at: "2026-04-02T00:00:00.000Z",
        updated_at: "2026-04-02T00:02:00.000Z",
      })),
    };
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets: wallets as never,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
    });

    const preview = await payouts.previewPayoutRequest(
      {
        accountId: "acc_seller" as never,
        amount: "10.00",
      },
      context,
    );

    expect(preview.can_request).toBe(false);
    expect(preview.unavailable_reasons).toContain("negative-balance-active");
    await expect(
      payouts.requestPayout(
        {
          accountId: "acc_seller" as never,
          amount: "10.00",
        },
        context,
      ),
    ).rejects.toThrow("Negative balance must be recovered before requesting payout.");
  });

  it("blocks payout requests until payout readiness is ready", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const operationEvents: Record<string, unknown>[] = [];
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("pending"),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: {
        record: (event) => {
          operationEvents.push(event);
        },
      },
    });

    await expect(
      payouts.requestPayout(
        {
          accountId: "acc_seller" as never,
          amount: "12.50",
          destinationReference: "bank_123",
        },
        context,
      ),
    ).rejects.toThrow("Payout setup must be complete before requesting payouts.");
    expect(readAllEvents()).toHaveLength(0);
    expect(operationEvents).toContainEqual(
      expect.objectContaining({
        kind: "payout-request-blocked-by-setup",
        accountId: "acc_seller",
        amount: "12.50",
        safeCategory: "setup_incomplete",
      }),
    );
  });

  it("keeps payout preview and requests blocked when embedded setup readiness is stale or requirements remain open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T17:00:00.000Z"));
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const operationEvents: Record<string, unknown>[] = [];
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready", {
        updatedAt: "2026-04-01T17:00:00.000Z",
        missingRequirements: ["external_account"],
      }),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: {
        record: (event) => {
          operationEvents.push(event);
        },
      },
    });

    const preview = await payouts.previewPayoutRequest(
      {
        accountId: "acc_seller" as never,
        amount: "12.50",
      },
      context,
    );

    expect(preview.can_request).toBe(false);
    expect(preview.unavailable_reasons).toEqual(["payout-setup-refresh-required", "provider-requirements-open"]);
    await expect(
      payouts.requestPayout(
        {
          accountId: "acc_seller" as never,
          amount: "12.50",
          destinationReference: "bank_123",
        },
        context,
      ),
    ).rejects.toThrow("Payout setup status must be refreshed before requesting a payout.");
    expect(readAllEvents()).toHaveLength(0);
    expect(operationEvents).toContainEqual(
      expect.objectContaining({
        kind: "payout-request-blocked-by-setup",
        accountId: "acc_seller",
        safeCategory: "setup_stale",
        staleReadiness: true,
        missingRequirementCount: 1,
      }),
    );
    vi.useRealTimers();
  });

  it("auto-refreshes stale-only payout readiness so a ready seller can preview and request payout in one attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T17:00:00.000Z"));
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const refreshProviderReadiness = vi.fn(createPayoutReadiness("ready").refreshProviderReadiness);
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready", {
        updatedAt: "2026-04-30T17:00:00.000Z",
        refreshProviderReadiness,
      }),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
    });
    await seedAvailableWallet(wallets);

    const preview = await payouts.previewPayoutRequest(
      {
        accountId: "acc_seller" as never,
        amount: "12.50",
      },
      context,
    );
    const requested = await payouts.requestPayout(
      {
        accountId: "acc_seller" as never,
        amount: "12.50",
        destinationReference: "bank_123",
      },
      context,
    );

    expect(preview.can_request).toBe(true);
    expect(preview.unavailable_reasons).toEqual([]);
    expect(requested.payout.status).toBe("in-transit");
    expect(refreshProviderReadiness).toHaveBeenCalledTimes(2);
    expect(refreshProviderReadiness).toHaveBeenNthCalledWith(
      1,
      {
        accountId: "acc_seller",
        providerReference: "acct_test",
      },
      context,
    );
    expect(refreshProviderReadiness).toHaveBeenNthCalledWith(
      2,
      {
        accountId: "acc_seller",
        providerReference: "acct_test",
      },
      context,
    );
    vi.useRealTimers();
  });

  it("keeps stale-only payout readiness blocked when the auto-refresh fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T17:00:00.000Z"));
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const operationEvents: Record<string, unknown>[] = [];
    const refreshProviderReadiness = vi.fn(async () => {
      throw new Error("Provider readiness refresh failed.");
    });
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready", {
        updatedAt: "2026-04-30T17:00:00.000Z",
        refreshProviderReadiness,
      }),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: {
        record: (event) => {
          operationEvents.push(event);
        },
      },
    });

    const preview = await payouts.previewPayoutRequest(
      {
        accountId: "acc_seller" as never,
        amount: "12.50",
      },
      context,
    );

    expect(preview.can_request).toBe(false);
    expect(preview.unavailable_reasons).toEqual(["payout-setup-refresh-required"]);
    await expect(
      payouts.requestPayout(
        {
          accountId: "acc_seller" as never,
          amount: "12.50",
          destinationReference: "bank_123",
        },
        context,
      ),
    ).rejects.toThrow("Payout setup status must be refreshed before requesting a payout.");
    expect(readAllEvents()).toHaveLength(0);
    expect(refreshProviderReadiness).toHaveBeenCalledTimes(2);
    expect(operationEvents).toContainEqual(
      expect.objectContaining({
        kind: "payout-request-blocked-by-setup",
        accountId: "acc_seller",
        safeCategory: "setup_stale",
        staleReadiness: true,
        missingRequirementCount: 0,
      }),
    );
    vi.useRealTimers();
  });

  it("records payout request blocks when provider requirements remain open", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const operationEvents: Record<string, unknown>[] = [];
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready", {
        updatedAt: new Date().toISOString(),
        missingRequirements: ["external_account"],
      }),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: {
        record: (event) => {
          operationEvents.push(event);
        },
      },
    });

    await expect(
      payouts.requestPayout(
        {
          accountId: "acc_seller" as never,
          amount: "12.50",
          destinationReference: "bank_123",
        },
        context,
      ),
    ).rejects.toThrow("Payout setup requirements must be resolved before requesting a payout.");

    expect(readAllEvents()).toHaveLength(0);
    expect(operationEvents).toContainEqual(
      expect.objectContaining({
        kind: "payout-request-blocked-by-setup",
        accountId: "acc_seller",
        safeCategory: "requirements_open",
        missingRequirementCount: 1,
      }),
    );
  });

  it("uses deterministic provider idempotency keys for transfer and payout submission", async () => {
    const { eventStore } = createInMemoryEventStore();
    const queries: string[] = [];
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const moneyMovementGateway = createFakeMoneyMovementGateway();
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway,
    });
    await seedAvailableWallet(wallets);

    const requested = await payouts.requestPayout(
      {
        accountId: "acc_seller" as never,
        amount: "12.50",
      },
      context,
    );

    expect(moneyMovementGateway.usedIdempotencyKeys).toContain(`settlement:payout:${requested.payoutId}:transfer`);
    expect(moneyMovementGateway.usedIdempotencyKeys).toContain(`settlement:payout:${requested.payoutId}:payout`);
    expect(queries.filter((sql) => sql.includes("INSERT INTO settlement_provider_operations"))).toHaveLength(2);
  });

  it("fails before creating payout events when platform balance is too low", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: createFakeMoneyMovementGateway({
        availableAmount: "10.00",
      }),
    });

    await expect(
      payouts.requestPayout(
        {
          accountId: "acc_seller" as never,
          amount: "12.50",
        },
        context,
      ),
    ).rejects.toThrow("Platform balance is too low for this payout.");
    expect(readAllEvents()).toHaveLength(0);
  });

  it("enforces payout amount policy before provider money movement", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20000.00",
                total_credited_amount: "20000.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const moneyMovementGateway = createFakeMoneyMovementGateway();
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway,
    });

    await expect(
      payouts.requestPayout(
        {
          accountId: "acc_seller" as never,
          amount: "4.99",
        },
        context,
      ),
    ).rejects.toThrow("Payout amount must be at least 5.00 USD.");
    await expect(
      payouts.requestPayout(
        {
          accountId: "acc_seller" as never,
          amount: "10000.01",
        },
        context,
      ),
    ).rejects.toThrow("Payout amount cannot exceed 10000.00 USD.");
    expect(moneyMovementGateway.usedIdempotencyKeys).toEqual([]);
    expect(readAllEvents()).toHaveLength(0);
  });

  it("leaves a payout recoverable without reversal when payout creation fails transiently after transfer succeeds", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const gateway = createFakeMoneyMovementGateway({ failPayout: true });
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: gateway,
    });
    await seedAvailableWallet(wallets);

    const requested = await payouts.requestPayout(
      {
        accountId: "acc_seller" as never,
        amount: "12.50",
      },
      context,
    );

    expect(requested.payout).toMatchObject({
      payout_id: requested.payoutId,
      status: "requested",
      provider_transfer_reference: `tr_${requested.payoutId}`,
      provider_payout_reference: null,
    });
    expect(
      readAllEvents()
        .filter((event) => event.eventType.startsWith("settlement.payout."))
        .map((event) => event.eventType),
    ).toEqual([
      "settlement.payout.monthly-baseline-recorded",
      "settlement.payout.monthly-request-counted",
      "settlement.payout.requested",
      "settlement.payout.provider-references-recorded",
    ]);
    expect(
      readAllEvents()
        .filter(
          (event) =>
            event.eventType === "settlement.wallet.ledger-entry-posted" &&
            (event.payload as { payoutId?: string }).payoutId === requested.payoutId,
        )
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ kind: "payout", direction: "debit", amount: "12.21" }),
      expect.objectContaining({ kind: "fee", direction: "debit", amount: "0.29" }),
    ]);
  });

  it("reverses the wallet when a terminal provider transfer decline fails payout submission", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const fakeGateway = createFakeMoneyMovementGateway();
    const terminalDeclineGateway = {
      ...fakeGateway,
      async transferPlatformBalanceToConnectedAccount() {
        throw Object.assign(new Error("Provider transfer declined."), {
          statusCode: 400,
          code: "invalid_transfer",
        });
      },
    } satisfies typeof fakeGateway;
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: terminalDeclineGateway,
    });
    await seedAvailableWallet(wallets);

    const requested = await payouts.requestPayout(
      {
        accountId: "acc_seller" as never,
        amount: "12.50",
      },
      context,
    );

    expect(requested.payout).toMatchObject({
      payout_id: requested.payoutId,
      status: "failed",
      failure_reason: "Payout account details need review.",
      provider_failure_message: expect.stringContaining("Provider"),
      version: requested.version,
    });

    expect(
      readAllEvents()
        .filter((event) => event.eventType.startsWith("settlement.payout."))
        .map((event) => event.eventType),
    ).toEqual([
      "settlement.payout.monthly-baseline-recorded",
      "settlement.payout.monthly-request-counted",
      "settlement.payout.requested",
      "settlement.payout.monthly-request-released",
      "settlement.payout.failed",
    ]);
    expect(
      readAllEvents()
        .filter(
          (event) =>
            event.eventType === "settlement.wallet.ledger-entry-posted" &&
            (event.payload as { payoutId?: string }).payoutId === requested.payoutId,
        )
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ kind: "payout", direction: "debit" }),
      expect.objectContaining({ kind: "fee", direction: "debit" }),
      expect.objectContaining({ kind: "payout-reversal", direction: "credit" }),
      expect.objectContaining({ kind: "fee", direction: "credit" }),
    ]);
  });

  it("payout-fee-failure-reversal restores the wallet after a synthetic post-net interruption and retries exactly once", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    await seedAvailableWallet(wallets);
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      payoutPostingFault: () => {
        throw new Error("synthetic-post-net-interruption");
      },
    });

    const requested = await payouts.requestPayout({ accountId: "acc_seller" as never, amount: "12.50" }, context);
    expect(requested.payout).toMatchObject({
      status: "failed",
      requested_amount: "12.50",
      fee_amount: "0.29",
      net_amount: "12.21",
    });

    const payoutWalletEntries = () =>
      readAllEvents().filter(
        (event) =>
          event.eventType === "settlement.wallet.ledger-entry-posted" &&
          (event.payload as { payoutId?: string }).payoutId === requested.payoutId,
      );
    expect(payoutWalletEntries().map((event) => event.payload)).toEqual([
      expect.objectContaining({
        ledgerEntryId: `led_payout_${requested.payoutId}`,
        kind: "payout",
        direction: "debit",
        amount: "12.21",
      }),
      expect.objectContaining({
        ledgerEntryId: `led_payout_reversal_${requested.payoutId}`,
        kind: "payout-reversal",
        direction: "credit",
        amount: "12.21",
      }),
    ]);

    await payouts.failPayout(
      {
        payoutId: requested.payoutId,
        accountId: "acc_seller",
        failureReason: "synthetic retry",
        netAmount: "12.21",
        feeAmount: "0.29",
        currencyCode: "usd",
      },
      context,
    );
    expect(payoutWalletEntries()).toHaveLength(2);
  });

  it("converges a stale requested provider-paid payout through recorded provider operations", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    let payoutRow: Record<string, unknown> | null = null;
    const { db } = createPayoutProviderOperationDb(() => (payoutRow ? [payoutRow] : []));
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const fakeGateway = createFakeMoneyMovementGateway();
    let payoutCreateCount = 0;
    const payoutIdempotencyKeys: string[] = [];
    const gateway = {
      ...fakeGateway,
      async createConnectedAccountPayout(input: Parameters<typeof fakeGateway.createConnectedAccountPayout>[0]) {
        payoutCreateCount += 1;
        payoutIdempotencyKeys.push(input.idempotencyKey);
        if (payoutCreateCount === 1) {
          throw Object.assign(new Error("Provider payout request timed out."), { code: "timeout" });
        }
        return {
          providerPayoutReference: `po_${input.payoutId}`,
          providerStatus: "paid",
        };
      },
    } satisfies typeof fakeGateway;
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: gateway,
    });
    await seedAvailableWallet(wallets);

    const requested = await payouts.requestPayout({ accountId: "acc_seller" as never, amount: "12.50" }, context);
    payoutRow = {
      payout_id: requested.payoutId,
      account_id: "acc_seller",
      amount: "12.50",
      currency_code: "usd",
      destination_reference: null,
      note: null,
      status: "requested",
      provider_transfer_reference: requested.payout.provider_transfer_reference,
      provider_payout_reference: null,
      provider_status: null,
      provider_failure_code: null,
      provider_failure_message: null,
      requested_at: "2026-04-02T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
      sent_at: null,
      completed_at: null,
      failed_at: null,
      failure_reason: null,
      last_provider_event_at: null,
      last_reconciled_at: null,
      retry_count: 0,
      next_retry_at: null,
      retry_reason: null,
    };

    const result = await payouts.reconcilePayoutsNeedingAttention({ accountId: "acc_seller", limit: 1 }, context);

    expect(result).toMatchObject({ checked: 1, reconciled: 1, ignored: 0, skipped: 0, errors: [] });
    expect(
      readAllEvents()
        .filter((event) => event.eventType.startsWith("settlement.payout."))
        .map((event) => event.eventType),
    ).toContain("settlement.payout.completed");
    expect(
      readAllEvents().filter(
        (event) =>
          event.eventType === "settlement.wallet.ledger-entry-posted" &&
          (event.payload as { kind?: string }).kind === "payout-reversal",
      ),
    ).toHaveLength(0);
    expect(payoutIdempotencyKeys).toEqual([
      `settlement:payout:${requested.payoutId}:payout`,
      `settlement:payout:${requested.payoutId}:payout`,
    ]);
  });

  it("correlates payout webhooks through recorded provider operation references", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    let payoutRow: Record<string, unknown> | null = null;
    const { db } = createPayoutProviderOperationDb(() => (payoutRow ? [payoutRow] : []));
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const gateway = createFakeMoneyMovementGateway();
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: gateway,
    });
    await seedAvailableWallet(wallets);
    const requested = await payouts.requestPayout({ accountId: "acc_seller" as never, amount: "12.50" }, context);
    payoutRow = {
      payout_id: requested.payoutId,
      account_id: "acc_seller",
      amount: "12.50",
      currency_code: "usd",
      destination_reference: null,
      note: null,
      status: "requested",
      provider_transfer_reference: null,
      provider_payout_reference: null,
      provider_status: null,
      provider_failure_code: null,
      provider_failure_message: null,
      requested_at: "2026-04-02T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
      sent_at: null,
      completed_at: null,
      failed_at: null,
      failure_reason: null,
      last_provider_event_at: null,
      last_reconciled_at: null,
      retry_count: 0,
      next_retry_at: null,
      retry_reason: null,
    };

    const result = await payouts.processMoneyMovementWebhook(
      {
        rawBody: JSON.stringify({
          kind: "payout-completed",
          providerEventId: "evt_provider_paid",
          providerPayoutReference: `po_${requested.payoutId}`,
          providerStatus: "paid",
        }),
        signatureHeader: null,
      },
      context,
    );

    expect(result).toEqual({ received: true, ignored: false });
    expect(
      readAllEvents()
        .filter((event) => event.eventType.startsWith("settlement.payout."))
        .map((event) => event.eventType),
    ).toContain("settlement.payout.completed");
  });

  it("does not reverse a payout when the wallet debit never committed", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const realWallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    await seedAvailableWallet(realWallets);
    const wallets = {
      ...realWallets,
      postEntry: async (...args: Parameters<WalletServices["postEntry"]>) => {
        if (args[0].kind === "payout") {
          throw new Error("simulated wallet debit conflict");
        }
        return realWallets.postEntry(...args);
      },
    } satisfies WalletServices;
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
    });

    const requested = await payouts.requestPayout(
      {
        accountId: "acc_seller" as never,
        amount: "12.50",
      },
      context,
    );

    expect(requested.payout).toMatchObject({
      payout_id: requested.payoutId,
      status: "failed",
      provider_failure_message: "simulated wallet debit conflict",
    });
    expect(
      readAllEvents()
        .filter((event) => event.eventType === "settlement.wallet.ledger-entry-posted")
        .map((event) => (event.payload as { kind?: string }).kind),
    ).toEqual(["sale"]);
  });

  it("posts the payout reversal on retry when failure was recorded before the reversal", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    let payoutRow: Record<string, unknown> | null = null;
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        if (sql.includes("FROM settlement_payout_pages")) {
          return {
            rows: payoutRow ? [payoutRow] : [],
            rowCount: payoutRow ? 1 : 0,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const realWallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    await seedAvailableWallet(realWallets);
    let failNextReversal = true;
    const wallets = {
      ...realWallets,
      postEntry: async (...args: Parameters<WalletServices["postEntry"]>) => {
        if (args[0].kind === "payout-reversal" && failNextReversal) {
          failNextReversal = false;
          throw new Error("simulated crash after payout failure");
        }
        return realWallets.postEntry(...args);
      },
    } satisfies WalletServices;
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: {
        ...createFakeMoneyMovementGateway(),
        async transferPlatformBalanceToConnectedAccount() {
          throw Object.assign(new Error("Provider transfer declined."), {
            statusCode: 400,
            code: "invalid_transfer",
          });
        },
      },
    });

    await expect(
      payouts.requestPayout(
        {
          accountId: "acc_seller" as never,
          amount: "12.50",
        },
        context,
      ),
    ).rejects.toThrow("simulated crash after payout failure");

    const payoutId = (
      readAllEvents().find((event) => event.eventType === "settlement.payout.requested")?.payload as
        | { payoutId?: string }
        | undefined
    )?.payoutId;
    expect(payoutId).toEqual(expect.any(String));
    payoutRow = {
      payout_id: payoutId,
      account_id: "acc_seller",
      amount: "12.50",
      currency_code: "usd",
      destination_reference: null,
      note: null,
      status: "failed",
      provider_transfer_reference: null,
      provider_payout_reference: null,
      provider_status: "failed",
      provider_failure_code: null,
      provider_failure_message: "Provider transfer declined.",
      requested_at: "2026-04-02T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
      sent_at: null,
      completed_at: null,
      failed_at: "2026-04-02T01:00:00.000Z",
      failure_reason: "Payout account details need review.",
    };

    await payouts.failPayout(
      {
        payoutId: payoutId as string,
        accountId: "acc_seller",
        failureReason: "Payout account details need review.",
        failedAt: "2026-04-02T01:05:00.000Z",
      },
      context,
    );

    const walletEntryEvents = readAllEvents().filter(
      (event) =>
        event.eventType === "settlement.wallet.ledger-entry-posted" &&
        ["payout", "payout-reversal"].includes((event.payload as { kind?: string }).kind ?? ""),
    );
    expect(walletEntryEvents.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        ledgerEntryId: `led_payout_${payoutId}`,
        kind: "payout",
        direction: "debit",
      }),
      expect.objectContaining({
        ledgerEntryId: `led_payout_reversal_${payoutId}`,
        kind: "payout-reversal",
        direction: "credit",
      }),
    ]);
  });

  it("does not mark payout webhooks processed when the payout projection is not ready", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT provider_event_id") && sql.includes("settlement_money_movement_webhook_events")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO settlement_money_movement_webhook_events")) {
          throw new Error("Provider event should not be marked processed before payout effects commit.");
        }
        if (sql.includes("FROM settlement_payout_pages")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
    });

    await expect(
      payouts.processMoneyMovementWebhook(
        {
          rawBody: JSON.stringify({
            kind: "payout-completed",
            providerEventId: "evt_provider_paid_before_projection",
            providerPayoutReference: "po_missing",
          }),
          signatureHeader: null,
        },
        context,
      ),
    ).rejects.toThrow("Payout was not found for provider webhook.");
    expect(
      db.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO settlement_money_movement_webhook_events")),
    ).toBe(false);
  });

  it("fails and reverses a payout from webhook metadata before the payout projection catches up", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const { db } = createPayoutProviderOperationDb(() => []);
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
    });
    await seedAvailableWallet(wallets);
    const requested = await payouts.requestPayout({ accountId: "acc_seller" as never, amount: "12.50" }, context);

    await expect(
      payouts.processMoneyMovementWebhook(
        {
          rawBody: JSON.stringify({
            kind: "payout-failed",
            providerEventId: "evt_failed_before_projection",
            payoutId: requested.payoutId,
            providerPayoutReference: `po_${requested.payoutId}`,
          }),
          signatureHeader: null,
        },
        context,
      ),
    ).resolves.toEqual({ received: true, ignored: false });

    expect(
      readAllEvents().filter(
        (event) =>
          event.eventType === "settlement.wallet.ledger-entry-posted" &&
          (event.payload as { kind?: string }).kind === "payout-reversal",
      ),
    ).toHaveLength(1);
    expect(readAllEvents().map((event) => event.eventType)).toContain("settlement.payout.failed");

    await expect(
      payouts.processMoneyMovementWebhook(
        {
          rawBody: JSON.stringify({
            kind: "payout-failed",
            providerEventId: "evt_failed_before_projection",
            payoutId: requested.payoutId,
            providerPayoutReference: `po_${requested.payoutId}`,
          }),
          signatureHeader: null,
        },
        context,
      ),
    ).resolves.toEqual({ received: true, ignored: true, failure_class: "inbox-conflict" });
    expect(
      readAllEvents().filter(
        (event) =>
          event.eventType === "settlement.wallet.ledger-entry-posted" &&
          (event.payload as { kind?: string }).kind === "payout-reversal",
      ),
    ).toHaveLength(1);
    expect(
      readAllEvents().filter(
        (event) =>
          event.eventType === "settlement.wallet.ledger-entry-posted" &&
          (event.payload as { ledgerEntryId?: string }).ledgerEntryId ===
            `led_payout_fee_reversal_${requested.payoutId}`,
      ),
    ).toHaveLength(1);
  });

  it("processes duplicate payout failure webhooks without duplicate reversals", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    let payoutRow: Record<string, unknown> | null = null;
    const processedProviderEvents = new Set<string>();
    const db = {
      query: async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes("FROM settlement_wallet_pages")) {
          return {
            rows: [
              {
                account_id: "acc_seller",
                currency_code: "usd",
                pending_balance_amount: "0.00",
                available_balance_amount: "20.00",
                total_credited_amount: "20.00",
                total_debited_amount: "0.00",
                opened_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        if (sql.includes("FROM settlement_payout_pages")) {
          return {
            rows: payoutRow ? [payoutRow] : [],
            rowCount: payoutRow ? 1 : 0,
          };
        }

        if (sql.includes("settlement_money_movement_webhook_events")) {
          const providerEventId = String(values?.[0] ?? "");
          if (sql.includes("SELECT provider_event_id")) {
            return {
              rows: processedProviderEvents.has(providerEventId) ? [{ provider_event_id: providerEventId }] : [],
              rowCount: processedProviderEvents.has(providerEventId) ? 1 : 0,
            };
          }
          processedProviderEvents.add(providerEventId);
          return {
            rows: [{ provider_event_id: providerEventId }],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    const wallets = createWalletRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
    });
    await seedAvailableWallet(wallets);
    const requested = await payouts.requestPayout(
      {
        accountId: "acc_seller" as never,
        amount: "12.50",
      },
      context,
    );
    payoutRow = {
      payout_id: requested.payoutId,
      account_id: "acc_seller",
      amount: "12.50",
      currency_code: "usd",
      destination_reference: null,
      note: null,
      status: "in-transit",
      provider_transfer_reference: `tr_${requested.payoutId}`,
      provider_payout_reference: `po_${requested.payoutId}`,
      provider_status: "pending",
      provider_failure_code: null,
      provider_failure_message: null,
      requested_at: "2026-04-02T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
      sent_at: "2026-04-02T00:00:00.000Z",
      completed_at: null,
      failed_at: null,
      failure_reason: null,
    };

    const rawBody = JSON.stringify({
      kind: "payout-failed",
      providerEventId: "evt_fake_failure",
      providerPayoutReference: `po_${requested.payoutId}`,
    });
    await payouts.processMoneyMovementWebhook({ rawBody, signatureHeader: null }, context);
    await payouts.processMoneyMovementWebhook({ rawBody, signatureHeader: null }, context);

    expect(
      readAllEvents().filter(
        (event) =>
          event.eventType === "settlement.wallet.ledger-entry-posted" &&
          (event.payload as { kind?: string }).kind === "payout-reversal",
      ),
    ).toHaveLength(1);
    expect(
      readAllEvents().filter(
        (event) =>
          event.eventType === "settlement.wallet.ledger-entry-posted" &&
          (event.payload as { ledgerEntryId?: string }).ledgerEntryId ===
            `led_payout_fee_reversal_${requested.payoutId}`,
      ),
    ).toHaveLength(1);
  });

  it("hands off reconciliation immediately when the durable job claim is lost", async () => {
    const { eventStore } = createInMemoryEventStore();
    const payoutRow = {
      payout_id: "pay_handoff",
      account_id: "acc_seller",
      amount: "12.50",
      currency_code: "usd",
      destination_reference: null,
      note: null,
      status: "in-transit",
      provider_transfer_reference: "tr_handoff",
      provider_payout_reference: "po_handoff",
      provider_status: "pending",
      provider_failure_code: null,
      provider_failure_message: null,
      requested_at: "2026-04-02T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
      sent_at: "2026-04-02T00:00:00.000Z",
      completed_at: null,
      failed_at: null,
      failure_reason: null,
      last_provider_event_at: null,
      last_reconciled_at: null,
      retry_count: 0,
      next_retry_at: null,
      retry_reason: null,
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("settlement_payout_pages")) {
          return { rows: [payoutRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const gateway = createFakeMoneyMovementGateway();
    const payouts = createPayoutRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      wallets: {} as never,
      payoutReadiness: createPayoutReadiness("ready"),
      moneyMovementGateway: gateway,
    });
    const jobContext = {
      signal: new AbortController().signal,
      throwIfCancelled: vi.fn(),
      renew: vi.fn(async () => {
        throw new Error("Payout reconciliation job claim was lost.");
      }),
      checkpointProgress: vi.fn(),
    };

    await expect(
      payouts.reconcilePayoutsNeedingAttention({ accountId: "acc_seller", limit: 1 }, context, jobContext),
    ).rejects.toThrow("claim was lost");
    expect(gateway.usedIdempotencyKeys).toEqual([]);
    expect(jobContext.checkpointProgress).not.toHaveBeenCalled();
  });
});
