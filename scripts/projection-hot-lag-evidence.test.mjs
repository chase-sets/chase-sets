import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectionHotLagEvidence,
  PROJECTION_HOT_LAG_EVIDENCE_VERSION,
  renderProjectionHotLagMarkdown,
} from "./projection-hot-lag-evidence.mjs";

describe("projection hot lag evidence", () => {
  it("attributes hot lag to database pool pressure before runner queue symptoms", () => {
    const evidence = buildProjectionHotLagEvidence({
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
    const evidence = buildProjectionHotLagEvidence({
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

  it("attributes queued hot api-wait work to hot-lane queueing when the reserved slot is occupied", () => {
    const evidence = buildProjectionHotLagEvidence({
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

  it("uses wake-drill aggregate signals for heartbeat counts, pool-counter availability, and queued age", () => {
    const evidence = buildProjectionHotLagEvidence({
      checkedAt: "2026-06-24T12:00:00.000Z",
      workerStatus: workerStatus({
        databasePoolPressure: {
          databasePoolMax: 7,
          poolCount: 1,
          totalClients: null,
          activeClients: null,
          idleClients: null,
          waitingClients: null,
          waitingPoolCount: null,
          saturatedPoolCount: null,
          counterAvailability: {
            status: "unavailable",
            unavailableCounters: [
              "totalClients",
              "activeClients",
              "idleClients",
              "waitingClients",
              "waitingPoolCount",
              "saturatedPoolCount",
            ],
            unavailableReason: "node-postgres-pool-counters-unavailable-or-not-exposed",
          },
        },
        projectionWakeIntentBreakdown: [
          hotBreakdown({
            state: "queued",
            intentCount: 2,
            oldestAgeMs: 45_000,
            oldestCreatedAt: undefined,
          }),
        ],
        workers: [],
        workerHeartbeatSummary: {
          workerCount: 2,
          activeWorkerCount: 2,
          staleOrExpiredWorkerCount: 0,
        },
      }),
    });

    expect(evidence.signals.workerHeartbeats).toEqual({
      workerCount: 2,
      activeWorkerCount: 2,
      staleOrExpiredWorkerCount: 0,
    });
    expect(evidence.signals.databasePool.counterAvailability).toMatchObject({
      status: "unavailable",
      unavailableReason: "node-postgres-pool-counters-unavailable-or-not-exposed",
    });
    expect(evidence.signals.hotLane.oldestHotQueuedAgeMs).toBe(45_000);
    expect(evidence.attribution.reasons).toContain(
      "Database pool pressure counters were unavailable: node-postgres-pool-counters-unavailable-or-not-exposed.",
    );
  });

  it("reports projection repair before capacity tuning when blocked streams are present", () => {
    const evidence = buildProjectionHotLagEvidence({
      checkedAt: "2026-06-24T12:00:00.000Z",
      workerStatus: workerStatus(),
      projectionStatus: {
        projectionGroups: [
          {
            projectionName: "checkout.session-projection",
            subscriptions: [{ blockedStreamCount: 1, poisonEventCount: 0 }],
          },
        ],
      },
    });

    expect(evidence.attribution.primaryCause).toBe("projection-repair-needed");
    expect(evidence.signals.projectionRepair.blockedStreamSignalCount).toBe(1);
  });

  it("summarizes background workload control posture without echoing private details", () => {
    const evidence = buildProjectionHotLagEvidence({
      checkedAt: "2026-06-24T12:00:00.000Z",
      workerStatus: workerStatus(),
      backgroundControls: {
        workloads: [
          backgroundControl("representative commerce refresh"),
          backgroundControl("projection replay/rebuild/backfill", {
            pauseThrottleEvidence: "private operation op_private_123 was cancelled",
          }),
          backgroundControl("provider import/promotion and bulk authoring"),
          backgroundControl("scheduled/dispatch/provider-delivery loops"),
        ],
      },
    });
    const serialized = JSON.stringify(evidence);

    expect(evidence.signals.backgroundControls).toEqual({
      status: "pass",
      workloadCount: 4,
      coveredWorkloads: [
        "representative-commerce-refresh",
        "projection-replay-rebuild-backfill",
        "provider-import-promotion-bulk-authoring",
        "scheduled-dispatch-provider-delivery",
      ],
      missingWorkloads: [],
      incompleteWorkloads: [],
    });
    expect(serialized).not.toContain("op_private_123");
  });

  it("marks background workload controls incomplete when matrix rows are missing", () => {
    const evidence = buildProjectionHotLagEvidence({
      checkedAt: "2026-06-24T12:00:00.000Z",
      workerStatus: workerStatus(),
      backgroundControls: {
        workloads: [
          {
            workload: "representative commerce refresh",
            normalControl: "bounded workflow dispatch",
            hotPathProof: "representative-volume load run",
          },
        ],
      },
    });

    expect(evidence.signals.backgroundControls).toMatchObject({
      status: "incomplete",
      workloadCount: 1,
      coveredWorkloads: [],
      missingWorkloads: [
        "projection-replay-rebuild-backfill",
        "provider-import-promotion-bulk-authoring",
        "scheduled-dispatch-provider-delivery",
      ],
      incompleteWorkloads: [
        {
          workload: "representative-commerce-refresh",
          missingFields: ["pauseThrottleEvidence"],
        },
      ],
    });
  });

  it("writes a redacted JSON evidence record from the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "projection-hot-lag-"));
    const workerStatusPath = join(dir, "worker-status.json");
    const outPath = join(dir, "evidence.json");
    writeFileSync(
      workerStatusPath,
      JSON.stringify(
        workerStatus({
          projectionWakeIntentBreakdown: [hotBreakdown({ state: "queued", intentCount: 1 })],
        }),
      ),
    );

    execFileSync(
      process.execPath,
      [
        "./scripts/projection-hot-lag-evidence.mjs",
        "--checked-at",
        "2026-06-24T12:00:00.000Z",
        "--worker-status",
        workerStatusPath,
        "--out",
        outPath,
      ],
      { stdio: "pipe" },
    );

    const evidence = JSON.parse(readFileSync(outPath, "utf8"));
    expect(evidence.redaction).toEqual({
      secrets: "not-read",
      databaseUrls: "not-read",
      liveEnvironmentAccess: "not-used",
      wakePayloads: "not-read",
    });
    expect(evidence.attribution.primaryCause).toBe("hot-lane-queueing");
  });

  it("renders concise markdown for operator handoff", () => {
    const markdown = renderProjectionHotLagMarkdown(
      buildProjectionHotLagEvidence({
        checkedAt: "2026-06-24T12:00:00.000Z",
        workerStatus: workerStatus({
          databasePoolPressure: { waitingClients: 0, waitingPoolCount: 0, saturatedPoolCount: 0 },
        }),
      }),
    );

    expect(markdown).toContain("Primary cause: **no-hot-lag-evidence**");
    expect(markdown).toContain("DB waiting clients: 0");
  });
});

function workerStatus(overrides = {}) {
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

function hotBreakdown(overrides = {}) {
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

function loop(overrides = {}) {
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

function backgroundControl(workload, overrides = {}) {
  return {
    workload,
    normalControl: "operator-owned bounded control",
    pauseThrottleEvidence: "completed before the hot-path proof window",
    hotPathProof: "paired representative-volume wake load and reconciliation artifacts",
    ...overrides,
  };
}
