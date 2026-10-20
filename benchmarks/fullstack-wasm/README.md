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

## Bun follow-up (measured 2026-10-19, `results/ssr-bun-r1..r3`)

Same React Router page and client bundle, five server setups, each alone at 1 CPU / 1 GiB with
the same k6 phases (fixed 60 req/s, then 64 and 256 VUs). Bun is the `oven/bun:1` image,
`bun --revision` 1.4.3+c6da4a4d3; its binary embeds `src/**/*.rs` paths and no `.zig` paths.

| Setup | Runtime | Server | React render | Max req/s (64 VUs) | 256 VUs | CPU at 60 req/s | Mem at 60 req/s | Idle mem |
|---|---|---|---|---|---|---|---|---|
| A, today's stack | Node 24 | Express | `renderToPipeableStream` | 68 | 63, 2% failed | 100% (saturated) | 121 MiB | 34 MiB |
| B | Node 24 | Express | `renderToReadableStream` | 87 | 110, 0.7% failed | 57% | 149 MiB | 34 MiB |
| C, 3 rounds | Node 24 | `node:http` | `renderToReadableStream` | 91 / 110 / 124 | 118 / 89 / 118, 0.6-1.1% failed | 38-71% | 137-150 MiB | 26 MiB |
| D | Bun 1.4.3 | Express | `renderToReadableStream` | 88 | 85 | 64% | 98 MiB | 23 MiB |
| E, 3 rounds | Bun 1.4.3 | `Bun.serve` | `renderToReadableStream` | 122 / 193 / 172 | 114 / 157 / 205, 0 failed | 34-42% | 81-87 MiB | 14 MiB |

All five pass `parity.mjs` (16/16) and the form action. Findings:

1. React Router's default Node entry does not start on Bun: Bun resolves `react-dom/server` to
   `server.bun.js`, which has no `renderToPipeableStream`. B to E use `bun/entry.server.tsx`.
2. On Node, the Web Streams renderer alone moved 68 to 87 req/s, and dropping Express added a
   little more. These are TypeScript-only changes.
3. Bun on Express (D) matched Node on Express (B). Bun's gain appears only with `Bun.serve`:
   E over C was about 1.55x on median max throughput, with about 40% less memory.
4. E's median (172 req/s) is in the range Leptos reached in the earlier run (170), but that was a
   different session, so treat it as roughly comparable, not equal.
5. Round-to-round spread is large (E ranged 122 to 193). Startup timings (`*-startup.json`) were
   dominated by `docker run` and too noisy to rank.
6. C and E serve assets without compression; the production server compresses and logs with
   morgan, which none of B to E reproduce.

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
docker build -t fsw-react-bun -f benchmarks/fullstack-wasm/react-router/Dockerfile.bun benchmarks/fullstack-wasm/react-router
docker build -t fsw-react-node-web -f benchmarks/fullstack-wasm/react-router/Dockerfile.node-webstreams benchmarks/fullstack-wasm/react-router
node benchmarks/fullstack-wasm/run-ssr.mjs ssr-bun-r1 60 react,node-webstreams,node-native,bun-express,bun-native
node benchmarks/fullstack-wasm/parity.mjs http://localhost:18401 http://localhost:18402
node benchmarks/fullstack-wasm/browser.mjs http://localhost:18401 http://localhost:18402 10
```
