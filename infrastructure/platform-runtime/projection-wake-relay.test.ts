import { type ContextProjectionGroup } from "@chase-sets/bounded-context-runtime";
import { type EventStoreWakeNotificationEnvelope } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { describe, expect, it } from "vitest";

import {
  buildProjectionInterestIndex,
  markProjectionInterestIndexStale,
  ProjectionInterestIndexStaleError,
} from "./projection-interest-index";
import {
  fanOutEventStoreWakeNotification,
  ProjectionWakeRelayNotificationRejectedError,
  type ProjectionWakeRelayFanOutFailedEvent,
  type ProjectionWakeRelayFanOutSkippedEvent,
  type ProjectionWakeRelayFanOutSucceededEvent,
  type ProjectionWakeRelayNotificationRejectedEvent,
  type ProjectionWakeRelaySourceSkippedEvent,
} from "./projection-wake-relay";
import {
  listSourceContextWakeRelayConfigs,
  sourceContextWakeRegistry,
  type SourceContextWakeRegistryEntry,
} from "./source-context-wake-registry";
import type {
  EnqueueProjectionWakeIntentInput,
  ProjectionWakeIntentRecord,
  WorkSignalPriorityLane,
} from "./work-signal-store";

const GENERATED_AT = new Date("2026-06-10T12:00:00.000Z");
const NOW = new Date("2026-06-10T12:00:01.000Z");

