import { describe, expect, it } from "vitest";
import {
  isRealtimeProjectionPatch,
  isRealtimeSyncRequired,
  realtimeProjectionPatchExamples,
  realtimeSyncRequiredExamples,
} from "./index";

describe("realtime contracts", () => {
  it("guards projection patches", () => {
    expect(
      isRealtimeProjectionPatch({
        kind: "projection.patch",
        context: "discovery",
        projection: "discovery-market-projection",
        topics: ["public:market"],
        changes: [
          {
            op: "upsert",
            entity: "discovery.marketListing",
            id: "list_1",
            value: { listing_id: "list_1" },
          },
        ],
      }),
    ).toBe(true);

    expect(
      isRealtimeProjectionPatch({
        kind: "projection.patch",
        context: "discovery",
        projection: "discovery-market-projection",
        topics: ["public:market"],
        changes: [],
      }),
    ).toBe(false);
  });

  it("guards sync-required messages", () => {
    expect(
      isRealtimeSyncRequired({
        kind: "sync.required",
        reason: "replay-backpressure",
        contexts: ["discovery"],
      }),
    ).toBe(true);

    expect(
      isRealtimeSyncRequired({
        kind: "sync.required",
        reason: "domain-event-leaked",
        contexts: ["discovery"],
      }),
    ).toBe(false);
  });

  it("keeps published contract examples guard-valid", () => {
    for (const example of Object.values(realtimeProjectionPatchExamples)) {
      expect(isRealtimeProjectionPatch(example)).toBe(true);
    }

    for (const example of Object.values(realtimeSyncRequiredExamples)) {
      expect(isRealtimeSyncRequired(example)).toBe(true);
    }
  });
});
