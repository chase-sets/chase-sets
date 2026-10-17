import { pathToFileURL } from "node:url";
import process from "node:process";

export function parseDiscoveryEmbeddingBackfillOptions(argv, env = process.env) {
  const options = {
    apply: false,
    batchSize: positiveInteger(env.VOYAGE_EMBEDDING_BATCH_SIZE ?? 128, "VOYAGE_EMBEDDING_BATCH_SIZE"),
    maxBatches: Number.POSITIVE_INFINITY,
    model: env.VOYAGE_EMBEDDING_MODEL?.trim() || "voyage-4-lite",
    pricePerMillionTokensUsd: positiveNumber(
      env.VOYAGE_EMBEDDING_PRICE_PER_MILLION_TOKENS_USD ?? 0.02,
      "VOYAGE_EMBEDDING_PRICE_PER_MILLION_TOKENS_USD",
    ),
  };

  for (const argument of argv) {
    if (argument === "--dry-run") options.apply = false;
    else if (argument === "--apply") options.apply = true;
    else if (argument.startsWith("--batch-size=")) {
      options.batchSize = positiveInteger(argument.slice("--batch-size=".length), "--batch-size");
    } else if (argument.startsWith("--max-batches=")) {
      options.maxBatches = positiveInteger(argument.slice("--max-batches=".length), "--max-batches");
    } else if (argument.startsWith("--model=")) {
      options.model = argument.slice("--model=".length).trim();
      if (!options.model) throw new Error("--model must be non-empty.");
    } else if (argument.startsWith("--price-per-million-tokens-usd=")) {
      options.pricePerMillionTokensUsd = positiveNumber(
        argument.slice("--price-per-million-tokens-usd=".length),
        "--price-per-million-tokens-usd",
      );
    } else {
      throw new Error(`Unknown argument '${argument}'.`);
    }
  }
  return options;
}

export async function runDiscoveryEmbeddingBackfill(enrichment, options) {
  const capabilities = await enrichment.inspectVectorCapabilities();
  if (options.apply && (!capabilities.supportsHalfvec || !capabilities.supportsHnsw)) {
    throw new Error(
      `Discovery embedding backfill requires pgvector >=0.7 with halfvec and HNSW; installed version is '${capabilities.extensionVersion ?? "missing"}'.`,
    );
  }

  if (!options.apply) {
    let itemCount = 0;
    let estimatedTokens = 0;
    let afterCatalogItemId = null;
    while (true) {
      const page = await enrichment.estimateBackfillPage({
        afterCatalogItemId,
        limit: options.batchSize,
        pricePerMillionTokensUsd: options.pricePerMillionTokensUsd,
      });
      itemCount += page.itemCount;
      estimatedTokens += page.estimatedTokens;
      if (page.itemCount < options.batchSize || !page.lastCatalogItemId) break;
      afterCatalogItemId = page.lastCatalogItemId;
    }
    return {
      mode: "dry-run",
      model: options.model,
      itemCount,
      estimatedTokens,
      estimatedCostUsd: (estimatedTokens / 1_000_000) * options.pricePerMillionTokensUsd,
      capabilities,
    };
  }

  let batches = 0;
  let processed = 0;
  let embedded = 0;
  let totalTokens = 0;
  while (batches < options.maxBatches) {
    const result = await enrichment.processNextBatch({ limit: options.batchSize });
    if (result.processed === 0) break;
    batches += 1;
    processed += result.processed;
    embedded += result.embedded;
    totalTokens += result.totalTokens;
    if (result.embedded === 0) break;
  }
  const remaining = await enrichment.estimateBackfillPage({ limit: 1 });
  return {
    mode: "apply",
    model: options.model,
    batches,
    processed,
    embedded,
    totalTokens,
    resumable: true,
    remaining: remaining.itemCount > 0,
    capabilities,
  };
}

async function main() {
  const options = parseDiscoveryEmbeddingBackfillOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL_DISCOVERY ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL_DISCOVERY or DATABASE_URL is required.");
  }
  if (options.apply && !process.env.VOYAGE_API_KEY?.trim()) {
    throw new Error("VOYAGE_API_KEY is required with --apply; dry-run does not call Voyage.");
  }
  if (
    options.apply &&
    new Set(["disabled", "off", "false", "0", "kill"]).has(
      (process.env.DISCOVERY_SEARCH_EMBEDDINGS ?? "").trim().toLowerCase(),
    )
  ) {
    throw new Error("Discovery search embedding enrichment is disabled by DISCOVERY_SEARCH_EMBEDDINGS.");
  }

  const { register } = await import("node:module");
  register("../infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url);
  const [{ Pool }, enrichmentModule, providerModule] = await Promise.all([
    import("pg"),
    import("../bounded-contexts/discovery/features/search/read-model/embedding-enrichment.ts"),
    import("../bounded-contexts/discovery/features/search/integrations/voyage-embedding-provider.ts"),
  ]);
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const provider = options.apply
      ? providerModule.createVoyageEmbeddingProvider({
          apiKey: process.env.VOYAGE_API_KEY,
          model: options.model,
          batchSize: options.batchSize,
          timeoutMs: positiveInteger(process.env.VOYAGE_EMBEDDING_TIMEOUT_MS ?? 15_000, "VOYAGE_EMBEDDING_TIMEOUT_MS"),
          maxAttempts: positiveInteger(process.env.VOYAGE_EMBEDDING_MAX_ATTEMPTS ?? 4, "VOYAGE_EMBEDDING_MAX_ATTEMPTS"),
        })
      : {
          model: options.model,
          dimensions: 1_024,
          embed: async () => {
            throw new Error("Dry-run must not call the embedding provider.");
          },
        };
    const enrichment = enrichmentModule.createDiscoverySearchEmbeddingEnrichment({
      db: pool,
      provider,
      batchSize: options.batchSize,
    });
    const report = await runDiscoveryEmbeddingBackfill(enrichment, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

function positiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${fieldName} must be a positive integer.`);
  return parsed;
}

function positiveNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${fieldName} must be a positive number.`);
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
