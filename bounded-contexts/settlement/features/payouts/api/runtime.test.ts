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
  options: Readonly<{ updatedAt?: string | null; missingRequirements?: readonly string[] }> = {},
) {
  return {
    getPayoutReadiness: async () => ({
      account_id: "acc_seller",
      status,
      missing_requirements: options.missingRequirements ?? (status === "ready" ? [] : ["provider-onboarding"]),
      provider_reference: "acct_test",
      onboarding_status: status === "ready" ? "complete" : "pending",
      transfer_capability_status: status === "ready" ? "active" : "pending",
      payout_capability_status: status === "ready" ? "active" : "pending",
      payout_destination_status: status === "ready" ? "ready" : "missing",
      payout_account_dashboard: "none",
      losses_collector: "application",
      fees_collector: "application",
      requirements_collector: "application",
      updated_at: options.updatedAt ?? new Date().toISOString(),
    }),
  } as unknown as PayoutReadinessServices;
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

    const preview = await payouts.previewPayoutRequest({
      accountId: "acc_seller" as never,
      amount: "10.00",
    });

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

    const preview = await payouts.previewPayoutRequest({
      accountId: "acc_seller" as never,
      amount: "12.50",
    });

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

  it.each([
    ["transfer", createFakeMoneyMovementGateway({ failTransfer: true })],
    ["payout", createFakeMoneyMovementGateway({ failPayout: true })],
  ])("reverses the wallet when provider %s submission fails", async (_kind, gateway) => {
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
          if (processedProviderEvents.has(providerEventId)) {
            return { rows: [], rowCount: 0 };
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
