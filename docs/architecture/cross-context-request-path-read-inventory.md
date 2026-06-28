# Cross-Context Request-Path Read Inventory

Issue #2776 owns the living inventory for customer-critical request paths that still read a sibling bounded context during a loader or action. The committed source of truth is `scripts/check-structure/cross-context-read-baseline.json`; `pnpm run check:structure` scans the current route code and writes the generated operator artifact to `artifacts/cross-context-read-inventory.json`.

## Classification Guide

Use `composite-projection-servable` by default. The consuming bounded context should own a view-scoped composite projection, fed by upstream events, and read that local model at request time. Each row must link the slice issue that removes the HTTP read.

Use `read-your-writes` when the read follows the caller's own just-written state and the UI must observe that write before continuing. Replace request-time HTTP with a local mirror plus wake-before-wait freshness on the local checkpoint, coordinated with #2512.

Use `genuinely-synchronous` only when the read cannot be projected, such as a live third-party/provider response or an authorization decision that must be evaluated synchronously against the owning context. These rows must carry a written justification in the baseline.

## Decision Flow

1. If the route only needs rendered view data, classify it as `composite-projection-servable`.
2. If the route is recovering or confirming a write it just issued, classify it as `read-your-writes`.
3. If projection would be incorrect because the value is live external state or a synchronous ownership decision, classify it as `genuinely-synchronous` and explain why.
4. Record the source wake posture. `checkout`, `marketplace`, `ordering`, and `payments` are `wave-1-listened`; other sources are `poll-only` until #1364 expands push coverage.
5. Run `pnpm run check:structure`. New reads warn locally and fail in CI until they are removed or added to the baseline with a classification, migration note, and issue link.

The target implementation pattern is Checkout's cart projection family under `bounded-contexts/checkout/features/cart/integrations/*`: local, view-owned, rebuildable projections instead of request-path fan-out.
