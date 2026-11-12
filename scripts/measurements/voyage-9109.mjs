// Operator-approved, bounded synthetic Voyage measurement. No deployment or DB access.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PIN = "5177c88d76eceab88ebcb9b21a1088664ef1ff66";
export const ATTEMPTS = 30;
export function createBudget({ rate, otherCosts, ceiling = 20 }) {
  if (!(rate > 0 && rate <= 100) || !(otherCosts >= 0 && otherCosts < ceiling))
    throw new Error("Invalid reviewed cost assumptions");
  let reservedTokens = 0;
  return {
    reserve(texts) {
      // Reserve the full documented 32k model context per input, including failed calls.
      const tokens = texts.length * 32000;
      if (otherCosts + ((reservedTokens + tokens) * rate) / 1e6 > ceiling)
        throw new Error("Budget exhausted before request");
      reservedTokens += tokens;
    },
    summary: () => ({
      reservedTokens,
      reviewedUsdPerMillionTokens: rate,
      reservedOtherUsd: otherCosts,
      estimatedUpperUsd: otherCosts + (reservedTokens * rate) / 1e6,
      ceilingUsd: ceiling,
    }),
  };
}
export function distribution(rows) {
  const values = rows.map((row) => row.ms).sort((a, b) => a - b);
  return {
    count: values.length,
    p50Ms: values.length ? values[Math.ceil(values.length * 0.5) - 1] : null,
    p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
  };
}
async function main() {
  if (process.env.MEASUREMENT_APPROVAL !== "9109-reviewed-cost-and-synthetic-inputs")
    throw new Error("Operator cost/input review required");
  if (process.env.GITHUB_RUN_ATTEMPT !== "1")
    throw new Error("Automatic reruns prohibited; account for prior spend before any new run");
  const root = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (head !== PIN) throw new Error("Pinned measurement checkout required");
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("Staging Voyage secret unavailable");
  const deadline = Number(process.env.QUERY_TIMEOUT_MS);
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 60000)
    throw new Error("Explicit query timeout required");
  const model = process.env.VOYAGE_MODEL;
  if (model !== "voyage-4-lite") throw new Error("This draft only reviews the pinned default voyage-4-lite model");
  if (!process.env.REVIEWED_RATE_USD_PER_MILLION?.trim() || !process.env.RESERVED_NON_TOKEN_USD?.trim())
    throw new Error("Reviewed cost inputs required");
  const budget = createBudget({
    rate: Number(process.env.REVIEWED_RATE_USD_PER_MILLION),
    otherCosts: Number(process.env.RESERVED_NON_TOKEN_USD),
  });
  const url = (relative) => pathToFileURL(path.join(root, relative)).href;
  register(url("infrastructure/platform-runtime/typescript-resolver.mjs"), import.meta.url);
  const { buildRelevanceEmbeddingFixture } = await import(url("scripts/discovery-search-relevance-embeddings.mjs"));
  const { buildDiscoveryEmbeddingDocument } = await import(
    url("bounded-contexts/discovery/features/search/domain/embedding-document.ts")
  );
  const { normalizeQueryForEmbedding } = await import(
    url("bounded-contexts/discovery/features/search/domain/query-embedding-cache.ts")
  );
  const { createVoyageEmbeddingProvider } = await import(
    url("bounded-contexts/discovery/features/search/integrations/voyage-embedding-provider.ts")
  );
  const fixtureDir = path.join(root, "bounded-contexts/discovery/tests/fixtures/search-relevance");
  const catalogItems = JSON.parse(await readFile(path.join(fixtureDir, "catalog-items.json"), "utf8"));
  const goldenQueries = JSON.parse(await readFile(path.join(fixtureDir, "golden-queries.json"), "utf8"));
  let requests = 0;
  let guardStopped = false;
  let confirmedUsageTokens = 0;
  const rawProvider = createVoyageEmbeddingProvider({
    apiKey,
    model,
    maxAttempts: 1,
    fetch: (endpoint, options) => {
      if (endpoint !== "https://api.voyageai.com/v1/embeddings" || options.method !== "POST")
        throw new Error("Unexpected provider destination");
      const body = JSON.parse(options.body);
      try {
        if (requests >= 40 || body.model !== model || body.output_dimension !== 1024)
          throw new Error("Request bound exceeded");
        budget.reserve(body.input);
      } catch (error) {
        guardStopped = true;
        throw error;
      }
      requests++;
      return fetch(endpoint, { ...options, redirect: "error" });
    },
  });
  const provider = {
    ...rawProvider,
    async embed(...args) {
      const result = await rawProvider.embed(...args);
      confirmedUsageTokens += result.totalTokens;
      return result;
    },
  };
  await mkdir(output, { recursive: true });
  const rows = [];
  let snapshotStatus = "not-started";
  try {
    const fixture = await buildRelevanceEmbeddingFixture({
      catalogItems,
      goldenQueries,
      buildDocument: buildDiscoveryEmbeddingDocument,
      normalizeQuery: normalizeQueryForEmbedding,
      provider,
    });
    const serialized = JSON.stringify(fixture, null, 2) + "\n";
    await writeFile(path.join(output, "real-embeddings.json"), serialized);
    await writeFile(path.join(output, "snapshot.sha256"), createHash("sha256").update(serialized).digest("hex") + "\n");
    snapshotStatus = "complete";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const started = performance.now();
      try {
        const result = await provider.embed([normalizeQueryForEmbedding("charizard")], "query", {
          signal: AbortSignal.timeout(deadline),
          timeoutMs: deadline,
          maxAttempts: 1,
        });
        rows.push({ attempt, outcome: "success", ms: performance.now() - started, totalTokens: result.totalTokens });
      } catch (error) {
        if (guardStopped) break;
        // Never persist error messages, bodies, headers, or credentials.
        const outcome = error?.kind === "timeout" ? "timeout" : "error";
        rows.push({ attempt, outcome, ms: performance.now() - started });
        if (error?.kind === "authentication" || error?.kind === "rate-limit") break;
      }
    }
  } finally {
    await writeFile(
      path.join(output, "timings.json"),
      JSON.stringify(
        {
          head,
          model,
          dimensions: 1024,
          deadlineMs: deadline,
          deadlineBasis: "pinned code default; live staging override not verified",
          measuredAt: new Date().toISOString(),
          snapshotStatus,
          requests,
          guardStopped,
          confirmedUsageTokens,
          budget: budget.summary(),
          rows,
          allAttempts: distribution(rows),
          successful: distribution(rows.filter((row) => row.outcome === "success")),
          timeouts: rows.filter((row) => row.outcome === "timeout").length,
          errors: rows.filter((row) => row.outcome === "error").length,
          stagingOwnerTelemetry: "not collected; these direct calls are not staging p50/p95",
        },
        null,
        2,
      ),
    );
  }
  if (rows.length !== ATTEMPTS) throw new Error("Incomplete measurement; inspect sanitized artifact");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch(() => {
    console.error("Measurement stopped; inspect sanitized artifact. No automatic retry.");
    process.exitCode = 1;
  });
