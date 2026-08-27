import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { createHash } from "node:crypto";
import {
  buildProjectionInterestIndex,
  lookupProjectionInterests,
} from "@chase-sets/platform-runtime/projection-interest-index";
import { listProjectionInterestOverridesForPushMigration } from "@chase-sets/platform-runtime/projection-push-migration";
import {
  fanOutEventStoreWakeNotification,
  type ProjectionWakeRelayWorkSignalStore,
} from "@chase-sets/platform-runtime/projection-wake-relay";
import { listSourceContextWakeRelayConfigs } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { describe, expect, it } from "vitest";
import { workerContextRegistry } from "../src/generated/worker-context-registry";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "../src/test-support/provider-gateways";

const ORDERING_CREATED_INVENTORY_RESERVATION_TARGET = {
  sourceContextName: "ordering",
  eventType: "ordering.order.created",
  targetContextName: "inventory",
  projectionName: "inventory-order-reservation-workflow",
  checkpointKey: "inventory-order-reservation-workflow:ordering:v1",
} as const;

const AGENT_WEBHOOK_TARGETS = [
  {
    sourceContextName: "ordering",
    eventType: "ordering.order.created",
    targetContextName: "auth",
    projectionName: "auth-agent-order-webhook-projection",
    checkpointKey: "auth-agent-order-webhook-projection:ordering:v1",
  },
  {
    sourceContextName: "fulfillment",
    eventType: "fulfillment.shipment.dispatched",
    targetContextName: "auth",
    projectionName: "auth-agent-order-webhook-projection",
    checkpointKey: "auth-agent-order-webhook-projection:fulfillment:v1",
  },
  {
    sourceContextName: "payments",
    eventType: "payments.refund-issued",
    targetContextName: "auth",
    projectionName: "auth-agent-order-webhook-projection",
    checkpointKey: "auth-agent-order-webhook-projection:payments:v1",
  },
] as const;

