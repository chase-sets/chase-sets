import { describe, expect, it } from "vitest";
import { buildWakeAttentionItems, normalizeWakeStatusSnapshot } from "./wake-status-contracts";

describe("wake status contracts", () => {
  it("normalizes a full wake status payload into structural fields", () => {
    const snapshot = normalizeWakeStatusSnapshot({
      generatedAt: "2026-06-11T12:00:00.000Z",
      wakeStore: {
        available: true,
        intentSummary: {
          queuedCount: 3,
          claimedCount: 1,
          failedCount: 2,
          expiredCount: 4,
          staleClaimCount: 1,
          oldestQueuedAt: "2026-06-11T11:58:00.000Z",
          oldestQueuedAgeMs: 120000,
          oldestClaimedAt: null,
        },
        intentBreakdown: [
          {
            priorityLane: "hot",
            origin: "api-wait",
            state: "queued",
            sourceContextName: "catalog",
            targetContextName: "checkout",
            projectionName: "checkout-session-projection",
            checkpointKey: "checkout.checkout-session-projection:catalog",
            intentCount: 3,
            oldestCreatedAt: "2026-06-11T11:58:00.000Z",
            oldestAgeMs: 120000,
            maxAttemptCount: 0,
          },
        ],
        checkpointSignals: {
          readinessCount: 5,
          expiredReadinessCount: 1,
          latestReadyRecordedAt: "2026-06-11T11:59:45.000Z",
          latestReadyAgeMs: 15000,
          pendingWaiterCount: 2,
          expiredPendingWaiterCount: 1,
          satisfiedWaiterCount: 9,
          oldestPendingWaiterAt: "2026-06-11T11:57:00.000Z",
          oldestPendingWaiterAgeMs: 180000,
          pendingWaiterOrigins: [{ origin: "api-wait", waiterCount: 2 }],
        },
      },
      relay: {
        available: true,
        activeLeaseName: "projection-wake-relay:active",
        lease: {
          ownerId: "platform-worker-1",
          fencingToken: "12",
          acquiredAt: "2026-06-11T11:50:00.000Z",
          renewedAt: "2026-06-11T11:59:00.000Z",
          expiresAt: "2026-06-11T12:01:00.000Z",
          state: "active",
        },
        cursors: [
          {
            sourceContextName: "checkout",
            lastFanOutPosition: "102",
            lastRequiredCursor: "checkout:102",
            ownerId: "platform-worker-1",
            fencingToken: "12",
            updatedAt: "2026-06-11T11:59:30.000Z",
            updatedAgeMs: 30000,
            interestIndexVersion: "v3",
            lastAdvanceReason: "notify",
            lastStreamCategory: "checkout-session",
          },
        ],
      },
      schedulers: {
        available: true,
        wakeCapableWorkerCount: 1,
        activeWakeCapableWorkerCount: 1,
        workers: [
          {
            workerId: "platform-worker-1",
            workerKind: "platform-worker",
            workerState: "active",
            heartbeatAt: "2026-06-11T11:59:55.000Z",
            heartbeatAgeMs: 5000,
            wakeRunnerCount: 3,
            wakeMaxConcurrentRunners: 3,
          },
        ],
      },
      rollout: {
        eventStoreWakeEmissionEnabledOnHost: true,
        summary: {
          entryCount: 18,
          activeEntryCount: 4,
          enabledEventStoreWakeContextCount: 4,
          enabledRelayFanOutContextCount: 4,
        },
        sources: [
          {
            sourceContextName: "checkout",
            rolloutState: "staging-enabled",
            phase: "phase-1-hot-path",
            rolloutWave: "wave-1-hot-path",
            priorityLane: "hot",
            eventStoreWakeNotificationsEnabled: true,
            relayFanOutEnabled: true,
            affectedProjectionNames: ["checkout:checkout.checkout-session-projection"],
            disabledReason: null,
            optOutReason: null,
          },
        ],
      },
      migration: {
        summary: {
          projectionCount: 58,
          statusCounts: [
            { status: "push-enabled", count: 20 },
            { status: "push-eligible", count: 38 },
            { status: "disabled", count: 0 },
            { status: "opted-out", count: 0 },
          ],
          optOutCount: 0,
          routeDependencyCount: 18,
          pushEnabledRouteDependencyCount: 12,
        },
        projections: [
          {
            projectionKey: "checkout:checkout.session-projection",
            targetContextName: "checkout",
            projectionName: "checkout.session-projection",
            owner: "Checkout",
            status: "push-enabled",
            sourceContextCount: 1,
            enabledSourceContextCount: 1,
            sourceContextNames: ["checkout"],
            consumesDurableWakeIntents: true,
            optOutReason: null,
            optOutReviewBy: null,
          },
        ],
      },
    });

    expect(snapshot.wakeStore.intentSummary.queuedCount).toBe(3);
    expect(snapshot.wakeStore.intentBreakdown[0]).toMatchObject({
      priorityLane: "hot",
      origin: "api-wait",
      state: "queued",
      sourceContextName: "catalog",
      targetContextName: "checkout",
      projectionName: "checkout-session-projection",
      checkpointKey: "checkout.checkout-session-projection:catalog",
      intentCount: 3,
    });
    expect(snapshot.relay.lease).toMatchObject({ ownerId: "platform-worker-1", state: "active" });
    expect(snapshot.relay.cursors[0]).toMatchObject({
      sourceContextName: "checkout",
      lastFanOutPosition: "102",
      interestIndexVersion: "v3",
    });
    expect(snapshot.schedulers.workers[0]).toMatchObject({ workerId: "platform-worker-1", wakeRunnerCount: 3 });
    expect(snapshot.rollout.sources[0]).toMatchObject({
      sourceContextName: "checkout",
      rolloutState: "staging-enabled",
      relayFanOutEnabled: true,
    });
    expect(snapshot.migration.summary).toMatchObject({
      projectionCount: 58,
      optOutCount: 0,
      routeDependencyCount: 18,
      pushEnabledRouteDependencyCount: 12,
    });
    expect(snapshot.migration.projections[0]).toMatchObject({
      projectionKey: "checkout:checkout.session-projection",
      owner: "Checkout",
      status: "push-enabled",
      enabledSourceContextCount: 1,
      sourceContextNames: ["checkout"],
      consumesDurableWakeIntents: true,
    });
  });

  it("normalizes malformed payloads to unavailable sections", () => {
    const snapshot = normalizeWakeStatusSnapshot({ wakeStore: "nope", relay: null });

    expect(snapshot.wakeStore.available).toBe(false);
    expect(snapshot.relay.available).toBe(false);
    expect(snapshot.schedulers.available).toBe(false);
    expect(snapshot.rollout.sources).toEqual([]);
    expect(snapshot.migration.projections).toEqual([]);
    expect(snapshot.migration.summary.projectionCount).toBe(0);
  });

  it("builds wake attention items for failed intents, stale claims, and expired signals", () => {
    const snapshot = normalizeWakeStatusSnapshot({
      wakeStore: {
        available: true,
        intentSummary: {
          queuedCount: 0,
          claimedCount: 0,
          failedCount: 2,
          expiredCount: 5,
          staleClaimCount: 1,
        },
        checkpointSignals: { expiredPendingWaiterCount: 3 },
      },
      relay: {
        available: true,
        lease: { ownerId: "platform-worker-1", fencingToken: "12", state: "expired" },
        cursors: [],
      },
    });

    const items = buildWakeAttentionItems(snapshot);
    const ids = items.map((item) => item.id);

    expect(ids).toContain("wake-failed-intents");
    expect(ids).toContain("wake-stale-claims");
    expect(ids).toContain("wake-expired-intents");
    expect(ids).toContain("wake-expired-waiters");
    expect(ids).toContain("wake-relay-lease-expired");
    expect(items.every((item) => item.targetTab === "wake")).toBe(true);
  });

  it("reports a missing relay lease as informational only when fan-out sources are enabled", () => {
    const withEnabledSources = normalizeWakeStatusSnapshot({
      wakeStore: { available: true, intentSummary: {}, checkpointSignals: {} },
      relay: { available: true, lease: null, cursors: [] },
      rollout: { summary: { enabledRelayFanOutContextCount: 4 } },
    });
    const withoutEnabledSources = normalizeWakeStatusSnapshot({
      wakeStore: { available: true, intentSummary: {}, checkpointSignals: {} },
      relay: { available: true, lease: null, cursors: [] },
      rollout: { summary: { enabledRelayFanOutContextCount: 0 } },
    });

    const enabledItems = buildWakeAttentionItems(withEnabledSources);
    expect(enabledItems.map((item) => item.id)).toContain("wake-relay-lease-missing");
    expect(enabledItems.find((item) => item.id === "wake-relay-lease-missing")?.tone).toBe("accent");
    expect(buildWakeAttentionItems(withoutEnabledSources)).toEqual([]);
  });

  it("returns no attention items for a null snapshot", () => {
    expect(buildWakeAttentionItems(null)).toEqual([]);
  });
});
