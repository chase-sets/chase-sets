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
  it("creates a fresh provider onboarding link idempotency key for each same-account attempt", async () => {
    const onboardingKeys: string[] = [];
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
        missingRequirements: ["external_account"],
      })),
      refreshPayoutReadiness: vi.fn(),
      createOnboardingSession: vi.fn(async (input: { idempotencyKey: string }) => {
        onboardingKeys.push(input.idempotencyKey);
        return {
          providerReference: "acct_123",
          url: `https://connect.stripe.test/${onboardingKeys.length}`,
          expiresAt: null,
          readiness: {
            providerReference: "acct_123",
            onboardingStatus: "pending",
            transferCapabilityStatus: "active",
            payoutCapabilityStatus: "pending",
            payoutDestinationStatus: "pending",
            missingRequirements: ["external_account"],
          },
        };
      }),
      createAccountManagementSession: vi.fn(),
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

    await services.createOnboardingSession({ accountId: "acc_seller" as never }, context);
    await services.createOnboardingSession({ accountId: "acc_seller" as never }, context);

    expect(onboardingKeys).toHaveLength(2);
    expect(onboardingKeys[0]).toMatch(/^settlement:payout-account:acc_seller:onboarding:setup_/);
    expect(onboardingKeys[1]).toMatch(/^settlement:payout-account:acc_seller:onboarding:setup_/);
    expect(onboardingKeys[0]).not.toBe(onboardingKeys[1]);
  });

  it("creates embedded payout setup sessions with provider-neutral components", async () => {
    const setupKeys: string[] = [];
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
        missingRequirements: ["external_account"],
      })),
      refreshPayoutReadiness: vi.fn(),
      createOnboardingSession: vi.fn(),
      createAccountManagementSession: vi.fn(),
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
    });

    await expect(services.createPayoutSetupSession({ accountId: "acc_seller" as never }, context)).resolves.toEqual({
      clientSecret: "provider_session_secret",
      providerReference: "acct_123",
      expiresAt: "2026-06-01T15:00:00.000Z",
      components: ["payout-setup"],
    });
    expect(setupKeys).toHaveLength(1);
    expect(setupKeys[0]).toMatch(/^settlement:payout-account:acc_seller:embedded-setup:setup_/);
    expect(JSON.stringify(eventStore.appendToStream.mock.calls)).not.toContain("provider_session_secret");
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
            updated_at: "2026-06-01T16:00:00.000Z",
          },
        ],
      })),
    };
    const moneyMovementGateway = {
      providerName: "stripe",
      ensurePayoutAccount: vi.fn(),
      refreshPayoutReadiness: vi.fn(async () => readiness),
      createOnboardingSession: vi.fn(),
      createAccountManagementSession: vi.fn(),
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
      missingRequirements: ["external_account", "individual.verification.document"],
      recordedAt: "2026-06-01T17:00:00.000Z",
    });
    vi.useRealTimers();
  });
});
