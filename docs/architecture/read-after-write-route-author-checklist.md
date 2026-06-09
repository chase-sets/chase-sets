# Read-After-Write Route Author Checklist

## Purpose

Use this checklist when a browser action writes durable state and immediately redirects or refreshes to a route whose loader reads a projection-backed API resource. The route author contract is:

1. The write response returns source-context commit receipt metadata.
2. The browser route carries that receipt in a short-lived `afterWrite` token.
3. Server-side route clients forward the token as `Chase-Sets-Read-After-Write` and name the serving read context with `Chase-Sets-Read-Target-Context`.
4. The API read consistency gate waits only for the exact projection groups required by the destination route.
5. The destination route treats `404`, `projection_freshness_timeout`, and any route-bounded gateway/service timeout as temporary only while the original token is valid.

This pattern prevents a user-facing "not found" after a successful write without turning every read into a synchronous projection drain.

## Required Authoring Steps

- Identify the source action and command that writes durable state.
- Identify the destination browser route, API context, API `GET` or `HEAD` route, and read-model table or projection group used by the first loader read.
- Ensure the write result includes `Chase-Sets-Commit-Receipt` or source-aware commit metadata that `appendFreshWriteToken` can encode.
- Add the `afterWrite` token with `appendFreshWriteToken` or `appendFreshWriteTokenFromSources` when redirecting to the destination.
- Load the destination with `loadFreshlyWrittenResource` only for the projection-backed resource that may lag.
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

Shared API mounts must include the target context header. Without `Chase-Sets-Read-Target-Context`, two contexts exposing similar route shapes under `/api/marketplace` can cause unrelated projections to be selected or skipped.

## Route Inventory Fields

Every helper use in production route modules must be represented in `readAfterWriteRouteInventory` or by a dated exception. Required fields for a normal route are:

- `id`: stable context-scoped inventory id.
- `owner`: accountable context or team.
- `risk`: one of `critical`, `important`, `internal`, or `informational`.
- `source.routeId` or `source.routeIds`: route contribution that creates or refreshes the write.
- `source.actions`: customer or operator actions that trigger the write.
- `source.command`: domain command or command family.
- `source.helperUses`: `appendFreshWriteToken`, `appendFreshWriteTokenFromSources`, or both.
- `destination.routeId`: browser route that performs the post-write read.
- `destination.apiContextName`: context serving the API read.
- `destination.apiRoutePath`: route path matching `apiMounts[].readFreshnessRoutes[].routePath`.
- `destination.readModelTables` or `destination.projectionDependencies`: exact dependency proof.
- `destination.helperUses`: loader helper, usually `loadFreshlyWrittenResource`.
- `destination.transientRecovery`: route-owned behavior for temporary lag.

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

`404` is permanent by default. It may be treated as temporary only when `readFreshWriteTokenState(request)` or `recoverFreshWriteReadError` sees a valid, unexpired `afterWrite` token.

Temporary states:

- Fresh token plus `404`: the route may show preparation or refresh UI.
- Fresh token plus `503 projection_freshness_timeout`: the route may show the same temporary recovery UI.
- Fresh token plus a route-bounded opaque `502`, `503`, or `504`: the route may show the same temporary recovery UI when the request client intentionally prevents an outer platform timeout.

Permanent states:

- Missing token.
- Malformed token.
- Far-future token outside clock-skew allowance.
- Expired token.
- `401`, `403`, or unrelated API errors unless the route has separate protected-resource recovery.

Do not mint a replacement token after timeout, refresh indefinitely, or convert old manual URLs into temporary states. Token validity and retry budgets are the termination rule.

## Cookie-Backed Continuations

When the same action also creates, rotates, clears, or switches an auth-like cookie, the route must satisfy both contracts:

- Return a document-level redirect, such as `redirectDocument`, so the browser commits `Set-Cookie` before the destination loader runs.
- Preserve the `afterWrite` token on the redirect if the destination loader reads projection-backed data.

Guest Buy Now checkout is the canonical case. The contact submit action creates guest checkout state, starts a checkout session, sets `chase_sets_guest_checkout`, and redirects to `/checkout/:sessionId`. The redirect must be document-level for the cookie and must include `afterWrite` for `checkout_session_pages` freshness.

## Canonical Examples

Checkout guest Buy Now:

- Source route: `checkout-start`.
- Destination route: `checkout-session`.
- API route: Checkout `/account/checkout-sessions/:sessionId`.
- Dependency: `checkout_session_pages`, owned by `checkout.session-projection`.
- Inventory id: `checkout.session-start-to-detail`.
- Recovery: valid fresh-write `404`, `projection_freshness_timeout`, or route-bounded gateway/service timeout renders temporary checkout preparation UI; expired handoff renders safe restart copy that confirms payment has not started.

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
- Recovery: listing detail retries fresh-write not-found while the listing projection catches up.

## Guardrails And Checks

Local checks:

- `pnpm run check:structure` validates context manifests, `readFreshnessRoutes`, route inventory, helper coverage, exception shape, and stale forwarding helper imports.
- `pnpm run test:structure` covers structural guardrail behavior, including retired freshness-dropping forwarding imports.
- `pnpm run check:localization` catches route-owned recovery copy gaps.
- `pnpm run check:no-any` and type checks catch unsafe helper and request-client drift.
- Route or context tests must cover the source redirect, token forwarding, fresh temporary recovery, expired-token permanent recovery, and expected protected-resource failures.

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
