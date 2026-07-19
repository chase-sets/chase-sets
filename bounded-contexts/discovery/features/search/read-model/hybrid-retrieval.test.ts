import { describe, expect, it, vi } from "vitest";
import { createQueryEmbeddingCache } from "../domain/query-embedding-cache";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";
import { retrieveDiscoveryItems } from "./hybrid-retrieval";
import type { DiscoverySearchItemRow, ListResult } from "./queries";

const vector = Array.from({ length: 1_024 }, (_, index) => (index === 0 ? 1 : 0));

describe("Discovery hybrid retrieval", () => {
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
    expect(provider.embed).toHaveBeenCalledWith(["blue dragon"], "query");
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

    expect(actual).toEqual({ ...lexical, retrievalMode: "lexical", lexicalCount: 0 });
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

    expect(actual).toEqual({ ...lexical, retrievalMode: "lexical", lexicalCount: 1 });
  });

  it("resolves a structured set-code + collector-number query ahead of lexical/semantic retrieval", async () => {
    const searchNaturalKey = vi.fn(async () => result([row("sv04-123", "Charizard ex")]));
    const searchLexical = vi.fn();
    const searchSemantic = vi.fn();

    const actual = await retrieveDiscoveryItems(
      {
        db: {} as never,
        rescueEnabled: false,
        hybridEnabled: false,
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

  it("skips structured resolution when paging (a cursor is present)", async () => {
    const searchNaturalKey = vi.fn();
    const searchLexical = vi.fn(async () => result([row("page-2")]));

    await retrieveDiscoveryItems(
      {
        db: {} as never,
        rescueEnabled: false,
        hybridEnabled: false,
        searchNaturalKey,
        searchLexical,
        searchSemantic: vi.fn(),
      },
      { search: "sv04 123", cursor: "some-cursor" },
    );

    expect(searchNaturalKey).not.toHaveBeenCalled();
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
});

function fakeProvider(): DiscoveryEmbeddingProvider {
  return {
    model: "fake-query-model",
    dimensions: 1_024,
    embed: vi.fn(async () => ({ vectors: [vector], totalTokens: 1 })),
  };
}

function result(items: DiscoverySearchItemRow[]): ListResult<DiscoverySearchItemRow> {
  return { items, facets: [], total: items.length, nextCursor: null };
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
