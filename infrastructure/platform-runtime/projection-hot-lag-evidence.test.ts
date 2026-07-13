import { describe, expect, it } from "vitest";
import { attributeProjectionHotLag, PROJECTION_HOT_LAG_EVIDENCE_VERSION } from "./projection-hot-lag-evidence";

describe("attributeProjectionHotLag", () => {
  it("attributes hot lag to database pool pressure before runner queue symptoms", () => {
    const evidence = attributeProjectionHotLag({
      checkedAt: "2026-06-24T12:00:00.000Z",
      workerStatus: workerStatus({
        databasePoolPressure: {
          databasePoolMax: 7,
          waitingClients: 2,
          waitingPoolCount: 1,
          saturatedPoolCount: 1,
        },
        projectionWakeIntentBreakdown: [
          hotBreakdown({ state: "queued", intentCount: 5, oldestCreatedAt: "2026-06-24T11:59:30.000Z" }),
        ],
        loops: [loop({ name: "wakes", activeRunnerCount: 2, maxConcurrentRunners: 2 })],
      }),
    });

    expect(evidence.schemaVersion).toBe(PROJECTION_HOT_LAG_EVIDENCE_VERSION);
    expect(evidence.attribution.primaryCause).toBe("database-pool-pressure");
    expect(evidence.attribution.confidence).toBe("high");
    expect(evidence.signals.hotLane.hotQueuedIntentCount).toBe(5);
    expect(evidence.signals.hotLane.oldestHotQueuedAgeMs).toBe(30_000);
  });

  it("attributes retrying hot wakes to projection-group lease contention when outcome evidence is supplied", () => {
    const evidence = attributeProjectionHotLag({
      checkedAt: "2026-06-24T12:00:00.000Z",
      workerStatus: workerStatus({
        projectionWakeIntentBreakdown: [hotBreakdown({ state: "failed", intentCount: 2, maxAttemptCount: 3 })],
      }),
      wakeOutcomes: [{ priorityLane: "hot", origin: "api-wait", outcome: "deferred", count: 2 }],
    });

    expect(evidence.attribution.primaryCause).toBe("projection-group-lease-contention");
    expect(evidence.signals.projectionGroupLeaseContention).toMatchObject({
      contentionEventCount: 2,
      hotIntentFailedCount: 2,
      hasContention: true,
    });
  });

  it("attributes lease contention live from a runner last_error even without wake-outcome evidence", () => {
    const evidence = attributeProjectionHotLag({
      checkedAt: "2026-06-24T12:00:00.000Z",
      workerStatus: workerStatus({
        runners: [{ last_error: "projection-group-lease-busy: checkout.session-projection" }],
      }),
    });

    expect(evidence.attribution.primaryCause).toBe("projection-group-lease-contention");
  });

  it("attributes queued hot api-wait work to hot-lane queueing when the reserved slot is occupied", () => {
    const evidence = attributeProjectionHotLag({
      checkedAt: "2026-06-24T12:00:00.000Z",
      workerStatus: workerStatus({
        projectionWakeIntentBreakdown: [
          hotBreakdown({
            origin: "api-wait",
            state: "queued",
            intentCount: 3,
            oldestCreatedAt: "2026-06-24T11:59:50.000Z",
          }),
        ],
        loops: [
          loop({
            name: "wakes",
            activeRunnerCount: 2,
            maxConcurrentRunners: 2,
            activeReservedSlotCount: 1,
            reservedRunnerSlots: 1,
          }),
        ],
      }),
    });

    expect(evidence.attribution.primaryCause).toBe("hot-lane-queueing");
    expect(evidence.signals.hotLane.hotApiWaitQueuedIntentCount).toBe(3);
  });

  it("reports projection repair before capacity tuning when blocked streams are present live", () => {
    const evidence = attributeProjectionHotLag({
      checkedAt: "2026-06-24T12:00:00.000Z",
      workerStatus: workerStatus(),
      projectionStatus: [
        {
          projectionName: "checkout.session-projection",
          subscriptions: [{ blockedStreamCount: 1, poisonEventCount: 0 }],
        },
      ],
    });

    expect(evidence.attribution.primaryCause).toBe("projection-repair-needed");
    expect(evidence.signals.projectionRepair.blockedStreamSignalCount).toBe(1);
  });

  it("reports worker-absent-or-stale when no worker heartbeat is active", () => {
    const evidence = attributeProjectionHotLag({
      checkedAt: "2026-06-24T12:00:00.000Z",
      workerStatus: workerStatus({ workers: [{ workerState: "stale" }] }),
    });

    expect(evidence.attribution.primaryCause).toBe("worker-absent-or-stale");
    expect(evidence.attribution.confidence).toBe("high");
  });

  it("reports no-hot-lag-evidence when nothing is queued or degraded", () => {
    const evidence = attributeProjectionHotLag({
      checkedAt: "2026-06-24T12:00:00.000Z",
      workerStatus: workerStatus({
        databasePoolPressure: { waitingClients: 0, waitingPoolCount: 0, saturatedPoolCount: 0 },
      }),
    });

    expect(evidence.attribution.primaryCause).toBe("no-hot-lag-evidence");
    expect(evidence.attribution.status).toBe("not-observed");
  });

  it("defaults checkedAt to now when omitted", () => {
    const before = Date.now();
    const evidence = attributeProjectionHotLag({ workerStatus: workerStatus() });
    const after = Date.now();

    const checkedAtMs = Date.parse(evidence.checkedAt);
    expect(checkedAtMs).toBeGreaterThanOrEqual(before);
    expect(checkedAtMs).toBeLessThanOrEqual(after);
  });
});

function workerStatus(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    databasePoolPressure: {
      databasePoolMax: 7,
      waitingClients: 0,
      waitingPoolCount: 0,
      saturatedPoolCount: 0,
    },
    projectionWakeControls: {
      schedulerEnabled: true,
      laneRunnerCounts: { hot: 1, standard: 1, bulk: 1 },
      hotLaneReservedRunnerSlots: 1,
    },
    projectionWakeIntents: {
      queuedCount: 0,
      failedCount: 0,
    },
    projectionWakeIntentBreakdown: [],
    loops: [
      loop({
        name: "wakes",
        activeRunnerCount: 0,
        maxConcurrentRunners: 2,
        activeReservedSlotCount: 0,
        reservedRunnerSlots: 1,
      }),
      loop({ name: "jobs", activeRunnerCount: 0, maxConcurrentRunners: 1 }),
    ],
    workers: [{ workerState: "active" }],
    runners: [],
    ...overrides,
  };
}

function hotBreakdown(overrides: Record<string, unknown> = {}) {
  return {
    priorityLane: "hot",
    origin: "relay",
    state: "queued",
    intentCount: 1,
    oldestCreatedAt: "2026-06-24T11:59:55.000Z",
    maxAttemptCount: 0,
    ...overrides,
  };
}

function loop(overrides: Record<string, unknown> = {}) {
  return {
    name: "wakes",
    activeRunnerCount: 0,
    maxConcurrentRunners: 2,
    activeReservedSlotCount: 0,
    reservedRunnerSlots: 0,
    leaseMissCount: 0,
    ...overrides,
  };
}
