# Headless Marketplace API

The headless marketplace API is the REST surface used by `marketplace-web` and external clients. Most account commerce, order, payment, fulfillment, and review flows are mounted at `/api/marketplace`. Identity, inventory, notifications, and settlement keep their canonical context-owned base paths (`/api/identity`, `/api/inventory`, `/api/notifications`, and `/api/settlement`) because those contexts already own the behavior and route clients.

Every account can participate on both sides of the marketplace. API names should use account language for identity, setup, inventory, listings, wallet, and settings; buyer/seller language is reserved for transaction roles and role-specific projections such as purchases, sales, buyer-paid refunds, seller net, and account-confirmed sales fee snapshots. Selling enablement such as terms acceptance, payout readiness, tax setup, or provider onboarding is an account capability, not a separate seller account identity.

The canonical machine-readable contract is [`marketplace.openapi.json`](./marketplace.openapi.json). This OpenAPI document is hand-authored and must be updated with every route-contract change. Keep endpoint coverage in the OpenAPI contract and generated route manifests rather than maintaining a separate manual parity matrix.

## Authentication

Clients authenticate with either the browser session cookie or a bearer API key:

```http
Authorization: Bearer key_...
Cookie: chase_sets_session=...
```

Account-scoped endpoints resolve tenant, user, account, and permissions from the authenticated actor. Do not send `accountId` as an authority field in request bodies; bodies may include account IDs only when the owning business action explicitly models another participant.

## Headers

- `traceparent`: optional W3C trace context propagated into request telemetry and stored event trace metadata.
- `tracestate`: optional W3C vendor trace state.
- `Chase-Sets-Read-After-Write`: short-lived source-context commit receipt used on read-model-backed `GET` and `HEAD` requests after a client follows a write redirect.
- `Chase-Sets-Read-Target-Context`: server-set target context hint used by platform request clients on shared API mount paths.

## Browser Query Metadata

- `afterWrite`: short-lived browser-route query token encoded from `Chase-Sets-Commit-Receipt`.
- `postWriteHandoff`: optional semantic query metadata paired with `afterWrite`. It describes the expected visible outcome of the successful command, such as `collection-non-empty` for an account-cart add-line handoff. It is not a header and is valid only while the paired `afterWrite` receipt is valid.

`postWriteHandoff` is for browser routes that can otherwise hide a successful command behind a stale `200` empty collection, stale unchanged resource, or `404`. Durable job/status flows should keep returning durable status resources, job snapshots, polling links, or SSE progress instead of being forced into browser handoffs.

## Responses

List endpoints return:

```json
{ "items": [], "total": 0, "count": 0 }
```

Command endpoints return:

```json
{ "id": "resource_id", "version": 1, "status": "accepted" }
```

Write responses may also include consistency headers:

- `Chase-Sets-Consistency: eventual`
- `Chase-Sets-Commit-Position: <global event position>`
- `Chase-Sets-Commit-Receipt: <encoded source-context receipt>` when committed events were recorded
- `Chase-Sets-Commit-Event-Ids: <comma-separated event ids>` when the compact value fits in response headers

Browser routes that redirect to a read-model-backed page after a write carry the source-context receipt as a short-lived `afterWrite` query token. When a normal-looking stale response could hide the command result, the same URL may also carry `postWriteHandoff` query metadata with safe structural fields: `kind`, `expectation`, and optional `surface`. Server-side route fetches must use `@chase-sets/platform-runtime/http` forwarding helpers so the freshness token is sent as `Chase-Sets-Read-After-Write`; request clients on shared API mounts must also pass `readTargetContextName` so `Chase-Sets-Read-Target-Context` is set. `postWriteHandoff` stays on the browser URL for route-local evaluation and must not be forwarded as a new header. Stale auth-only forwarding helpers are retired and should not be reintroduced. Mounted APIs wait for relevant projection checkpoints before loading the read model. Route authors should declare `readFreshnessRoutes` on the owning API mount for post-write read-model routes so the gate waits on exact projection dependencies instead of every projection in the target context. Detail loaders may still use bounded `404` retries as a compatibility fallback. Clients must not treat every `404` as retryable; only a valid, unexpired fresh-write token means the resource may still be waiting for projections.

