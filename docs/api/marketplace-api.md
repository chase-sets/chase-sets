# Headless Marketplace API

The headless marketplace API is the REST surface used by `marketplace-web` and external clients. Most buyer, seller, order, payment, fulfillment, and review flows are mounted at `/api/marketplace`. Identity, inventory, and settlement keep their canonical context-owned base paths (`/api/identity`, `/api/inventory`, and `/api/settlement`) because those contexts already own the behavior and route clients.

The canonical machine-readable contract is [`marketplace.openapi.json`](./marketplace.openapi.json). The parity inventory is [`marketplace-api-parity.md`](./marketplace-api-parity.md).

## Authentication

Clients authenticate with either the browser session cookie or a bearer API key:

```http
Authorization: Bearer key_...
Cookie: chase_sets_session=...
```

Account-scoped endpoints resolve tenant, user, account, and permissions from the authenticated actor. Do not send `accountId` as an authority field in request bodies; bodies may include account IDs only when the owning business action explicitly models another participant.

## Headers

- `x-correlation-id`: optional trace identifier forwarded into command metadata.
- `x-causation-id`: optional parent action identifier.
- `x-command-id`: optional idempotency/command identifier for write requests.

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
4. `POST /api/marketplace/account/checkout-sessions/{sessionId}/confirm`
5. `GET /api/marketplace/account/payments/{id}`

Seller listing:

1. `GET /api/inventory/items`
2. `GET /api/marketplace/account/listing-inventory`
3. `POST /api/marketplace/account/listings/preview`
4. `POST /api/marketplace/account/listings`
5. `POST /api/marketplace/account/listings/{id}/publish`

Offer acceptance:

1. `POST /api/marketplace/account/offers/submitted`
2. `GET /api/marketplace/account/offers/matches`
3. `POST /api/marketplace/account/offers/matches/{id}/accept`

Seller payout setup:

1. `GET /api/settlement/account-status`
2. `POST /api/settlement/payout-setup/onboarding-session`
3. `POST /api/settlement/payout-setup/refresh`
4. `POST /api/settlement/payouts/preview`
5. `POST /api/settlement/payouts`
