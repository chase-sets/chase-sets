import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDiscoverySearchRelevanceOptions, validateFixtures } from "./discovery-search-relevance.mjs";
import {
  deterministicSparseEmbedding,
  expandSparseEmbedding,
  fixtureSourceHash,
} from "./discovery-search-relevance-embeddings.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = path.join(root, "bounded-contexts/discovery/tests/fixtures/search-relevance");

describe("Discovery search relevance runner", () => {
  it("defaults to a gate-enforcing JSON and Markdown report", () => {
    expect(parseDiscoverySearchRelevanceOptions([])).toEqual({
      jsonOut: "artifacts/discovery-search-relevance/report.json",
      markdownOut: "artifacts/discovery-search-relevance/report.md",
      enforceGate: true,
      inMemory: false,
    });
    expect(parseDiscoverySearchRelevanceOptions(["--report-only"]).enforceGate).toBe(false);
    expect(parseDiscoverySearchRelevanceOptions(["--in-memory"]).inMemory).toBe(true);
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
    expect(goldenQueries).toHaveLength(63);
    expect(embeddingFixture.sourceHash).toBe(fixtureSourceHash(catalogItems, goldenQueries));
    expect(() => validateFixtures(catalogItems, goldenQueries, embeddingFixture)).not.toThrow();
    expect(embeddingFixture.model).toBe("deterministic-relevance-v1");
  });
});

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(fixtures, fileName), "utf8"));
}
