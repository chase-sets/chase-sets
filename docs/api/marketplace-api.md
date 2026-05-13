# Headless Marketplace API

The headless marketplace API is the REST surface used by `marketplace-web` and external clients. Most buyer, seller, order, payment, fulfillment, and review flows are mounted at `/api/marketplace`. Identity, inventory, and settlement keep their canonical context-owned base paths (`/api/identity`, `/api/inventory`, and `/api/settlement`) because those contexts already own the behavior and route clients.

The canonical machine-readable contract is [`marketplace.openapi.json`](./marketplace.openapi.json). Keep endpoint coverage in the OpenAPI contract and generated route manifests rather than maintaining a separate manual parity matrix.

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

## Responses

List endpoints return:

```json
{ "items": [], "total": 0, "count": 0 }
```

Command endpoints return:

```json
{ "id": "resource_id", "version": 1, "status": "accepted" }
```

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

Standard error codes are `authentication_required`, `authorization_forbidden`, `validation_failed`, `not_found`, `conflict`, `provider_failed`, and `internal_error`.

Fee-confirmed listing and offer actions may also return `fee_quote_stale` with a `currentQuote` object. Clients should show the returned quote and retry with its `feeQuoteFingerprint`. Payment creation may return `fee_quote_stale` with `marketplace_checkout_fee` when the confirmed Marketplace Checkout Fee fingerprint is stale.

## Permissions

- Catalog browsing and public reputation reads are anonymous unless a route needs account-specific state.
- Cart, checkout, purchases, and payment checkout recovery use `orders.view` or `orders.manage`.
- Listings use `listings.view` or `listings.manage`.
- Offers use `offers.view` or `offers.manage`; seller match acceptance also requires listing access.
- Inventory intake and stock actions use `inventory.view` or `inventory.manage`.
- Seller shipment operations use `orders.view` plus seller/listing permissions where enforced by the owning route.
- Payout and wallet workflows use `payouts.view`, `payouts.setup`, `payouts.request`, `payouts.reconcile`, or `payouts.manage`.
- Account team, invitations, and API keys use the identity permissions projected into Auth, including `memberships.*` and `security.manage`.

## Critical Workflows

Browse to cart:

1. `GET /api/marketplace/items`
2. `GET /api/marketplace/items/{id}`
3. `GET /api/marketplace/products/{productId}/market-summary`
4. `POST /api/marketplace/account/cart`

Cart to checkout:

1. `GET /api/marketplace/account/cart`
2. `POST /api/marketplace/account/checkout-sessions`
3. `POST /api/marketplace/account/checkout-sessions/{sessionId}/shipping-option`
4. `GET /api/marketplace/account/checkout/status`
5. `POST /api/marketplace/account/checkout-sessions/{sessionId}/confirm`
6. `GET /api/marketplace/account/payments/{id}`

Seller listing:

1. `GET /api/inventory/items`
2. `GET /api/marketplace/account/listing-inventory`
3. `GET /api/marketplace/account/listing-availability`
4. `POST /api/marketplace/account/listing-availability/disable`
5. `POST /api/marketplace/account/listing-availability/enable`
6. `POST /api/marketplace/account/listings/preview`
7. `POST /api/marketplace/account/listings`
8. `POST /api/marketplace/account/listings/{id}/publish`
9. `GET /api/marketplace/account/listings/fee-lock-report`
10. `GET /api/marketplace/account/listings/{id}/fee-history`

Seller shipment printing:

1. `GET /api/marketplace/account/sales/shipments`
2. `GET /api/marketplace/account/sales/shipments/packing-slips?shipmentIds=shp_1,shp_2`

Offer acceptance:

1. `POST /api/marketplace/account/offers/submitted`
2. `GET /api/marketplace/account/offers/matches`
3. `GET /api/marketplace/account/offers/matches/{id}/terms-preview`
4. `POST /api/marketplace/account/offers/matches/{id}/accept`

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

The full policy and confirmation flow lives in [Marketplace Seller Fee Confirmation](../../bounded-contexts/marketplace/docs/seller-fee-confirmation.md).

## Seller Listing Availability

Seller Listing Availability is an account-level Marketplace overlay for pausing new seller commitments without changing individual Listing Status values. `GET /api/marketplace/account/listing-availability` returns the current overlay. `POST /api/marketplace/account/listing-availability/disable` accepts optional `reasonCategory` (`travel`, `audit`, `operations`, or `other`) and optional `availableAgainOn` (`YYYY-MM-DD`) for seller-facing context. `POST /api/marketplace/account/listing-availability/enable` restores the account's listings to public availability.

When the overlay is off, Marketplace blocks checkout confirmation and offer acceptance for the seller's listings. Discovery hides affected listings from browse, search, item detail market supply, seller pages, and sitemap surfaces, while direct listing URLs remain reachable with no buy action. The durable behavior model lives in [Marketplace Seller Listing Availability](../../bounded-contexts/marketplace/docs/seller-listing-availability.md).

## Marketplace Checkout Fee Confirmation

Payments quotes the buyer-side Marketplace Checkout Fee at payment level after wallet or platform credit and after order totals include shipping and sales tax. `GET /api/marketplace/account/checkout/status` returns the selected `marketplace_checkout_fee`, payment method quotes, and wallet credit amounts before payment.

Payment creation must submit the confirmed `marketplaceCheckoutFeeQuoteFingerprint`. Stale payment quotes return `409 fee_quote_stale` with the current `marketplace_checkout_fee`; clients should show the returned quote and retry with the new fingerprint.

`GET /api/marketplace/account/marketplace-checkout-fee-policy` exposes the active policy version, method adjustments, enabled jurisdictions, and quote audit fields for payment operations. The current fee policy lives in [Payments Marketplace Checkout Fee Policy](../../bounded-contexts/payments/docs/marketplace-checkout-fee-policy.md).

Seller payout setup:

1. `GET /api/settlement/account-status`
2. `POST /api/settlement/payout-setup/onboarding-session`
3. `POST /api/settlement/payout-setup/refresh`
4. `POST /api/settlement/payouts/preview`
5. `POST /api/settlement/payouts`
