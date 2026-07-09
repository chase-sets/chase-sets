import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
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
