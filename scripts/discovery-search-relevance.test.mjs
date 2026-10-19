import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDiscoverySearchRelevanceOptions, validateFixtures } from "./discovery-search-relevance.mjs";
import {
  deterministicSparseEmbedding,
  expandSparseEmbedding,
  fixtureSourceHash,
  buildRelevanceEmbeddingFixture,
  parseRelevanceEmbeddingOptions,
  embeddingInputKey,
  createRelevanceFixtureProvider,
  resolveRelevanceSnapshotOutput,
} from "./discovery-search-relevance-embeddings.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = path.join(root, "bounded-contexts/discovery/tests/fixtures/search-relevance");

describe("Discovery search relevance runner", () => {
  it("real generator boundary", async () => {
    expect(() =>
      createRelevanceFixtureProvider("voyage", {}, () => {
        throw new Error("must not create");
      }),
    ).toThrow(/VOYAGE_API_KEY is required/);
    expect(
      createRelevanceFixtureProvider(
        "deterministic",
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("must not read env");
            },
          },
        ),
        () => {
          throw new Error("must not create");
        },
      ),
    ).toBeUndefined();
    expect(parseRelevanceEmbeddingOptions(["--provider=voyage", "--out=artifacts/real.json"])).toMatchObject({
      provider: "voyage",
      out: "artifacts/real.json",
    });
    expect(() => parseRelevanceEmbeddingOptions(["--provider=voyage"])).toThrow(/out/);
    expect(resolveRelevanceSnapshotOutput(root, "artifacts/test-vectors.json", () => true)).toBe(
      path.resolve(root, "artifacts/test-vectors.json"),
    );
    expect(() => resolveRelevanceSnapshotOutput(root, "../outside.json", () => true)).toThrow(/inside/);
    expect(() => resolveRelevanceSnapshotOutput(root, "tracked.json", () => false)).toThrow(/ignored/);
    const { buildDiscoveryEmbeddingDocument } =
      await import("../bounded-contexts/discovery/features/search/domain/embedding-document.ts");
    const { normalizeQueryForEmbedding } =
      await import("../bounded-contexts/discovery/features/search/domain/query-embedding-cache.ts");
    const catalogItems = [
      {
        catalogItemId: "one",
        languageCode: "en",
        title: "Éclair",
        subtitle: "Base",
        description: "Body",
        categories: ["Cards"],
        tags: ["not-an-embedding-field"],
        aliases: ["Alias"],
      },
    ];
    const goldenQueries = [{ id: "never-the-lookup-key", query: "ÉCLAIR_foo!" }];
    const calls = [];
    const provider = {
      model: "synthetic-real-boundary",
      dimensions: 1024,
      embed: async (texts, inputType) => {
        calls.push({ texts, inputType });
        return {
          vectors: texts.map(() => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 2 : 0))),
          totalTokens: 1,
        };
      },
    };
    const fixture = await buildRelevanceEmbeddingFixture({
      catalogItems,
      goldenQueries,
      buildDocument: buildDiscoveryEmbeddingDocument,
      normalizeQuery: normalizeQueryForEmbedding,
      provider,
    });
    expect(calls).toEqual([
      {
        texts: ["title: Éclair\nsubtitle: Base\naliases: Alias\ncategories: Cards\ndescription: Body"],
        inputType: "document",
      },
      { texts: [normalizeQueryForEmbedding(goldenQueries[0].query)], inputType: "query" },
    ]);
    expect(
      fixture.queries[embeddingInputKey(provider.model, "query", normalizeQueryForEmbedding(goldenQueries[0].query))],
    ).toEqual([[0, 1]]);
    expect(fixture.documentProvenance.one.text).not.toContain("not-an-embedding-field");
  });
  it("defaults to a gate-enforcing JSON and Markdown report", () => {
    expect(parseDiscoverySearchRelevanceOptions([])).toEqual({
      jsonOut: "artifacts/discovery-search-relevance/report.json",
      markdownOut: "artifacts/discovery-search-relevance/report.md",
      enforceGate: true,
      embeddingFixture: "bounded-contexts/discovery/tests/fixtures/search-relevance/fixture-embeddings.json",
      rankedInput: null,
    });
    expect(parseDiscoverySearchRelevanceOptions(["--report-only"]).enforceGate).toBe(false);
    expect(() => parseDiscoverySearchRelevanceOptions(["--in-memory"])).toThrow(/Unknown/);
    expect(parseDiscoverySearchRelevanceOptions(["--embedding-fixture=artifacts/real.json"]).embeddingFixture).toBe(
      "artifacts/real.json",
    );
  });

  it("keeps deterministic embeddings finite, normalized, and 1024-dimensional", () => {
    const first = deterministicSparseEmbedding("sealed box with charizard");
    expect(deterministicSparseEmbedding("sealed box with charizard")).toEqual(first);
    const vector = expandSparseEmbedding(first);
    expect(vector).toHaveLength(1_024);
    expect(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 6);
  });

  it("checks in a current 50-100 query fixture with all required coverage", async () => {
    const [catalogItems, goldenQueries, embeddingFixture] = await Promise.all([
      readJson("catalog-items.json"),
      readJson("golden-queries.json"),
      readJson("fixture-embeddings.json"),
    ]);
    expect(goldenQueries).toHaveLength(72);
    expect(embeddingFixture.sourceHash).toBe(fixtureSourceHash(catalogItems, goldenQueries));
    await expect(validateFixtures(catalogItems, goldenQueries, embeddingFixture)).resolves.toBeUndefined();
    expect(embeddingFixture.model).toBe("deterministic-relevance-v1");
  });
  it("normalized input tuple lookup and missing effective-query vector fails", async () => {
    const { normalizeQueryForEmbedding } =
      await import("../bounded-contexts/discovery/features/search/domain/query-embedding-cache.ts");
    const [items, queries, fixture] = await Promise.all([
      readJson("catalog-items.json"),
      readJson("golden-queries.json"),
      readJson("fixture-embeddings.json"),
    ]);
    const text = normalizeQueryForEmbedding(queries[0].query);
    expect(fixture.queries[queries[0].id]).toBeUndefined();
    const key = embeddingInputKey(fixture.model, "query", text);
    expect(fixture.queryProvenance[key]).toEqual({ text, inputType: "query", model: fixture.model });
    const missing = structuredClone(fixture);
    delete missing.queries[key];
    await expect(validateFixtures(items, queries, missing)).rejects.toThrow(/Missing effective-query vector/);
    await expect(
      validateFixtures(
        items,
        queries.map((query, index) => (index ? query : { ...query, effectiveQueries: ["missing effective text"] })),
        fixture,
      ),
    ).rejects.toThrow(/Missing effective-query vector/);
  });
  it("regenerates the offline snapshot identically", async () => {
    const { buildDiscoveryEmbeddingDocument } =
      await import("../bounded-contexts/discovery/features/search/domain/embedding-document.ts");
    const { normalizeQueryForEmbedding } =
      await import("../bounded-contexts/discovery/features/search/domain/query-embedding-cache.ts");
    const [catalogItems, goldenQueries, fixture] = await Promise.all([
      readJson("catalog-items.json"),
      readJson("golden-queries.json"),
      readJson("fixture-embeddings.json"),
    ]);
    expect(
      await buildRelevanceEmbeddingFixture({
        catalogItems,
        goldenQueries,
        buildDocument: buildDiscoveryEmbeddingDocument,
        normalizeQuery: normalizeQueryForEmbedding,
      }),
    ).toEqual(fixture);
  });
  it("rejects unknown and out-of-bound GoldenQuery requests", async () => {
    const { validateGoldenQuery } =
      await import("../bounded-contexts/discovery/features/search/domain/relevance-evaluation.ts");
    const query = (await readJson("golden-queries.json"))[0];
    for (const request of [
      { limit: 51 },
      { sql: "SELECT 1" },
      { priceMax: "-1" },
      { priceMin: "20", priceMax: "2" },
      { inStock: "true" },
      { language: "toolong" },
      { dimensionFilters: Array.from({ length: 11 }, () => ({ dimensionId: "d", optionId: "o" })) },
    ])
      expect(() => validateGoldenQuery({ ...query, request })).toThrow();
    expect(() =>
      validateGoldenQuery({
        ...query,
        request: {
          language: "en",
          inStock: true,
          priceMin: "2",
          priceMax: "3",
          sort: "price_asc",
          dimensionFilters: [{ dimensionId: "finish", optionId: "foil" }],
        },
      }),
    ).not.toThrow();
  });
});

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(fixtures, fileName), "utf8"));
}
