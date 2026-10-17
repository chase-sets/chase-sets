import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryEmbeddingCache } from "../domain/query-embedding-cache";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";
import {
  classifyDiscoverySearchCursor,
  retrieveDiscoveryItems,
  type DiscoveryHybridRetrievalDependencies,
  type DiscoverySearchResult,
} from "./hybrid-retrieval";
import {
  searchDiscoveryItems,
  type DiscoverySearchItemRow,
  type DiscoverySearchParams,
  type ListResult,
} from "./queries";
import type { SearchInterpretationVocabulary } from "../domain/search-interpretation";
import type { ProtectedSearchToken } from "../domain/protected-search-tokens";
import { buildSpellingCorrectionQueries, type SearchCorrectionBudget } from "../domain/spelling-correction";

const vector = Array.from({ length: 1_024 }, (_, index) => (index === 0 ? 1 : 0));
const vocabulary: SearchInterpretationVocabulary = {
  gradingCompanyDimensionId: "dim_company",
  gradeDimensionId: "dim_grade",
  options: [
    { dimensionId: "dim_company", optionId: "psa", code: "psa", label: "PSA", numericValue: null },
    { dimensionId: "dim_grade", optionId: "gem-mint-10", code: "gem-mint-10", label: "Gem Mint 10", numericValue: 10 },
    {
      dimensionId: "dim_grade",
      optionId: "pristine-10",
      code: "pristine-10",
      label: "Pristine 10",
      numericValue: 10.5,
    },
  ],
};
const inferred = [
  { dimensionId: "dim_company", optionId: "psa" },
  { dimensionId: "dim_grade", optionId: "gem-mint-10" },
];

