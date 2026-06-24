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
  runProjectionWakeRelayActiveSession,
  type ProjectionWakeRelayFanOutFailedEvent,
  type ProjectionWakeRelayFanOutSkippedEvent,
  type ProjectionWakeRelayFanOutSucceededEvent,
  type ProjectionWakeRelayLeaseEvent,
  type ProjectionWakeRelaySourceCatchUpCompletedEvent,
  type ProjectionWakeRelayNotificationRejectedEvent,
  type ProjectionWakeRelaySourceSkippedEvent,
} from "./projection-wake-relay";
import {
  listSourceContextWakeRelayConfigs,
  sourceContextWakeRegistry,
  type SourceContextWakeRegistryEntry,
} from "./source-context-wake-registry";
import {
  type EnqueueProjectionWakeIntentInput,
  type ProjectionWakeIntentRecord,
  type WorkSignalPriorityLane,
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
    expect(succeeded[0].notificationAgeMs === null || succeeded[0].notificationAgeMs >= 0).toBe(true);
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

  it("accepts additive event-store wake payload versions during relay fan-out", async () => {
    const { store, inputs } = recordingWorkSignalStore();

    const result = await fanOutEventStoreWakeNotification({
      notification: JSON.stringify({
        ...checkoutWakeNotification(),
        payloadVersion: 2,
        payload: {
          ...checkoutWakeNotification().payload,
          additiveRoutingHint: "safe-over-wake-only",
        },
        additiveEnvelopeHint: "ignored-by-current-relay",
      }),
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      relayConfigs: checkoutRelayConfigs(),
    });

    expect(result).toMatchObject({
      status: "enqueued",
      requiredCursor: "checkout:102",
      enqueuedCount: 1,
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].metadata).toMatchObject({
      eventStoreWakeSchemaVersion: 1,
      eventStoreWakePayloadVersion: 2,
      eventStoreWakeLastGlobalPosition: "102",
    });
    expect(inputs[0].metadata).not.toHaveProperty("additiveRoutingHint");
    expect(inputs[0].metadata).not.toHaveProperty("additiveEnvelopeHint");
  });

  it("skips disabled source contexts without enqueueing work", async () => {
    const { store, inputs } = recordingWorkSignalStore();
    const skipped: ProjectionWakeRelaySourceSkippedEvent[] = [];

    const result = await fanOutEventStoreWakeNotification({
      notification: checkoutWakeNotification(),
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      relayConfigs: [],
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

  it("rejects notifications whose position range runs backwards before fan-out", async () => {
    const rejected: ProjectionWakeRelayNotificationRejectedEvent[] = [];
    const { store, inputs } = recordingWorkSignalStore();

    await expect(
      fanOutEventStoreWakeNotification({
        notification: JSON.stringify(
          checkoutWakeNotification({
            firstGlobalPosition: parseGlobalPosition("102"),
            lastGlobalPosition: parseGlobalPosition("101"),
          }),
        ),
        projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
        workSignalStore: store,
        relayConfigs: checkoutRelayConfigs(),
        observer: {
          notificationRejected: (event) => rejected.push(event),
        },
      }),
    ).rejects.toThrow(ProjectionWakeRelayNotificationRejectedError);

    expect(rejected[0].reason).toContain("lastGlobalPosition must be >= firstGlobalPosition");
    expect(inputs).toEqual([]);
  });

  it("rejects breaking event-store wake schema versions before fan-out", async () => {
    const rejected: ProjectionWakeRelayNotificationRejectedEvent[] = [];
    const { store, inputs } = recordingWorkSignalStore();

    await expect(
      fanOutEventStoreWakeNotification({
        notification: JSON.stringify({
          ...checkoutWakeNotification(),
          schemaVersion: 2,
          payloadVersion: 1,
        }),
        projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
        workSignalStore: store,
        relayConfigs: checkoutRelayConfigs(),
        observer: {
          notificationRejected: (event) => rejected.push(event),
        },
      }),
    ).rejects.toThrow(ProjectionWakeRelayNotificationRejectedError);

    expect(rejected[0].reason).toContain("unsupported schemaVersion");
    expect(inputs).toEqual([]);
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

describe("projection wake relay active runtime", () => {
  it("catches up from durable source rows and advances the source cursor after fan-out", async () => {
    const abortController = new AbortController();
    const { store, inputs } = recordingWorkSignalStore();
    const controlPlane = recordingRelayControlPlane();
    const completed: ProjectionWakeRelaySourceCatchUpCompletedEvent[] = [];

    const result = await runProjectionWakeRelayActiveSession({
      workerId: "worker-a",
      controlPlane,
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      sources: [
        {
          sourceContextName: "checkout",
          eventStore: eventStoreWithRows([
            storedEvent({ position: "101", eventType: "CheckoutSessionCreated" }),
            storedEvent({ position: "102", eventType: "CheckoutSessionCreated" }),
          ]),
        },
      ],
      relayConfigs: checkoutRelayConfigs(),
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      signal: abortController.signal,
      observer: {
        sourceCatchUpCompleted: (event) => {
          completed.push(event);
          abortController.abort();
        },
      },
    });

    expect(result).toMatchObject({
      status: "stopped",
      sourceContextNames: ["checkout"],
      caughtUpEventCount: 2,
      cursorAdvanceCount: 1,
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      sourceContextName: "checkout",
      requiredPosition: "102",
      requiredCursor: "checkout:102",
      origin: "relay",
    });
    expect(controlPlane.advances).toMatchObject([
      {
        sourceContextName: "checkout",
        lastFanOutPosition: "102",
        lastRequiredCursor: "checkout:102",
        lease: expect.objectContaining({
          leaseName: "projection-wake-relay:active",
          ownerId: "worker-a",
          fencingToken: "1",
        }),
      },
    ]);
    expect(completed).toMatchObject([{ reason: "startup", eventCount: 2, cursorAdvanceCount: 1 }]);
    expect(completed[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(controlPlane.released).toBe(1);
  });

  it("does not advance the source cursor when durable fan-out fails", async () => {
    const { store } = recordingWorkSignalStore({ failOnEnqueue: true });
    const controlPlane = recordingRelayControlPlane();

    await expect(
      runProjectionWakeRelayActiveSession({
        workerId: "worker-a",
        controlPlane,
        projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
        workSignalStore: store,
        sources: [
          {
            sourceContextName: "checkout",
            eventStore: eventStoreWithRows([storedEvent({ position: "101", eventType: "CheckoutSessionCreated" })]),
          },
        ],
        relayConfigs: checkoutRelayConfigs(),
        leaseTtlMs: 30_000,
        leaseRenewIntervalMs: 10_000,
      }),
    ).rejects.toThrow("control-plane unavailable");

    expect(controlPlane.advances).toEqual([]);
    expect(controlPlane.released).toBe(1);
  });

  it("uses notifications as hints and serializes duplicate catch-up through the durable cursor", async () => {
    const abortController = new AbortController();
    const listener = new FakeRelayListenerClient();
    const events = eventStoreWithRows([]);
    const { store, inputs } = recordingWorkSignalStore();
    const controlPlane = recordingRelayControlPlane();
    const completed: ProjectionWakeRelaySourceCatchUpCompletedEvent[] = [];

    const resultPromise = runProjectionWakeRelayActiveSession({
      workerId: "worker-a",
      controlPlane,
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      sources: [
        {
          sourceContextName: "checkout",
          eventStore: events,
          listenerPool: listenerPoolFromClients([listener]),
        },
      ],
      relayConfigs: checkoutRelayConfigs(),
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      signal: abortController.signal,
      observer: {
        sourceCatchUpCompleted: (event) => {
          completed.push(event);
          if (event.reason === "startup") {
            events.rows.push(storedEvent({ position: "101", eventType: "CheckoutSessionCreated" }));
            listener.emit("platform_event_store_commits", "{}");
            listener.emit("platform_event_store_commits", "{}");
            return;
          }
          if (event.reason === "notification") {
            abortController.abort();
          }
        },
      },
    });

    const result = await resultPromise;

    expect(listener.queries).toContain("LISTEN platform_event_store_commits");
    expect(listener.queries).toContain("UNLISTEN platform_event_store_commits");
    expect(inputs).toHaveLength(1);
    expect(controlPlane.advances).toHaveLength(1);
    expect(controlPlane.advances[0]).toMatchObject({
      sourceContextName: "checkout",
      lastFanOutPosition: "101",
    });
    expect(completed.filter((event) => event.reason === "notification")).toHaveLength(2);
    expect(result).toMatchObject({
      status: "stopped",
      caughtUpEventCount: 1,
      cursorAdvanceCount: 1,
    });
  });

  it("keeps old and new live wake envelopes interoperable through durable catch-up during rolling deploy", async () => {
    const abortController = new AbortController();
    const listener = new FakeRelayListenerClient();
    const events = eventStoreWithRows([]);
    const { store, inputs } = recordingWorkSignalStore();
    const controlPlane = recordingRelayControlPlane();
    const completed: ProjectionWakeRelaySourceCatchUpCompletedEvent[] = [];

    const resultPromise = runProjectionWakeRelayActiveSession({
      workerId: "worker-a",
      controlPlane,
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      sources: [
        {
          sourceContextName: "checkout",
          eventStore: events,
          listenerPool: listenerPoolFromClients([listener]),
        },
      ],
      relayConfigs: checkoutRelayConfigs(),
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      signal: abortController.signal,
      observer: {
        sourceCatchUpCompleted: (event) => {
          completed.push(event);
          if (event.reason === "startup") {
            events.rows.push(storedEvent({ position: "101", eventType: "CheckoutSessionCreated" }));
            listener.emit("platform_event_store_commits", JSON.stringify(checkoutWakeNotification({ eventCount: 1 })));
            return;
          }
          if (completed.filter((entry) => entry.reason === "notification").length === 1) {
            events.rows.push(storedEvent({ position: "102", eventType: "CheckoutSessionCreated" }));
            listener.emit(
              "platform_event_store_commits",
              JSON.stringify({
                ...checkoutWakeNotification({
                  firstGlobalPosition: parseGlobalPosition("102"),
                  lastGlobalPosition: parseGlobalPosition("102"),
                  eventCount: 1,
                }),
                payloadVersion: 2,
                payload: {
                  ...checkoutWakeNotification({
                    firstGlobalPosition: parseGlobalPosition("102"),
                    lastGlobalPosition: parseGlobalPosition("102"),
                    eventCount: 1,
                  }).payload,
                  additiveRoutingHint: "safe-over-wake-only",
                },
              }),
            );
            return;
          }
          if (completed.filter((entry) => entry.reason === "notification").length === 2) {
            abortController.abort();
          }
        },
      },
    });

    const result = await resultPromise;

    expect(completed.map((event) => [event.reason, event.eventCount])).toEqual([
      ["startup", 0],
      ["notification", 1],
      ["notification", 1],
    ]);
    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => input.requiredCursor)).toEqual(["checkout:101", "checkout:102"]);
    expect(controlPlane.advances).toMatchObject([
      { sourceContextName: "checkout", lastFanOutPosition: "101" },
      { sourceContextName: "checkout", lastFanOutPosition: "102" },
    ]);
    expect(result).toMatchObject({ status: "stopped", caughtUpEventCount: 2, cursorAdvanceCount: 2 });
  });

  it("reconnects listener connections and catches up durable rows after reconnect", async () => {
    const abortController = new AbortController();
    const firstListener = new FakeRelayListenerClient();
    const secondListener = new FakeRelayListenerClient();
    const events = eventStoreWithRows([]);
    const { store, inputs } = recordingWorkSignalStore();
    const controlPlane = recordingRelayControlPlane();
    const connected: string[] = [];
    const completed: ProjectionWakeRelaySourceCatchUpCompletedEvent[] = [];

    const resultPromise = runProjectionWakeRelayActiveSession({
      workerId: "worker-a",
      controlPlane,
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      sources: [
        {
          sourceContextName: "checkout",
          eventStore: events,
          listenerPool: listenerPoolFromClients([firstListener, secondListener]),
        },
      ],
      relayConfigs: checkoutRelayConfigs(),
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      reconnectBackoffMs: 1,
      signal: abortController.signal,
      observer: {
        listenerConnected: (event) => {
          connected.push(event.sourceContextName);
          if (connected.length === 1) {
            firstListener.fail(new Error("connection lost"));
            return;
          }

          events.rows.push(storedEvent({ position: "101", eventType: "CheckoutSessionCreated" }));
        },
        sourceCatchUpCompleted: (event) => {
          completed.push(event);
          if (event.reason === "reconnect") {
            abortController.abort();
          }
        },
      },
    });

    const result = await resultPromise;

    expect(firstListener.queries).toContain("LISTEN platform_event_store_commits");
    expect(firstListener.queries).toContain("UNLISTEN platform_event_store_commits");
    expect(secondListener.queries).toContain("LISTEN platform_event_store_commits");
    expect(secondListener.queries).toContain("UNLISTEN platform_event_store_commits");
    expect(inputs).toHaveLength(1);
    expect(controlPlane.advances).toMatchObject([
      {
        sourceContextName: "checkout",
        lastFanOutPosition: "101",
      },
    ]);
    expect(completed.map((event) => event.reason)).toEqual(["startup", "reconnect"]);
    expect(result).toMatchObject({
      status: "stopped",
      caughtUpEventCount: 1,
      cursorAdvanceCount: 1,
    });
  });

  it("keeps the listener error handler attached until the listener client is released", async () => {
    const abortController = new AbortController();
    const listener = new FakeRelayListenerClient({ recordErrorListenerDuringUnlisten: true });
    const { store } = recordingWorkSignalStore();

    await runProjectionWakeRelayActiveSession({
      workerId: "worker-a",
      controlPlane: recordingRelayControlPlane(),
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      sources: [
        {
          sourceContextName: "checkout",
          eventStore: eventStoreWithRows([]),
          listenerPool: listenerPoolFromClients([listener]),
        },
      ],
      relayConfigs: checkoutRelayConfigs(),
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      signal: abortController.signal,
      observer: {
        sourceCatchUpCompleted: () => abortController.abort(),
      },
    });

    expect(listener.hadErrorListenerDuringUnlisten).toBe(true);
    expect(listener.isListening("error")).toBe(false);
  });

  it("continues durable startup catch-up when listener setup cleanup fails", async () => {
    const abortController = new AbortController();
    const listener = new FakeRelayListenerClient({ failListen: true, failUnlisten: true });
    const { store, inputs } = recordingWorkSignalStore();
    const controlPlane = recordingRelayControlPlane();
    const listenerFailures: unknown[] = [];

    const result = await runProjectionWakeRelayActiveSession({
      workerId: "worker-a",
      controlPlane,
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      sources: [
        {
          sourceContextName: "checkout",
          eventStore: eventStoreWithRows([storedEvent({ position: "101", eventType: "CheckoutSessionCreated" })]),
          listenerPool: listenerPoolFromClients([listener]),
        },
      ],
      relayConfigs: checkoutRelayConfigs(),
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      signal: abortController.signal,
      observer: {
        listenerUnavailable: (event) => listenerFailures.push(event.error),
        listenerDisconnected: (event) => {
          if (event.error) {
            listenerFailures.push(event.error);
          }
        },
        sourceCatchUpCompleted: () => abortController.abort(),
      },
    });

    expect(listener.queries).toEqual(["LISTEN platform_event_store_commits", "UNLISTEN platform_event_store_commits"]);
    expect(listener.released).toBe(true);
    expect(listenerFailures).toHaveLength(2);
    expect(inputs).toHaveLength(1);
    expect(controlPlane.advances).toMatchObject([
      {
        sourceContextName: "checkout",
        lastFanOutPosition: "101",
      },
    ]);
    expect(result).toMatchObject({
      status: "stopped",
      caughtUpEventCount: 1,
      cursorAdvanceCount: 1,
    });
  });

  it("replays durable rows as a coalescable duplicate after a crash between durable enqueue and cursor advance", async () => {
    const controlPlaneOptions = { rejectCursorAdvance: true };
    const controlPlane = recordingRelayControlPlane(controlPlaneOptions);
    const { store, inputs } = recordingWorkSignalStore();
    const events = eventStoreWithRows([storedEvent({ position: "101", eventType: "CheckoutSessionCreated" })]);
    const index = checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] });

    // Session 1: the durable enqueue succeeds, then the relay dies before the
    // source cursor is persisted.
    await expect(
      runProjectionWakeRelayActiveSession({
        workerId: "worker-a",
        controlPlane,
        projectionInterestIndex: index,
        workSignalStore: store,
        sources: [{ sourceContextName: "checkout", eventStore: events }],
        relayConfigs: checkoutRelayConfigs(),
        leaseTtlMs: 30_000,
        leaseRenewIntervalMs: 10_000,
      }),
    ).rejects.toThrow("cursor advance was rejected");

    expect(inputs).toHaveLength(1);
    expect(controlPlane.advances).toEqual([]);

    // Session 2 (restart): catch-up replays from the unadvanced cursor. The
    // same durable rows fan out again so nothing is lost, and the duplicate
    // enqueue lands on the identical coalescing identity so the durable store
    // coalesces it instead of duplicating work.
    controlPlaneOptions.rejectCursorAdvance = false;
    const abortController = new AbortController();
    const result = await runProjectionWakeRelayActiveSession({
      workerId: "worker-a",
      controlPlane,
      projectionInterestIndex: index,
      workSignalStore: store,
      sources: [{ sourceContextName: "checkout", eventStore: events }],
      relayConfigs: checkoutRelayConfigs(),
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      signal: abortController.signal,
      observer: {
        sourceCatchUpCompleted: () => abortController.abort(),
      },
    });

    expect(result).toMatchObject({ status: "stopped", caughtUpEventCount: 1, cursorAdvanceCount: 1 });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({
      checkpointKey: inputs[0].checkpointKey,
      requiredPosition: inputs[0].requiredPosition,
      requiredCursor: inputs[0].requiredCursor,
    });
    expect(
      createProjectionWakeIntentCoalescingKey({
        sourceContextName: inputs[1].sourceContextName,
        targetContextName: inputs[1].targetContextName,
        projectionName: inputs[1].projectionName,
        checkpointKey: inputs[1].checkpointKey,
        priorityLane: inputs[1].priorityLane ?? "standard",
      }),
    ).toBe(
      createProjectionWakeIntentCoalescingKey({
        sourceContextName: inputs[0].sourceContextName,
        targetContextName: inputs[0].targetContextName,
        projectionName: inputs[0].projectionName,
        checkpointKey: inputs[0].checkpointKey,
        priorityLane: inputs[0].priorityLane ?? "standard",
      }),
    );
    expect(controlPlane.advances).toMatchObject([{ sourceContextName: "checkout", lastFanOutPosition: "101" }]);
  });

  it("treats stale out-of-order notifications as no-ops once the cursor has advanced past their positions", async () => {
    const abortController = new AbortController();
    const listener = new FakeRelayListenerClient();
    const events = eventStoreWithRows([
      storedEvent({ position: "101", eventType: "CheckoutSessionCreated" }),
      storedEvent({ position: "102", eventType: "CheckoutSessionCreated" }),
    ]);
    const { store, inputs } = recordingWorkSignalStore();
    const controlPlane = recordingRelayControlPlane();
    const completed: ProjectionWakeRelaySourceCatchUpCompletedEvent[] = [];

    const result = await runProjectionWakeRelayActiveSession({
      workerId: "worker-a",
      controlPlane,
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      sources: [
        {
          sourceContextName: "checkout",
          eventStore: events,
          listenerPool: listenerPoolFromClients([listener]),
        },
      ],
      relayConfigs: checkoutRelayConfigs(),
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      signal: abortController.signal,
      observer: {
        sourceCatchUpCompleted: (event) => {
          completed.push(event);
          if (event.reason === "startup") {
            // A delayed notification referencing positions the cursor already
            // passed arrives after newer positions were fanned out.
            listener.emit(
              "platform_event_store_commits",
              JSON.stringify(
                checkoutWakeNotification({
                  firstGlobalPosition: parseGlobalPosition("101"),
                  lastGlobalPosition: parseGlobalPosition("101"),
                  eventCount: 1,
                }),
              ),
            );
            return;
          }
          abortController.abort();
        },
      },
    });

    expect(completed.map((event) => [event.reason, event.eventCount])).toEqual([
      ["startup", 2],
      ["notification", 0],
    ]);
    expect(inputs).toHaveLength(1);
    expect(controlPlane.advances).toMatchObject([{ sourceContextName: "checkout", lastFanOutPosition: "102" }]);
    expect(result).toMatchObject({ status: "stopped", caughtUpEventCount: 2, cursorAdvanceCount: 1 });
  });

  it("performs no listener, fan-out, or cursor work when the active lease is held by another relay", async () => {
    const listener = new FakeRelayListenerClient();
    const { store, inputs } = recordingWorkSignalStore();
    const controlPlane = recordingRelayControlPlane({ missLease: true });
    const missed: ProjectionWakeRelayLeaseEvent[] = [];

    const result = await runProjectionWakeRelayActiveSession({
      workerId: "worker-b",
      controlPlane,
      projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
      workSignalStore: store,
      sources: [
        {
          sourceContextName: "checkout",
          eventStore: eventStoreWithRows([storedEvent({ position: "101", eventType: "CheckoutSessionCreated" })]),
          listenerPool: listenerPoolFromClients([listener]),
        },
      ],
      relayConfigs: checkoutRelayConfigs(),
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      observer: {
        leaseMissed: (event) => missed.push(event),
      },
    });

    expect(result).toMatchObject({
      status: "lease-missed",
      caughtUpEventCount: 0,
      cursorAdvanceCount: 0,
    });
    expect(missed).toMatchObject([{ leaseName: "projection-wake-relay:active", workerId: "worker-b" }]);
    expect(inputs).toEqual([]);
    expect(listener.queries).toEqual([]);
    expect(controlPlane.advances).toEqual([]);
    expect(controlPlane.released).toBe(0);
  });

  it("fails closed when cursor advancement is rejected by lease fencing", async () => {
    const { store } = recordingWorkSignalStore();
    const controlPlane = recordingRelayControlPlane({ rejectCursorAdvance: true });

    await expect(
      runProjectionWakeRelayActiveSession({
        workerId: "worker-a",
        controlPlane,
        projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
        workSignalStore: store,
        sources: [
          {
            sourceContextName: "checkout",
            eventStore: eventStoreWithRows([storedEvent({ position: "101", eventType: "CheckoutSessionCreated" })]),
          },
        ],
        relayConfigs: checkoutRelayConfigs(),
        leaseTtlMs: 30_000,
        leaseRenewIntervalMs: 10_000,
      }),
    ).rejects.toThrow("cursor advance was rejected");
  });

  it("does not acquire the active lease when no enabled source runtime is configured", async () => {
    const controlPlane = recordingRelayControlPlane();

    await expect(
      runProjectionWakeRelayActiveSession({
        workerId: "worker-a",
        controlPlane,
        projectionInterestIndex: checkoutProjectionIndex({ eventTypes: ["CheckoutSessionCreated"] }),
        workSignalStore: recordingWorkSignalStore().store,
        sources: [],
        relayConfigs: checkoutRelayConfigs(),
        leaseTtlMs: 30_000,
        leaseRenewIntervalMs: 10_000,
      }),
    ).resolves.toMatchObject({
      status: "no-enabled-sources",
      sourceContextNames: [],
    });
    expect(controlPlane.acquired).toBe(0);
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

function createProjectionWakeIntentCoalescingKey(input: {
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  checkpointKey: string;
  priorityLane: WorkSignalPriorityLane;
}): string {
  return [
    "projection-wake",
    input.sourceContextName,
    input.targetContextName,
    input.projectionName,
    input.checkpointKey,
    input.priorityLane,
  ].join(":");
}

function recordingRelayControlPlane(options: { rejectCursorAdvance?: boolean; missLease?: boolean } = {}) {
  const lease = {
    leaseName: "projection-wake-relay:active",
    ownerId: "worker-a",
    fencingToken: "1",
    expiresAt: "2026-06-10T12:01:00.000Z",
  };
  const cursors = new Map<string, { lastFanOutPosition: bigint; lastRequiredCursor: string | null }>();
  const advances: Array<{
    sourceContextName: string;
    lastFanOutPosition: string;
    lastRequiredCursor: string | null;
    lease: typeof lease;
  }> = [];

  const controlPlane = {
    advances,
    acquired: 0,
    released: 0,
    acquireLease: async () => {
      if (options.missLease) {
        return null;
      }

      controlPlane.acquired += 1;
      return lease;
    },
    renewLease: async () => true,
    releaseLease: async () => {
      controlPlane.released += 1;
    },
    getProjectionWakeRelayCursor: async (sourceContextName: string) => {
      const cursor = cursors.get(sourceContextName);
      return cursor
        ? {
            sourceContextName,
            lastFanOutPosition: cursor.lastFanOutPosition,
            lastRequiredCursor: cursor.lastRequiredCursor,
            ownerId: lease.ownerId,
            fencingToken: lease.fencingToken,
            metadata: {},
            updatedAt: "2026-06-10T12:00:00.000Z",
          }
        : null;
    },
    advanceProjectionWakeRelayCursor: async (input: {
      sourceContextName: string;
      lastFanOutPosition: bigint | number | string;
      lastRequiredCursor?: string | null;
      lease: typeof lease;
    }) => {
      if (options.rejectCursorAdvance) {
        return null;
      }

      const nextPosition = BigInt(input.lastFanOutPosition);
      const existing = cursors.get(input.sourceContextName);
      const currentPosition = existing?.lastFanOutPosition ?? 0n;
      if (nextPosition > currentPosition) {
        cursors.set(input.sourceContextName, {
          lastFanOutPosition: nextPosition,
          lastRequiredCursor: input.lastRequiredCursor ?? null,
        });
        advances.push({
          sourceContextName: input.sourceContextName,
          lastFanOutPosition: nextPosition.toString(),
          lastRequiredCursor: input.lastRequiredCursor ?? null,
          lease: input.lease,
        });
      }

      return {
        sourceContextName: input.sourceContextName,
        lastFanOutPosition: cursors.get(input.sourceContextName)?.lastFanOutPosition ?? currentPosition,
        lastRequiredCursor:
          cursors.get(input.sourceContextName)?.lastRequiredCursor ?? existing?.lastRequiredCursor ?? null,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        metadata: {},
        updatedAt: "2026-06-10T12:00:00.000Z",
      };
    },
  };

  return controlPlane;
}

function eventStoreWithRows(rows: ReturnType<typeof storedEvent>[]) {
  return {
    rows,
    readAll: async (input?: {
      afterGlobalPosition?: ReturnType<typeof parseGlobalPosition>;
      streamPrefixes?: readonly string[];
      limit?: number;
    }) => {
      const after = BigInt(input?.afterGlobalPosition ?? "0");
      const prefixes = input?.streamPrefixes ?? [];
      const limit = input?.limit ?? 500;

      return rows
        .filter((event) => BigInt(event.globalPosition) > after)
        .filter((event) => prefixes.length === 0 || prefixes.some((prefix) => event.streamId.startsWith(prefix)))
        .slice(0, limit);
    },
  };
}

function storedEvent(input: { position: string; eventType: string }) {
  return {
    eventId: `evt_${input.position}` as never,
    streamId: `checkout.session-${input.position}`,
    streamVersion: Number(input.position),
    globalPosition: parseGlobalPosition(input.position),
    tenantId: "tnt_test" as never,
    eventType: input.eventType,
    payload: {},
    metadata: {},
    occurredAt: parseIsoUtcTimestamp("2026-06-10T12:00:00.000Z"),
    recordedAt: parseIsoUtcTimestamp("2026-06-10T12:00:00.000Z"),
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
    traceId: "trace_checkout_1" as never,
  };
}

class FakeRelayListenerClient {
  readonly queries: string[] = [];
  private readonly listeners = new Map<string, Set<(message?: unknown) => void>>();
  released = false;
  hadErrorListenerDuringUnlisten = false;

  constructor(
    private readonly options: Readonly<{
      failListen?: boolean;
      failUnlisten?: boolean;
      recordErrorListenerDuringUnlisten?: boolean;
    }> = {},
  ) {}

  async query(sql: string) {
    this.queries.push(sql);
    if (this.options.recordErrorListenerDuringUnlisten && sql.startsWith("UNLISTEN ")) {
      this.hadErrorListenerDuringUnlisten = this.isListening("error");
    }
    if (this.options.failListen && sql.startsWith("LISTEN ")) {
      throw new Error("LISTEN failed");
    }
    if (this.options.failUnlisten && sql.startsWith("UNLISTEN ")) {
      throw new Error("UNLISTEN failed");
    }

    return { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }

  on(event: "notification" | "error", listener: (message?: unknown) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: "notification" | "error", listener: (message?: unknown) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  isListening(event: "notification" | "error") {
    return (this.listeners.get(event)?.size ?? 0) > 0;
  }

  emit(channel: string, payload: string) {
    for (const listener of this.listeners.get("notification") ?? []) {
      listener({ channel, payload });
    }
  }

  fail(error: unknown) {
    for (const listener of this.listeners.get("error") ?? []) {
      listener(error);
    }
  }
}

function listenerPoolFromClients(clients: FakeRelayListenerClient[]) {
  return {
    connect: async () => {
      const client = clients.shift();
      if (!client) {
        throw new Error("No fake listener client available.");
      }

      return client;
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
