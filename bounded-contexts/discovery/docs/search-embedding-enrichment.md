# Search Embedding Enrichment

Discovery owns semantic Search Index enrichment while it is the only consumer. The serial Catalog-to-Discovery projector only builds deterministic embedding text hashes and marks changed rows dirty. It never calls Voyage or any other external provider.

## Provider decision

As of 2026-07-10, Discovery uses voyage-4-lite at its default 1024 dimensions. Voyage documents it as the low-latency, low-cost Voyage 4 model with a 32k context window, multilingual retrieval, and compatible Matryoshka dimensions. Current text-embedding pricing is $0.02 per million tokens after the account's 200 million free tokens. The model stays configurable through VOYAGE_EMBEDDING_MODEL; changing it makes existing rows eligible for enrichment again.

Every request uses input_type document; future query embedding must use input_type query. The adapter normalizes returned vectors before storage so pgvector inner product and cosine produce the same ordering.

- [Voyage text embeddings](https://docs.voyageai.com/docs/embeddings)
- [Voyage pricing](https://docs.voyageai.com/docs/pricing)
- [Voyage rate limits](https://docs.voyageai.com/docs/rate-limits)

## Runtime and failure posture

discovery.search-embedding-enrichment is a leased platform-worker scheduled job. It drains at most 128 dirty rows, calls Voyage outside projector transactions, and writes each vector only when the row's desired text hash still matches. Provider failures leave rows dirty and lexical search remains unchanged.

DISCOVERY_SEARCH_EMBEDDINGS=off (also disabled, false, 0, or kill) removes the enrichment service and runner. A missing VOYAGE_API_KEY has the same clean disabled result. Neither condition prevents the API, worker, schema bootstrap, projection replay, or lexical search from starting.

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
