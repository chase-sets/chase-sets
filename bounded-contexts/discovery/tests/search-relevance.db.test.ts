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
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as discoveryModule } from "..";
import * as relevanceDomain from "../features/search/domain/relevance-evaluation";
import {
  runDiscoveryRelevanceEvaluation,
  seedDiscoveryRelevanceCatalog,
  type RelevanceCatalogFixtureItem,
  type RelevanceEmbeddingFixture,
} from "../features/search/read-model/relevance-evaluation";
import { findSimilarDiscoveryItems } from "../features/search/read-model/similar-items";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureDirectory = path.join(root, "bounded-contexts/discovery/tests/fixtures/search-relevance");
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
let pool: PgTransactionalPool;

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

  it("writes the lexical-vs-hybrid report and enforces exact/lexical protection", async () => {
    const [catalogItems, goldenQueries, embeddingFixture] = await Promise.all([
      readJson("catalog-items.json"),
      readJson("golden-queries.json"),
      readJson("fixture-embeddings.json"),
    ]);
    const report = await runDiscoveryRelevanceEvaluation(pool, {
      catalogItems: catalogItems as readonly RelevanceCatalogFixtureItem[],
      goldenQueries: goldenQueries as readonly relevanceDomain.GoldenQuery[],
      embeddingFixture: embeddingFixture as RelevanceEmbeddingFixture,
      generatedAt: new Date().toISOString(),
    });
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
  });

  it("keeps Charizard printings ahead of unrelated items and excludes self and delisted rows", async () => {
    const catalogItems = (await readJson("catalog-items.json")) as readonly RelevanceCatalogFixtureItem[];
    const embeddingFixture = (await readJson("fixture-embeddings.json")) as RelevanceEmbeddingFixture;
    const documentEmbeddings = Object.fromEntries(
      Object.entries(embeddingFixture.documents).map(([itemId, components]) => [
        itemId,
        expandSparseEmbedding(components, embeddingFixture.dimensions),
      ]),
    );
    await seedDiscoveryRelevanceCatalog(pool, catalogItems, documentEmbeddings, embeddingFixture.model);

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

function expandSparseEmbedding(components: readonly (readonly [number, number])[], dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const [index, value] of components) vector[index] = value;
  return vector;
}
