import { describe, expect, it, vi } from "vitest";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { ProviderPayoutReadiness } from "@chase-sets/money-movement";
import { createPayoutReadinessRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_seller" as never,
  },
};

function createEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, unknown[]>();
  return {
    appendToStream: vi.fn(
      async (input: { streamId: string; events: readonly { eventType: string; payload: unknown }[] }) => {
        const existing = streams.get(input.streamId) ?? [];
        const stored = input.events.map((event, index) => {
          globalPosition += 1;
          return {
            eventId: `evt_${globalPosition}`,
            streamId: input.streamId,
            streamVersion: existing.length + index + 1,
            globalPosition: String(globalPosition),
            tenantId: "tnt_test",
            eventType: event.eventType,
            payload: event.payload,
            metadata: {},
            occurredAt: "2026-05-01T00:00:00.000Z",
            recordedAt: "2026-05-01T00:00:00.000Z",
            performedByUserId: "usr_test",
            forAccountId: "acc_seller",
          };
        });
        streams.set(input.streamId, [...existing, ...stored]);
        return stored;
      },
    ),
    readStream: vi.fn(async (input: { streamId: string }) => streams.get(input.streamId) ?? []),
    readAll: vi.fn(async () => []),
  };
}

describe("payout readiness runtime", () => {
  it("creates embedded payout setup sessions with provider-neutral components", async () => {
    const setupKeys: string[] = [];
    const operationEvents: Record<string, unknown>[] = [];
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const moneyMovementGateway = {
      providerName: "stripe",
      ensurePayoutAccount: vi.fn(async () => ({
        providerReference: "acct_123",
        onboardingStatus: "pending",
        transferCapabilityStatus: "active",
        payoutCapabilityStatus: "pending",
        payoutDestinationStatus: "pending",
        payoutAccountDashboard: "none",
        lossesCollector: "application",
        feesCollector: "application",
        requirementsCollector: "application",
        missingRequirements: ["external_account"],
      })),
      refreshPayoutReadiness: vi.fn(),
      createPayoutSetupSession: vi.fn(async (input: { idempotencyKey: string }) => {
        setupKeys.push(input.idempotencyKey);
        return {
          providerReference: "acct_123",
          clientSecret: "provider_session_secret",
          expiresAt: "2026-06-01T15:00:00.000Z",
          components: ["payout-setup"],
          readiness: {
            providerReference: "acct_123",
            onboardingStatus: "pending",
            transferCapabilityStatus: "active",
            payoutCapabilityStatus: "pending",
            payoutDestinationStatus: "pending",
            payoutAccountDashboard: "none",
            lossesCollector: "application",
            feesCollector: "application",
            requirementsCollector: "application",
            missingRequirements: ["external_account"],
          },
        };
      }),
      createPayoutAccountManagementSession: vi.fn(),
      retrievePlatformBalance: vi.fn(),
      transferPlatformBalanceToConnectedAccount: vi.fn(),
      createConnectedAccountPayout: vi.fn(),
      retrieveConnectedAccountPayout: vi.fn(),
      parseMoneyMovementWebhook: vi.fn(),
    };
    const eventStore = createEventStore();
    const services = createPayoutReadinessRuntime({
      eventStore: eventStore as never,
      checkpointStore: {
        loadCheckpoint: vi.fn(async () => ZERO_GLOBAL_POSITION),
        saveCheckpoint: vi.fn(async () => {}),
      },
      db: db as never,
      moneyMovementGateway: moneyMovementGateway as never,
      operationsRecorder: {
        record: (event) => {
          operationEvents.push(event);
        },
      },
    });

    await expect(
      services.createPayoutSetupSession(
        { accountId: "acc_seller" as never, contactEmail: "seller@example.test" },
        context,
      ),
    ).resolves.toEqual({
      clientSecret: "provider_session_secret",
      providerReference: "acct_123",
      expiresAt: "2026-06-01T15:00:00.000Z",
      components: ["payout-setup"],
      readiness: expect.objectContaining({
        account_id: "acc_seller",
        status: "pending",
        provider_reference: "acct_123",
        missing_requirements: ["external_account"],
      }),
    });
    expect(setupKeys).toHaveLength(1);
    expect(setupKeys[0]).toMatch(/^settlement:payout-account:acc_seller:embedded-setup:setup_/);
    expect(moneyMovementGateway.ensurePayoutAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        contactEmail: "seller@example.test",
      }),
    );
    expect(moneyMovementGateway.createPayoutSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerReference: "acct_123",
        contactEmail: "seller@example.test",
      }),
    );
    expect(JSON.stringify(eventStore.appendToStream.mock.calls)).not.toContain("provider_session_secret");
    expect(operationEvents).toContainEqual(
      expect.objectContaining({
        kind: "payout-setup-session-created",
        accountId: "acc_seller",
        setupSurface: "embedded-payout-setup",
        providerReference: "acct_123",
        readinessStatus: "pending",
        missingRequirementCount: 1,
      }),
    );
    expect(JSON.stringify(operationEvents)).not.toContain("provider_session_secret");
  });

  it("passes contact email into setup sessions for existing provider accounts", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            account_id: "acc_seller",
            status: "pending",
            missing_requirements: ["external_account"],
            provider_reference: "acct_existing",
            onboarding_status: "pending",
            transfer_capability_status: "active",
            payout_capability_status: "pending",
            payout_destination_status: "missing",
            payout_account_dashboard: "none",
            losses_collector: "application",
            fees_collector: "application",
            requirements_collector: "application",
            updated_at: "2026-06-01T16:00:00.000Z",
          },
        ],
      })),
    };
    const readiness: ProviderPayoutReadiness = {
      providerReference: "acct_existing",
      onboardingStatus: "pending",
      transferCapabilityStatus: "active",
      payoutCapabilityStatus: "pending",
      payoutDestinationStatus: "missing",
      payoutAccountDashboard: "none",
      lossesCollector: "application",
      feesCollector: "application",
      requirementsCollector: "application",
      missingRequirements: ["external_account"],
    };
    const moneyMovementGateway = {
      providerName: "stripe",
      ensurePayoutAccount: vi.fn(),
      refreshPayoutReadiness: vi.fn(async () => readiness),
      createPayoutSetupSession: vi.fn(async () => ({
        providerReference: "acct_existing",
        clientSecret: "provider_session_secret",
        expiresAt: null,
        components: ["payout-setup"],
        readiness,
      })),
      createPayoutAccountManagementSession: vi.fn(),
      retrievePlatformBalance: vi.fn(),
      transferPlatformBalanceToConnectedAccount: vi.fn(),
      createConnectedAccountPayout: vi.fn(),
      retrieveConnectedAccountPayout: vi.fn(),
      parseMoneyMovementWebhook: vi.fn(),
    };
    const services = createPayoutReadinessRuntime({
      eventStore: createEventStore() as never,
      checkpointStore: {
        loadCheckpoint: vi.fn(async () => ZERO_GLOBAL_POSITION),
        saveCheckpoint: vi.fn(async () => {}),
      },
      db: db as never,
      moneyMovementGateway: moneyMovementGateway as never,
    });

    await expect(
      services.createPayoutSetupSession(
        { accountId: "acc_seller" as never, contactEmail: "seller@example.test" },
        context,
      ),
    ).resolves.toMatchObject({
      providerReference: "acct_existing",
      components: ["payout-setup"],
    });
    expect(moneyMovementGateway.refreshPayoutReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        providerReference: "acct_existing",
      }),
    );
    expect(moneyMovementGateway.ensurePayoutAccount).not.toHaveBeenCalled();
    expect(moneyMovementGateway.createPayoutSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        providerReference: "acct_existing",
        contactEmail: "seller@example.test",
      }),
    );
  });

  it("records setup session failures by safe category without leaking provider messages", async () => {
    const operationEvents: Record<string, unknown>[] = [];
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const moneyMovementGateway = {
      providerName: "stripe",
      ensurePayoutAccount: vi.fn(),
      refreshPayoutReadiness: vi.fn(),
      createPayoutSetupSession: vi.fn(),
      createPayoutAccountManagementSession: vi.fn(),
      retrievePlatformBalance: vi.fn(),
      transferPlatformBalanceToConnectedAccount: vi.fn(),
      createConnectedAccountPayout: vi.fn(),
      retrieveConnectedAccountPayout: vi.fn(),
      parseMoneyMovementWebhook: vi.fn(),
    };
    const error = new Error("provider payload included client_secret and tax id");
    Object.assign(error, { statusCode: 429 });
    moneyMovementGateway.ensurePayoutAccount.mockRejectedValueOnce(error);
    const services = createPayoutReadinessRuntime({
      eventStore: createEventStore() as never,
      checkpointStore: {
        loadCheckpoint: vi.fn(async () => ZERO_GLOBAL_POSITION),
        saveCheckpoint: vi.fn(async () => {}),
      },
      db: db as never,
      moneyMovementGateway: moneyMovementGateway as never,
      operationsRecorder: {
        record: (event) => {
          operationEvents.push(event);
        },
      },
    });

    await expect(services.createPayoutSetupSession({ accountId: "acc_seller" as never }, context)).rejects.toThrow(
      "provider payload",
    );

    expect(operationEvents).toContainEqual(
      expect.objectContaining({
        kind: "payout-setup-session-failed",
        accountId: "acc_seller",
        setupSurface: "embedded-payout-setup",
        safeCategory: "provider_rate_limited",
      }),
    );
    expect(JSON.stringify(operationEvents)).not.toContain("client_secret");
    expect(JSON.stringify(operationEvents)).not.toContain("tax id");
  });

  it("records the same provider-neutral readiness shape from manual refresh and webhooks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T17:00:00.000Z"));
    const readiness: ProviderPayoutReadiness = {
      providerReference: "acct_123",
      onboardingStatus: "pending",
      transferCapabilityStatus: "active",
      payoutCapabilityStatus: "pending",
      payoutDestinationStatus: "missing",
      payoutAccountDashboard: "none",
      lossesCollector: "application",
      feesCollector: "application",
      requirementsCollector: "application",
      missingRequirements: ["external_account", "individual.verification.document"],
    };
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            account_id: "acc_seller",
            status: "pending",
            missing_requirements: ["external_account"],
            provider_reference: "acct_123",
            onboarding_status: "pending",
            transfer_capability_status: "active",
            payout_capability_status: "pending",
            payout_destination_status: "missing",
            payout_account_dashboard: "none",
            losses_collector: "application",
            fees_collector: "application",
            requirements_collector: "application",
            updated_at: "2026-06-01T16:00:00.000Z",
          },
        ],
      })),
    };
    const moneyMovementGateway = {
      providerName: "stripe",
      ensurePayoutAccount: vi.fn(),
      refreshPayoutReadiness: vi.fn(async () => readiness),
      createPayoutSetupSession: vi.fn(),
      createPayoutAccountManagementSession: vi.fn(),
      retrievePlatformBalance: vi.fn(),
      transferPlatformBalanceToConnectedAccount: vi.fn(),
      createConnectedAccountPayout: vi.fn(),
      retrieveConnectedAccountPayout: vi.fn(),
      parseMoneyMovementWebhook: vi.fn(),
    };
    const eventStore = createEventStore();
    const services = createPayoutReadinessRuntime({
      eventStore: eventStore as never,
      checkpointStore: {
        loadCheckpoint: vi.fn(async () => ZERO_GLOBAL_POSITION),
        saveCheckpoint: vi.fn(async () => {}),
      },
      db: db as never,
      moneyMovementGateway: moneyMovementGateway as never,
    });

    await services.refreshProviderReadiness({ accountId: "acc_seller" as never }, context);
    await services.recordProviderReadinessFromWebhook(
      {
        providerReference: "acct_123",
        readiness,
        recordedAt: "2026-06-01T17:00:00.000Z",
      },
      context,
    );

    const recordedPayloads = eventStore.appendToStream.mock.calls
      .flatMap(([input]) => input.events)
      .map((event) => event.payload as { data?: Record<string, unknown> } & Record<string, unknown>)
      .map((payload) => payload.data ?? payload);

    expect(recordedPayloads).toHaveLength(2);
    expect(recordedPayloads[0]).toEqual(recordedPayloads[1]);
    expect(recordedPayloads[0]).toMatchObject({
      accountId: "acc_seller",
      status: "pending",
      providerReference: "acct_123",
      onboardingStatus: "pending",
      transferCapabilityStatus: "active",
      payoutCapabilityStatus: "pending",
      payoutDestinationStatus: "missing",
      payoutAccountDashboard: "none",
      lossesCollector: "application",
      feesCollector: "application",
      requirementsCollector: "application",
      missingRequirements: ["external_account", "individual.verification.document"],
      recordedAt: "2026-06-01T17:00:00.000Z",
    });
    vi.useRealTimers();
  });

  it("returns fresh provider readiness from refresh without waiting for projection catch-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T18:00:00.000Z"));
    const operationEvents: Record<string, unknown>[] = [];
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const moneyMovementGateway = {
      providerName: "stripe",
      ensurePayoutAccount: vi.fn(),
      refreshPayoutReadiness: vi.fn(async () => ({
        providerReference: "acct_embedded_smoke",
        onboardingStatus: "complete",
        transferCapabilityStatus: "active",
        payoutCapabilityStatus: "active",
        payoutDestinationStatus: "ready",
        payoutAccountDashboard: "none",
        lossesCollector: "application",
        feesCollector: "application",
        requirementsCollector: "application",
        missingRequirements: [],
      })),
      createPayoutSetupSession: vi.fn(),
      createPayoutAccountManagementSession: vi.fn(),
      retrievePlatformBalance: vi.fn(),
      transferPlatformBalanceToConnectedAccount: vi.fn(),
      createConnectedAccountPayout: vi.fn(),
      retrieveConnectedAccountPayout: vi.fn(),
      parseMoneyMovementWebhook: vi.fn(),
    };
    const services = createPayoutReadinessRuntime({
      eventStore: createEventStore() as never,
      checkpointStore: {
        loadCheckpoint: vi.fn(async () => ZERO_GLOBAL_POSITION),
        saveCheckpoint: vi.fn(async () => {}),
      },
      db: db as never,
      moneyMovementGateway: moneyMovementGateway as never,
      operationsRecorder: {
        record: (event) => {
          operationEvents.push(event);
        },
      },
    });

    await expect(
      services.refreshProviderReadiness(
        {
          accountId: "acc_seller" as never,
          contactEmail: "seller@example.test",
          providerReference: "acct_embedded_smoke",
        },
        context,
      ),
    ).resolves.toMatchObject({
      account_id: "acc_seller",
      status: "ready",
      provider_reference: "acct_embedded_smoke",
      payout_account_dashboard: "none",
      losses_collector: "application",
      fees_collector: "application",
      requirements_collector: "application",
      updated_at: "2026-06-01T18:00:00.000Z",
    });
    expect(moneyMovementGateway.refreshPayoutReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        providerReference: "acct_embedded_smoke",
      }),
    );
    expect(moneyMovementGateway.ensurePayoutAccount).not.toHaveBeenCalled();
    expect(operationEvents).toContainEqual(
      expect.objectContaining({
        kind: "payout-readiness-refresh-succeeded",
        accountId: "acc_seller",
        providerReference: "acct_embedded_smoke",
        readinessStatus: "ready",
        payoutAccountDashboard: "none",
      }),
    );
    vi.useRealTimers();
  });

  it("fails closed when a refresh returns a different provider account than the existing setup", async () => {
    const operationEvents: Record<string, unknown>[] = [];
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            account_id: "acc_seller",
            status: "pending",
            missing_requirements: ["external_account"],
            provider_reference: "acct_existing",
            onboarding_status: "pending",
            transfer_capability_status: "active",
            payout_capability_status: "pending",
            payout_destination_status: "missing",
            payout_account_dashboard: "none",
            losses_collector: "application",
            fees_collector: "application",
            requirements_collector: "application",
            updated_at: "2026-06-01T16:00:00.000Z",
          },
        ],
      })),
    };
    const eventStore = createEventStore();
    const moneyMovementGateway = {
      providerName: "stripe",
      ensurePayoutAccount: vi.fn(),
      refreshPayoutReadiness: vi.fn(async () => ({
        providerReference: "acct_other",
        onboardingStatus: "pending",
        transferCapabilityStatus: "active",
        payoutCapabilityStatus: "pending",
        payoutDestinationStatus: "missing",
        payoutAccountDashboard: "none",
        lossesCollector: "application",
        feesCollector: "application",
        requirementsCollector: "application",
        missingRequirements: ["external_account"],
      })),
      createPayoutSetupSession: vi.fn(),
      createPayoutAccountManagementSession: vi.fn(),
      retrievePlatformBalance: vi.fn(),
      transferPlatformBalanceToConnectedAccount: vi.fn(),
      createConnectedAccountPayout: vi.fn(),
      retrieveConnectedAccountPayout: vi.fn(),
      parseMoneyMovementWebhook: vi.fn(),
    };
    const services = createPayoutReadinessRuntime({
      eventStore: eventStore as never,
      checkpointStore: {
        loadCheckpoint: vi.fn(async () => ZERO_GLOBAL_POSITION),
        saveCheckpoint: vi.fn(async () => {}),
      },
      db: db as never,
      moneyMovementGateway: moneyMovementGateway as never,
      operationsRecorder: {
        record: (event) => {
          operationEvents.push(event);
        },
      },
    });

    await expect(services.refreshProviderReadiness({ accountId: "acc_seller" as never }, context)).rejects.toThrow(
      "Payout setup changed while refreshing. Please restart payout setup.",
    );
    expect(eventStore.appendToStream).not.toHaveBeenCalled();
    expect(operationEvents).toContainEqual(
      expect.objectContaining({
        kind: "payout-readiness-refresh-failed",
        accountId: "acc_seller",
        providerReference: "acct_existing",
        safeCategory: "provider_validation",
      }),
    );
  });
});
