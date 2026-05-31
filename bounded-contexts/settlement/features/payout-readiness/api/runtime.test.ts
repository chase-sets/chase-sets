import { describe, expect, it, vi } from "vitest";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
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
});
