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
    { count: 0, hybrid: false },
    { count: 1, hybrid: false },
    { count: 2, hybrid: false },
    { count: 0, hybrid: true },
    { count: 1, hybrid: true },
  ])("lexical and final zero states: initial count $count, hybrid=$hybrid", async ({ count, hybrid }) => {
    const recordSearchQuery = vi.fn();
    let lexicalReads = 0;
    const db = interpretationDb((sql) => {
      if (sql.startsWith("SELECT * FROM (")) {
        lexicalReads++;
        return Array.from({ length: count }, (_, i) => ({
          catalog_item_id: `synthetic-lexical-${i}`,
          title: "Lexical",
        }));
      }
      if (sql.includes("AS semantic_similarity"))
        return [{ catalog_item_id: "synthetic-semantic", title: "Semantic", semantic_similarity: 0.99 }];
      if (sql.startsWith("SELECT COUNT(*) AS count")) return [{ count: String(count) }];
      return [];
    });
    const runtime = createDiscoveryItemSearchRuntime(
      { ...deps(), db },
      {
        provider: {
          model: "synthetic-zero-matrix",
          dimensions: 1_024,
          embed: async () => ({
            vectors: [Array.from({ length: 1_024 }, (_, i) => (i === 0 ? 1 : 0))],
            totalTokens: 1,
          }),
        },
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: hybrid,
        recordSearchQuery,
      },
    );
    const result = await runtime.searchItems({ search: "chraizard", includeTotal: false });
    expect(result).toMatchObject({
      retrievalMode: hybrid ? "hybrid" : "rescue",
      lexicalCount: hybrid ? count : null,
      total: hybrid ? count : null,
    });
    expect(result.items).toHaveLength(count + 1);
    expect(lexicalReads).toBe(1);
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ lexicalZero: count === 0, zeroResults: false, interpretation: "not-applied" }),
    );
  });

  it.each([false, true])("bounded recovery outcomes: corrected, interpreted=%s", async (interpreted) => {
    const recordSearchQuery = vi.fn();
    const db = interpretationDb((sql, values) => {
      if (sql.startsWith("SELECT * FROM") && values.some((value) => String(value).includes("| charizard")))
        return [{ catalog_item_id: "synthetic-corrected" }];
      return [];
    });
    const query = db.query;
    db.query = async (sql, values = []) =>
      sql.startsWith("SELECT EXISTS")
        ? { rows: [{ literal: false, prefix: false, candidates: ["charizard"] }] as never[], rowCount: 1 }
        : query(sql, values);
    const runtime = createDiscoveryItemSearchRuntime({ ...deps(), db }, { recordSearchQuery });
    const result = await runtime.searchItems({ search: interpreted ? "chraizard psa 10" : "chraizard" });
    expect(result).toMatchObject({ retrievalMode: "corrected", lexicalCount: 0, total: 1 });
    expect(Boolean(result.interpretation)).toBe(interpreted);
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        retrievalMode: "corrected",
        lexicalZero: true,
        zeroResults: false,
        interpretation: interpreted ? "applied" : "not-applied",
      }),
    );
  });

  it("lexical and final zero states: structured bypass is unknown, not false", async () => {
    const recordSearchQuery = vi.fn();
    const db = interpretationDb((sql) =>
      sql.startsWith("SELECT catalog_item_id,") && sql.includes("card_number =")
        ? [{ catalog_item_id: "synthetic-structured" }]
        : [],
    );
    const runtime = createDiscoveryItemSearchRuntime({ ...deps(), db }, { recordSearchQuery });
    const result = await runtime.searchItems({ search: "TSP 136" });
    expect(result.retrievalMode).toBe("structured");
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ lexicalZero: null, zeroResults: false, interpretation: "not-applied" }),
    );
  });

  it("effective cursor restart signal uses fresh rows, not rejected-page emptiness", async () => {
    const recordSearchQuery = vi.fn();
    const listReads: string[] = [];
    const db = interpretationDb((sql) => {
      if (sql.startsWith("SELECT * FROM (")) {
        listReads.push(sql);
        return sql.includes("OFFSET $") ? [] : [{ catalog_item_id: "synthetic-fresh" }];
      }
      if (sql.startsWith("SELECT COUNT(*)")) return [{ count: "1" }];
      return [];
    });
    const runtime = createDiscoveryItemSearchRuntime({ ...deps(), db }, { recordSearchQuery });
    await runtime.searchItems({ search: "pikachu", cursor: "rejected", offset: 100, includeTotal: false });
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cursorState: "restarted", lexicalZero: false, zeroResults: false, total: 1 }),
    );
    expect(listReads).toHaveLength(1);
    expect(listReads[0]).not.toContain("OFFSET $");
  });

  it("lexical and final zero states: nonempty hybrid candidates survive later retrieval failure", async () => {
    const recordSearchQuery = vi.fn();
    const recordSearchRetrievalFailure = vi.fn();
    const failure = new Error("synthetic hydration failure");
    const db = interpretationDb((sql, values) => {
      if (sql.startsWith("SELECT * FROM (")) return [{ catalog_item_id: "synthetic-candidate", title: "Candidate" }];
      if (Array.isArray(values[0]) && values[0].includes("synthetic-candidate")) throw failure;
      return [];
    });
    const runtime = createDiscoveryItemSearchRuntime(
      { ...deps(), db },
      {
        provider: {
          model: "synthetic-hydration-fault",
          dimensions: 1_024,
          embed: async () => ({
            vectors: [Array.from({ length: 1_024 }, (_, i) => (i === 0 ? 1 : 0))],
            totalTokens: 1,
          }),
        },
        cache: createQueryEmbeddingCache(),
        hybridEnabled: true,
        recordSearchQuery,
        recordSearchRetrievalFailure,
      },
    );
    await expect(
      runtime.searchItems({ search: "dragon" }, { correlationId: "0123456789abcdef0123456789abcdef" }),
    ).rejects.toBe(failure);
    expect(recordSearchRetrievalFailure).toHaveBeenCalledExactlyOnceWith({
      correlationId: "0123456789abcdef0123456789abcdef",
      error: failure,
    });
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ lexicalZero: false, zeroResults: null, interpretation: "unknown", outcome: "failure" }),
    );
  });

  it("rethrows the original retrieval error when the failure observer throws", async () => {
    const failure = new Error("synthetic retrieval failure");
    const observer = vi.fn(() => {
      throw new Error("synthetic observer failure");
    });
    const runtime = createDiscoveryItemSearchRuntime(
      { ...deps(), db: { query: vi.fn().mockRejectedValue(failure) } },
      { recordSearchRetrievalFailure: observer },
    );

    await expect(runtime.searchItems({ search: "query" })).rejects.toBe(failure);
    expect(observer).toHaveBeenCalledExactlyOnceWith({ correlationId: undefined, error: failure });
  });

  it("does not invoke the failure observer after a successful retrieval", async () => {
    const observer = vi.fn();
    const runtime = createDiscoveryItemSearchRuntime(deps(), { recordSearchRetrievalFailure: observer });

    await expect(runtime.searchItems({ search: "" })).resolves.toMatchObject({ retrievalMode: "lexical" });
    expect(observer).not.toHaveBeenCalled();
  });

  it("privacy sentinels never enter query signals or logs", async () => {
    const recordSearchQuery = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const db = interpretationDb((sql) =>
        sql.startsWith("SELECT * FROM (")
          ? [{ catalog_item_id: "PRIVATE_ITEM_SENTINEL", title: "PRIVATE_TITLE_SENTINEL" }]
          : [],
      );
      const runtime = createDiscoveryItemSearchRuntime({ ...deps(), db }, { recordSearchQuery });
      await runtime.searchItems({
        search: "privatequerysentinel",
        language: "PRIVATE_LANGUAGE_SENTINEL",
        category: "PRIVATE_CATEGORY_SENTINEL",
        dimensionFilters: [{ dimensionId: "PRIVATE_DIMENSION_SENTINEL", optionId: "PRIVATE_OPTION_SENTINEL" }],
      });
      expect(recordSearchQuery).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(recordSearchQuery.mock.calls)).not.toMatch(/privatequerysentinel|PRIVATE_/);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
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
        lexicalZero: true,
        interpretation: "unknown",
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
      expect.objectContaining({
        outcome: "success",
        retrievalMode: "lexical",
        queryEmbeddingOutcome: "error",
        lexicalZero: true,
        zeroResults: true,
      }),
    );
    expect(JSON.stringify(recordSearchQuery.mock.calls)).not.toContain("chraizard");
  });

  it("bounded recovery outcomes: an interpreted hit records one final signal without text, labels, or an embedding", async () => {
    const recordSearchQuery = vi.fn();
    const embed = vi.fn(async () => ({ vectors: [[1]], totalTokens: 1 }));
    const db = interpretationDb((sql, values) =>
      sql.startsWith("SELECT * FROM") && values.includes("dim_seed_grade") ? [{ catalog_item_id: "zard-psa-10" }] : [],
    );
    const runtime = createDiscoveryItemSearchRuntime(
      { ...deps(), db },
      {
        provider: { model: "synthetic-interpretation", dimensions: 1, embed },
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: false,
        recordSearchQuery,
      },
    );

    const result = await runtime.searchItems({ search: "zard psa 10" });
    expect(result.items.map((item) => item.catalog_item_id)).toEqual(["zard-psa-10"]);
    expect(result.interpretation).toEqual({
      remainingQuery: "zard",
      applied: [
        { param: "dimension.dim_seed_grading_company", optionId: "chc_seed_grading_company_psa", label: "PSA" },
        { param: "dimension.dim_seed_grade", optionId: "chc_seed_grade_gem_mint_10", label: "Gem Mint 10" },
      ],
    });
    expect(embed).not.toHaveBeenCalled();
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "success",
        retrievalMode: "lexical",
        lexicalZero: true,
        zeroResults: false,
        interpretation: "applied",
        resultCount: 1,
        filterState: "none",
        queryEmbeddingOutcome: "not-attempted",
      }),
    );
    for (const text of ["zard", "psa", "PSA", "Gem Mint", "chc_seed", "dim_seed"]) {
      expect(JSON.stringify(recordSearchQuery.mock.calls)).not.toContain(text);
    }
  });

  it("an interpreted miss records one signal with the original-text owner outcome", async () => {
    const recordSearchQuery = vi.fn();
    const embed = vi.fn(async () => ({ vectors: [[1]], totalTokens: 1 }));
    const db = interpretationDb(() => []);
    const runtime = createDiscoveryItemSearchRuntime(
      { ...deps(), db },
      {
        provider: { model: "synthetic-interpretation-miss", dimensions: 1, embed },
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: false,
        recordSearchQuery,
      },
    );

    await expect(runtime.searchItems({ search: "chraizard japanese" })).resolves.not.toHaveProperty("interpretation");
    expect(embed).toHaveBeenCalledExactlyOnceWith(["chraizard japanese"], "query", expect.anything());
    expect(db.correctionLookups).toBeLessThanOrEqual(3);
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "success",
        retrievalMode: "lexical",
        queryEmbeddingOutcome: "loaded",
        lexicalZero: true,
        interpretation: "not-applied",
      }),
    );
    expect(JSON.stringify(recordSearchQuery.mock.calls)).not.toMatch(/chraizard|japanese|Japanese/);
  });

  it("keys a marked request as its own Result Set", async () => {
    const runtime = createDiscoveryItemSearchRuntime(deps(), {});
    const request = { search: "zard", dimensionFilters: [{ dimensionId: "dim_seed_grade", optionId: "gm10" }] };
    const unmarked = await runtime.searchItems(request);
    const absentMarker = await runtime.searchItems({ ...request, interpreted: undefined });
    const marked = await runtime.searchItems({ ...request, interpreted: true });
    expect(absentMarker.resultSetKey).toBe(unmarked.resultSetKey);
    expect(marked.resultSetKey).not.toBe(unmarked.resultSetKey);
    expect(marked.queryHash).toBe(unmarked.queryHash);
  });

  it("Result Set identity tracks the effective category set and price currency", async () => {
    const recordSearchQuery = vi.fn();
    const runtime = createDiscoveryItemSearchRuntime(deps(), { recordSearchQuery });
    const a = await runtime.searchItems({ categories: ["B", "A", "A", " "] });
    const b = await runtime.searchItems({ categories: ["A", "B"] });
    const emptyCategories = await runtime.searchItems({ search: "zard", categories: [] });
    const omittedCategories = await runtime.searchItems({ search: "zard" });
    const eur = await runtime.searchItems({ priceCurrency: "EUR" });
    const usd = await runtime.searchItems({ priceCurrency: "USD" });
    const scalar = await runtime.searchItems({ category: "cards" });
    const categoryAndScalar = await runtime.searchItems({ categories: ["A"], category: "ignored" });
    const categoryOnly = await runtime.searchItems({ categories: ["A"] });
    expect(a.resultSetKey).toBe(b.resultSetKey);
    expect(emptyCategories.resultSetKey).toBe(omittedCategories.resultSetKey);
    expect(eur.resultSetKey).not.toBe(usd.resultSetKey);
    expect(recordSearchQuery).toHaveBeenNthCalledWith(1, expect.objectContaining({ filterState: "category" }));
    expect(recordSearchQuery).toHaveBeenNthCalledWith(5, expect.objectContaining({ filterState: "price-currency" }));
    expect(scalar.resultSetKey).toBe("cc1f7884e6194dd1b0eaff1bc2768816dcfe7f7c2b46fb40a31f65f4ae2d2ca0");
    expect(categoryAndScalar.resultSetKey).toBe(categoryOnly.resultSetKey);
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
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cursorState: expected, lexicalZero: true, zeroResults: true }),
    );
  });

  it("one signal and fail-open telemetry: reports unknown before a lexical observation", async () => {
    const recordSearchQuery = vi.fn(() => {
      throw new Error("synthetic exporter failure");
    });
    const failingDeps = { ...deps(), db: { query: vi.fn().mockRejectedValue(new Error("SQL failed")) } };
    const runtime = createDiscoveryItemSearchRuntime(failingDeps, { recordSearchQuery });

    await expect(runtime.searchItems({ search: "pikachu", cursor: "not-a-cursor" })).rejects.toThrow("SQL failed");
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "failure",
        cursorState: "restarted",
        lexicalZero: null,
        zeroResults: null,
        interpretation: "unknown",
      }),
    );
  });

  it("one signal and fail-open telemetry: lexical and final zero states stay private", async () => {
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
        lexicalZero: true,
        interpretation: "not-applied",
        retrievalMode: "lexical",
        outcome: "success",
      }),
    );
    expect(JSON.stringify(recordSearchQuery.mock.calls)).not.toContain("pikachu");

    const throwingExporter = vi.fn(() => {
      throw new Error("exporter unavailable");
    });
    const telemetryFailure = createDiscoveryItemSearchRuntime(deps(), { recordSearchQuery: throwingExporter });
    await expect(telemetryFailure.searchItems({ search: "pikachu", limit: 1 })).resolves.toMatchObject({
      retrievalMode: "lexical",
    });
    expect(throwingExporter).toHaveBeenCalledTimes(1);
  });
});

