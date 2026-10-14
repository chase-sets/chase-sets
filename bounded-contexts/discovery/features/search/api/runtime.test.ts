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

  it.each([
    [false, "candidate-lookup"],
    [true, "candidate-lookup"],
    [false, "corrected-row-query"],
    [true, "corrected-row-query"],
    [false, "hydration"],
    [true, "hydration"],
  ] as const)("reports correction failure before embedding (hybrid=%s, fault=%s)", async (hybridEnabled, fault) => {
    const failure = new Error(`SYNTHETIC_CORRECTION_${fault}_FAILURE`);
    const recordSearchQuery = vi.fn();
    const recordQueryEmbeddingLoad = vi.fn();
    const embed = vi.fn(async () => ({ vectors: [[1]], totalTokens: 1 }));
    let faultCalls = 0;
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        if (sql.startsWith("SELECT EXISTS")) {
          if (fault === "candidate-lookup") {
            faultCalls++;
            throw failure;
          }
          return { rows: [{ literal: false, prefix: false, candidates: ["charizard"] }] as Row[], rowCount: 1 };
        }
        if (sql.startsWith("SELECT * FROM") && values.includes("(chraizard | charizard)")) {
          if (fault === "corrected-row-query") {
            faultCalls++;
            throw failure;
          }
          return { rows: [{ catalog_item_id: "synthetic-corrected-item" }] as Row[], rowCount: 1 };
        }
        if (Array.isArray(values[0]) && values[0].includes("synthetic-corrected-item")) {
          faultCalls++;
          throw failure;
        }
        return { rows: [] as Row[], rowCount: 0 };
      },
    };
    const runtime = createDiscoveryItemSearchRuntime(
      { ...deps(), db },
      {
        provider: { model: "synthetic-correction-fault", dimensions: 1, embed },
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled,
        recordSearchQuery,
        recordQueryEmbeddingLoad,
      },
    );

    await expect(runtime.searchItems({ search: "chraizard" })).rejects.toBe(failure);
    expect(faultCalls).toBe(1);
    expect(embed).not.toHaveBeenCalled();
    expect(recordQueryEmbeddingLoad).not.toHaveBeenCalled();
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "failure",
        retrievalMode: null,
        resultCount: null,
        total: null,
        zeroResults: null,
        queryEmbeddingOutcome: "not-attempted",
        queryEmbeddingWaiterDurationMs: 0,
      }),
    );
    expect(JSON.stringify(recordSearchQuery.mock.calls)).not.toContain("chraizard");
  });

  it.each([false, true])("retains lexical fail-open for provider failure (hybrid=%s)", async (hybridEnabled) => {
    const recordSearchQuery = vi.fn();
    const embed = vi.fn(async () => {
      throw new Error("SYNTHETIC_PROVIDER_FAILURE");
    });
    const runtime = createDiscoveryItemSearchRuntime(deps(), {
      provider: { model: "synthetic-provider-fault", dimensions: 1, embed },
      cache: createQueryEmbeddingCache(),
      rescueEnabled: true,
      hybridEnabled,
      recordSearchQuery,
    });

    await expect(runtime.searchItems({ search: "chraizard" })).resolves.toMatchObject({
      retrievalMode: "lexical",
      items: [],
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "success", retrievalMode: "lexical", queryEmbeddingOutcome: "error" }),
    );
    expect(JSON.stringify(recordSearchQuery.mock.calls)).not.toContain("chraizard");
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

      const failedDeps = { ...deps(), db: { query: vi.fn().mockRejectedValue(new Error("SQL failed")) } };
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
  it.each([
    ["fresh", undefined, "fresh"],
    [
      "v2 relevance continuation",
      encodeCursorJson({ v: 2, id: "a", title: "A", rank: 0.5, baseMatch: true, tier: 1 }),
      "cursor",
    ],
    ["unversioned legacy cursor", encodeCursorJson({ id: "a", title: "A", rank: 0.5, baseMatch: true }), "restarted"],
    ["malformed cursor", "not-a-cursor", "restarted"],
  ] as const)("reports the effective %s cursor state, not raw cursor presence", async (_label, cursor, expected) => {
    const recordSearchQuery = vi.fn();
    const runtime = createDiscoveryItemSearchRuntime(deps(), { recordSearchQuery });

    const result = await runtime.searchItems({ search: "pikachu", cursor });

    expect(result.cursorState).toBe(expected);
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cursorState: expected }));
  });

  it("reports the classified cursor state when retrieval fails", async () => {
    const recordSearchQuery = vi.fn();
    const failingDeps = { ...deps(), db: { query: vi.fn().mockRejectedValue(new Error("SQL failed")) } };
    const runtime = createDiscoveryItemSearchRuntime(failingDeps, { recordSearchQuery });

    await expect(runtime.searchItems({ search: "pikachu", cursor: "not-a-cursor" })).rejects.toThrow("SQL failed");
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failure", cursorState: "restarted" }),
    );
  });

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

function encodeCursorJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
