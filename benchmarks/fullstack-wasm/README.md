# Full-stack Rust/WASM prototype: Leptos vs React Router

Reference experiment, not product code. It renders the same item-detail page twice, both
backed by the Rust item API from `../rust-item-detail` (Redis-warm, Postgres behind it):

- `react-router/`: React Router 7 framework mode (React 19, Vite 8), served by an Express
  server that mirrors `infrastructure/platform-runtime/web-server.ts`.
- `leptos/`: Leptos 0.8 with axum. Server-side rendering, WASM hydration, `#[server]`
  functions and `ActionForm`, which is the closest Rust equivalent of a Remix loader and action.

Both pages share the same CSS byte for byte, the same view model, a client-side sort toggle,
a "show all offers" toggle, a price-alert form action, and client-side navigation from `/`.
`parity.mjs` compares the visible text of the server-rendered pages: 16/16 ids match,
including the 404 page.

## Results (measured 2026-10-19, local Docker Desktop, 16-thread host)

Each web app ran alone at 1 CPU / 1 GiB. The API and Redis had no CPU limit and stayed
under 10% CPU, so the web tier was what saturated.

SSR throughput (k6, uncompressed, items 1-500, `results/ssr-r1/summary.json`):

| Phase | React Router | Leptos |
|---|---|---|
| Open model at 150 req/s | 64 req/s achieved, p50 2.6 s, 6.7% failed | 150 req/s, p50 53 ms, p95 292 ms, 0 failed |
| 64 VUs, saturated | 71 req/s, p95 1.14 s | 170 req/s, p95 510 ms |
| 256 VUs, saturated | 74 req/s, 1.8% failed | 138 req/s, 0 failed |
| Web CPU, saturated | about 1.02 cores | about 1.04 cores |
| Web memory under load | 126-137 MiB | 16-18 MiB (56 MiB at 256 VUs) |
| Idle memory after start | 28 MiB | 2.5 MiB |
| `docker run` to first 200 | 9.4 s | 3.0 s |
| Image size | 245 MB | 85 MB |

Browser (Playwright Chromium, cold cache, 10 runs per cell, medians, `results/browser-summary.json`).
Mobile is 4x CPU slowdown with 1.6 Mbps download.

| Metric | React desktop | Leptos desktop | React mobile | Leptos mobile |
|---|---|---|---|---|
| TTFB | 36 ms | 15 ms | 35 ms | 14 ms |
| FCP / LCP | 192 ms | 164 ms | 1114 ms | 1156 ms |
| Hydrated | 277 ms | 206 ms | 2129 ms | 2297 ms |
| Blocking time before hydration | 44 ms | 46 ms | 876 ms | 1118 ms |
| Form action round trip | 320 ms | 251 ms | 944 ms | 816 ms |
| Client navigation | 53 ms | 44 ms | 510 ms | 489 ms |
| JS heap | 2.9 MB | 2.1 MB | 2.9 MB | 2.1 MB |

Payload (brotli on the wire / decoded):

| Asset | React Router | Leptos |
|---|---|---|
| Client code | 102 KB / 319 KB JS in 4 files | 283 KB / 737 KB WASM + 7 KB / 25 KB JS glue |
| HTML for item_1 | 1.6 KB / 19.7 KB | 0.6 KB / 18.1 KB |
| Requests per cold load | 7 | 4 |

Build (measured, Docker, BuildKit cache mounts): a Leptos rebuild after a one-file change took
264 s. The WASM crate compiled in 35 s, then wasm-bindgen and wasm-opt took 39 s (about 31 s of it
reinstalling those tools, which a cached image layer would avoid). The server release build ran in
parallel and finished after 4 min, which set the total. The cold builds ran concurrently
(React 569 s, Leptos 929 s), so neither number is meaningful on its own.

## Caveats

1. One page, synthetic data, one machine. The host was also running unrelated containers.
2. Chrome CPU throttling applies to the main thread. WASM compilation partly runs off it, so
   mobile WASM numbers may be optimistic or pessimistic; a real low-end Android device is the
   only real answer. Emulated latency did not show up in TTFB.
3. The WASM bundle is a single 283 KB brotli file for one page. Leptos 0.8 supports split
   WASM per route, which was not tried. React would grow roughly per component; WASM grows
   per crate and generic instantiation.
4. No Cargo.lock or package-lock is committed; versions are pinned in the manifests only.
5. Porting the real app means rewriting about 437 React components and the design system,
   with no Rust equivalents for most of the npm UI libraries in use.

## Reproduce

Needs the `rustbench` network, `rb-rust` (API), `rustbench-pg` and `rustbench-redis` from
`../rust-item-detail`.

```powershell
docker build -t fsw-react-router benchmarks/fullstack-wasm/react-router
docker build -t fsw-leptos benchmarks/fullstack-wasm/leptos
node benchmarks/fullstack-wasm/run-ssr.mjs ssr-r1 150
node benchmarks/fullstack-wasm/parity.mjs http://localhost:18401 http://localhost:18402
node benchmarks/fullstack-wasm/browser.mjs http://localhost:18401 http://localhost:18402 10
```