function deps() {
  const db: PgQueryable = {
    query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }),
  };
  return { db, eventStore: {} as never, checkpointStore: {} as never };
}

// Serves the seed PSA and Gem Mint 10 options from the option mirror and counts correction
// candidate lookups; every other read answers `rows`.
function interpretationDb(rows: (sql: string, values: readonly unknown[]) => unknown[]) {
  const db = {
    correctionLookups: 0,
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("FROM discovery_search_catalog_dimension_options")) {
        const options = [
          ["dim_seed_grading_company", "chc_seed_grading_company_psa", "psa", "PSA", null],
          ["dim_seed_grade", "chc_seed_grade_gem_mint_10", "gem-mint-10", "Gem Mint 10", "10"],
        ].map(([dimension_id, option_id, code, label, numeric_value]) => ({
          dimension_id,
          option_id,
          code,
          label,
          numeric_value,
        }));
        return { rows: options as Row[], rowCount: options.length };
      }
      if (sql.startsWith("SELECT EXISTS")) {
        db.correctionLookups++;
        return { rows: [{ literal: false, prefix: false, candidates: [] }] as Row[], rowCount: 1 };
      }
      const page = rows(sql, values);
      return { rows: page as Row[], rowCount: page.length };
    },
  };
  return db;
}

function encodeCursorJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
