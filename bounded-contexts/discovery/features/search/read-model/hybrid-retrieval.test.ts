import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryEmbeddingCache } from "../domain/query-embedding-cache";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";
import { classifyDiscoverySearchCursor, retrieveDiscoveryItems } from "./hybrid-retrieval";
import { searchDiscoveryItems, type DiscoverySearchItemRow, type ListResult } from "./queries";

const vector = Array.from({ length: 1_024 }, (_, index) => (index === 0 ? 1 : 0));

describe("Discovery hybrid retrieval", () => {
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
    expect(searchLexical).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cursor }));
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
