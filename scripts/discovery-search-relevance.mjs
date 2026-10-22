import path from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { loadTestEnvironment } from "./run-workspaces.mjs";
import {
  fixtureSourceHash,
  embeddingInputKey,
  expandSparseEmbedding,
} from "./discovery-search-relevance-embeddings.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function parseDiscoverySearchRelevanceOptions(argv) {
  const options = {
    jsonOut: "artifacts/discovery-search-relevance/report.json",
    markdownOut: "artifacts/discovery-search-relevance/report.md",
    enforceGate: true,
    embeddingFixture: "bounded-contexts/discovery/tests/fixtures/search-relevance/fixture-embeddings.json",
    rankedInput: null,
  };
  for (const argument of argv) {
    if (argument === "--report-only") options.enforceGate = false;
    else if (argument.startsWith("--embedding-fixture="))
      options.embeddingFixture = nonEmpty(argument.slice(20), "--embedding-fixture");
    else if (argument.startsWith("--ranked-input="))
      options.rankedInput = nonEmpty(argument.slice(15), "--ranked-input");
    else if (argument.startsWith("--json-out="))
      options.jsonOut = nonEmpty(argument.slice("--json-out=".length), "--json-out");
    else if (argument.startsWith("--markdown-out=")) {
      options.markdownOut = nonEmpty(argument.slice("--markdown-out=".length), "--markdown-out");
    } else throw new Error(`Unknown argument '${argument}'.`);
  }
  return options;
}

export async function validateFixtures(catalogItems, goldenQueries, embeddingFixture) {
  const { validateGoldenQuery } =
    await import("../bounded-contexts/discovery/features/search/domain/relevance-evaluation.ts");
  const { normalizeQueryForEmbedding } =
    await import("../bounded-contexts/discovery/features/search/domain/query-embedding-cache.ts");
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
    validateGoldenQuery(goldenQuery);
    if (goldenQuery.expected.kind === "items") {
      if (goldenQuery.expected.itemIds.length === 0)
        throw new Error(`Golden query '${goldenQuery.id}' has no expected items.`);
      for (const itemId of goldenQuery.expected.itemIds) {
        if (!itemIds.has(itemId))
          throw new Error(`Golden query '${goldenQuery.id}' references unknown item '${itemId}'.`);
      }
    }
    for (const query of [goldenQuery.query, ...(goldenQuery.effectiveQueries ?? [])]) {
      const text = normalizeQueryForEmbedding(query);
      const key = embeddingInputKey(embeddingFixture.model, "query", text);
      const provenance = embeddingFixture.queryProvenance?.[key];
      if (
        !embeddingFixture.queries[key] ||
        provenance?.text !== text ||
        provenance.model !== embeddingFixture.model ||
        provenance.inputType !== "query"
      )
        throw new Error(`Missing effective-query vector for '${text}'.`);
    }
  }
  for (const itemId of itemIds) {
    if (!embeddingFixture.documents[itemId]) throw new Error(`Missing document embedding for '${itemId}'.`);
    const provenance = embeddingFixture.documentProvenance?.[itemId];
    if (
      !provenance ||
      createHash("sha256").update(provenance.text).digest("hex") !== provenance.hash ||
      embeddingInputKey(embeddingFixture.model, "document", provenance.text) !== provenance.key
    )
      throw new Error(`Invalid document provenance for '${itemId}'.`);
  }
  const expectedSourceHash = fixtureSourceHash(catalogItems, goldenQueries);
  if (embeddingFixture.sourceHash !== expectedSourceHash) {
    throw new Error("Embedding fixture is stale; run pnpm run generate:discovery-search-relevance-embeddings.");
  }
  if (embeddingFixture.dimensions !== 1_024) throw new Error("Relevance fixture embeddings must use 1024 dimensions.");
  if (embeddingFixture.version !== 2 || !["deterministic", "voyage"].includes(embeddingFixture.source))
    throw new Error("Invalid snapshot provenance.");
  for (const components of [...Object.values(embeddingFixture.documents), ...Object.values(embeddingFixture.queries)]) {
    const vector = expandSparseEmbedding(components);
    if (Math.abs(Math.hypot(...vector) - 1) > 0.00001) throw new Error("Snapshot vectors must be normalized.");
  }
}

async function main() {
  const options = parseDiscoverySearchRelevanceOptions(process.argv.slice(2));
  const { register } = await import("node:module");
  register("../infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url);
  if (options.rankedInput) {
    await runRankedInputEvaluation(options);
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
      DISCOVERY_RELEVANCE_EMBEDDING_FIXTURE: path.resolve(root, options.embeddingFixture),
    },
  });
}

export async function runRankedInputEvaluation(options) {
  const input = JSON.parse(await readFile(path.resolve(root, options.rankedInput), "utf8"));
  const relevance = await import("../bounded-contexts/discovery/features/search/domain/relevance-evaluation.ts");
  const report = relevance.scoreRankedRelevanceInputs(input);
  const markdown = relevance.renderRelevanceMarkdown(report);
  const jsonPath = path.resolve(root, options.jsonOut);
  const markdownPath = path.resolve(root, options.markdownOut);
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, markdown, "utf8");
  if (options.enforceGate) relevance.assertRelevanceGate(report);
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