describe("projection wake relay fan-out", () => {
  it("fans an enabled event-store wake into durable projection wake intents", async () => {
    const index = checkoutProjectionIndex({
      eventTypes: ["CheckoutSessionCreated"],
      streamPrefixes: ["checkout.session."],
    });
    const relayConfigs = checkoutRelayConfigs();
    const { store, inputs } = recordingWorkSignalStore();
    const succeeded: ProjectionWakeRelayFanOutSucceededEvent[] = [];

    const result = await fanOutEventStoreWakeNotification({
      notification: checkoutWakeNotification(),
      projectionInterestIndex: index,
      workSignalStore: store,
      relayConfigs,
      observer: {
        fanOutSucceeded: (event) => succeeded.push(event),
      },
    });

    expect(result).toMatchObject({
      status: "enqueued",
      skippedReason: null,
      sourceContextName: "checkout",
      streamCategory: "checkout.session",
      firstGlobalPosition: "101",
      lastGlobalPosition: "102",
      requiredCursor: "checkout:102",
      priorityLane: "hot",
      projectionInterestIndexVersion: index.indexVersion,
      intentCount: 1,
      enqueuedCount: 1,
      enqueuedWakeIntentIds: ["projection-wake-1"],
    });
    expect(succeeded).toHaveLength(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      sourceContextName: "checkout",
      targetContextName: "checkout",
      projectionName: "checkout-session-pages",
      checkpointKey: "checkout-session-pages:checkout:v1",
      requiredPosition: "102",
      requiredCursor: "checkout:102",
      priorityLane: "hot",
      origin: "relay",
      correlationId: "trace_checkout_1",
      schemaVersion: 1,
      payloadVersion: 1,
    });
    expect(inputs[0].metadata).toMatchObject({
      projectionWakeRelaySchemaVersion: 1,
      projectionWakeRelayMetadataVersion: 1,
      eventStoreWakeSource: "event-core-postgres",
      eventStoreWakeStreamCategory: "checkout.session",
      eventStoreWakeFirstGlobalPosition: "101",
      eventStoreWakeLastGlobalPosition: "102",
      eventStoreWakeEventCount: 2,
      eventStoreWakeEventTypes: ["CheckoutSessionCreated"],
      sourceContextWakeRolloutState: "staging-enabled",
      sourceContextWakeRolloutWave: "wave-1-checkout-hot-path",
      projectionInterestIndexVersion: index.indexVersion,
    });
    expect(inputs[0].metadata).not.toHaveProperty("streamId");
    expect(inputs[0].metadata).not.toHaveProperty("eventPayload");
  });

  it("skips disabled source contexts without enqueueing work", async () => {
    const { store, inputs } = recordingWorkSignalStore();
    const skipped: ProjectionWakeRelaySourceSkippedEvent[] = [];

    const result = await fanOutEventStoreWakeNotification({
      notification: checkoutWakeNotification(),
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      observer: {
        sourceSkipped: (event) => skipped.push(event),
      },
    });

    expect(result).toMatchObject({
      status: "skipped",
      skippedReason: "source-disabled",
      sourceContextName: "checkout",
      intentCount: 0,
      enqueuedCount: 0,
      priorityLane: null,
    });
    expect(inputs).toEqual([]);
    expect(skipped).toMatchObject([
      {
        sourceContextName: "checkout",
        reason: "source-disabled",
        relayFanOutEnabled: false,
        rolloutState: null,
      },
    ]);
  });

  it("rejects invalid notification envelopes before fan-out", async () => {
    const rejected: ProjectionWakeRelayNotificationRejectedEvent[] = [];
    const failures: ProjectionWakeRelayFanOutFailedEvent[] = [];

    await expect(
      fanOutEventStoreWakeNotification({
        notification: JSON.stringify({
          schemaVersion: 1,
          payloadVersion: 1,
          kind: "wrong.kind",
          source: "event-core-postgres",
          emittedAt: "2026-06-10T12:00:00.000Z",
          payload: {},
        }),
        projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
        workSignalStore: recordingWorkSignalStore().store,
        relayConfigs: checkoutRelayConfigs(),
        observer: {
          notificationRejected: (event) => rejected.push(event),
          fanOutFailed: (event) => failures.push(event),
        },
      }),
    ).rejects.toThrow(ProjectionWakeRelayNotificationRejectedError);

    expect(rejected[0].reason).toContain("unsupported kind");
    expect(failures).toMatchObject([{ reason: "invalid-notification", intentCount: 0, enqueuedCount: 0 }]);
  });

  it("fails closed when the projection interest index is stale", async () => {
    const failures: ProjectionWakeRelayFanOutFailedEvent[] = [];

    await expect(
      fanOutEventStoreWakeNotification({
        notification: checkoutWakeNotification(),
        projectionInterestIndex: markProjectionInterestIndexStale(
          checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
          "runtime reload requested",
        ),
        workSignalStore: recordingWorkSignalStore().store,
        relayConfigs: checkoutRelayConfigs(),
        observer: {
          fanOutFailed: (event) => failures.push(event),
        },
      }),
    ).rejects.toThrow(ProjectionInterestIndexStaleError);

    expect(failures).toMatchObject([{ reason: "stale-interest-index", intentCount: 0, enqueuedCount: 0 }]);
  });

  it("skips enabled sources that have no interested projections", async () => {
    const { store, inputs } = recordingWorkSignalStore();
    const skipped: ProjectionWakeRelayFanOutSkippedEvent[] = [];

    const result = await fanOutEventStoreWakeNotification({
      notification: checkoutWakeNotification({ eventTypes: ["CheckoutSessionCreated"] }),
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["OtherCheckoutEvent"] }),
      workSignalStore: store,
      relayConfigs: checkoutRelayConfigs(),
      observer: {
        fanOutSkipped: (event) => skipped.push(event),
      },
    });

    expect(result).toMatchObject({
      status: "skipped",
      skippedReason: "no-interests",
      sourceContextName: "checkout",
      requiredCursor: "checkout:102",
      priorityLane: "hot",
      intentCount: 0,
      enqueuedCount: 0,
    });
    expect(inputs).toEqual([]);
    expect(skipped).toMatchObject([{ reason: "no-interests", sourceContextName: "checkout" }]);
  });

  it("reports enqueue failures after intent creation", async () => {
    const failures: ProjectionWakeRelayFanOutFailedEvent[] = [];
    const { store, inputs } = recordingWorkSignalStore({ failOnEnqueue: true });

    await expect(
      fanOutEventStoreWakeNotification({
        notification: checkoutWakeNotification(),
        projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
        workSignalStore: store,
        relayConfigs: checkoutRelayConfigs(),
        observer: {
          fanOutFailed: (event) => failures.push(event),
        },
      }),
    ).rejects.toThrow("control-plane unavailable");

    expect(inputs).toHaveLength(1);
    expect(failures).toMatchObject([{ reason: "enqueue-failed", intentCount: 1, enqueuedCount: 0 }]);
  });

  it("preserves core relay metadata and rejects unsafe metadata keys", async () => {
    const { store, inputs } = recordingWorkSignalStore();

    await fanOutEventStoreWakeNotification({
      notification: checkoutWakeNotification(),
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      relayConfigs: checkoutRelayConfigs(),
      metadata: {
        operatorNote: "proof-mode",
        projectionWakeRelaySchemaVersion: 999,
      },
    });

    expect(inputs[0].metadata).toMatchObject({
      operatorNote: "proof-mode",
      projectionWakeRelaySchemaVersion: 1,
    });

    await expect(
      fanOutEventStoreWakeNotification({
        notification: checkoutWakeNotification(),
        projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
        workSignalStore: recordingWorkSignalStore().store,
        relayConfigs: checkoutRelayConfigs(),
        metadata: {
          streamId: "checkout.session.chk_1",
        },
      }),
    ).rejects.toThrow(/metadata key 'streamId' is not allowed/);
  });
});

