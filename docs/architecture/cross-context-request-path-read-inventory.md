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

## Milestone 57 Freshness Matrix (#2781)

This matrix records the freshness demand for Milestone #57's request-path read migration slices. It does not create a new exception for request-time HTTP reads: each consuming slice still moves to a local, view-owned mirror. Non-wave-1 source contexts only gate the freshness SLO and push/listener rollout decision in #1364.

For this matrix, `non-wave-1` follows the #2776 guardrail's source wake posture: `checkout`, `marketplace`, `ordering`, and `payments` are wave-1-listened; `identity` and `inventory` remain poll-only for these request-path mirrors until #1364 records and resolves the source-demand posture.

| Consuming issue/view | Source context | Mirrored fact | Freshness requirement | Interim posture | #1364 source-demand input |
| --- | --- | --- | --- | --- | --- |
| #2777 Checkout sell rail | Marketplace | Offer acceptance terms, offer matches, and seller listing inventory rows | Local Checkout sell-session/sell-list mirror must be current enough to render and submit sell actions without request fan-out. | Wave-1-listened; proceed with local-read migration using the existing push-wake posture. | None beyond existing wave-1 coverage. |
| #2777 Checkout sell rail | Identity | Account shipping-address summaries used by the sell checkout loader | Local Checkout sell-session mirror must provide usable address choices; exact "just changed address" freshness is an SLO concern, not a migration blocker. | Poll-only mirror is acceptable during migration; use bounded recovery/empty-state copy if the mirror has not caught up. | Demand: record Identity shipping-address events as a Checkout sell-session mirror source; decide whether #1364 expands push/listener coverage before tightening the SLO. |
| #2778 Checkout buy rail | Payments | Buy-session payment status, payment preview/status, saved checkout instruments, and confirmation payment state | Payment status reads are read-your-writes and need wake-before-wait (#2512) against the local Checkout payment/buy-session mirror before user-visible continuation. | Wave-1-listened; migrate to local mirror and keep wake-before-wait rollout as the freshness gate. | None beyond existing wave-1 coverage. |
| #2778 Checkout buy rail | Ordering | Fulfillment preview state for checkout sessions | Checkout buy-session mirror must be current enough to avoid request fan-out while rendering fulfillment readiness. | Wave-1-listened; proceed with local-read migration. | None beyond existing wave-1 coverage. |
| #2778 Checkout buy rail | Identity | Account shipping-address summaries used by checkout sessions | Local Checkout buy-session mirror must expose address choices; a just-created or just-edited address needs a defined SLO before the route can promise exact freshness. | Poll-only mirror is acceptable for the migration; stale/empty address choices remain a freshness-SLO gate rather than a local-read blocker. | Demand: record Identity shipping-address events as a Checkout buy-session mirror source; #1364 decides the push/listener posture for exact address freshness. |
| #2779 Discovery item-detail seller overlays | Marketplace and Checkout | Listing terms, seller listing overlays, offer matches, seller listing inventory summaries, and current account sell-list state | Discovery item-detail overlay mirror must render seller/buyer affordances without request-path Marketplace or Checkout reads. | Wave-1-listened; proceed with local-read migration. | None beyond existing wave-1 coverage. |
| #2779 Discovery item-detail seller overlays | Inventory | Storage location summaries used to recover or explain listing setup state | Discovery mirror may tolerate poll-cadence freshness; stale storage locations can surface bounded recovery while the mirror catches up. Exact read-your-writes is not required by the current slice. | Poll-only mirror is acceptable for migration; keep the SLO explicitly looser than Checkout payment/address freshness. | Demand: record Inventory storage-location events as a Discovery item-detail mirror source; no immediate push expansion required unless #1364 later raises the overlay SLO. |
| #2780 Account overlays | Marketplace, Ordering, and Payments | Review opportunity summaries and order context for account purchase/sale/payment views | Account overlays must use local mirrors for display context; current milestone demand is minimal and aligns with existing wave-1 source posture. | Wave-1-listened for the listed sources; proceed with local-read migration. | None beyond existing wave-1 coverage. |
| #2780 Marketplace account listings | Inventory | Inventory item detail needed by Marketplace account-listings routes | Marketplace account-listings mirror must show seller inventory item details without request fan-out; exact post-edit freshness should be confirmed before enforcing a tight SLO. | Poll-only mirror is acceptable to unblock local-read migration; SLO remains gated until Inventory source posture is confirmed. | Demand: record Inventory item/storage-location events as Marketplace account-listings mirror sources; #1364 should decide whether Inventory needs push/listener coverage for seller account-listing freshness. |

Follow-up rule for #2781 closure: if a slice discovers a new non-wave-1 source while removing the request-path read, add it here before closing the slice. If the slice only needs a tighter freshness guarantee for an already listed source, update #1364 instead of blocking the local-read migration.
