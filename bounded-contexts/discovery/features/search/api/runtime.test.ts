import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { createDiscoveryItemSearchRuntime } from "./runtime";

describe("Discovery search runtime telemetry", () => {
  it("records the resolved retrieval mode without making telemetry a dependency", async () => {
    const recordRetrievalMode = vi.fn();
    const runtime = createDiscoveryItemSearchRuntime(deps(), { recordRetrievalMode });
    await expect(runtime.searchItems({ search: "pikachu", limit: 1 })).resolves.toMatchObject({
      retrievalMode: "lexical",
    });
    expect(recordRetrievalMode).toHaveBeenCalledWith("lexical");

    const telemetryFailure = createDiscoveryItemSearchRuntime(deps(), {
      recordRetrievalMode: () => {
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
