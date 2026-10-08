import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscoveryItemSearchRuntime } from "./runtime";
import { createQueryEmbeddingCache } from "../domain/query-embedding-cache";
import { createDiscoveryServices } from "../../../support/runtime-support/services";
import { createVoyageEmbeddingProvider } from "../integrations/voyage-embedding-provider";

describe("Discovery search runtime telemetry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("outcome/timing matrix separates owner, joined, and warm reuse", async () => {
    vi.useFakeTimers();
    const recordSearchQuery = vi.fn();
    const recordQueryEmbeddingLoad = vi.fn();
    const embed = vi.fn(
      () =>
        new Promise<{ vectors: number[][]; totalTokens: number }>((resolve) =>
          setTimeout(() => resolve({ vectors: [[1]], totalTokens: 1 }), 500),
        ),
    );
    const runtime = createDiscoveryItemSearchRuntime(deps(), {
      provider: { model: "fake", dimensions: 1, embed },
      cache: createQueryEmbeddingCache(),
      rescueEnabled: true,
      recordSearchQuery,
      recordQueryEmbeddingLoad,
    });
    const owner = runtime.searchItems({ search: "secret query" });
    await vi.advanceTimersByTimeAsync(200);
    const peer = runtime.searchItems({ search: "SECRET QUERY" });
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([owner, peer]);
    await runtime.searchItems({ search: "secret query" });
    expect(
      recordSearchQuery.mock.calls.map(([signal]) => [
        signal.queryEmbeddingOutcome,
        signal.queryEmbeddingWaiterDurationMs,
      ]),
    ).toEqual([
      ["loaded", 500],
      ["joined", 300],
      ["cache-hit", 0],
    ]);
    expect(recordQueryEmbeddingLoad).toHaveBeenCalledExactlyOnceWith({ outcome: "loaded", durationMs: 500 });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([recordSearchQuery.mock.calls, recordQueryEmbeddingLoad.mock.calls])).not.toContain(
      "secret query",
    );
  });

  it("owner-disconnect completion emits exactly one provider-load observation after its finally signal", async () => {
    vi.useFakeTimers();
    const recordSearchQuery = vi.fn();
    const recordQueryEmbeddingLoad = vi.fn();
    const controller = new AbortController();
    const embed = vi.fn(
      () =>
        new Promise<{ vectors: number[][]; totalTokens: number }>((resolve) =>
          setTimeout(() => resolve({ vectors: [[1]], totalTokens: 1 }), 500),
        ),
    );
    const runtime = createDiscoveryItemSearchRuntime(deps(), {
      provider: { model: "fake", dimensions: 1, embed },
      cache: createQueryEmbeddingCache(),
      rescueEnabled: true,
      recordSearchQuery,
      recordQueryEmbeddingLoad,
    });
    const owner = runtime.searchItems({ search: "query" }, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    const peer = runtime.searchItems({ search: "query" });
    controller.abort();
    await owner;
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ queryEmbeddingOutcome: "timeout", queryEmbeddingWaiterDurationMs: 100 }),
    );
    expect(recordQueryEmbeddingLoad).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    await peer;
    expect(recordSearchQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ queryEmbeddingOutcome: "joined", queryEmbeddingWaiterDurationMs: 400 }),
    );
    expect(recordQueryEmbeddingLoad).toHaveBeenCalledExactlyOnceWith({ outcome: "loaded", durationMs: 500 });
  });

  it.each(["error", "timeout"] as const)(
    "reports %s for failed owners and joiners, including retrieval-finally failure",
    async (outcome) => {
      vi.useFakeTimers();
      const recordSearchQuery = vi.fn();
      const recordQueryEmbeddingLoad = vi.fn();
      const embed = vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            if (outcome === "error") setTimeout(() => reject(new Error("provider")), 500);
          }),
      );
      const runtime = createDiscoveryItemSearchRuntime(deps(), {
        provider: { model: "fake", dimensions: 1, embed },
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        recordSearchQuery,
        recordQueryEmbeddingLoad,
      });
      const owner = runtime.searchItems({ search: "query" });
      await vi.advanceTimersByTimeAsync(100);
      const peer = runtime.searchItems({ search: "query" });
      await vi.advanceTimersByTimeAsync(700);
      await Promise.all([owner, peer]);
      expect(recordSearchQuery.mock.calls.map(([signal]) => signal.queryEmbeddingOutcome)).toEqual([outcome, outcome]);
      expect(recordQueryEmbeddingLoad).toHaveBeenCalledExactlyOnceWith({
        outcome,
        durationMs: outcome === "timeout" ? 800 : 500,
      });

      const failedDeps = deps();
      failedDeps.db.query = vi.fn().mockRejectedValue(new Error("SQL failed"));
      const failingRuntime = createDiscoveryItemSearchRuntime(failedDeps, { recordSearchQuery });
      await expect(failingRuntime.searchItems({ search: "query" })).rejects.toThrow("SQL failed");
      expect(recordSearchQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({
          outcome: "failure",
          queryEmbeddingOutcome: "not-attempted",
          queryEmbeddingWaiterDurationMs: 0,
        }),
      );
    },
  );

  it.each(["browse", "sort", "disabled", "pre-abort"])(
    "reports zero/not-attempted without load observations: %s",
    async (kind) => {
      const recordSearchQuery = vi.fn();
      const recordQueryEmbeddingLoad = vi.fn();
      const embed = vi.fn();
      const runtime = createDiscoveryItemSearchRuntime(deps(), {
        provider: { model: "fake", dimensions: 1, embed },
        cache: createQueryEmbeddingCache(),
        rescueEnabled: kind !== "disabled",
        recordSearchQuery,
        recordQueryEmbeddingLoad,
      });
      await runtime.searchItems(
        { search: kind === "browse" ? "" : "query", sort: kind === "sort" ? "newest" : undefined },
        { signal: kind === "pre-abort" ? AbortSignal.abort() : undefined },
      );
      expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ queryEmbeddingOutcome: "not-attempted", queryEmbeddingWaiterDurationMs: 0 }),
      );
      expect(recordQueryEmbeddingLoad).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
    },
  );

  it("both telemetry exporters may throw without failing search or cache warming", async () => {
    const runtime = createDiscoveryItemSearchRuntime(deps(), {
      provider: { model: "fake", dimensions: 1, embed: async () => ({ vectors: [[1]], totalTokens: 0 }) },
      cache: createQueryEmbeddingCache(),
      rescueEnabled: true,
      recordSearchQuery: () => {
        throw new Error("query exporter");
      },
      recordQueryEmbeddingLoad: () => {
        throw new Error("load exporter");
      },
    });
    await expect(runtime.searchItems({ search: "query" })).resolves.toMatchObject({ retrievalMode: "lexical" });
    await expect(runtime.searchItems({ search: "query" })).resolves.toMatchObject({ retrievalMode: "lexical" });
  });

  it.each([false, true])(
    "service wiring isolates online policy from configured or injected batch provider (injected=%s)",
    async (injected) => {
      vi.useFakeTimers();
      const fetchRequest = vi.fn<typeof fetch>(() => new Promise(() => {}));
      vi.stubGlobal("fetch", fetchRequest);
      const recordQueryEmbeddingLoad = vi.fn();
      const provider = createVoyageEmbeddingProvider({
        apiKey: "fake-key",
        fetch: fetchRequest,
        timeoutMs: 1,
        maxAttempts: 9,
      });
      const services = createDiscoveryServices(deps().db as never, {
        notificationOutbox: {} as never,
        searchEmbeddingConfig: {
          apiKey: "fake-key",
          timeoutMs: 1,
          maxAttempts: 9,
          queryTimeoutMs: 250,
          rolloutValue: "on",
          rescueValue: "on",
        },
        searchEmbeddingProvider: injected ? provider : undefined,
        searchTelemetry: { recordQueryEmbeddingLoad },
      });
      const result = services.items.search.searchItems({ search: "query" });
      await vi.advanceTimersByTimeAsync(249);
      expect(fetchRequest).toHaveBeenCalledTimes(1);
      expect(fetchRequest.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ retrievalMode: "lexical" });
      expect(fetchRequest).toHaveBeenCalledTimes(1);
      expect(recordQueryEmbeddingLoad).toHaveBeenCalledWith({ outcome: "timeout", durationMs: 250 });
      expect(services.searchEmbeddings).toBeDefined();
    },
  );
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
