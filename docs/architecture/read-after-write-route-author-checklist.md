# Advanced Read-After-Write Route Author Checklist

## Purpose

Use the default-safe path first: source actions call `navigateAfterWrite`, destination loaders call `loadAfterWrite`, and the route maps the returned result through its recovery boundary. The canonical migration steps live in [Post-Write Consistency Policy: Migrating An Existing Route](./post-write-consistency.md#migrating-an-existing-route).

This checklist is advanced authoring guidance for browser actions that write durable state and immediately redirect or refresh to a route whose loader reads a projection-backed API resource when the route needs bespoke review. Typical reasons are semantic handoff predicates, cookie-backed continuations, shared API mounts, file-level helper scans, temporary exceptions, or unusual dependency proof. The route author contract is still:

1. The write response returns source-context commit receipt metadata.
2. The browser route carries that receipt in a short-lived `afterWrite` token.
3. Server-side route clients forward the token as `Chase-Sets-Read-After-Write` and name the serving read context with `Chase-Sets-Read-Target-Context`.
4. The API read consistency gate waits only for the exact projection groups required by the destination route.
5. The destination route treats `404`, `projection_freshness_timeout`, and any route-bounded gateway/service timeout as temporary only while the original token is valid.

The helper path implements this pattern without turning every read into a synchronous projection drain. Route authors should not hand-build `afterWrite`, manually parse `postWriteHandoff`, or duplicate `loadAfterWrite` classification for ordinary routes.

When the destination can return a stale but successful shape, use the [Semantic Post-Write Handoffs](./semantic-post-write-handoffs.md) extension. `postWriteHandoff` is query metadata paired with `afterWrite`; it lets the destination distinguish an expected post-command outcome from a stale `200` empty collection, stale unchanged resource, or `404`. It is not a new header and does not change API freshness waits.

For flows that do not need a projection-backed immediate read, first choose the strategy in the [Post-Write Consistency Policy](./post-write-consistency.md). Realtime/SSE may supplement this checklist, but it is not the sole guarantee for critical immediate feedback unless the route documents and tests an authoritative reload/refetch fallback.

## Required Authoring Steps

- Identify the source action and command that writes durable state.
- Identify the destination browser route, API context, API `GET` or `HEAD` route, and read-model table or projection group used by the first loader read.
- Ensure the write result includes `Chase-Sets-Commit-Receipt` or source-aware commit metadata that `appendFreshWriteToken` can encode.
- Add the `afterWrite` token with `navigateAfterWrite` when redirecting to the destination.
- Pass a `handoff` option to `navigateAfterWrite` when the destination also needs semantic pending recovery for a stale `200` empty, stale unchanged resource, or `404`.
- Load the destination with `loadAfterWrite` only for the projection-backed resource that may lag.
- Evaluate semantic expectations through the `loadAfterWrite` `isHandoffSatisfied` option. Use lower-level `readPostWriteHandoffState`, `readPostWriteHandoff`, or `evaluatePostWriteHandoff` only for bespoke routes that cannot use the helper result shape; missing, malformed, expired, or unpaired handoffs are normal non-applicable states.
- Use request clients built on `@chase-sets/platform-runtime/http` so server-side fetches preserve `Chase-Sets-Read-After-Write`.
- Pass `readTargetContextName` from context-owned request clients on shared mounts such as `/api/marketplace`.
- Declare the destination API route in the owning context's `apiMounts[].readFreshnessRoutes`.
- Add or update the owning context's `readAfterWriteRouteInventory` entry.
- Add route-owned transient recovery copy for valid fresh-write `404`, `503 projection_freshness_timeout`, and any scoped opaque gateway/service timeout that the route intentionally bounds.
- Keep permanent `404`, `401`, and `403` behavior intact for missing, expired, malformed, or wrong-actor handoffs.

## Exact Freshness Dependencies

Projection waits must stay narrow. For each destination API route, prefer a `readModelTable` dependency when one projection group owns the table:

```json
{
  "routePath": "/account/payments/:id",
  "methods": ["GET", "HEAD"],
  "dependencies": [
    {
      "readModelTable": "payments_payment_pages"
    }
  ]
}
```

Use `projectionName` when the route depends on a projection group rather than a single declared table. Do not declare broad context-level waits for a critical post-write route. If a table is read immediately after a write, it must appear in exactly one projection group's `ownedTables` so the gate can resolve it without ambiguity.

Use `projectionName` only when the route truly needs projection-level proof, such as a multi-table read whose projection cannot be represented by one table owner. Add `freshnessDependencyReason` in the route inventory for projection-level dependencies so reviewers can see why a `readModelTable` dependency was not enough.

Shared API mounts must include the target context header. Without `Chase-Sets-Read-Target-Context`, two contexts exposing similar route shapes under `/api/marketplace` can cause unrelated projections to be selected or skipped.

## Route Inventory Fields

Every helper use in production route modules must be represented in `readAfterWriteRouteInventory` or by a dated exception. Required fields for a normal route are:

- `id`: stable context-scoped inventory id.
- `owner`: accountable context or team.
- `risk`: one of `critical`, `important`, `internal`, or `informational`.
- `source.routeId` or `source.routeIds`: route contribution that creates or refreshes the write.
- `source.actions`: customer or operator actions that trigger the write.
- `source.command`: domain command or command family.
- `source.helperUses`: `navigateAfterWrite` or the lower-level `appendFreshWriteToken`, `appendFreshWriteTokenFromSources`, or `appendPostWriteHandoff` subset used by a bespoke route.
- `destination.routeId`: browser route that performs the post-write read.
- `destination.apiContextName`: context serving the API read.
- `destination.apiRoutePath`: route path matching `apiMounts[].readFreshnessRoutes[].routePath`.
- `destination.readModelTables` or `destination.projectionDependencies`: exact dependency proof.
- `destination.helperUses`: loader helper, usually `loadAfterWrite`; include lower-level `loadFreshlyWrittenResource`, `readPostWriteHandoffState`, `readPostWriteHandoff`, or `evaluatePostWriteHandoff` only when the route cannot use the default helper result shape.
- `destination.transientRecovery`: object with `kinds` and `behavior`. `kinds` is the canonical post-write recovery kind or array of kinds that the route can surface. `behavior` describes the route-owned customer recovery behavior. Use `refreshable-catching-up` for valid fresh-write `404`, `projection_freshness_timeout`, or bounded gateway/service lag; add `pending-projection` when a valid semantic handoff can leave a stale successful response pending; use the remaining canonical kinds only when the route explicitly documents that terminal or user-action recovery state.

File-level entries are allowed only when the scanner cannot map a helper use to a deployable route contribution. Prefer route ids whenever possible.

## Exception Format

Exceptions are temporary records, not permanent bypasses. Use them only when the helper use is freshness-neutral or the owning migration is explicitly tracked.

```json
{
  "exception": {
    "status": "not-read-model-backed",
    "owner": "marketplace",
    "reviewBy": "2026-07-31",
    "reason": "This helper only preserves the token for a route whose first read does not use a projection-backed read model."
  }
}
```

Supported statuses are:

- `accepted`: known projection-backed gap with a tracked migration owner.
- `not-read-model-backed`: the destination does not depend on projection catch-up.
- `not-post-write-read`: this context only carries the token to another owning destination.

Each exception must include `owner`, `reason`, and `reviewBy` in `YYYY-MM-DD` form. Renew or remove exceptions during release hardening. Critical customer-facing routes should not keep accepted exceptions after their exact dependency and recovery behavior are implemented.

## Transient Recovery Rules

Manifest declarations use the canonical post-write recovery taxonomy from the Post-Write Consistency Policy:

- `pending-projection`
- `refreshable-catching-up`
- `stale-projection`
- `action-required`
- `expired-handoff`
- `terminal-failure`

`404` is permanent by default. It may be treated as temporary only when `readFreshWriteTokenState(request)` or `recoverFreshWriteReadError` sees a valid, unexpired `afterWrite` token.

Temporary states:

- Fresh token plus `404`: the route may show preparation or refresh UI.
- Fresh token plus `503 projection_freshness_timeout`: the route may show the same temporary recovery UI.
- Fresh token plus a route-bounded opaque `502`, `503`, or `504`: the route may show the same temporary recovery UI when the request client intentionally prevents an outer platform timeout.
- Fresh token plus valid `postWriteHandoff` whose expectation is not yet visible in a stale `200` response: the route may show the same bounded pending UI.

Temporary states are projection-visibility states. They are not domain/readiness/source blockers. A fresh token must not turn stale checkout readiness, split-group handoff disagreement, unresolved fulfillment, blocked payout readiness, validation failure, authorization failure, or a true missing source into preparation UI.

Permanent states:

- Missing token.
- Malformed token.
- Far-future token outside clock-skew allowance.
- Expired token.
- `401`, `403`, or unrelated API errors unless the route has separate protected-resource recovery.

Do not mint a replacement token after timeout, refresh indefinitely, or convert old manual URLs into temporary states. Token validity and retry budgets are the termination rule.

Do not keep a spinner or disabled action past the retry budget. When `loadAfterWrite` returns `permanent-failure`, render the context-owned recovery instead of retrying in place.

Semantic handoffs should be added only when an audit finds a successful command can be hidden by stale `200` empty, stale unchanged resource, or `404`. Durable job/status flows, admin operation pages, and command responses that already carry a committed visible snapshot should stay with their existing `mutationConsistencyInventory` strategies instead of being forced into browser handoffs.

## Cookie-Backed Continuations

When the same action also creates, rotates, clears, or switches an auth-like cookie, the route must satisfy both contracts:

- Return a document-level redirect, such as `redirectDocument`, so the browser commits `Set-Cookie` before the destination loader runs.
- Preserve the `afterWrite` token on the redirect if the destination loader reads projection-backed data.

Guest Buy Now checkout is the canonical case. The contact submit action creates guest checkout state, starts a checkout session, sets `chase_sets_guest_checkout`, and redirects to `/checkout/buy/session/:sessionId`. The redirect must be document-level for the cookie and must include `afterWrite` for `checkout_session_pages` freshness.

## Canonical Examples

Checkout guest Buy Now:

- Source route: `buy-checkout-readiness`.
- Destination route: `buy-checkout-session`.
- API route: Checkout `/account/checkout-sessions/:sessionId`.
- Dependency: `checkout_session_pages`, owned by `checkout.session-projection`.
- Inventory id: `checkout.session-start-to-detail`.
- Helper path: source calls `navigateAfterWrite`; destination calls `loadAfterWrite`; the Checkout recovery boundary maps helper results into readiness/source outcomes.
- Recovery: valid fresh-write `404`, `projection_freshness_timeout`, or route-bounded gateway/service timeout renders temporary checkout preparation UI; stale readiness, split-group handoff disagreement, validation, auth, and domain blockers render review/restart/access recovery; expired handoff renders safe restart copy that confirms payment has not started.

Item detail add-to-cart to Buy Cart semantic handoff:

- Source route: `item-detail`.
- Source behavior: Discovery returns the committed Checkout cart-line snapshot and builds `viewCartHref` with `navigateAfterWrite(result, "/account/cart", { handoff: ACCOUNT_CART_ADD_LINE_HANDOFF })`.
- Destination route: `account-cart`.
- API route: Checkout `/account/cart`.
- Dependency: `checkout_cart_line_pages`, owned by `checkout.cart-projection`.
- Inventory ids: `discovery.item-detail-checkout-handoff` for the cross-context token carrier and `checkout.cart-self-refresh` for the destination wait and pending state.
- Recovery: a valid `checkout.cart.add-line` handoff with `collection-non-empty` renders temporary "Adding your item" copy only when the loaded cart is still empty. Satisfied carts render normally; missing, malformed, expired, far-future, unpaired, wrong-kind, remove-to-empty, and normal empty visits do not show add-line pending recovery.
- Diagnostics: emit `chase_sets_post_write_consistency_events_total` through the platform post-write telemetry port with `strategy="fresh-read"` and `correction_source="semantic-handoff:checkout.cart.add-line"`.

Payments create to detail:

- Source route: `account-payment-new`.
- Destination route: `account-payment`.
- API route: Payments `/account/payments/:id`.
- Dependency: `payments_payment_pages`, owned by `payments-payment-projection`.
- Inventory id: `payments.create-to-detail`.
- Recovery: `recoverFreshWriteReadError` maps temporary lag to payment preparation UI; old or invalid payment URLs remain normal not-found or access outcomes.

Marketplace listing create to detail:

- Source routes: `account-listings` and `account-listing`.
- Destination route: `account-listing`.
- API route: Marketplace `/account/listings/:id`.
- Dependency: `marketplace_listing_pages`, owned by `marketplace-listing-projection`.
- Inventory id: `marketplace.listing-create-to-detail`.
- Helper path: source calls `navigateAfterWrite`; destination calls `loadAfterWrite`.
- Recovery: listing detail renders bounded preparing recovery while the listing projection catches up, then preserves normal not-found/access behavior for old URLs or permanent failures.

Admin durable job/status non-example:

- Source route: Catalog Source Observations import, promotion, bulk review, reapply, or reject action.
- Destination route: durable job/status or operator control-plane page.
- Strategy: durable job/status snapshot plus realtime correction.
- Rule: do not add browser `postWriteHandoff` metadata. Operators need job ids, status rows, progress events, retries, and diagnostics that outlive a short browser receipt.
- Evidence: `bounded-contexts/catalog/features/source-observations/api/route-modules/route-integration-jobs.test.ts` and `bounded-contexts/catalog/tests/admin-integrations-route-action.test.tsx`.

## Guardrails And Checks

Local checks:

- `pnpm run check:structure` validates context manifests, `readFreshnessRoutes`, route inventory, helper coverage, exception shape, and stale forwarding helper imports.
- `pnpm run test:structure` covers structural guardrail behavior, including retired freshness-dropping forwarding imports.
- `pnpm run check:localization` catches route-owned recovery copy gaps.
- `pnpm run check:no-any` and type checks catch unsafe helper and request-client drift.
- Route or context tests must cover the source redirect, token forwarding, fresh temporary recovery, expired-token permanent recovery, and expected protected-resource failures. Semantic handoff routes must also cover valid pending, satisfied, missing/malformed, and expired or unpaired handoff states.

The inventory report is generated at `artifacts/read-after-write-route-inventory.md`. It lists routes, helper uses, dependencies, recovery behavior, exceptions, and validation findings. Regenerate it through `pnpm run check:structure`; do not edit it by hand.

## Performance Expectations

Post-write freshness paths are customer-facing latency paths. Keep them performant by:

- Declaring exact route dependencies instead of context-wide waits.
- Using `readModelTable` ownership to resolve one projection group per table.
- Keeping projection subscription `eventTypes` narrow and validated against handler maps.
- Avoiding broad stream-prefix subscriptions for immediate-read routes unless query plans have been checked with production-like data.
- Ensuring projection-owned read-model tables have indexes for the destination loader's lookup shape.
- Keeping route recovery bounded so repeated timeouts do not create unbounded API or worker pressure.

Do not introduce synchronous write-drain as the normal fix. It is a compatibility mode only; the platform contract is receipt propagation plus bounded projection checkpoint gating.
