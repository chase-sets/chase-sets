import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { createDiscoveryItemSearchRuntime } from "./runtime";

describe("Discovery search runtime telemetry", () => {
  it("emits one privacy-safe signal for each search invocation without making telemetry a dependency", async () => {
    const recordSearchQuery = vi.fn();
    const runtime = createDiscoveryItemSearchRuntime(deps(), { recordSearchQuery });
    await expect(runtime.searchItems({ search: "pikachu", limit: 1 })).resolves.toMatchObject({
      retrievalMode: "lexical",
    });
    expect(recordSearchQuery).toHaveBeenCalledTimes(1);
    expect(recordSearchQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        resultSetKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        filterState: "none",
        sortOrder: "relevance",
        cursorState: "fresh",
        resultCount: 0,
        total: null,
        zeroResults: true,
        retrievalMode: "lexical",
        outcome: "success",
      }),
    );
    expect(JSON.stringify(recordSearchQuery.mock.calls)).not.toContain("pikachu");

    const telemetryFailure = createDiscoveryItemSearchRuntime(deps(), {
      recordSearchQuery: () => {
        throw new Error("exporter unavailable");
      },
    });
    await expect(telemetryFailure.searchItems({ search: "pikachu", limit: 1 })).resolves.toMatchObject({
      retrievalMode: "lexical",
    });
  });
});

function deps() {
  const db: PgQueryable = {
    query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }),
  };
  return { db, eventStore: {} as never, checkpointStore: {} as never };
}
