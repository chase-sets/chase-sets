# Search Embedding Enrichment

Discovery owns semantic Search Index enrichment while it is the only consumer. The serial Catalog-to-Discovery projector only builds deterministic embedding text hashes and marks changed rows dirty. It never calls Voyage or any other external provider.

## Provider decision

As of 2026-07-10, Discovery uses voyage-4-lite at its default 1024 dimensions. Voyage documents it as the low-latency, low-cost Voyage 4 model with a 32k context window, multilingual retrieval, and compatible Matryoshka dimensions. Current text-embedding pricing is $0.02 per million tokens after the account's 200 million free tokens. The model stays configurable through VOYAGE_EMBEDDING_MODEL; changing it makes existing rows eligible for enrichment again.

Enrichment requests use `input_type: document`; semantic retrieval requests always use `input_type: query`. The adapter normalizes returned vectors before storage so pgvector inner product and cosine produce the same ordering. The input type is passed explicitly and covered by retrieval tests; document and query embeddings are never interchangeable at the provider boundary.

- [Voyage text embeddings](https://docs.voyageai.com/docs/embeddings)
- [Voyage pricing](https://docs.voyageai.com/docs/pricing)
- [Voyage rate limits](https://docs.voyageai.com/docs/rate-limits)

## Runtime and failure posture

discovery.search-embedding-enrichment is a leased platform-worker scheduled job. It drains at most 128 dirty rows, calls Voyage outside projector transactions, and writes each vector only when the row's desired text hash still matches. Provider failures leave rows dirty and lexical search remains unchanged.

DISCOVERY_SEARCH_EMBEDDINGS=off (also disabled, false, 0, or kill) removes the enrichment service and runner. A missing VOYAGE_API_KEY has the same clean disabled result. Neither condition prevents the API, worker, schema bootstrap, projection replay, or lexical search from starting.

## Hybrid retrieval rollout

`DISCOVERY_SEARCH_RESCUE` controls stage 1 and defaults open. For a fresh relevance query with fewer than three lexical results, Discovery keeps those text matches first and appends up to 24 filter-respecting semantic neighbors. The API returns `retrievalMode: rescue` and `lexicalCount`, and the search page labels the recovery block **Closest matches**. `DISCOVERY_SEARCH_RESCUE=off` disables only this stage.

`DISCOVERY_SEARCH_HYBRID` controls stage 2 and defaults off. When explicitly enabled, Discovery fuses the top 200 lexical and vector candidates with reciprocal-rank fusion (`k=60`, lexical weight 0.7, semantic weight 0.3). Exact-title matches sort first and any lexical/base match stays ahead of semantic-only candidates. Pagination re-evaluates the bounded 200-candidate window and slices it with an opaque offset cursor; results beyond that window intentionally require lexical-only search rather than pretending the fused order is unbounded.

Both modes require the parent `DISCOVERY_SEARCH_EMBEDDINGS` control and an API-side `VOYAGE_API_KEY`. They run only for non-empty relevance text queries, never browse, facet-only, title-sort, or newest-sort requests. A missing key, missing item embedding, invalid provider response, provider timeout, or vector-query/index error returns the lexical result unchanged and does not surface an error to the user.

Query embeddings use an in-process LRU with a 1,000-entry hard bound and 15-minute TTL by default. Keys are SHA-256 hashes of `(model, normalized query)`; concurrent misses share one provider request, failures are evicted, and hits refresh LRU order. `DISCOVERY_QUERY_EMBEDDING_CACHE_MAX_ENTRIES` and `DISCOVERY_QUERY_EMBEDDING_CACHE_TTL_MS` tune the bounds. No query-cache table is created, so the `BcRetentionSweep` table convention does not apply and horizontally scaled API replicas remain independent.

The API response records `lexical | rescue | hybrid` as `retrievalMode`, and the platform API emits the same redaction-safe dimension through `DiscoverySearchQuerySignal` for #3407. Raw query text is not added to telemetry, and telemetry failure is swallowed so it cannot become a search dependency.

## HNSW and latency budget

The ledger-owned `discovery_search_items_embedding_hnsw_idx` uses `halfvec_ip_ops` and includes only active rows with an embedding. Voyage vectors are normalized, so the negative inner-product `<#>` order is equivalent to cosine order. PostgreSQL pgvector defaults are retained deliberately at the current scale: `m=16` and `ef_construction=64`. Semantic SQL orders directly by `<#>` so the index is eligible, then applies the same category, tag, language, blueprint, field, reference, dimension, price/stock market-activity constraints as lexical retrieval. Pgvector 0.8 iterative scans improve selective post-filter recall; the query remains correct on 0.7 and the 100k-row probe measures the deployed version.

Run the non-CI acceptance probe against a disposable test database:

    pnpm run benchmark:discovery-hybrid-retrieval

It creates a rolled-back 100,000-row fixture, builds the filtered HNSW and lexical GIN indexes, asserts the semantic plan names the HNSW index, samples 30 warm queries, and reports lexical p95, additional semantic-database p95, and combined hybrid-database p95. The report calls out Voyage network time separately because provider latency must come from API telemetry rather than a local PostgreSQL benchmark. This is the hybrid extension of the still-open #3399 lexical EXPLAIN work; once #3399 lands, the two probes should share their seed helper rather than duplicate a second 100k fixture.

## Backfill and capability check

Dry-run is the default and never needs or calls a provider:

    pnpm run backfill:discovery-search-embeddings -- --dry-run

The report includes dirty item count, estimated tokens/cost, installed pgvector version, HNSW support, halfvec support, and iterative-index-scan availability. The apply path is chunked and resumable because every successful row records its model, desired text hash, and update time:

    pnpm run backfill:discovery-search-embeddings -- --apply --max-batches=100

Rerunning skips completed rows whose model is current. --max-batches provides an operator checkpoint; interruption or provider failure leaves only unfinished rows dirty.

The schema requires pgvector 0.7 or newer for halfvec; HNSW is available from 0.5 and iterative index scans from 0.8. The dry-run refuses an apply-capability posture without halfvec and HNSW and reports whether retrieval work can use iterative scans. DigitalOcean's current managed PostgreSQL documentation lists halfvec and HNSW as supported, but the installed staging extension version must be read from the dry-run report after deploy.

- [DigitalOcean pgvector loading and verification](https://docs.digitalocean.com/products/vector-databases/postgresql/how-to/load-embeddings/)
- [DigitalOcean vector index tuning](https://docs.digitalocean.com/products/vector-databases/postgresql/how-to/index-and-tune/)

## Rebuild behavior

The Discovery search projection uses replay-only checkpoint reset and upserts existing Search Index rows. The upsert retains the vector and embedding_updated_at when the deterministic text hash is unchanged, and clears only embedding_updated_at when the hash changes. A rebuild therefore preserves valid embeddings while asynchronously refreshing changed documents.

## Relevance evaluation harness

Run the rollout gate against a dedicated, per-context test database:

    pnpm run evaluate:discovery-search-relevance

When a local database is unavailable, the same checked-in fixtures and fusion policy can produce unit-level rollout evidence without weakening the gate:

    pnpm run evaluate:discovery-search-relevance -- --in-memory

The command seeds the checked-in representative Search Index fixture, runs lexical-only, semantic-fallback, and hybrid retrieval, then writes JSON and Markdown reports under `artifacts/discovery-search-relevance/`. It fails when hybrid exact-title top-1 is below 100% or when hybrid pass rate, recall@10, or MRR regresses for the exact or lexical categories. Semantic-category gains and negative-query pass rates are reported but do not weaken those protections.

The 63 golden queries and 24 catalog items live in `bounded-contexts/discovery/tests/fixtures/search-relevance/`. Fixture embeddings use the injected deterministic provider model `deterministic-relevance-v1`; neither evaluation nor regeneration reads `VOYAGE_API_KEY` or makes a network call. Regenerate them after editing either source fixture:

    pnpm run generate:discovery-search-relevance-embeddings

The embedding fixture records a source hash, and the evaluation command rejects stale vectors. Use `--report-only` only while tuning a candidate; the default command is the rollout comparison gate.