describe("platform worker projection wake interest graph", () => {
  it("boots every public-profile context and creates the Checkout Session runner from its local projector", () => {
    const runtime = createPlatformWorkerHost("public");
    const mountedContextNames = runtime.mountedContexts.map((entry) => entry.contextName).sort();
    const registryContextNames = workerContextRegistry.map((entry) => entry.contextName).sort();
    const checkoutModule = runtime.mountedContexts.find((entry) => entry.contextName === "checkout")?.module;
    const checkoutSessionRunner = runtime.subscriptionRunners.find(
      (runner) =>
        runner.targetContextName === "checkout" &&
        runner.sourceContextName === "checkout" &&
        runner.projectionName === "checkout.session-projection",
    );

    expect(mountedContextNames).toEqual(registryContextNames);
    expect(runtime.mountedContexts.every((entry) => entry.mountRole === "active")).toBe(true);
    expect(
      checkoutModule?.eventSubscriptions?.find(
        (subscription) =>
          subscription.sourceContextName === "checkout" &&
          subscription.projectionName === "checkout.session-projection",
      ),
    ).toBeUndefined();
    expect(checkoutSessionRunner).toMatchObject({
      checkpointKey: "checkout.session-projection:checkout:v1",
      subscriptionVersion: 1,
    });
    expect(checkoutSessionRunner?.eventTypes).toEqual([
      "checkout.session.authenticity-check-opt-in-selected",
      "checkout.session.cancelled",
      "checkout.session.fulfillment-preview-recorded",
      "checkout.session.offer-submitted",
      "checkout.session.optimization-goal-selected",
      "checkout.session.orders-created",
      "checkout.session.payment-started",
      "checkout.session.reservations-recorded",
      "checkout.session.shipping-address-set",
      "checkout.session.shipping-option-selected",
      "checkout.session.started",
    ]);
  });

  it("preserves the complete manifest-built subscription fingerprint, checkpoint identities, and shared names", () => {
    const runtime = createPlatformWorkerHost("public");
    const rawSubscriptions = runtime.mountedContexts.flatMap((entry) =>
      (entry.module.buildSubscriptions?.(entry.services) ?? []).map((subscription) => ({
        targetContextName: entry.contextName,
        subscription,
      })),
    );
    const sharedNames = summarizeSharedSubscriptionNames(rawSubscriptions.map(({ subscription }) => subscription));
    const rawCheckpointIdentities = rawSubscriptions
      .map(
        ({ subscription }) =>
          `${subscription.projectionName}:${subscription.sourceContextName}:v${subscription.subscriptionVersion}`,
      )
      .sort();

    expect(fingerprint(runtime.subscriptionRunners.map((runner) => fingerprintObject(runner)))).toEqual({
      count: 227,
      sha256: "f69b156f1845dfd327776d55120154f4963051a80b4587073820e398b9be0351",
    });
    expect(
      fingerprint(
        rawSubscriptions.map(({ targetContextName, subscription }) => ({
          targetContextName,
          subscription: fingerprintObject(subscription),
        })),
      ),
    ).toEqual({
      count: 141,
      sha256: "7e3e478d9d8eea0302b90c4ca7c8f5c257bc3692caceea858088c4b60d398b22",
    });
    expect({
      count: rawCheckpointIdentities.length,
      sha256: sha256(JSON.stringify(rawCheckpointIdentities)),
    }).toEqual({
      count: 141,
      sha256: "02f546dd333c96b44f53935fd66e9b01b159b133a561ed00b722f69c85c2127c",
    });
    expect(fingerprint(runtime.subscriptionRunners.map((runner) => runner.checkpointKey))).toEqual({
      count: 227,
      sha256: "d5fca85318714b4641a71b9625fe341dffbdfe42c0fdffe943bef26aa68ca7f8",
    });
    expect(sharedNames).toMatchObject({
      distinctNames: 110,
      distinctSharedNames: 18,
      runnersUsingSharedNames: 49,
    });
    expect(sharedNames.values["checkout.checkout.sell-list-projection"]).toBe(3);
    expect(sharedNames.values["support.affected-line-amount-projection"]).toBe(2);
  });

  it("boots the landing worker with source-only contexts required by active subscriptions", () => {
    const runtime = createPlatformWorkerHost("landing");

    expect(runtime.mountedContexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contextName: "ordering", mountRole: "source-only" }),
        expect.objectContaining({ contextName: "platform-operations", mountRole: "active" }),
        expect.objectContaining({ contextName: "public-presence", mountRole: "active" }),
      ]),
    );
    expect(runtime.projectionGroups.map((group) => `${group.targetContextName}:${group.projectionName}`)).toEqual(
      expect.arrayContaining([
        "platform-operations:support-order-source-projection",
        "public-presence:public-presence-waitlist-projection",
      ]),
    );
  });

  it("wires ordering.order.created to the Inventory order reservation workflow checkpoint", () => {
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();

    const entries = lookupProjectionInterests(index, {
      sourceContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.sourceContextName,
      eventType: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.eventType,
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.targetContextName,
          projectionName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.projectionName,
          checkpointKey: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.checkpointKey,
          sourceContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.sourceContextName,
          enabled: true,
          eventTypes: expect.arrayContaining([ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.eventType]),
        }),
      ]),
    );
  });

  it("subscribes the Auth agent webhook projection to order, shipment, and refund updates", () => {
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();

    for (const target of AGENT_WEBHOOK_TARGETS) {
      const entries = lookupProjectionInterests(index, {
        sourceContextName: target.sourceContextName,
        eventType: target.eventType,
      });

      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetContextName: target.targetContextName,
            projectionName: target.projectionName,
            checkpointKey: target.checkpointKey,
            sourceContextName: target.sourceContextName,
            enabled: true,
            eventTypes: expect.arrayContaining([target.eventType]),
          }),
        ]),
      );
    }
  });

  it("fans an Ordering created notification to Inventory instead of skipping as no-interests", async () => {
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();
    const enqueuedInputs: Parameters<ProjectionWakeRelayWorkSignalStore["enqueueProjectionWakeIntent"]>[0][] = [];

    const result = await fanOutEventStoreWakeNotification({
      notification: {
        schemaVersion: 1,
        payloadVersion: 1,
        kind: "event-store.commit",
        source: "event-core-postgres",
        emittedAt: parseIsoUtcTimestamp("2026-06-26T12:00:00.000Z"),
        correlationId: "trace_ordering_created_1",
        payload: {
          sourceContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.sourceContextName,
          streamCategory: "ordering.order",
          firstGlobalPosition: parseGlobalPosition("71"),
          lastGlobalPosition: parseGlobalPosition("71"),
          eventCount: 1,
          eventTypes: [ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.eventType],
        },
      },
      projectionInterestIndex: index,
      workSignalStore: {
        enqueueProjectionWakeIntent: async (input) => {
          enqueuedInputs.push(input);
          return {
            wakeIntentId: `wake-${enqueuedInputs.length}`,
            coalescingKey: `coalescing-${enqueuedInputs.length}`,
            sourceContextName: input.sourceContextName,
            targetContextName: input.targetContextName,
            projectionName: input.projectionName,
            checkpointKey: input.checkpointKey,
            requiredPosition: BigInt(input.requiredPosition),
            requiredCursor: input.requiredCursor ?? null,
            priorityLane: input.priorityLane ?? "standard",
            origin: input.origin,
            schemaVersion: input.schemaVersion ?? 1,
            payloadVersion: input.payloadVersion ?? 1,
            correlationId: input.correlationId ?? null,
            metadata: input.metadata ?? {},
            state: "queued",
            claimOwnerId: null,
            claimFencingToken: null,
            claimedRequiredPosition: null,
            claimedRequiredCursor: null,
            claimedUntil: null,
            nextEligibleAt: new Date("2026-06-26T12:00:00.000Z"),
            attemptCount: 0,
            lastError: null,
            createdAt: new Date("2026-06-26T12:00:00.000Z"),
            updatedAt: new Date("2026-06-26T12:00:00.000Z"),
            expiresAt: new Date("2026-06-26T12:05:00.000Z"),
            completedAt: null,
          };
        },
      },
      relayConfigs: listSourceContextWakeRelayConfigs(),
    });

    expect(result).toMatchObject({
      status: "enqueued",
      skippedReason: null,
      sourceContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.sourceContextName,
      requiredCursor: "ordering:71",
    });
    expect(enqueuedInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.targetContextName,
          projectionName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.projectionName,
          checkpointKey: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.checkpointKey,
          requiredPosition: "71",
          requiredCursor: "ordering:71",
          priorityLane: "hot",
          origin: "relay",
        }),
      ]),
    );
  });
});