Routes should use `classifyFreshWriteReadError` from `@chase-sets/http/responses` before deciding whether read-model `404`, `projection_freshness_timeout`, or an opaque bounded gateway/service timeout is temporary. Missing, malformed, far-future, or expired `afterWrite` values are not retryable. Slightly future-dated tokens are accepted within the platform clock-skew allowance so slow redirects and server clock drift do not become false not-found failures. Checkout maps valid fresh-write `404`, `503 projection_freshness_timeout`, and bounded `502`/`503`/`504` checkout-entry transport responses to a temporary checkout preparation state; expired Checkout handoffs use safe buyer-task copy with payment-not-started reassurance instead of generic session-not-found copy. Non-Checkout detail routes should use the same contract with context-owned copy: for example, Marketplace listing detail can show a temporary listing preparation state immediately after publication, while an old listing URL without a valid receipt remains a normal not-found or access response.

Route authors adding `navigateAfterWrite`, `loadAfterWrite`, or lower-level helpers such as `appendFreshWriteToken`, `appendFreshWriteTokenFromSources`, `appendPostWriteHandoff`, `loadFreshlyWrittenResource`, `readPostWriteHandoff`, `readPostWriteHandoffState`, or `evaluatePostWriteHandoff` must also update the owning context's `readAfterWriteRouteInventory` metadata. `pnpm run check:structure` fails when a helper use is missing from the inventory, when a critical route lacks exact `readFreshnessRoutes` dependencies, or when an exception is missing owner, reason, and renewal date.

Use the [Post-Write Consistency Policy](../architecture/post-write-consistency.md) before choosing a mutation strategy. For ordinary `fresh-read` routes, source actions should use `navigateAfterWrite`, destination loaders should use `loadAfterWrite`, and route recovery boundaries should distinguish bounded projection lag from readiness/source blockers. If the stale response risk is semantic rather than only `404`/timeout, also follow [Semantic Post-Write Handoffs](../architecture/semantic-post-write-handoffs.md). Use the [Advanced Read-After-Write Route Author Checklist](../architecture/read-after-write-route-author-checklist.md) for bespoke manifest fields, supported exception statuses, cookie-backed continuation requirements, and local checks that keep shared-mount projection waits narrow and predictable.

Command responses do not imply downstream projections have drained. Clients that need read-your-writes behavior should choose one of the documented strategies: keep response metadata attached and redirect with `afterWrite`, apply optimistic UI with bounded correction, render a command-owned snapshot, or use realtime only as a bounded correction channel with reload/refetch fallback.

