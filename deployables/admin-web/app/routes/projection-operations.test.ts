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
});
