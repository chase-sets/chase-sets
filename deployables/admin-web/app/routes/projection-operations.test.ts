import { describe, expect, it } from "vitest";
import { normalizeProjectionOperationsSnapshot } from "./projection-operations";

describe("normalizeProjectionOperationsSnapshot", () => {
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
    expect(snapshot.projectionGroups[0]?.subscriptions).toEqual([]);
    expect(snapshot.blockedProjections[0]?.blockedStreams).toEqual([]);
    expect(snapshot.blockedProjections[0]?.poisonEvents).toEqual([]);
  });

  it("normalizes projection operation states and summary metrics for queued history", () => {
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
});