Errors use one envelope:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Price amount is required.",
    "details": [{ "field": "priceAmount", "message": "Required." }]
  }
}
```

Standard error codes are `authentication_required`, `authorization_forbidden`, `validation_failed`, `not_found`, `conflict`, `projection_freshness_timeout`, `provider_failed`, and `internal_error`.

`projection_freshness_timeout` returns HTTP `503` when a read-after-write receipt is fresh but the required projection checkpoints do not catch up before the bounded wait. Clients should retry the read with the same `afterWrite` token while it is still fresh or surface a temporary refresh state. Reloads, back/forward navigation, and delayed navigation may reuse the same token only while it is still valid. Clients must not mint a replacement token after timeout; the original token age is the termination rule that prevents infinite recovery loops. The token must remain limited to commit receipt metadata: observation time, source context names, source global positions, and event ids. Do not add account ids, email addresses, session ids, item details, payment state, or other customer data.

Fee-confirmed listing and offer actions may also return `fee_quote_stale` with a `currentQuote` object. Clients should show the returned quote and retry with its `feeQuoteFingerprint`. Payment creation may return `fee_quote_stale` with `marketplace_checkout_fee` when the confirmed Marketplace Checkout Fee fingerprint is stale.

## Permissions

- Catalog browsing and public reputation reads are anonymous unless a route needs account-specific state.
- Cart, checkout, purchases, and payment checkout recovery use `orders.view` or `orders.manage`.
- Listings use `listings.view` or `listings.manage`.
- Offers use `offers.view` or `offers.manage`; offer match acceptance also requires listing access.
- Inventory intake and stock actions use `inventory.view` or `inventory.manage`.
- Shipment operations for sales use `orders.view` plus listing permissions where enforced by the owning route.
- Payout and wallet workflows use `payouts.view`, `payouts.setup`, `payouts.request`, `payouts.reconcile`, or `payouts.manage`.
- Notification center feed and settings workflows use `accounts.view`.
- Account team, invitations, and API keys use the identity permissions projected into Auth, including `memberships.*` and `security.manage`.

## Critical Workflows

Marketplace item search accepts URL-backed Discovery filters. Dynamic filters use stable Catalog identifiers: `field.<field_id>` for descriptive Field values, `reference.<reference_type_key>` for Reference Records such as Pokemon Trading Card Product Line, Series, and Expansion, and `dimension.<dimension_id>` for Product-defining Options. Repeating the same filter key applies OR within that facet group; different facet groups combine as AND.

Browse to Buy Cart:

1. `GET /api/marketplace/items`
2. `GET /api/marketplace/items/{id}`
3. `GET /api/marketplace/products/{productId}/market-summary`
4. `POST /api/marketplace/account/cart`

Buy Cart to checkout:

1. `GET /api/marketplace/account/cart`
2. `POST /api/marketplace/account/checkout-sessions`
3. `POST /api/marketplace/account/checkout-sessions/{sessionId}/shipping-option`
4. `GET /api/marketplace/account/checkout/status`
5. `POST /api/marketplace/account/checkout-sessions/{sessionId}/confirm`
6. `GET /api/marketplace/account/payments/{id}`

Offer Match to Sell List review:

1. `GET /api/marketplace/account/offers/matches`
2. `GET /api/marketplace/account/offers/matches/{id}`
3. `POST /api/marketplace/account/sell-list`
4. `GET /api/marketplace/account/sell-list`
5. `POST /api/marketplace/account/sell-list/{lineId}/remove`

Checkout owns durable Sell List review state for selected offers and product-level Smart Match offer lines. Marketplace owns the Offer and Listing lifecycle; Offer Matches should source selected offers into Checkout Sell List instead of owning the review plan.

Listing publication:

1. `POST /api/inventory/items/listing-stock/ensure`
2. `GET /api/marketplace/account/listing-availability`
3. `POST /api/marketplace/account/listing-availability/disable`
4. `POST /api/marketplace/account/listing-availability/enable`
5. `POST /api/marketplace/account/listings/preview`
6. `POST /api/marketplace/account/listings`
7. `POST /api/marketplace/account/listings/{id}/publish`
8. `GET /api/marketplace/account/listings/fee-lock-report`
9. `GET /api/marketplace/account/listings/{id}/fee-history`

Advanced inventory workflows may still call `GET /api/inventory/items` and `GET /api/marketplace/account/listing-inventory` before binding a Listing to a specific existing Inventory Item.

High-dollar Listing publication can fail with `validation_failed` when Marketplace requires Listing Photo evidence or account trust before activation. Draft creation remains allowed; only buyer-visible publication is blocked until the Listing and account-risk policy clears.

Agent listing import:

1. `GET /api/inventory/import-batches/sources`
2. `POST /api/inventory/import-batches`
3. `GET /api/inventory/import-batches/{id}`
4. `POST /api/inventory/import-batches/{id}/commit`

The same flow is exposed through native MCP tools: `inventory.list-import-sources`, `inventory.create-import-batch`, `inventory.get-import-batch`, and `inventory.commit-import-batch`. Connectors and agents fetch or parse provider rows; Inventory source profiles decide row semantics and Catalog reference matching.

Sale shipment printing:

1. `GET /api/marketplace/account/sales/shipments`
2. `GET /api/marketplace/account/sales/shipments/packing-slips?shipmentIds=shp_1,shp_2`

Notification center:

1. `GET /api/notifications/center`
2. `GET /api/notifications/center/unread-count`
3. `POST /api/notifications/center/{deliveryId}/read`
4. `POST /api/notifications/center/read-all`
5. `GET /api/notifications/preferences`
6. `POST /api/notifications/preferences/{key}`

Offer acceptance:

1. `POST /api/marketplace/account/offers/submitted`
2. `GET /api/marketplace/account/offers/matches`
3. `GET /api/marketplace/account/offers/matches/{id}/terms-preview`
4. `POST /api/marketplace/account/offers/matches/{id}/accept`

Marketplace exposes only source-list and direct offer acceptance APIs for offer matches. Durable seller review state belongs to Checkout at `/api/marketplace/account/sell-list`.

## Marketplace Sales Fee Confirmation

Seller-side marketplace sales fees are confirmed before publication or acceptance and then carried as per-unit snapshots. Ordering consumes those snapshots for listing purchases and accepted offers.

Listing preview returns:

```json
{
  "basis_amount": "20.00",
  "marketplace_sales_fee_unit_amount": "1.00",
  "seller_net_unit_amount": "19.00",
  "schedule_id": "cts_default",
  "agreement_id": null,
  "resolved_at": "2026-05-03T18:00:00.000Z",
  "fee_quote_fingerprint": "20.00|1.00|19.00|cts_default|"
}
```

Publish, active price edits, active quantity-cap edits, and offer acceptance must submit the confirmed `feeQuoteFingerprint`. If terms have changed since preview, the API returns:

```json
{
  "error": {
    "code": "fee_quote_stale",
    "message": "Fee quote is stale. Refresh the fee preview before continuing.",
    "currentQuote": {
      "basis_amount": "20.00",
      "marketplace_sales_fee_unit_amount": "2.00",
      "seller_net_unit_amount": "18.00",
      "schedule_id": "cts_default",
      "agreement_id": null,
      "resolved_at": "2026-05-03T18:05:00.000Z",
      "fee_quote_fingerprint": "20.00|2.00|18.00|cts_default|"
    }
  }
}
```

`GET /api/marketplace/account/listings/{id}/fee-history` returns the seller-visible lock history for listing creation, publication, active price edits, and active quantity-cap edits.

`GET /api/marketplace/account/listings/fee-lock-report` returns the seller-visible management report of current per-unit marketplace sales fee locks across the account's listings, including source schedule/agreement ids, resolved time, fee quote fingerprint, locked fee, and seller net.

The full policy and confirmation flow lives in [Marketplace Sales Fee Confirmation](../../bounded-contexts/marketplace/docs/marketplace-sales-fee-confirmation.md).

## Seller Listing Availability

Seller Listing Availability is the legacy name for an account-level Marketplace overlay that pauses new selling commitments without changing individual Listing Status values. `GET /api/marketplace/account/listing-availability` returns the current overlay. `POST /api/marketplace/account/listing-availability/disable` accepts optional `reasonCategory` (`travel`, `audit`, `operations`, or `other`) and optional `availableAgainOn` (`YYYY-MM-DD`) for account-facing context. `POST /api/marketplace/account/listing-availability/enable` restores the account's listings to public availability.

When the overlay is off, Marketplace blocks checkout confirmation and offer acceptance for the account's listings. Discovery hides affected listings from browse, search, item detail market supply, account pages, and sitemap surfaces, while direct listing URLs remain reachable with no buy action. The durable behavior model lives in [Marketplace Seller Listing Availability](../../bounded-contexts/marketplace/docs/seller-listing-availability.md).

## Marketplace Checkout Fee Confirmation

Payments quotes the buyer-side Marketplace Checkout Fee at payment level after wallet or platform credit and after order totals include shipping and sales tax. `GET /api/marketplace/account/checkout/status` returns the selected `marketplace_checkout_fee`, payment method quotes, and wallet credit amounts before payment.

Payment creation must submit the confirmed `marketplaceCheckoutFeeQuoteFingerprint`. Stale payment quotes return `409 fee_quote_stale` with the current `marketplace_checkout_fee`; clients should show the returned quote and retry with the new fingerprint.

`GET /api/marketplace/account/marketplace-checkout-fee-policy` exposes the active policy version, method adjustments, enabled jurisdictions, and quote audit fields for payment operations. The current fee policy lives in [Payments Marketplace Checkout Fee Policy](../../bounded-contexts/payments/docs/marketplace-checkout-fee-policy.md).

Payout setup:

1. `GET /api/settlement/account-status`
2. `POST /api/settlement/payout-setup/embedded-session`
3. `POST /api/settlement/payout-setup/refresh`
4. `POST /api/settlement/payouts/preview`
5. `POST /api/settlement/payouts`

Embedded payout setup and account management:

- `POST /api/settlement/payout-setup/embedded-session` creates a short-lived embedded setup session for the authenticated account.
- `POST /api/settlement/payout-setup/account-management-embedded-session` creates a short-lived embedded account management session for an account with an existing payout account.
- Both routes require `payouts.setup`, return `401 authentication_required` without account context, and return `403 authorization_forbidden` without setup permission.
- Embedded routes return only `{ "clientSecret", "providerReference", "expiresAt", "components" }`. Clients pass `clientSecret` directly to the embedded provider UI and must not store or log it.
- The launch API exposes no hosted redirect setup or login-link routes; payout setup and account management use embedded provider components only.

After purchase capture, Settlement posts seller item proceeds and shipping allowance credits as pending wallet entries. Pending credits become payout-eligible only after the order has a delivered Fulfillment fact, no active support hold, and the applicable release window has elapsed. Standard accounts release at the later of capture plus two days and delivery plus two days. New, unrated, untrusted, high-dollar, or manual-review accounts use delivery plus seven days. Payout preview can return `payout-release-hold-active` when the wallet has pending funds that are still blocked by delivery or risk release policy.