function buildPlatformWorkerProjectionWakeRelayInterestIndex(disabledProjectionKeys: readonly string[] = []) {
  const runtime = createPlatformWorkerHost();

  return buildProjectionInterestIndex({
    projectionGroups: runtime.projectionGroups,
    projectionOverrides: [
      ...disabledProjectionKeys.map((projectionKey) => {
        const separatorIndex = projectionKey.indexOf(":");
        return {
          targetContextName: projectionKey.slice(0, separatorIndex),
          projectionName: projectionKey.slice(separatorIndex + 1),
          disabled: true,
          optOutReason: "Disabled by WORKER_WAKE_DISABLED_PROJECTIONS.",
        };
      }),
      ...listProjectionInterestOverridesForPushMigration(),
    ],
  });
}

function createPlatformWorkerHost(runtimeProfile: "landing" | "proof" | "public" = "public") {
  return createWorkerHost(workerContextRegistry, "platform-worker", {
    pools: Object.fromEntries(workerContextRegistry.map((entry) => [entry.contextName, createUnusedPool()])),
    hostPorts: {
      processorGateway: createFakePaymentProcessorGateway(),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: { record: () => undefined },
      postageLabelProvider: createSandboxPostageLabelProvider(),
      draftListingCreator: { createDraftListings: async () => [] },
      notificationAdapter: { send: async () => undefined },
      agentWebhookOrderResolvers: {
        resolveOrderRecipient: async () => null,
        resolveShipmentOrderId: async () => null,
        resolveWebhookTargets: async () => [],
      },
    },
    runtimeProfile,
  });
}

function createUnusedPool() {
  const fail = () => {
    throw new Error("The platform-worker wake interest graph test must not touch database pools.");
  };

  return {
    query: fail,
    connect: fail,
  } as never;
}

type FingerprintRecord = Readonly<Record<string, unknown>>;

function fingerprintObject(value: FingerprintRecord) {
  const fieldNames = Object.keys(value)
    .filter((fieldName) => typeof value[fieldName] !== "function")
    .sort();
  const handlerEventTypes = isRecord(value.handlers) ? Object.keys(value.handlers).sort() : [];

  return {
    fieldNames,
    fields: Object.fromEntries(fieldNames.map((fieldName) => [fieldName, stableValue(value[fieldName])])),
    handlerEventTypes,
  };
}

function fingerprint(values: readonly unknown[]) {
  const serialized = JSON.stringify(
    [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
  return {
    count: values.length,
    sha256: sha256(serialized),
  };
}

function summarizeSharedSubscriptionNames(subscriptions: readonly Readonly<{ subscriptionName: string }>[]) {
  const counts = new Map<string, number>();
  for (const subscription of subscriptions) {
    counts.set(subscription.subscriptionName, (counts.get(subscription.subscriptionName) ?? 0) + 1);
  }
  const sharedNames = [...counts.entries()].filter(([, count]) => count > 1);

  return {
    distinctNames: counts.size,
    distinctSharedNames: sharedNames.length,
    runnersUsingSharedNames: sharedNames.reduce((total, [, count]) => total + count, 0),
    values: Object.fromEntries(sharedNames),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!isRecord(value)) {
    return typeof value === "function" ? "<function>" : value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function isRecord(value: unknown): value is FingerprintRecord {
  return typeof value === "object" && value !== null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
