import path from "node:path";
import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { loadTestEnvironment } from "./run-workspaces.mjs";
import { fixtureSourceHash } from "./discovery-search-relevance-embeddings.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function parseDiscoverySearchRelevanceOptions(argv) {
  const options = {
    jsonOut: "artifacts/discovery-search-relevance/report.json",
    markdownOut: "artifacts/discovery-search-relevance/report.md",
    enforceGate: true,
    inMemory: false,
  };
  for (const argument of argv) {
    if (argument === "--report-only") options.enforceGate = false;
    else if (argument === "--in-memory") options.inMemory = true;
    else if (argument.startsWith("--json-out="))
      options.jsonOut = nonEmpty(argument.slice("--json-out=".length), "--json-out");
    else if (argument.startsWith("--markdown-out=")) {
      options.markdownOut = nonEmpty(argument.slice("--markdown-out=".length), "--markdown-out");
    } else throw new Error(`Unknown argument '${argument}'.`);
  }
  return options;
}

export function validateFixtures(catalogItems, goldenQueries, embeddingFixture) {
  if (goldenQueries.length < 50 || goldenQueries.length > 100) {
    throw new Error(`Golden query fixture must contain 50-100 cases; found ${goldenQueries.length}.`);
  }
  const requiredCoverage = ["en", "ja", "alias", "misspelling", "semantic-intent", "zero-result"];
  const coverage = new Set(goldenQueries.flatMap((item) => item.coverage));
  const missingCoverage = requiredCoverage.filter((value) => !coverage.has(value));
  if (missingCoverage.length > 0)
    throw new Error(`Golden query fixture is missing coverage: ${missingCoverage.join(", ")}.`);
  const categories = new Set(goldenQueries.map((item) => item.category));
  const missingCategories = ["exact", "lexical", "semantic", "negative"].filter((value) => !categories.has(value));
  if (missingCategories.length > 0)
    throw new Error(`Golden query fixture is missing categories: ${missingCategories.join(", ")}.`);
  const itemIds = new Set(catalogItems.map((item) => item.catalogItemId));
  for (const goldenQuery of goldenQueries) {
    if (goldenQuery.expected.kind === "items") {
      if (goldenQuery.expected.itemIds.length === 0)
        throw new Error(`Golden query '${goldenQuery.id}' has no expected items.`);
      for (const itemId of goldenQuery.expected.itemIds) {
        if (!itemIds.has(itemId))
          throw new Error(`Golden query '${goldenQuery.id}' references unknown item '${itemId}'.`);
      }
    }
    if (!embeddingFixture.queries[goldenQuery.id]) throw new Error(`Missing query embedding for '${goldenQuery.id}'.`);
  }
  for (const itemId of itemIds) {
    if (!embeddingFixture.documents[itemId]) throw new Error(`Missing document embedding for '${itemId}'.`);
  }
  const expectedSourceHash = fixtureSourceHash(catalogItems, goldenQueries);
  if (embeddingFixture.sourceHash !== expectedSourceHash) {
    throw new Error("Embedding fixture is stale; run pnpm run generate:discovery-search-relevance-embeddings.");
  }
  if (embeddingFixture.dimensions !== 1_024) throw new Error("Relevance fixture embeddings must use 1024 dimensions.");
}

async function main() {
  const options = parseDiscoverySearchRelevanceOptions(process.argv.slice(2));
  if (options.inMemory) {
    await runInMemoryEvaluation(options);
    return;
  }
  loadTestEnvironment({ includeTestDatabaseUrl: true });
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required. Start the worktree database with pnpm run dev:bootstrap.");
  }
  const invocation = buildPackageManagerInvocation(["--filter", "@chase-sets/discovery", "run", "test:relevance"]);
  await runCommand(invocation.command, invocation.args, {
    cwd: root,
    stdio: "inherit",
    timeoutMs: 10 * 60 * 1_000,
    env: {
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      DISCOVERY_RELEVANCE_JSON_OUT: options.jsonOut,
      DISCOVERY_RELEVANCE_MARKDOWN_OUT: options.markdownOut,
      DISCOVERY_RELEVANCE_ENFORCE_GATE: options.enforceGate ? "true" : "false",
    },
  });
}

export async function runInMemoryEvaluation(options) {
  const fixtureDirectory = path.join(root, "bounded-contexts/discovery/tests/fixtures/search-relevance");
  const [catalogItems, goldenQueries, embeddingFixture] = await Promise.all(
    ["catalog-items.json", "golden-queries.json", "fixture-embeddings.json"].map(async (fileName) =>
      JSON.parse(await readFile(path.join(fixtureDirectory, fileName), "utf8")),
    ),
  );
  validateFixtures(catalogItems, goldenQueries, embeddingFixture);
  const { register } = await import("node:module");
  register("./typescript-source-loader.mjs", import.meta.url);
  const relevance = await import("../bounded-contexts/discovery/features/search/domain/relevance-evaluation.ts");
  const report = relevance.runInMemoryDiscoveryRelevanceEvaluation({
    catalogItems,
    goldenQueries,
    embeddingFixture,
    generatedAt: new Date().toISOString(),
  });
  if (options.enforceGate) relevance.assertRelevanceGate(report);
  const markdown = relevance.renderRelevanceMarkdown(report);
  const jsonPath = path.resolve(root, options.jsonOut);
  const markdownPath = path.resolve(root, options.markdownOut);
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, markdown, "utf8");
  process.stdout.write(
    `${markdown}JSON: ${path.relative(root, jsonPath)}\nMarkdown: ${path.relative(root, markdownPath)}\n`,
  );
  return report;
}

function nonEmpty(value, label) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty.`);
  return normalized;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
