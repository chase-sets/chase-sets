import { describe, expect, it, vi } from "vitest";
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
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement/test-support";

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
          traceId: input.context.trace?.traceId,
          spanId: input.context.trace?.spanId,
          parentSpanId: input.context.trace?.parentSpanId,
          traceState: input.context.trace?.traceState,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice(input.fromVersion ?? 0),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return {
    eventStore,
    readAllEvents: () => allEvents,
  };
}

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

  it("debits the wallet when requesting a payout and credits it back when the payout fails", async () => {
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
        destinationReference: "bank_123",
        note: "Weekly payout",
      },
      context,
    );

    expect(requested.payout).toMatchObject({
      payout_id: requested.payoutId,
      account_id: "acc_seller",
      amount: "12.50",
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
        ["payout", "payout-reversal"].includes((event.payload as { kind?: string }).kind ?? ""),
    );

    expect(payoutEvents.map((event) => event.eventType)).toEqual([
      "settlement.payout.requested",
      "settlement.payout.provider-references-recorded",
      "settlement.payout.provider-references-recorded",
      "settlement.payout.in-transit-recorded",
      "settlement.payout.failed",
    ]);
    expect(walletEntryEvents).toHaveLength(2);
    expect(walletEntryEvents[0]?.payload).toMatchObject({
      kind: "payout",
      direction: "debit",
      amount: "12.50",
    });
    expect(walletEntryEvents[1]?.payload).toMatchObject({
      kind: "payout-reversal",
      direction: "credit",
      amount: "12.50",
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
    ).toEqual(["settlement.payout.requested", "settlement.payout.provider-references-recorded"]);
    expect(
      readAllEvents()
        .filter(
          (event) =>
            event.eventType === "settlement.wallet.ledger-entry-posted" &&
            ["payout", "payout-reversal"].includes((event.payload as { kind?: string }).kind ?? ""),
        )
        .map((event) => event.payload),
    ).toEqual([expect.objectContaining({ kind: "payout", direction: "debit" })]);
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
    ).toEqual(["settlement.payout.requested", "settlement.payout.failed"]);
    expect(
      readAllEvents()
        .filter(
          (event) =>
            event.eventType === "settlement.wallet.ledger-entry-posted" &&
            ["payout", "payout-reversal"].includes((event.payload as { kind?: string }).kind ?? ""),
        )
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ kind: "payout", direction: "debit" }),
      expect.objectContaining({ kind: "payout-reversal", direction: "credit" }),
    ]);
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
    ).resolves.toEqual({ received: true, ignored: true });
    expect(
      readAllEvents().filter(
        (event) =>
          event.eventType === "settlement.wallet.ledger-entry-posted" &&
          (event.payload as { kind?: string }).kind === "payout-reversal",
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
