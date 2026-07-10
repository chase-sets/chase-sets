import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function parseHybridRetrievalBenchmarkOptions(argv) {
  const options = { rowCount: 100_000, samples: 30, warmups: 5 };
  for (const argument of argv) {
    if (argument.startsWith("--rows=")) options.rowCount = positiveInteger(argument.slice(7), "--rows");
    else if (argument.startsWith("--samples=")) options.samples = positiveInteger(argument.slice(10), "--samples");
    else if (argument.startsWith("--warmups=")) options.warmups = positiveInteger(argument.slice(10), "--warmups");
    else throw new Error(`Unknown argument '${argument}'.`);
  }
  return options;
}

export function percentile(values, quantile) {
  if (values.length === 0) throw new Error("Cannot calculate a percentile without samples.");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export function collectPlanIndexNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPlanIndexNames(item, names);
  } else if (value && typeof value === "object") {
    if (typeof value["Index Name"] === "string") names.add(value["Index Name"]);
    for (const child of Object.values(value)) collectPlanIndexNames(child, names);
  }
  return names;
}

async function main() {
  const options = parseHybridRetrievalBenchmarkOptions(process.argv.slice(2));
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL_DISCOVERY ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL, DATABASE_URL_DISCOVERY, or DATABASE_URL is required.");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await client.query(`CREATE TEMP TABLE discovery_hybrid_benchmark_items (
      catalog_item_id text PRIMARY KEY,
      status text NOT NULL,
      category text NOT NULL,
      price_amount numeric NOT NULL,
      in_stock boolean NOT NULL,
      search_text tsvector NOT NULL,
      search_embedding halfvec(1024)
    ) ON COMMIT DROP`);
    await client.query(
      `INSERT INTO discovery_hybrid_benchmark_items (
         catalog_item_id, status, category, price_amount, in_stock, search_text, search_embedding
       )
       SELECT
         'item-' || series,
         CASE WHEN series % 20 = 0 THEN 'archived' ELSE 'active' END,
         CASE WHEN series % 4 = 0 THEN 'sealed' ELSE 'cards' END,
         (series % 500)::numeric,
         series % 7 <> 0,
         to_tsvector('english', CASE WHEN series % 31 = 0 THEN 'dragon vintage card' ELSE 'marketplace card' END),
         ('[' || component || ',' || sqrt(1 - component * component) || repeat(',0', 1022) || ']')::halfvec(1024)
       FROM (
         SELECT series, ((series % 97) + 1)::double precision / 100 AS component
         FROM generate_series(1, $1::integer) AS series
       ) AS seeded`,
      [options.rowCount],
    );
    await client.query(
      `CREATE INDEX discovery_hybrid_benchmark_search_gin_idx
         ON discovery_hybrid_benchmark_items USING gin (search_text)`,
    );
    await client.query(
      `CREATE INDEX discovery_hybrid_benchmark_embedding_hnsw_idx
         ON discovery_hybrid_benchmark_items USING hnsw (search_embedding halfvec_ip_ops)
         WHERE status = 'active' AND search_embedding IS NOT NULL`,
    );
    await client.query("ANALYZE discovery_hybrid_benchmark_items");

    const queryVector = `[0.5,0.8660254037844386${",0".repeat(1022)}]`;
    const lexicalSql = `SELECT catalog_item_id
      FROM discovery_hybrid_benchmark_items
      WHERE status = 'active'
        AND category = 'cards'
        AND price_amount <= 100
        AND in_stock
        AND search_text @@ plainto_tsquery('english', 'dragon')
      ORDER BY ts_rank(search_text, plainto_tsquery('english', 'dragon')) DESC, catalog_item_id
      LIMIT 24`;
    const semanticSql = `SELECT catalog_item_id
      FROM discovery_hybrid_benchmark_items
      WHERE status = 'active'
        AND category = 'cards'
        AND price_amount <= 100
        AND in_stock
        AND search_embedding IS NOT NULL
        AND -(search_embedding <#> $1::halfvec(1024)) >= 0.52
      ORDER BY search_embedding <#> $1::halfvec(1024), catalog_item_id
      LIMIT 24`;
    for (let index = 0; index < options.warmups; index++) {
      await client.query(lexicalSql);
      await client.query(semanticSql, [queryVector]);
    }
    const lexicalSamples = await sampleQuery(client, lexicalSql, [], options.samples);
    const semanticSamples = await sampleQuery(client, semanticSql, [queryVector], options.samples);
    const explain = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${semanticSql}`, [queryVector]);
    const indexes = [...collectPlanIndexNames(explain.rows[0]["QUERY PLAN"])];
    if (!indexes.includes("discovery_hybrid_benchmark_embedding_hnsw_idx")) {
      throw new Error(`Semantic benchmark did not use the HNSW index; used [${indexes.join(", ")}].`);
    }
    const lexicalP95Ms = percentile(lexicalSamples, 0.95);
    const semanticP95Ms = percentile(semanticSamples, 0.95);
    process.stdout.write(
      `${JSON.stringify(
        {
          rowCount: options.rowCount,
          samples: options.samples,
          filters: ["status", "category", "price", "stock"],
          hnsw: { operatorClass: "halfvec_ip_ops", m: 16, efConstruction: 64, indexes },
          p95Ms: {
            lexical: lexicalP95Ms,
            semanticDatabaseOverhead: semanticP95Ms,
            hybridDatabasePath: lexicalP95Ms + semanticP95Ms,
          },
          excludes: ["Voyage network latency; measure separately from API telemetry"],
        },
        null,
        2,
      )}\n`,
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
}

async function sampleQuery(client, sql, values, samples) {
  const timings = [];
  for (let index = 0; index < samples; index++) {
    const startedAt = performance.now();
    await client.query(sql, values);
    timings.push(performance.now() - startedAt);
  }
  return timings;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
