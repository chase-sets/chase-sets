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
  type RelevanceCatalogFixtureItem,
  type RelevanceEmbeddingFixture,
} from "../features/search/read-model/relevance-evaluation";

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
});

async function readJson(fileName: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtureDirectory, fileName), "utf8")) as unknown;
}
