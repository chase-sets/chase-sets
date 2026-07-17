import { describe, expect, it } from "vitest";
import {
  buildAttentionItems,
  buildProjectionRepairQueue,
  buildProjectionSubscriptionRows,
  normalizeProjectionOperationsSnapshot,
  resolveProjectionOperatorState,
  stateSeverity,
} from "./contracts";

describe("projection operation view models", () => {
  it("defaults missing optional collections so the operations page can render partial snapshots", () => {
    const snapshot = normalizeProjectionOperationsSnapshot({
      summary: {
        status: "ok",
        totalGroups: 1,
      },
      projectionGroups: [
        {
          projectionName: "catalog-item-projection",
          targetContextName: "catalog",
        },
      ],
      blockedProjections: [
        {
          projectionKey: "catalog.catalog-item-projection",
        },
      ],
    });

    expect(snapshot.runners).toEqual([]);
    expect(snapshot.workers).toEqual([]);
    expect(snapshot.workerHeartbeatHistory).toEqual({
      activeOrStaleCount: 0,
      expiredTotalCount: 0,
      expiredWithinDiagnosticWindowCount: 0,
      expiredReturnedCount: 0,
      expiredTruncated: false,
      expiredDiagnosticLimit: 0,
      diagnosticWindowMs: 0,
    });
    expect(snapshot.projectionGroups[0]?.subscriptions).toEqual([]);
    expect(snapshot.blockedProjections[0]?.blockedStreams).toEqual([]);
    expect(snapshot.blockedProjections[0]?.poisonEvents).toEqual([]);
    expect(snapshot.projectionStatusSource).toBe("runtime-memory");
  });

  it("keeps the repair queue bounded while stale-worker attention reflects truncated history", () => {
    const workers = [
      { worker_id: "active", worker_kind: "platform-worker", worker_state: "active" },
      ...Array.from({ length: 100 }, (_, index) => ({
        worker_id: `expired-${index}`,
        worker_kind: "platform-worker",
        worker_state: "expired",
      })),
    ];
    const snapshot = normalizeProjectionOperationsSnapshot({
      summary: { status: "ok" },
      projectionStatusSource: "worker-snapshot",
      workers,
      workerHeartbeatHistory: {
        activeOrStaleCount: 1,
        expiredTotalCount: 20_000,
        expiredWithinDiagnosticWindowCount: 20_000,
        expiredReturnedCount: 100,
        expiredTruncated: true,
        expiredDiagnosticLimit: 100,
        diagnosticWindowMs: 604_800_000,
      },
    });

    expect(buildProjectionRepairQueue(snapshot)).toHaveLength(100);
    expect(buildAttentionItems(snapshot)).toContainEqual(
      expect.objectContaining({ id: "stale-workers", count: 20_000 }),
    );
  });

  it("normalizes operation states and summary metrics for queued history", () => {
    const snapshot = normalizeProjectionOperationsSnapshot({
      summary: {},
      operations: ["queued", "running", "succeeded", "failed", "cancel_requested", "cancelled"].map((state, index) => ({
        operationId: `projection-operation-${index}`,
        operationKind: "rebuild-projection-group",
        state,
        contextName: "catalog",
        projectionName: "catalog-item-projection",
        requestedAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z",
      })),
      operationSummary: {
        queuedCount: "1",
        runningCount: "1",
        failedCount: "1",
        cancelRequestedCount: "1",
        oldestQueuedAt: "2026-05-26T00:00:00.000Z",
        oldestRunningAt: "2026-05-26T00:01:00.000Z",
        averageDurationMs: "250",
      },
    });

    expect(snapshot.operations.map((operation) => operation.state)).toEqual([
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancel_requested",
      "cancelled",
    ]);
    expect(snapshot.operationSummary).toMatchObject({
      queuedCount: "1",
      runningCount: "1",
      failedCount: "1",
      cancelRequestedCount: "1",
    });
  });

  it("treats behind subscriptions with running runner evidence as running", () => {
    expect(resolveProjectionOperatorState("behind", "running")).toBe("running");
    expect(resolveProjectionOperatorState("behind", "idle")).toBe("behind");
  });

  it("builds attention items from failed operations, blocked streams, stale workers, and stale revisions", () => {
    const snapshot = normalizeProjectionOperationsSnapshot({
      summary: { status: "degraded", totalGroups: 1 },
      projectionStatusSource: "worker-snapshot",
      operations: [
        {
          operationId: "op_1",
          operationKind: "rebuild-projection-group",
          state: "failed",
          contextName: "catalog",
          requestedAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z",
        },
      ],
      projectionGroups: [
        {
          projectionName: "catalog-item-projection",
          targetContextName: "catalog",
          state: "degraded",
          revisionStale: true,
          poisonEventCount: 2,
          blockedStreamCount: 1,
        },
      ],
      blockedProjections: [
        {
          projectionKey: "catalog.catalog-item-projection",
          blockedStreams: [{ streamId: "catalog.item-1", state: "blocked" }],
        },
      ],
      workers: [{ worker_id: "worker_1", worker_state: "expired" }],
    });

    expect(buildAttentionItems(snapshot).map((item) => item.id)).toEqual([
      "failed-operations",
      "degraded-groups",
      "blocked-streams",
      "poison-events",
      "stale-workers",
      "stale-revisions",
    ]);
  });

  it("builds entity-level repair queue items for operation, stream, poison event, and group drawers", () => {
    const snapshot = normalizeProjectionOperationsSnapshot({
      summary: { status: "degraded" },
      projectionStatusSource: "worker-snapshot",
      operations: [
        {
          operationId: "op_failed",
          operationKind: "rebuild-projection-group",
          state: "failed",
          contextName: "catalog",
          projectionName: "catalog-item-projection",
        },
      ],
      projectionGroups: [
        {
          projectionName: "catalog-item-projection",
          targetContextName: "catalog",
          state: "degraded",
        },
      ],
      blockedProjections: [
        {
          projectionKey: "catalog.catalog-item-projection",
          blockedStreams: [{ streamId: "catalog.item-1", state: "blocked" }],
          poisonEvents: [
            {
              eventId: "evt_poison",
              eventType: "catalog.item.updated",
              streamId: "catalog.item-1",
              state: "poison",
              errorMessage: "handler failed",
            },
          ],
        },
      ],
    });

    expect(buildProjectionRepairQueue(snapshot)).toMatchObject([
      { kind: "operation", targetId: "op_failed", state: "failed" },
      { kind: "projection-group", targetId: "catalog:catalog-item-projection", state: "degraded" },
      {
        kind: "poison-event",
        targetId: "poison-event:evt_poison",
        state: "poison",
        contextName: "catalog",
        projectionName: "catalog-item-projection",
        streamId: "catalog.item-1",
      },
      {
        kind: "blocked-stream",
        targetId: "catalog.catalog-item-projection:catalog.item-1",
        state: "blocked",
        contextName: "catalog",
        projectionName: "catalog-item-projection",
      },
    ]);
  });

  it("sorts severe states before healthy states", () => {
    expect(
      ["caught-up", "failed", "running", "degraded"].sort((left, right) => stateSeverity(left) - stateSeverity(right)),
    ).toEqual(["failed", "degraded", "running", "caught-up"]);
  });

  it("adds projection group names to subscription rows", () => {
    const snapshot = normalizeProjectionOperationsSnapshot({
      summary: {},
      runners: [{ runner_name: "catalog.catalog-item-projection", state: "running" }],
      projectionGroups: [
        {
          projectionName: "catalog-item-projection",
          targetContextName: "catalog",
          subscriptions: [
            {
              checkpointKey: "catalog.catalog-item-projection:catalog:1",
              sourceContextName: "catalog",
              targetContextName: "catalog",
              state: "behind",
            },
          ],
        },
      ],
    });

    expect(buildProjectionSubscriptionRows(snapshot)).toMatchObject([
      {
        projectionGroupName: "catalog-item-projection",
        operatorState: "running",
      },
    ]);
  });
});