describe("Discovery hybrid retrieval", () => {
  describe("initial lexical observation survives recovery", () => {
    it.each([
      { name: "rescue zero without totals", count: 0, hybrid: false, mode: "rescue" },
      { name: "rescue one", count: 1, hybrid: false, mode: "rescue" },
      { name: "rescue two", count: 2, hybrid: false, mode: "rescue" },
      { name: "hybrid zero", count: 0, hybrid: true, mode: "hybrid" },
      { name: "hybrid nonzero", count: 1, hybrid: true, mode: "hybrid" },
      { name: "corrected", count: 0, hybrid: false, mode: "corrected" },
      { name: "interpreted", count: 0, hybrid: false, mode: "lexical" },
    ])("$name", async ({ count, hybrid, mode, name }) => {
      const observed = vi.fn();
      const searchLexical = vi.fn<NonNullable<DiscoveryHybridRetrievalDependencies["searchLexical"]>>(
        async (_db, params = {}) => ({
          ...result(
            name === "interpreted" && params.search === "charizard"
              ? [row("interpreted")]
              : Array.from({ length: count }, (_, i) => row(`lexical-${i}`)),
          ),
          total: null,
        }),
      );
      const page = await retrieveDiscoveryItems(
        {
          db: emptyDb(),
          provider: fakeProvider(),
          cache: createQueryEmbeddingCache(),
          rescueEnabled: true,
          hybridEnabled: hybrid,
          searchLexical,
          searchCorrected: async () => (mode === "corrected" ? result([row("corrected")]) : null),
          loadInterpretationVocabulary: async () => vocabulary,
          searchSemantic: async () => [{ item: row("semantic"), similarity: 0.99 }],
          hydrateItems: async (_db, items) => [...items],
          onLexicalObservation: observed,
        },
        { search: name === "interpreted" ? "charizard psa 10" : "chraizard", includeTotal: false },
      );
      expect(observed).toHaveBeenCalledExactlyOnceWith(count === 0);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.retrievalMode).toBe(mode);
      expect(page.lexicalCount).toBe(mode === "corrected" ? 0 : null);
      expect(searchLexical.mock.calls[0]?.[1]?.includeTotal).toBe(hybrid);
    });

    it.each(["empty", "cursor", "structured", "provider-failure", "before-read", "after-read"] as const)(
      "%s preserves known versus unknown",
      async (scenario) => {
        const observed = vi.fn();
        const failure = new Error("synthetic retrieval failure");
        const provider = fakeProvider();
        if (scenario === "provider-failure") vi.mocked(provider.embed).mockRejectedValue(failure);
        const request = retrieveDiscoveryItems(
          {
            db: emptyDb(),
            provider,
            cache: createQueryEmbeddingCache(),
            rescueEnabled: scenario === "provider-failure",
            hybridEnabled: false,
            searchLexical: async () => {
              if (scenario === "before-read") throw failure;
              return { ...result([]), total: null };
            },
            searchNaturalKey: async () => result([row("structured")]),
            searchCorrected: async () => {
              if (scenario === "after-read") throw failure;
              return null;
            },
            onLexicalObservation: observed,
          },
          {
            search: scenario === "structured" ? "TSP 136" : "chraizard",
            cursor: scenario === "cursor" ? relevanceCursor() : undefined,
            includeTotal: false,
          },
        );
        if (scenario === "before-read" || scenario === "after-read") await expect(request).rejects.toBe(failure);
        else {
          const page = await request;
          expect(page.items.length === 0).toBe(scenario !== "structured");
        }
        if (scenario === "structured" || scenario === "before-read") expect(observed).not.toHaveBeenCalled();
        else expect(observed).toHaveBeenCalledExactlyOnceWith(true);
      },
    );

    it.each(["semantic", "hydration"] as const)(
      "hybrid cursor candidate observation survives %s failure and nonempty fallback",
      async (fault) => {
        const observed = vi.fn();
        const page = await retrieveDiscoveryItems(
          {
            db: emptyDb(),
            provider: fakeProvider(),
            cache: createQueryEmbeddingCache(),
            rescueEnabled: true,
            hybridEnabled: true,
            searchLexical: async (_db, _params, options) =>
              result(options?.loadMarketSummaries === false ? [] : [row("fallback")]),
            searchSemantic: async () => {
              if (fault === "semantic") throw new Error("synthetic semantic failure");
              return [{ item: row("semantic"), similarity: 0.99 }];
            },
            hydrateItems: async () => {
              throw new Error("synthetic hydration failure");
            },
            onLexicalObservation: observed,
          },
          { search: "dragon", cursor: hybridCursor(1), includeTotal: false },
        );
        expect(page).toMatchObject({ retrievalMode: "lexical", cursorState: "cursor" });
        expect(page.items).toHaveLength(1);
        expect(observed).toHaveBeenCalledExactlyOnceWith(true);
      },
    );

    it("does not replace a failed initial read with a successful hybrid fallback observation", async () => {
      const observed = vi.fn();
      const searchLexical: NonNullable<DiscoveryHybridRetrievalDependencies["searchLexical"]> = vi
        .fn()
        .mockRejectedValueOnce(new Error("synthetic candidate failure"))
        .mockResolvedValueOnce(result([row("fallback")]));
      const page = await retrieveDiscoveryItems(
        {
          db: emptyDb(),
          provider: fakeProvider(),
          cache: createQueryEmbeddingCache(),
          rescueEnabled: true,
          hybridEnabled: true,
          searchLexical,
          searchSemantic: async () => [],
          onLexicalObservation: observed,
        },
        { search: "dragon", cursor: hybridCursor(1) },
      );
      expect(page.items).toHaveLength(1);
      expect(observed).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "protected structured misses never escape through semantic retrieval (provider=%s)",
    async (enabled) => {
      const provider = fakeProvider();
      const searchSemantic = vi.fn(async () => [{ item: row("wrong-printing"), similarity: 0.99 }]);
      const db: PgQueryable = { query: async () => ({ rows: [], rowCount: 0 }) };
      for (const search of ["charzard 5/102", "luffy op01 002", "TSP 999", "charzard 102/4", "TG05", "136a"]) {
        const actual = await retrieveDiscoveryItems(
          {
            db,
            provider: enabled ? provider : undefined,
            cache: createQueryEmbeddingCache(),
            rescueEnabled: true,
            hybridEnabled: true,
            searchNaturalKey: async () => result([]),
            searchLexical: async () => result([]),
            searchSemantic,
          },
          { search },
        );
        expect(actual.retrievalMode).toBe("lexical");
        expect(actual.items).toEqual([]);
      }
      expect(provider.embed).not.toHaveBeenCalled();
      expect(searchSemantic).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "a fresh zero correction hit prevents embedding and has a bounded single page (hybrid=%s)",
    async (hybridEnabled) => {
      const provider = fakeProvider();
      const searchCorrected = vi.fn(async () => result([row("correct-printing")]));
      const actual = await retrieveDiscoveryItems(
        {
          db: { query: async () => ({ rows: [], rowCount: 0 }) },
          provider,
          cache: createQueryEmbeddingCache(),
          rescueEnabled: true,
          hybridEnabled,
          searchLexical: async () => result([]),
          searchCorrected,
          searchSemantic: async () => [{ item: row("wrong-printing"), similarity: 0.99 }],
        },
        { search: "chraizard" },
      );
      expect(actual).toMatchObject({
        retrievalMode: "corrected",
        lexicalCount: 0,
        total: 1,
        nextCursor: null,
        facets: [],
        category_counts: [],
      });
      expect(actual.items.map((item) => item.catalog_item_id)).toEqual(["correct-printing"]);
      expect(provider.embed).not.toHaveBeenCalled();
    },
  );

  it.each(["blastois agumon", "chraizard digimon"])(
    "an unprotected correction miss remains rescue-eligible: %s",
    async (search) => {
      const provider = fakeProvider();
      const page = await retrieveDiscoveryItems(
        {
          db: { query: async () => ({ rows: [], rowCount: 0 }) },
          provider,
          cache: createQueryEmbeddingCache(),
          rescueEnabled: true,
          hybridEnabled: false,
          searchLexical: async () => result([]),
          searchCorrected: async () => null,
          searchSemantic: async () => [{ item: row("wrong-printing"), similarity: 0.99 }],
        },
        { search },
      );
      expect(page.retrievalMode).toBe("rescue");
      expect(page.items.map((item) => item.catalog_item_id)).toEqual(["wrong-printing"]);
      expect(provider.embed).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { search: "" },
    { search: "charzard", offset: 1 },
    { search: "charzard", cursor: "bad" },
    { search: "charzard", sort: "title_asc" },
  ])("skips correction outside a fresh relevance zero: %j", async (params) => {
    const searchCorrected = vi.fn(async () => result([row("corrected")]));
    await retrieveDiscoveryItems(
      {
        db: {} as never,
        rescueEnabled: false,
        hybridEnabled: false,
        searchLexical: async () => result([]),
        searchCorrected,
      },
      params,
    );
    expect(searchCorrected).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])("nonzero lexical pages never correct; ordinary rescue is retained (count=%s)", async (count) => {
    const searchCorrected = vi.fn();
    const provider = fakeProvider();
    const page = await retrieveDiscoveryItems(
      {
        db: {} as never,
        provider,
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: false,
        searchCorrected,
        searchLexical: async () => result(Array.from({ length: count }, (_, i) => row(`lexical-${i}`))),
        searchSemantic: async () => [{ item: row("semantic"), similarity: 0.99 }],
      },
      { search: "charzard" },
    );
    expect(searchCorrected).not.toHaveBeenCalled();
    expect(page.retrievalMode).toBe(count < 3 ? "rescue" : "lexical");
  });

  it("forwards selected dimensions through both hybrid candidates and batched hydration", async () => {
    const dimensionFilters = [{ dimensionId: "finish", optionId: "foil" }];
    const searchLexical = vi.fn(async () => result([row("lexical")]));
    const searchSemantic = vi.fn(async () => [{ item: row("semantic"), similarity: 0.9 }]);
    const hydrateItems = vi.fn(async (_db, items) => [...items]);
    await retrieveDiscoveryItems(
      {
        db: {} as never,
        provider: fakeProvider(),
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: true,
        searchLexical,
        searchSemantic,
        hydrateItems,
      },
      { search: "dragon", dimensionFilters },
    );
    expect(searchLexical).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dimensionFilters }),
      expect.anything(),
    );
    expect(searchSemantic).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dimensionFilters }),
      vector,
      expect.anything(),
    );
    expect(hydrateItems).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({ dimensionFilters }),
    );
  });
  afterEach(() => vi.useRealTimers());

  it.each([false, true])("online timeout returns lexical metadata (hybrid=%s)", async (hybridEnabled) => {
    vi.useFakeTimers();
    const provider = fakeProvider();
    vi.mocked(provider.embed).mockImplementation(() => new Promise(() => {}));
    const lexical: ListResult<DiscoverySearchItemRow> = {
      ...result([row("lexical")]),
      total: 17,
      nextCursor: "lexical-next",
      facets: [
        {
          id: "condition",
          kind: "dimension",
          label: "Condition",
          values: [{ id: "mint", label: "Mint", count: 17, selected: false }],
        },
      ],
      category_counts: [{ slug: "cards", count: 17 }],
    };
    const onEmbeddingWait = vi.fn();
    const searchSemantic = vi.fn();
    const pending = retrieveDiscoveryItems(
      {
        db: {} as never,
        provider,
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled,
        searchLexical: async () => lexical,
        searchSemantic,
        onEmbeddingWait,
      },
      { search: "intent" },
    );
    await vi.advanceTimersByTimeAsync(800);
    await expect(pending).resolves.toEqual({
      ...lexical,
      retrievalMode: "lexical",
      lexicalCount: 17,
      cursorState: "fresh",
    });
    expect(onEmbeddingWait).toHaveBeenCalledWith({ outcome: "timeout", waiterDurationMs: 800 });
    expect(provider.embed).toHaveBeenCalledExactlyOnceWith(
      ["intent"],
      "query",
      expect.objectContaining({ maxAttempts: 1, timeoutMs: 800 }),
    );
    expect(vi.mocked(provider.embed).mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(searchSemantic).not.toHaveBeenCalled();
  });

  it.each([[], [0, 0], [Number.NaN, 1], [Infinity, 1], [1]].map((embedding) => ({ embedding })))(
    "invalid vectors fail open and evict: %j",
    async ({ embedding }) => {
      const provider = {
        model: "fake",
        dimensions: 2,
        embed: vi.fn(async () => ({ vectors: [embedding], totalTokens: 0 })),
      };
      const cache = createQueryEmbeddingCache();
      const lexical = result([row("lexical")]);
      const onEmbeddingWait = vi.fn();
      const actual = await retrieveDiscoveryItems(
        {
          db: {} as never,
          provider,
          cache,
          rescueEnabled: true,
          hybridEnabled: false,
          searchLexical: async () => lexical,
          onEmbeddingWait,
        },
        { search: "intent" },
      );
      expect(actual).toEqual({ ...lexical, retrievalMode: "lexical", lexicalCount: 1, cursorState: "fresh" });
      expect(onEmbeddingWait).toHaveBeenCalledWith(expect.objectContaining({ outcome: "error" }));
      expect(cache.size()).toBe(0);
    },
  );
  it("rescues a low lexical result set, preserves its prefix, and embeds with input_type query", async () => {
    const provider = fakeProvider();
    const lexical = result([row("lexical", "Blue dragon")]);
    const searchLexical = vi.fn(async () => lexical);
    const searchSemantic = vi.fn(async (_db, params) => [
      { item: row("semantic", "Azure creature"), similarity: 0.91 },
      { item: row("lexical", "Blue dragon"), similarity: 0.9 },
    ]);

    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        provider,
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: false,
        searchLexical,
        searchSemantic,
      },
      { search: "  BLUE   dragon ", category: "cards", fieldFilters: [{ fieldId: "rarity", value: "rare" }] },
    );

    expect(actual.retrievalMode).toBe("rescue");
    expect(actual.lexicalCount).toBe(1);
    expect(actual.total).toBe(1);
    expect(actual.items.map((item) => item.catalog_item_id)).toEqual(["lexical", "semantic"]);
    expect(provider.embed).toHaveBeenCalledWith(
      ["blue dragon"],
      "query",
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 800, maxAttempts: 1 }),
    );
    expect(searchSemantic).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ category: "cards", fieldFilters: [{ fieldId: "rarity", value: "rare" }] }),
      vector,
      expect.anything(),
    );
  });

  it("does not call the provider for browse requests or lexical sets at the rescue threshold", async () => {
    const provider = fakeProvider();
    const searchLexical = vi.fn(async () => result([row("1"), row("2"), row("3")]));
    const dependencies = {
      db: {} as never,
      provider,
      cache: createQueryEmbeddingCache(),
      rescueEnabled: true,
      hybridEnabled: false,
      searchLexical,
      searchSemantic: vi.fn(),
    };

    await retrieveDiscoveryItems(dependencies, {});
    await retrieveDiscoveryItems(dependencies, { search: "dragon" });
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it("fails open to the unchanged lexical response on provider errors", async () => {
    const provider = fakeProvider();
    vi.mocked(provider.embed).mockRejectedValue(new Error("provider unavailable"));
    const lexical = result([]);

    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        provider,
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: false,
        searchLexical: vi.fn(async () => lexical),
        searchCorrected: async () => null,
        loadInterpretationVocabulary: async () => vocabulary,
        searchSemantic: vi.fn(),
      },
      { search: "semantic intent" },
    );

    expect(actual).toEqual({ ...lexical, retrievalMode: "lexical", lexicalCount: 0, cursorState: "fresh" });
  });

  it("fails open when the filtered vector query is unavailable", async () => {
    const lexical = result([row("lexical")]);
    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        provider: fakeProvider(),
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: true,
        searchLexical: vi.fn(async () => lexical),
        searchSemantic: vi.fn(async () => Promise.reject(new Error("vector index unavailable"))),
      },
      { search: "related item" },
    );

    expect(actual).toEqual({ ...lexical, retrievalMode: "lexical", lexicalCount: 1, cursorState: "fresh" });
  });

  it("resolves a structured set-code + collector-number query ahead of lexical/semantic retrieval", async () => {
    const provider = fakeProvider();
    const onEmbeddingWait = vi.fn();
    const searchNaturalKey = vi.fn(async () => result([row("sv04-123", "Charizard ex")]));
    const searchLexical = vi.fn();
    const searchSemantic = vi.fn();

    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        provider,
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: true,
        onEmbeddingWait,
        searchNaturalKey,
        searchLexical,
        searchSemantic,
      },
      { search: "SV04 123/182", category: "pokemon" },
    );

    expect(actual.retrievalMode).toBe("structured");
    expect(actual.items.map((item) => item.catalog_item_id)).toEqual(["sv04-123"]);
    expect(searchNaturalKey).toHaveBeenCalledWith(
      expect.anything(),
      { setCode: "sv04", cardNumber: "123" },
      expect.objectContaining({ search: "SV04 123/182", category: "pokemon" }),
    );
    expect(provider.embed).not.toHaveBeenCalled();
    expect(onEmbeddingWait).not.toHaveBeenCalled();
    expect(searchLexical).not.toHaveBeenCalled();
    expect(searchSemantic).not.toHaveBeenCalled();
  });

  it("falls back to lexical search when the structured query resolves no rows", async () => {
    const searchNaturalKey = vi.fn(async () => result([]));
    const lexical = result([row("fallback", "Charizard promo")]);
    const searchLexical = vi.fn(async () => lexical);

    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        rescueEnabled: false,
        hybridEnabled: false,
        searchNaturalKey,
        searchLexical,
        searchSemantic: vi.fn(),
      },
      { search: "sv04 123" },
    );

    expect(searchNaturalKey).toHaveBeenCalled();
    expect(actual.retrievalMode).toBe("lexical");
    expect(actual.items.map((item) => item.catalog_item_id)).toEqual(["fallback"]);
  });

  it("does not attempt structured resolution for an ordinary text query", async () => {
    const searchNaturalKey = vi.fn();
    const searchLexical = vi.fn(async () => result([row("dragon")]));

    await retrieveDiscoveryItems(
      {
        db: {} as never,
        rescueEnabled: false,
        hybridEnabled: false,
        searchNaturalKey,
        searchLexical,
        searchSemantic: vi.fn(),
      },
      { search: "blue dragon" },
    );

    expect(searchNaturalKey).not.toHaveBeenCalled();
  });

  it("skips structured resolution and rescue when paging a valid v2 relevance cursor", async () => {
    const searchNaturalKey = vi.fn();
    const searchLexical = vi.fn(async () => result([row("page-2")]));
    const provider = fakeProvider();
    const cursor = relevanceCursor();

    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        provider,
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: false,
        searchNaturalKey,
        searchLexical,
        searchSemantic: vi.fn(),
      },
      { search: "sv04 123", cursor },
    );

    expect(searchNaturalKey).not.toHaveBeenCalled();
    expect(provider.embed).not.toHaveBeenCalled();
    expect(searchLexical).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cursor }),
      expect.objectContaining({ protectedQuery: "(sv04) & (123)" }),
    );
    expect(actual).toMatchObject({ retrievalMode: "lexical", cursorState: "cursor" });
  });

  it("restarts a rejected cursor on a structured query as a fresh structured request", async () => {
    const searchNaturalKey = vi.fn(async () => result([row("sv04-123", "Charizard ex")]));
    const searchLexical = vi.fn();

    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        rescueEnabled: false,
        hybridEnabled: false,
        searchNaturalKey,
        searchLexical,
        searchSemantic: vi.fn(),
      },
      { search: "SV04 123/182", cursor: legacyCursor() },
    );

    expect(searchNaturalKey).toHaveBeenCalledWith(
      expect.anything(),
      { setCode: "sv04", cardNumber: "123" },
      expect.objectContaining({ cursor: undefined, includeTotal: true }),
    );
    expect(searchLexical).not.toHaveBeenCalled();
    expect(actual).toMatchObject({ retrievalMode: "structured", cursorState: "restarted" });
  });

  it("restarts a rejected cursor on a low-result lexical query and runs rescue with fresh metadata", async () => {
    const provider = fakeProvider();
    const searchLexical = vi.fn(async (_db, params) => ({
      ...result([row("lexical", "Blue dragon")]),
      total: params.includeTotal ? 1 : null,
      category_counts: params.cursor === undefined ? [{ slug: "cards", count: 1 }] : [],
    }));
    const searchSemantic = vi.fn(async () => [{ item: row("semantic", "Azure creature"), similarity: 0.91 }]);

    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        provider,
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: false,
        searchLexical,
        searchSemantic,
      },
      { search: "blue dragon", cursor: legacyCursor() },
    );

    expect(searchLexical).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ cursor: undefined, includeTotal: true }),
    );
    expect(actual.items.map((item) => item.catalog_item_id)).toEqual(["lexical", "semantic"]);
    expect(actual).toMatchObject({
      retrievalMode: "rescue",
      total: 1,
      category_counts: [{ slug: "cards", count: 1 }],
      cursorState: "restarted",
    });
  });

  it("classifies a hybrid cursor first and restarts it when hybrid retrieval is disabled", async () => {
    const searchLexical = vi.fn(async (_db, params) => ({
      ...result([row("first", "Pikachu")]),
      total: params.includeTotal ? 1 : null,
    }));

    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        provider: fakeProvider(),
        cache: createQueryEmbeddingCache(),
        rescueEnabled: false,
        hybridEnabled: false,
        searchLexical,
        searchSemantic: vi.fn(),
      },
      { search: "Pikachu", cursor: hybridCursor(24) },
    );

    expect(searchLexical).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ cursor: undefined, includeTotal: true }),
    );
    expect(actual).toMatchObject({ items: [expect.objectContaining({ catalog_item_id: "first" })], total: 1 });
    expect(actual.cursorState).toBe("restarted");
  });

  it("restarts a rejected cursor as a fresh hybrid first page when hybrid retrieval is enabled", async () => {
    const searchLexical = vi.fn(async (_db, params) => ({
      ...result([row("exact", "Pikachu")]),
      total: params.includeTotal ? 1 : null,
    }));

    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        provider: fakeProvider(),
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: true,
        searchLexical,
        searchSemantic: vi.fn(async () => [{ item: row("semantic", "Electric mascot"), similarity: 0.99 }]),
        hydrateItems: vi.fn(async (_db, items) => [...items]),
      },
      { search: "Pikachu", cursor: legacyCursor(), limit: 1 },
    );

    expect(searchLexical).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cursor: undefined, includeTotal: true }),
      expect.anything(),
    );
    expect(actual).toMatchObject({ retrievalMode: "hybrid", total: 1, cursorState: "restarted" });
    expect(actual.items.map((item) => item.catalog_item_id)).toEqual(["exact"]);
  });

  it.each([
    ["an unversioned legacy cursor", legacyCursor()],
    ["a malformed cursor", "not-a-cursor"],
    [
      "a wrong cursor version",
      encodeCursorJson({ v: 3, id: "cat_1", title: "Pikachu", rank: 0.5, baseMatch: true, tier: 1 }),
    ],
  ])("restarts %s with an offset at the first page", async (_label, cursor) => {
    const { db, listValues } = scriptedRelevanceDb();
    const searchLexical = vi.fn(searchDiscoveryItems);

    const actual = await retrieveDiscoveryItems(
      { db, rescueEnabled: false, hybridEnabled: false, searchLexical, searchSemantic: vi.fn() },
      { search: "Pikachu", cursor, offset: 1, limit: 1 },
    );

    expect(searchLexical).toHaveBeenCalledExactlyOnceWith(
      db,
      expect.objectContaining({ cursor: undefined, offset: undefined, includeTotal: true }),
    );
    expect(listValues).toEqual([["active", "Pikachu", "Pikachu", "Pikachu", 2]]);
    expect(actual.items.map((item) => item.catalog_item_id)).toEqual(["exact"]);
    expect(actual).toMatchObject({ retrievalMode: "lexical", total: 2, cursorState: "restarted" });
    expect(decodeCursorJson(actual.nextCursor)).toMatchObject({ v: 2, id: "exact", tier: 1 });
  });

  it("restarts a rejected cursor with an offset at the first page when hybrid retrieval fails open", async () => {
    const { db, listValues } = scriptedRelevanceDb();
    const provider = fakeProvider();
    vi.mocked(provider.embed).mockRejectedValue(new Error("provider unavailable"));

    const actual = await retrieveDiscoveryItems(
      {
        db,
        provider,
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: true,
        searchSemantic: vi.fn(),
      },
      { search: "Pikachu", cursor: legacyCursor(), offset: 1, limit: 1 },
    );

    expect(listValues).toEqual([["active", "Pikachu", "Pikachu", "Pikachu", 2]]);
    expect(actual.items.map((item) => item.catalog_item_id)).toEqual(["exact"]);
    expect(actual).toMatchObject({ retrievalMode: "lexical", total: 2, cursorState: "restarted" });
    expect(decodeCursorJson(actual.nextCursor)).toMatchObject({ v: 2, id: "exact", tier: 1 });
  });

  it("keeps explicit-sort keyset cursors as continuations", async () => {
    const cursor = legacyCursor();
    const searchLexical = vi.fn(async () => result([row("page-2")]));

    const actual = await retrieveDiscoveryItems(
      { db: {} as never, rescueEnabled: false, hybridEnabled: false, searchLexical, searchSemantic: vi.fn() },
      { search: "pikachu", sort: "newest", cursor },
    );

    expect(searchLexical).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cursor }));
    expect(actual.cursorState).toBe("cursor");
  });

  it("classifies the effective cursor state without retrieving", () => {
    const hybrid = { provider: fakeProvider(), cache: createQueryEmbeddingCache(), hybridEnabled: true };
    const lexicalOnly = { ...hybrid, hybridEnabled: false };

    expect(classifyDiscoverySearchCursor(hybrid, { search: "pikachu" })).toBe("fresh");
    expect(classifyDiscoverySearchCursor(hybrid, { search: "pikachu", cursor: hybridCursor(24) })).toBe("cursor");
    expect(classifyDiscoverySearchCursor(lexicalOnly, { search: "pikachu", cursor: hybridCursor(24) })).toBe(
      "restarted",
    );
    expect(classifyDiscoverySearchCursor(hybrid, { search: "pikachu", sort: "newest", cursor: hybridCursor(24) })).toBe(
      "restarted",
    );
    expect(classifyDiscoverySearchCursor(lexicalOnly, { search: "pikachu", cursor: relevanceCursor() })).toBe("cursor");
    expect(classifyDiscoverySearchCursor(lexicalOnly, { search: "pikachu", cursor: legacyCursor() })).toBe("restarted");
  });

  it("keeps lexical matches ahead of semantic-only candidates in hybrid mode", async () => {
    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        provider: fakeProvider(),
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: true,
        searchLexical: vi.fn(async () => result([row("exact", "Pikachu")])),
        searchSemantic: vi.fn(async () => [{ item: row("semantic", "Electric mascot"), similarity: 0.99 }]),
        hydrateItems: vi.fn(async (_db, items) => [...items]),
      },
      { search: "Pikachu", limit: 1 },
    );

    expect(actual.retrievalMode).toBe("hybrid");
    expect(actual.items.map((item) => item.catalog_item_id)).toEqual(["exact"]);
    expect(actual.total).toBe(1);
    expect(actual.lexicalCount).toBe(1);
    expect(actual.nextCursor).not.toBeNull();
  });

  it("skips the total on hybrid cursor pages", async () => {
    const searchLexical = vi.fn(async (_db, params) => ({
      ...result([row("exact", "Pikachu")]),
      total: params.includeTotal ? 1 : null,
    }));
    const dependencies = {
      db: {} as never,
      provider: fakeProvider(),
      cache: createQueryEmbeddingCache(),
      rescueEnabled: true,
      hybridEnabled: true,
      searchLexical,
      searchSemantic: vi.fn(async () => [{ item: row("semantic", "Electric mascot"), similarity: 0.99 }]),
      hydrateItems: vi.fn(async (_db, items) => [...items]),
    };

    const firstPage = await retrieveDiscoveryItems(dependencies, { search: "Pikachu", limit: 1 });
    const cursorPage = await retrieveDiscoveryItems(dependencies, {
      search: "Pikachu",
      cursor: firstPage.nextCursor ?? undefined,
      limit: 1,
    });

    expect(searchLexical).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ includeTotal: false }),
      expect.anything(),
    );
    expect(cursorPage.total).toBeNull();
    expect(firstPage.cursorState).toBe("fresh");
    expect(cursorPage.cursorState).toBe("cursor");
  });
});

