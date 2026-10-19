import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as discoveryModule } from "..";
import * as relevanceDomain from "../features/search/domain/relevance-evaluation";
import {
  runDiscoveryRelevanceEvaluation,
  seedDiscoveryRelevanceCatalog,
  type RelevanceCatalogFixtureItem,
  type RelevanceEmbeddingFixture,
  relevanceEmbeddingInputKey,
} from "../features/search/read-model/relevance-evaluation";
import { findSimilarDiscoveryItems } from "../features/search/read-model/similar-items";
import { createQueryEmbeddingCache, normalizeQueryForEmbedding } from "../features/search/domain/query-embedding-cache";
import { retrieveDiscoveryItems } from "../features/search/read-model/hybrid-retrieval";
import type { DiscoveryEmbeddingProvider } from "../features/search/integrations/voyage-embedding-provider";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureDirectory = path.join(root, "bounded-contexts/discovery/tests/fixtures/search-relevance");
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
let pool: PgTransactionalPool;
let report: relevanceDomain.RelevanceReport;

describe("Discovery search golden-query relevance gate", () => {
  beforeAll(async () => {
    if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for the Discovery relevance DB lane.");
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl, ["discovery"], "search_relevance");
    await ensureMultiContextTestDatabases(databaseBaseUrl, databaseUrls);
    const pools = createMultiContextTestPools(databaseUrls);
    pool = pools.discovery;
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(discoveryModule, pool);
  });

  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  it("production projection/live dispatcher parity", async () => {
    const [catalogItems, goldenQueries, embeddingFixture] = await Promise.all([
      readJson("catalog-items.json"),
      readJson("golden-queries.json"),
      readEmbeddings(),
    ]);
    report = await withPgTransaction(pool, (db) =>
      runDiscoveryRelevanceEvaluation(db, {
        catalogItems: catalogItems as readonly RelevanceCatalogFixtureItem[],
        goldenQueries: goldenQueries as readonly relevanceDomain.GoldenQuery[],
        embeddingFixture: embeddingFixture as RelevanceEmbeddingFixture,
        generatedAt: new Date().toISOString(),
      }),
    );
    const markdown = relevanceDomain.renderRelevanceMarkdown(report);
    const jsonPath = path.resolve(
      root,
      process.env.DISCOVERY_RELEVANCE_JSON_OUT ?? "artifacts/discovery-search-relevance/report.json",
    );
    const markdownPath = path.resolve(
      root,
      process.env.DISCOVERY_RELEVANCE_MARKDOWN_OUT ?? "artifacts/discovery-search-relevance/report.md",
    );
    await mkdir(path.dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, markdown, "utf8");
    process.stdout.write(
      `\n${markdown}JSON: ${path.relative(root, jsonPath)}\nMarkdown: ${path.relative(root, markdownPath)}\n`,
    );

    expect(report.fixture.goldenQueryCount).toBeGreaterThanOrEqual(50);
    expect(report.fixture.coverage).toEqual(
      expect.arrayContaining(["en", "ja", "alias", "misspelling", "semantic-intent", "zero-result"]),
    );
    if (process.env.DISCOVERY_RELEVANCE_ENFORCE_GATE !== "false") {
      expect(() => relevanceDomain.assertRelevanceGate(report)).not.toThrow();
    }
    const fixture = embeddingFixture as RelevanceEmbeddingFixture;
    for (const mode of relevanceDomain.RELEVANCE_MODES) {
      for (const query of goldenQueries as readonly relevanceDomain.GoldenQuery[]) {
        let calls = 0;
        const provider: DiscoveryEmbeddingProvider = {
          model: fixture.model,
          dimensions: 1024,
          embed: async (texts, inputType) => {
            calls += 1;
            expect(inputType).toBe("query");
            if (query.scenario === "provider-failure") throw new Error("Synthetic provider failure.");
            return {
              vectors: texts.map((text) => {
                expect(text).toBe(normalizeQueryForEmbedding(query.query));
                return expandSparseEmbedding(
                  fixture.queries[relevanceEmbeddingInputKey(fixture.model, "query", text)]!,
                  1024,
                );
              }),
              totalTokens: 0,
            };
          },
        };
        const page = await retrieveDiscoveryItems(
          {
            db: pool,
            provider,
            cache: createQueryEmbeddingCache(),
            rescueEnabled: mode !== "lexical-only",
            hybridEnabled: mode === "hybrid",
          },
          { ...query.request, search: query.query, limit: 50, includeTotal: true },
        );
        const actual = report.modes[mode].cases.find((item) => item.id === query.id)!;
        expect(actual.resultItemIds, `${mode}/${query.id}`).toEqual(
          page.items.slice(0, 10).map((item) => item.catalog_item_id),
        );
        expect(actual.live).toEqual({
          retrievalMode: page.retrievalMode,
          interpretation: page.interpretation ?? null,
          total: page.total,
          facets: page.facets,
          categoryCounts: page.category_counts,
          lexicalCount: page.lexicalCount,
          providerCalls: calls,
          resultItemIds: page.items.map((item) => item.catalog_item_id),
        });
        expect(actual.summaries).toEqual(
          page.items.map((item) => ({
            catalogItemId: item.catalog_item_id,
            summary: item.market_summary
              ? {
                  price: item.market_summary.lowest_price_amount,
                  currency: item.market_summary.lowest_price_currency_code ?? null,
                  inStock: item.market_summary.total_visible_quantity > 0,
                  buy: item.market_summary.active_listing_count > 0 && item.market_summary.total_visible_quantity > 0,
                }
              : null,
          })),
        );
      }
    }
  });

  it("lexical baseline never calls provider", () => {
    expect(report.modes["lexical-only"].cases.every((item) => item.live?.providerCalls === 0)).toBe(true);
    expect(
      report.modes["lexical-only"].cases.find((item) => item.id === "attribute-typo")?.live?.interpretation,
    ).not.toBeNull();
    for (const mode of relevanceDomain.RELEVANCE_MODES) {
      expect(report.modes[mode].cases.find((item) => item.id === "structured")?.live?.retrievalMode).toBe("structured");
      expect(report.modes[mode].cases.find((item) => item.id === "protected-wrong-printing")?.live?.providerCalls).toBe(
        0,
      );
    }
  });

  it("exact ranking comes from live search: title+subtitle hybrid reorder delta", async () => {
    const items: readonly RelevanceCatalogFixtureItem[] = [
      {
        catalogItemId: "exact-title-subtitle",
        languageCode: "en",
        title: "Aurora",
        subtitle: "Dragon",
        description: "",
        aliases: [],
        categories: [],
        tags: [],
      },
      {
        catalogItemId: "nonexact",
        languageCode: "en",
        title: "Aardvark Aurora",
        subtitle: "Dragon Signal",
        description: "",
        aliases: [],
        categories: [],
        tags: [],
      },
    ];
    await withPgTransaction(pool, (db) =>
      seedDiscoveryRelevanceCatalog(
        db,
        items,
        { "exact-title-subtitle": axis(1), nonexact: axis(0) },
        "synthetic-adversarial",
      ),
    );
    const provider: DiscoveryEmbeddingProvider = {
      model: "synthetic-adversarial",
      dimensions: 1024,
      embed: async () => ({ vectors: [axis(0)], totalTokens: 0 }),
    };
    const query: relevanceDomain.GoldenQuery = {
      id: "title+subtitle hybrid reorder delta",
      query: "Aurora Dragon",
      category: "exact",
      coverage: ["title-subtitle"],
      expected: { kind: "items", itemIds: ["exact-title-subtitle"] },
    };
    const modes = {} as Record<relevanceDomain.RelevanceMode, relevanceDomain.RelevanceModeReport>;
    for (const mode of relevanceDomain.RELEVANCE_MODES) {
      const page = await retrieveDiscoveryItems(
        {
          db: pool,
          provider,
          cache: createQueryEmbeddingCache(),
          rescueEnabled: mode !== "lexical-only",
          hybridEnabled: mode === "hybrid",
        },
        { search: query.query, includeTotal: true, limit: 50 },
      );
      const ids = page.items.map((item) => item.catalog_item_id);
      expect(ids).toEqual(
        mode === "hybrid" ? ["nonexact", "exact-title-subtitle"] : ["exact-title-subtitle", "nonexact"],
      );
      modes[mode] = relevanceDomain.summarizeRelevanceMode(mode, [
        relevanceDomain.evaluateGoldenQuery(
          query,
          ids.map((catalogItemId) => ({ catalogItemId })),
        ),
      ]);
    }
    const fusion = relevanceDomain.composeRelevanceCandidates(
      "hybrid",
      [
        {
          catalogItemId: "exact-title-subtitle",
          title: "Aurora",
          exactTitleMatch: false,
          lexicalRank: 1,
          semanticRank: null,
          semanticSimilarity: null,
        },
        {
          catalogItemId: "nonexact",
          title: "Aardvark Aurora",
          exactTitleMatch: false,
          lexicalRank: 2,
          semanticRank: null,
          semanticSimilarity: null,
        },
      ],
      [
        {
          catalogItemId: "nonexact",
          title: "Aardvark Aurora",
          exactTitleMatch: false,
          lexicalRank: null,
          semanticRank: 1,
          semanticSimilarity: 1,
        },
      ],
    );
    expect(fusion.map((item) => item.catalogItemId)).toEqual(["nonexact", "exact-title-subtitle"]);
    const delta = relevanceDomain.buildRelevanceReport({
      generatedAt: new Date().toISOString(),
      sourceHash: "synthetic-adversarial",
      embeddingModel: provider.model,
      dimensions: 1024,
      catalogItemCount: 2,
      goldenQueries: [query],
      modes,
    });
    expect(delta.comparison.gateFailures).toEqual([]);
    expect(delta.comparison.deltas).toContainEqual(expect.stringContaining("title+subtitle hybrid reorder delta"));
    expect(() => relevanceDomain.assertRelevanceGate(delta)).not.toThrow();
    process.stdout.write(`\n${relevanceDomain.renderRelevanceMarkdown(delta)}\n`);
  });

  it("live rescue below three", async () => {
    const items: readonly RelevanceCatalogFixtureItem[] = [
      {
        catalogItemId: "first",
        languageCode: "en",
        title: "Aurora",
        subtitle: "Dragon",
        description: "",
        aliases: [],
        categories: [],
        tags: [],
      },
      {
        catalogItemId: "second",
        languageCode: "en",
        title: "Other Aurora",
        subtitle: "",
        description: "",
        aliases: [],
        categories: [],
        tags: [],
      },
      {
        catalogItemId: "neighbor",
        languageCode: "en",
        title: "Neighbor",
        subtitle: "",
        description: "",
        aliases: [],
        categories: [],
        tags: [],
      },
    ];
    await withPgTransaction(pool, (db) =>
      seedDiscoveryRelevanceCatalog(
        db,
        items,
        Object.fromEntries(items.map((item) => [item.catalogItemId, axis(0)])),
        "synthetic-rescue",
      ),
    );
    let calls = 0;
    const provider: DiscoveryEmbeddingProvider = {
      model: "synthetic-rescue",
      dimensions: 1024,
      embed: async () => {
        calls += 1;
        return { vectors: [axis(0)], totalTokens: 0 };
      },
    };
    for (const [search, count] of [
      ["unmatched", 0],
      ["Neighbor", 1],
      ["Aurora", 2],
    ] as const) {
      const baseline = await retrieveDiscoveryItems(
        { db: pool, provider, cache: createQueryEmbeddingCache(), rescueEnabled: false, hybridEnabled: false },
        { search, includeTotal: true },
      );
      expect(baseline.items).toHaveLength(count);
      const before = calls;
      const rescue = await retrieveDiscoveryItems(
        { db: pool, provider, cache: createQueryEmbeddingCache(), rescueEnabled: true, hybridEnabled: false },
        { search, includeTotal: true },
      );
      expect(calls).toBe(before + 1);
      expect(rescue.retrievalMode).toBe("rescue");
      expect(rescue.items).toHaveLength(3);
      expect(rescue.items.slice(0, count)).toEqual(baseline.items);
      expect(rescue.total).toBe(baseline.total);
      expect(rescue.facets).toEqual(baseline.facets);
    }
  });

  it("Similar Items exclusions", async () => {
    const catalogItems = (await readJson("catalog-items.json")) as readonly RelevanceCatalogFixtureItem[];
    const embeddingFixture = (await readEmbeddings()) as RelevanceEmbeddingFixture;
    const documentEmbeddings = Object.fromEntries(
      Object.entries(embeddingFixture.documents).map(([itemId, components]) => [
        itemId,
        expandSparseEmbedding(components, embeddingFixture.dimensions),
      ]),
    );
    await withPgTransaction(pool, (db) =>
      seedDiscoveryRelevanceCatalog(db, catalogItems, documentEmbeddings, embeddingFixture.model),
    );

    const semantic = await findSimilarDiscoveryItems(pool, "charizard-base-4", {
      limit: 8,
      semanticEnabled: true,
    });
    const semanticIds = semantic?.items.map((item) => item.catalog_item_id) ?? [];
    const charizardPrintingRank = semanticIds.indexOf("charizard-ex-ja-066");
    const unrelatedRank = semanticIds.indexOf("agumon-bt14-001");

    expect(semantic?.mode).toBe("semantic");
    expect(semanticIds).not.toContain("charizard-base-4");
    expect(charizardPrintingRank).toBeGreaterThanOrEqual(0);
    expect(unrelatedRank === -1 || charizardPrintingRank < unrelatedRank).toBe(true);

    await pool.query(`UPDATE discovery_search_items SET status = 'archived' WHERE catalog_item_id = $1`, [
      "charizard-ex-ja-066",
    ]);
    const withoutDelisted = await findSimilarDiscoveryItems(pool, "charizard-base-4", {
      limit: 8,
      semanticEnabled: true,
    });
    expect(withoutDelisted?.items.map((item) => item.catalog_item_id)).not.toContain("charizard-ex-ja-066");

    await pool.query(`UPDATE discovery_search_items SET status = 'active' WHERE catalog_item_id = $1`, [
      "charizard-ex-ja-066",
    ]);
    await pool.query(`UPDATE discovery_search_items SET search_embedding = NULL WHERE catalog_item_id = $1`, [
      "charizard-base-4",
    ]);
    const nullEmbeddingFallback = await findSimilarDiscoveryItems(pool, "charizard-base-4", {
      limit: 8,
      semanticEnabled: true,
    });
    expect(nullEmbeddingFallback?.mode).toBe("category");
    expect(nullEmbeddingFallback?.items.map((item) => item.catalog_item_id)).not.toContain("charizard-base-4");
  });
});

async function readJson(fileName: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtureDirectory, fileName), "utf8")) as unknown;
}

async function readEmbeddings(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      process.env.DISCOVERY_RELEVANCE_EMBEDDING_FIXTURE ?? path.join(fixtureDirectory, "fixture-embeddings.json"),
      "utf8",
    ),
  );
}

function expandSparseEmbedding(components: readonly (readonly [number, number])[], dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const [index, value] of components) vector[index] = value;
  return vector;
}

function axis(index: number): number[] {
  return Array.from({ length: 1024 }, (_, position) => Number(position === index));
}