function checkoutWakeNotification(
  overrides: Partial<EventStoreWakeNotificationEnvelope["payload"]> = {},
): EventStoreWakeNotificationEnvelope {
  return {
    schemaVersion: 1,
    payloadVersion: 1,
    kind: "event-store.commit",
    source: "event-core-postgres",
    emittedAt: parseIsoUtcTimestamp("2026-06-10T12:00:00.000Z"),
    correlationId: "trace_checkout_1",
    payload: {
      sourceContextName: "checkout",
      streamCategory: "checkout.session",
      firstGlobalPosition: parseGlobalPosition("101"),
      lastGlobalPosition: parseGlobalPosition("102"),
      eventCount: 2,
      eventTypes: ["CheckoutSessionCreated"],
      ...overrides,
    },
  };
}

function checkoutRelayConfigs() {
  const registry: SourceContextWakeRegistryEntry[] = sourceContextWakeRegistry.map((entry) => {
    if (entry.sourceContextName !== "checkout") {
      return entry;
    }

    return {
      ...entry,
      rolloutState: "staging-enabled",
      enablement: {
        eventStoreWakeNotifications: true,
        relayFanOut: true,
      },
    };
  });

  return listSourceContextWakeRelayConfigs({ registry });
}

function checkoutProjectionIndex(
  input: Readonly<{ eventTypes: readonly string[]; streamPrefixes?: readonly string[] }>,
) {
  return buildProjectionInterestIndex({
    generatedAt: GENERATED_AT,
    projectionGroups: [
      projectionGroup({
        targetContextName: "checkout",
        projectionName: "checkout-session-pages",
        ownedTables: ["checkout_session_pages"],
        runners: [
          runner({
            sourceContextName: "checkout",
            targetContextName: "checkout",
            projectionName: "checkout-session-pages",
            eventTypes: input.eventTypes,
            streamPrefixes: input.streamPrefixes,
          }),
        ],
      }),
    ],
  });
}

function recordingWorkSignalStore(options: { failOnEnqueue?: boolean } = {}) {
  const inputs: EnqueueProjectionWakeIntentInput[] = [];

  return {
    inputs,
    store: {
      enqueueProjectionWakeIntent: async (input: EnqueueProjectionWakeIntentInput) => {
        inputs.push(input);
        if (options.failOnEnqueue) {
          throw new Error("control-plane unavailable");
        }

        return wakeIntentRecord(input, inputs.length);
      },
    },
  };
}

function wakeIntentRecord(input: EnqueueProjectionWakeIntentInput, sequence: number): ProjectionWakeIntentRecord {
  const priorityLane: WorkSignalPriorityLane = input.priorityLane ?? "standard";

  return {
    wakeIntentId: `projection-wake-${sequence}`,
    coalescingKey: input.coalescingKey ?? `coalescing-${sequence}`,
    sourceContextName: input.sourceContextName,
    targetContextName: input.targetContextName,
    projectionName: input.projectionName,
    checkpointKey: input.checkpointKey,
    requiredPosition: BigInt(input.requiredPosition),
    requiredCursor: input.requiredCursor ?? null,
    priorityLane,
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
    nextEligibleAt: NOW,
    attemptCount: 0,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: new Date("2026-06-10T12:05:00.000Z"),
    completedAt: null,
  };
}

function projectionGroup(
  input: Readonly<{
    targetContextName: string;
    projectionName: string;
    ownedTables: readonly string[];
    runners: readonly ReturnType<typeof runner>[];
  }>,
): ContextProjectionGroup {
  return {
    projectionName: input.projectionName,
    projectionRevision: 1,
    targetContextName: input.targetContextName,
    sourceContextNames: input.runners.map((entry) => entry.sourceContextName),
    ownedTables: input.ownedTables,
    requiredDuringBootstrap: false,
    subscriptionRunners: input.runners,
    reset: async () => {},
    getStatus: () => ({}) as never,
    refreshStatus: async () => ({}) as never,
    markRevisionSynced: async () => {},
  };
}

function runner(
  input: Readonly<{
    sourceContextName: string;
    targetContextName: string;
    projectionName: string;
    eventTypes?: readonly string[];
    streamPrefixes?: readonly string[];
  }>,
) {
  return {
    subscriptionName: `${input.targetContextName}.${input.projectionName}.${input.sourceContextName}`,
    projectionName: input.projectionName,
    sourceContextName: input.sourceContextName,
    targetContextName: input.targetContextName,
    subscriptionVersion: 1,
    checkpointKey: `${input.projectionName}:${input.sourceContextName}:v1`,
    eventTypes: input.eventTypes,
    streamPrefixes: input.streamPrefixes,
    order: 0,
    runOnce: async () => ({}) as never,
    getStatus: () => ({}) as never,
    refreshStatus: async () => ({}) as never,
    reset: async () => {},
    retryBlockedStream: async () => ({}) as never,
  };
}