describe("Discovery search interpretation retrieval", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const explicitFinish = { dimensionId: "dim_finish", optionId: "foil" };
  // Lexical rows exist only for the remaining words under the explicit plus inferred filters.
  const interpretedLexical = (remainder: string) =>
    vi.fn(async (_db: PgQueryable, params: DiscoverySearchParams = {}) =>
      params.search === remainder && params.dimensionFilters?.some((filter) => filter.optionId === "gem-mint-10")
        ? result([row("charizard-psa-10")])
        : result([]),
    );

  it.each([false, true])(
    "an interpreted lexical hit returns final non-paging rows without any embedding (hybrid=%s)",
    async (hybridEnabled) => {
      const provider = fakeProvider();
      const searchLexical = interpretedLexical("zard");
      const searchCorrected = vi.fn();
      const actual = await retrieveDiscoveryItems(
        {
          db: emptyDb(),
          provider,
          cache: createQueryEmbeddingCache(),
          rescueEnabled: true,
          hybridEnabled,
          searchLexical,
          searchCorrected,
          loadInterpretationVocabulary: async () => vocabulary,
          searchSemantic: vi.fn(),
        },
        { search: "zard psa 10", dimensionFilters: [explicitFinish], limit: 24, includeTotal: true },
      );
      expect(actual).toMatchObject({
        retrievalMode: "lexical",
        nextCursor: null,
        interpretation: {
          remainingQuery: "zard",
          applied: [
            { param: "dimension.dim_company", optionId: "psa", label: "PSA" },
            { param: "dimension.dim_grade", optionId: "gem-mint-10", label: "Gem Mint 10" },
          ],
        },
      });
      expect(actual.items.map((item) => item.catalog_item_id)).toEqual(["charizard-psa-10"]);
      expect(searchLexical.mock.calls.at(-1)?.[1]).toMatchObject({
        search: "zard",
        limit: 24,
        dimensionFilters: [explicitFinish, ...inferred],
      });
      expect(searchCorrected).not.toHaveBeenCalled();
      expect(provider.embed).not.toHaveBeenCalled();
    },
  );

  it("an interpreted correction hit corrects only the remainder under inferred filters", async () => {
    const searchCorrected = vi.fn(
      async (_db: PgQueryable, params: DiscoverySearchParams, _tokens: readonly ProtectedSearchToken[]) =>
        params.search === "charzard" ? result([row("charizard-psa-10")]) : null,
    );
    const provider = fakeProvider();
    const actual = await retrieveDiscoveryItems(
      {
        db: emptyDb(),
        provider,
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: false,
        searchLexical: async () => result([]),
        searchCorrected,
        loadInterpretationVocabulary: async () => vocabulary,
      },
      { search: "charzard psa 10" },
    );
    expect(actual).toMatchObject({ retrievalMode: "corrected", interpretation: { remainingQuery: "charzard" } });
    expect(searchCorrected).toHaveBeenCalledOnce();
    expect(searchCorrected.mock.calls[0]?.[1]).toMatchObject({ search: "charzard", dimensionFilters: inferred });
    expect(searchCorrected.mock.calls[0]?.[2].map((token) => token.raw)).toEqual(["charzard"]);
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it("an interpreted miss discards inferred filters and corrects the original text with explicit filters", async () => {
    const searchCorrected = vi.fn(async (_db: PgQueryable, params: DiscoverySearchParams) =>
      params.search === "charzard psa 10" ? result([row("literal-correction")]) : null,
    );
    const actual = await retrieveDiscoveryItems(
      {
        db: emptyDb(),
        rescueEnabled: false,
        hybridEnabled: false,
        searchLexical: async () => result([]),
        searchCorrected,
        loadInterpretationVocabulary: async () => vocabulary,
      },
      { search: "charzard psa 10", dimensionFilters: [explicitFinish] },
    );
    expect(actual.retrievalMode).toBe("corrected");
    expect(actual).not.toHaveProperty("interpretation");
    expect(searchCorrected.mock.calls.map(([, params]) => [params.search, params.dimensionFilters])).toEqual([
      ["charzard", [explicitFinish, ...inferred]],
      ["charzard psa 10", [explicitFinish]],
    ]);
  });

  it("shares at most three correction lookups across the interpreted and original-text paths", async () => {
    const lookup = vi.fn(async (_token: string) => ({ literal: false, prefix: false, candidates: [] as string[] }));
    const budgets: SearchCorrectionBudget[] = [];
    const searchCorrected = vi.fn(
      async (_db: PgQueryable, _params: DiscoverySearchParams, tokens, budget?: SearchCorrectionBudget) => {
        budgets.push(budget as SearchCorrectionBudget);
        await buildSpellingCorrectionQueries(tokens, lookup, budget);
        return null;
      },
    );
    await retrieveDiscoveryItems(
      {
        db: emptyDb(),
        rescueEnabled: false,
        hybridEnabled: false,
        searchLexical: async () => result([]),
        searchCorrected,
        loadInterpretationVocabulary: async () => vocabulary,
      },
      { search: "chraizard blastois venosaur psa 10" },
    );
    expect(searchCorrected).toHaveBeenCalledTimes(2);
    expect(budgets[0]).toBe(budgets[1]);
    expect(lookup.mock.calls.map(([token]) => token)).toEqual(["chraizard", "blastois", "venosaur"]);
  });

  it.each([
    ["empty", async () => ({ vectors: [vector], totalTokens: 1 }), 1],
    ["error", async () => Promise.reject(new Error("provider unavailable")), 0],
  ] as const)(
    "an interpreted miss rescues only the original text with one provider attempt (%s)",
    async (_name, embed, semanticCalls) => {
      const provider = { ...fakeProvider(), embed: vi.fn(embed) };
      const searchSemantic = vi.fn(async (_db: PgQueryable, _params: DiscoverySearchParams) => []);
      const actual = await retrieveDiscoveryItems(
        {
          db: emptyDb(),
          provider,
          cache: createQueryEmbeddingCache(),
          rescueEnabled: true,
          hybridEnabled: false,
          searchLexical: async () => result([]),
          searchCorrected: async () => null,
          loadInterpretationVocabulary: async () => vocabulary,
          searchSemantic,
        },
        { search: "chraizard japanese", dimensionFilters: [explicitFinish] },
      );
      expect(actual).toMatchObject({ retrievalMode: "lexical", items: [] });
      expect(actual).not.toHaveProperty("interpretation");
      expect(provider.embed).toHaveBeenCalledOnce();
      expect(provider.embed).toHaveBeenCalledWith(["chraizard japanese"], "query", expect.anything());
      expect(searchSemantic).toHaveBeenCalledTimes(semanticCalls);
      for (const [, params] of searchSemantic.mock.calls) {
        expect(params).toMatchObject({ search: "chraizard japanese", dimensionFilters: [explicitFinish] });
        expect(params.language).toBeUndefined();
      }
    },
  );

  it("an interpreted miss waits once for the original-text embedding, bounded by the S1 deadline", async () => {
    vi.useFakeTimers();
    const provider = { ...fakeProvider(), embed: vi.fn(() => new Promise<never>(() => {})) };
    const waits: string[] = [];
    const page = retrieveDiscoveryItems(
      {
        db: emptyDb(),
        provider,
        cache: createQueryEmbeddingCache({ timeoutMs: 800 }),
        rescueEnabled: true,
        hybridEnabled: true,
        searchLexical: async () => result([]),
        searchCorrected: async () => null,
        loadInterpretationVocabulary: async () => vocabulary,
        searchSemantic: vi.fn(),
        onEmbeddingWait: (observation) => waits.push(`${observation.outcome}:${observation.waiterDurationMs}`),
      },
      { search: "chraizard japanese" },
    );
    await vi.advanceTimersByTimeAsync(800);
    await expect(page).resolves.toMatchObject({ retrievalMode: "lexical", items: [] });
    expect(provider.embed).toHaveBeenCalledOnce();
    expect(provider.embed).toHaveBeenCalledWith(["chraizard japanese"], "query", expect.anything());
    expect(waits).toEqual(["timeout:800"]);
  });

  it("a protected original skips rescue after an interpreted miss", async () => {
    const provider = fakeProvider();
    await retrieveDiscoveryItems(
      {
        db: emptyDb(),
        provider,
        cache: createQueryEmbeddingCache(),
        rescueEnabled: true,
        hybridEnabled: true,
        searchLexical: async () => result([]),
        searchCorrected: async () => null,
        loadInterpretationVocabulary: async () => vocabulary,
        searchSemantic: vi.fn(),
      },
      { search: "charzard psa 10" },
    );
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it.each([
    ["a literal hit", { search: "zard psa 10" }, [row("literal")]],
    ["a marked request", { search: "zard psa 10", interpreted: true }, []],
    ["a one-word query", { search: "japanese" }, []],
    ["a cursor page", { search: "zard psa 10", cursor: "bad" }, []],
    ["an explicit sort", { search: "zard psa 10", sort: "price_asc" }, []],
  ] as const)("never interprets %s", async (_name, params, rows) => {
    const loadInterpretationVocabulary = vi.fn(async () => vocabulary);
    await retrieveDiscoveryItems(
      {
        db: emptyDb(),
        rescueEnabled: false,
        hybridEnabled: false,
        searchLexical: async () => result([...rows]),
        searchCorrected: async () => null,
        loadInterpretationVocabulary,
      },
      params,
    );
    expect(loadInterpretationVocabulary).not.toHaveBeenCalled();
  });

  it("an empty remainder discards the interpretation without a browse-all query", async () => {
    const searchLexical = vi.fn(async (_db: PgQueryable, _params?: DiscoverySearchParams) => result([]));
    const actual = await retrieveDiscoveryItems(
      {
        db: emptyDb(),
        rescueEnabled: false,
        hybridEnabled: false,
        searchLexical,
        searchCorrected: async () => null,
        loadInterpretationVocabulary: async () => vocabulary,
      },
      { search: "psa 10" },
    );
    expect(searchLexical.mock.calls.map(([, params]) => params?.search)).toEqual(["psa 10"]);
    expect(actual).not.toHaveProperty("interpretation");
  });

  // A deterministic provider with a distinct semantic-only row, so any rescue or hybrid work
  // on the marked canonical request would change its rows.
  const semanticDependencies = (
    hybridEnabled: boolean,
    searchLexical: (db: PgQueryable, params?: DiscoverySearchParams) => Promise<ListResult<DiscoverySearchItemRow>>,
    searchCorrected: (
      db: PgQueryable,
      params: DiscoverySearchParams,
    ) => Promise<ListResult<DiscoverySearchItemRow> | null>,
  ) => ({
    db: emptyDb(),
    provider: fakeProvider(),
    cache: createQueryEmbeddingCache(),
    rescueEnabled: true,
    hybridEnabled,
    searchLexical: vi.fn(searchLexical),
    searchCorrected: vi.fn(searchCorrected),
    loadInterpretationVocabulary: async () => vocabulary,
    searchSemantic: vi.fn(async () => [{ item: row("semantic-only"), similarity: 0.99 }]),
    hydrateItems: async (_db: PgQueryable, items: readonly DiscoverySearchItemRow[]) => [...items],
  });
  const marked = (remainingQuery: string) => ({
    search: remainingQuery,
    dimensionFilters: inferred,
    interpreted: true,
  });
  const gemMint10Only = (params: DiscoverySearchParams = {}) =>
    params.dimensionFilters?.some((filter) => filter.optionId === "gem-mint-10") ?? false;
  const summarize = (page: DiscoverySearchResult) => ({
    items: page.items,
    total: page.total,
    nextCursor: page.nextCursor,
    retrievalMode: page.retrievalMode,
  });

  it.each([false, true])(
    "a marked canonical request returns the interpreted rows without semantic work (hybrid=%s)",
    async (hybridEnabled) => {
      const lexicalHit = semanticDependencies(
        hybridEnabled,
        async (_db, params) => result(params?.search === "zard" && gemMint10Only(params) ? [row("lexical")] : []),
        async () => null,
      );
      const correctionHit = semanticDependencies(
        hybridEnabled,
        async () => result([]),
        async (_db, params) =>
          params.search === "charzard" && gemMint10Only(params) ? result([row("corrected")]) : null,
      );
      for (const [dependencies, search] of [
        [lexicalHit, "zard psa 10"],
        [correctionHit, "charzard psa 10"],
      ] as const) {
        const direct = await retrieveDiscoveryItems(dependencies, { search });
        expect(direct.interpretation?.applied.map((value) => value.param)).toEqual([
          "dimension.dim_company",
          "dimension.dim_grade",
        ]);
        const canonical = await retrieveDiscoveryItems(
          dependencies,
          marked(direct.interpretation?.remainingQuery ?? ""),
        );
        expect(summarize(canonical)).toEqual(summarize(direct));
        expect(canonical).not.toHaveProperty("interpretation");
        expect(dependencies.provider.embed).not.toHaveBeenCalled();
        expect(dependencies.searchSemantic).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "a marked canonical request that later finds nothing stays empty (hybrid=%s)",
    async (hybridEnabled) => {
      const dependencies = semanticDependencies(
        hybridEnabled,
        async () => result([]),
        async () => null,
      );
      const actual = await retrieveDiscoveryItems(dependencies, marked("zard"));
      expect(actual).toMatchObject({ retrievalMode: "lexical", items: [], nextCursor: null });
      expect(dependencies.searchCorrected).toHaveBeenCalledOnce();
      expect(dependencies.provider.embed).not.toHaveBeenCalled();
      expect(dependencies.searchSemantic).not.toHaveBeenCalled();
    },
  );

  it.each([
    [false, "rescue"],
    [true, "hybrid"],
  ] as const)("the same unmarked request keeps semantic retrieval (hybrid=%s)", async (hybridEnabled, mode) => {
    const dependencies = semanticDependencies(
      hybridEnabled,
      async (_db, params) => result(params?.search === "zard" ? [row("lexical")] : []),
      async () => null,
    );
    const actual = await retrieveDiscoveryItems(dependencies, { search: "zard", dimensionFilters: inferred });
    expect(actual.retrievalMode).toBe(mode);
    expect(actual.items.map((item) => item.catalog_item_id)).toEqual(["lexical", "semantic-only"]);
    expect(dependencies.provider.embed).toHaveBeenCalledOnce();
  });

  it("a marked request restarts a hybrid cursor and continues a lexical cursor lexically", async () => {
    const hybrid = { provider: fakeProvider(), cache: createQueryEmbeddingCache(), hybridEnabled: true };
    expect(classifyDiscoverySearchCursor(hybrid, { ...marked("zard"), cursor: hybridCursor(24) })).toBe("restarted");
    expect(classifyDiscoverySearchCursor(hybrid, { ...marked("zard"), cursor: relevanceCursor() })).toBe("cursor");

    const dependencies = semanticDependencies(
      true,
      async (_db, params) => result(params?.search === "zard" ? [row("lexical")] : []),
      async () => null,
    );
    const restarted = await retrieveDiscoveryItems(dependencies, { ...marked("zard"), cursor: hybridCursor(24) });
    expect(restarted).toMatchObject({ cursorState: "restarted", retrievalMode: "lexical" });
    expect(restarted.items.map((item) => item.catalog_item_id)).toEqual(["lexical"]);
    expect(dependencies.searchLexical.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: undefined, includeTotal: true });
    expect(dependencies.provider.embed).not.toHaveBeenCalled();
    expect(dependencies.searchSemantic).not.toHaveBeenCalled();
  });
});

function emptyDb(): PgQueryable {
  return { query: async () => ({ rows: [], rowCount: 0 }) };
}

function legacyCursor(): string {
  return encodeCursorJson({
    id: "cat_1",
    title: "Pikachu",
    updatedAt: "2026-07-10T00:00:00.000Z",
    rank: 0.5,
    baseMatch: true,
    lowestPriceAmount: null,
  });
}

function relevanceCursor(): string {
  return encodeCursorJson({
    v: 2,
    id: "cat_1",
    title: "Pikachu",
    updatedAt: "2026-07-10T00:00:00.000Z",
    rank: 0.5,
    baseMatch: true,
    tier: 1,
    lowestPriceAmount: null,
  });
}

function hybridCursor(offset: number): string {
  return encodeCursorJson({ kind: "hybrid", offset });
}

function encodeCursorJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursorJson(cursor: string | null): unknown {
  return JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
}

// Plays the Search Index for one relevance Result Set (the exact title first, then one
// other), applying only the emitted LIMIT/OFFSET bindings; SQL order is the DB tests' job.
function scriptedRelevanceDb() {
  const listValues: Array<readonly unknown[]> = [];
  const indexRow = (catalogItemId: string, title: string, tier: number, rank: number) => ({
    ...row(catalogItemId, title),
    lowest_price_amount: null,
    lowest_price_currency_code: null,
    visible_quantity: null,
    search_rank: rank,
    search_base_match: true,
    search_exact_tier: tier,
    search_title_identity: title.toLowerCase(),
  });
  const rows = [indexRow("exact", "Pikachu", 1, 0.1), indexRow("other", "Pikachu V", 0, 0.9)];
  const db: PgQueryable = {
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      let page: unknown[] = [];
      if (sql.startsWith("SELECT COUNT(*) AS count")) page = [{ count: String(rows.length) }];
      if (sql.startsWith("SELECT * FROM (")) {
        listValues.push(values);
        const offset = sql.includes("OFFSET $") ? Number(values.at(-1)) : 0;
        page = rows.slice(offset, offset + Number(values.at(sql.includes("OFFSET $") ? -2 : -1)));
      }
      return { rows: page as Row[], rowCount: page.length };
    },
  };
  return { db, listValues };
}

function fakeProvider(): DiscoveryEmbeddingProvider {
  return {
    model: "fake-query-model",
    dimensions: 1_024,
    embed: vi.fn(async () => ({ vectors: [vector], totalTokens: 1 })),
  };
}

function result(items: DiscoverySearchItemRow[]): ListResult<DiscoverySearchItemRow> {
  return { items, facets: [], category_counts: [], total: items.length, nextCursor: null };
}

function row(catalogItemId: string, title = catalogItemId): DiscoverySearchItemRow {
  return {
    catalog_item_id: catalogItemId,
    slug: catalogItemId,
    language_code: "en",
    title_i18n: {},
    title,
    subtitle_i18n: null,
    subtitle: null,
    display_badges: [],
    description_i18n: {},
    description: "",
    blueprint_id: null,
    blueprint_name: null,
    status: "active",
    category_names: [],
    category_slugs: [],
    tags: [],
    image_urls: [],
    product_asset_sets: [],
    image_fallback: null,
    market_summary: null,
    updated_at: "2026-07-10T00:00:00.000Z",
  };
}
