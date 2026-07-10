# Checkout Bounded Context

## Purpose

Checkout owns account commerce intent and active checkout workflows before orders, payments, or fulfillment work exist.

## Owns

- Cart intent
- Sell List intent
- Checkout session lifecycle
- Checkout review state
- Selected shipping option
- Purchase-intent capture for offer-intent checkout
- Orchestration into Ordering and Payments
- Cart, Sell List, and checkout account routes

## Does Not Own

- Order aggregates
- Payment aggregates
- Shipment aggregates
- Listing and inventory rules

## Ubiquitous Language

Checkout terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Cart
- Sell List
- Checkout Session

## Incoming Dependencies

- Catalog for canonical item, blueprint, and dimension facts used to keep cart and sell-list lines valid.
- Marketplace for listing, offer, and review facts referenced by sell-list intent and checkout confirmation.
- Inventory for item and hold facts used to keep availability current during checkout.
- Identity for account and shipping-address facts.
- Payments for payment lifecycle facts and checkout-affordance signals.
- Settlement for payout-readiness facts that gate seller checkout review.
- Commercial Terms (`@chase-sets/commercial-terms`) for synchronous seller-side fee resolution.
- Ordering (`@chase-sets/ordering`) for synchronous order state read during checkout confirmation.
- Auth (`@chase-sets/auth`) for synchronous actor/session resolution in route composition.

## Outgoing Integration Events

- `checkout.cart.line-added`
- `checkout.cart.line-quantity-set`
- `checkout.cart.line-fulfillment-set`
- `checkout.cart.line-removed`
- `checkout.cart.checked-out`
- `checkout.sell-list.line-added`
- `checkout.sell-list.line-quantity-set`
- `checkout.sell-list.line-removed`
- `checkout.sell-list.checkout-confirmed`
- `checkout.session.started`
- `checkout.session.optimization-goal-selected`
- `checkout.session.fulfillment-preview-recorded`
- `checkout.session.shipping-option-selected`
- `checkout.session.shipping-address-set`
- `checkout.session.reservations-recorded`
- `checkout.session.orders-created`
- `checkout.session.payment-started`
- `checkout.session.offer-submitted`
- `checkout.session.cancelled`

## Invariants

1. Cart is mutable saved buyer intent.
2. Sell List is mutable saved seller intent before selected offers or product-level Smart Match lines become sale commitments.
3. Checkout session is an active purchase snapshot from cart, buy-now, or offer-intent.
4. Buy Now creates a checkout session directly and never uses cart as a workaround.
5. Offer Intent captures buyer demand through Checkout but submits a Marketplace-owned Offer instead of creating an order or payment.
6. Sell List review can coordinate Marketplace offer acceptance or listing fallback, but Marketplace remains the owner of Offer and Listing lifecycle facts.
7. Marketplace source lists may post selected offer ids into the Checkout-owned Sell List route; Checkout resolves the Marketplace offer snapshot before storing durable seller intent.
8. Ordering creates orders grouped by seller account only after Checkout confirms a cart or buy-now session or Marketplace emits accepted offer facts.
9. Payments initializes external money movement only after orders or accepted-offer commitments require it.

## Tests

Run `pnpm --filter @chase-sets/checkout run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/checkout run test` before opening a PR.

## Development Data

Checkout seeds a demo account cart and a started cart checkout session owned entirely by this context. Ordering seeds only order commitments and must not recreate cart or sell-list data.

This is a greenfield codebase, so local development environments should reset/bootstrap schemas when moving across checkout ownership changes. Obsolete Ordering cart or Marketplace sell-list read-model tables can be dropped during a dev refresh; Checkout owns `checkout_cart_line_pages`, `checkout_sell_list_line_pages`, and `checkout_session_pages`, while Payments owns payment read models.

## Supporting Decisions

- [Fresh-State Route Strategy](./docs/fresh-state-route-strategy.md): Shopify-simple Buy Cart, Sell List, readiness, checkout, confirmation, old route disposition, and fresh-state guardrails.
- [Checkout Observability Contract](./docs/checkout-observability-contract.md): redacted telemetry profiles consumed by checkout observability code.
- [Guest Buy Now Freshness Verification](./docs/guest-buy-now-freshness-verification.md): signed-out Buy Now freshness contract, test/canary states, fixture ownership, and no-payment/no-order side-effect rules.
- [Optimistic With Correction](./docs/optimistic-with-correction.md): account-control correction rules for immediate Checkout UI updates such as Buy Cart quantity.

## Buy Cart Readiness

Buy Cart produces a Checkout-owned `checkout.cart-readiness.v1` snapshot before cart checkout session creation.
The snapshot records current cart revision, included line IDs, unresolved line IDs, customer-safe line outcomes,
and optional fulfillment optimization accepted/declined state. Cart checkout session creation consumes that
snapshot as the entry contract and fails closed when it is missing, stale, blocked, or unresolved.

## Post-Write Readiness And Source Results

Checkout post-write handoffs use the shared post-write recovery vocabulary while keeping readiness/source failures
explicit. A valid fresh-write receipt with projection lag is a bounded pending result (`refreshable-catching-up` or
`pending-projection`). Stale readiness snapshots, split-group handoff disagreement, auth failures, validation failures,
domain blockers, and permanent not-found responses are explicit blocker or permanent results; they must not be shown as
checkout preparation.

## Sell List Readiness

Sell List produces a Checkout-owned `checkout.sell-list-readiness.v1` snapshot before seller checkout review can
finalize sale actions. The snapshot records current Sell List revision, included line IDs, unresolved line IDs,
customer-safe line outcomes, and the pre-checkout sale action chosen for each included line, such as selected offer,
Smart Match offer, or fallback listing. Seller checkout review consumes that snapshot as the entry contract and fails
closed when it is missing, stale, blocked, or unresolved.

Product-level lines without a selected sale action stay in Sell List review/readiness. Payout, ship-from, label, and
provider readiness facts must come from their owning contexts and later seller-checkout slices; Checkout does not trust
client input to manufacture those facts.
