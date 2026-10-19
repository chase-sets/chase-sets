# Node vs Rust: Discovery item detail (reference only)

Reference experiment from 2026-10-19. Not part of the product build and not meant to merge.
It ports the Discovery item-detail and category read routes to Rust and load-tests both
stacks against the same Postgres 16 data. The page-lookup fix it found ships separately in
chase-sets/chase-sets#10162 (PR #10163); this branch carries the same change so the
`r2` and later rounds reproduce.

## Layout

- `rust/`: axum + tokio-postgres port (`src/main.rs`), same SQL, query order and JSON as Node.
- `node/server.ts`: mounts the production routes and queries on `@hono/node-server`.
  Bundle with esbuild to `node/dist/server.mjs` before `docker build`.
- `seed.sql`: synthetic data (50k item pages, 150k listings skewed to popular items, 30k offers,
  20k content lines, 300 categories, 5k slug redirects).
- `parity.mjs`: 235 requests against both stacks; responses must be deep-equal.
- `load.js`: k6 mix (80% item by id, 8% by slug, 2% retired slug, 10% categories).
- `run.mjs <round> [fixedRate]`: per stack, restart Postgres, run the app at `--cpus 1 --memory 1g`,
  then warmup, fixed rate, 64 VUs and 256 VUs. Optional env: `PHASES`, `REDIS_URL`, `CACHE_TTL_SECONDS`.
- `startup.mjs [iterations]`: cold start to first 200 and first DB request per image, plus Node bundled vs tsx on the host (`HOST_ONLY=1` skips containers).
- `sample-stats.mjs`: `docker stats` sampler. `results/`: raw k6 and stats output.

Containers: `rustbench-pg` (pgvector/pgvector:pg16, `--cpus 2 --memory 4g`, port 55432) and
`rustbench-redis` (redis:7-alpine) on Docker network `rustbench`.

## Rounds

| Round | What changed |
| --- | --- |
| r1 | Original page lookup; Postgres saturated at about 33 req/s for both stacks |
| r2, r3 | Index-backed lookup; fixed rate 150 (r2) and 100 (r3) |
| r3b | Repeat of the 100 req/s phase after the sampler fix |
| c1, c2 | Redis cache-aside on 200 responses; TTL 30 s (c1) and 300 s (c2) |

## Headline (measured locally, synthetic data, no PgBouncer or TLS)

| Measure | Node | Rust |
| --- | --- | --- |
| Max throughput, no cache | 127-134 req/s | 165-169 req/s |
| CPU at 100 req/s | 0.64 core | 0.34 core |
| Memory under load | 76-136 MiB | 11-33 MiB |
| 64 VUs, 300 s cache | 173 req/s | 341 req/s |

## Startup (measured, 10 container starts and 5 host starts each, medians)

| Measure | Node bundle | Rust |
| --- | --- | --- |
| Process start to listening, in container | 546 ms | 2.5 ms |
| First DB-backed request after start | 183 ms | 90 ms |
| Memory after first requests | 38 MiB | 3 MiB |

On the host, the same Node server took 560 ms to first 200 bundled and 4.6-5.0 s under tsx.
