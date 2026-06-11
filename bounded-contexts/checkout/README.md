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

## Development Data

Checkout seeds a demo account cart and a started cart checkout session owned entirely by this context. Ordering seeds only order commitments and must not recreate cart or sell-list data.

This is a greenfield codebase, so local development environments should reset/bootstrap schemas when moving across checkout ownership changes. Obsolete Ordering cart or Marketplace sell-list read-model tables can be dropped during a dev refresh; Checkout owns `checkout_cart_line_pages`, `checkout_sell_list_line_pages`, and `checkout_session_pages`, while Payments owns payment read models.

## Supporting Decisions

- [Fresh-State Route Strategy](./docs/fresh-state-route-strategy.md): Shopify-simple Buy Cart, Sell List, readiness, checkout, confirmation, legacy route disposition, and kill-switch route strategy.
- [Fresh Checkout Session Contracts](./docs/fresh-checkout-session-contracts.md): shared buy/sell snapshot, command, state-machine, recovery, idempotency, guest-merge, and fresh-state compatibility rules for Milestone #17.
- [Checkout Copy Policy](./docs/checkout-copy-policy.md): Milestone #17 customer-safe checkout copy, progressive-disclosure, policy language, support-reference, and launch cleanup contract.
- [Checkout Session Projection Performance](./docs/checkout-session-projection-performance.md): guest Buy Now freshness path, session read-model indexes, projection transaction behavior, and platform evidence gates.
- [Checkout Performance Budgets](./docs/checkout-performance-budgets.md): Milestone #17 cart/list, readiness, checkout entry, confirmation, mobile, support, and recovery performance budgets.
- [Guest Buy Now Freshness Verification](./docs/guest-buy-now-freshness-verification.md): signed-out Buy Now freshness contract, test/canary states, fixture ownership, and no-payment/no-order side-effect rules.

## Buy Cart Readiness

Buy Cart produces a Checkout-owned `checkout.cart-readiness.v1` snapshot before cart checkout session creation.
The snapshot records current cart revision, included line IDs, unresolved line IDs, customer-safe line outcomes,
and optional fulfillment optimization accepted/declined state. Cart checkout session creation consumes that
snapshot as the entry contract and fails closed when it is missing, stale, blocked, or unresolved.

## Sell List Readiness

Sell List produces a Checkout-owned `checkout.sell-list-readiness.v1` snapshot before seller checkout review can
finalize sale actions. The snapshot records current Sell List revision, included line IDs, unresolved line IDs,
customer-safe line outcomes, and the pre-checkout sale action chosen for each included line, such as selected offer,
Smart Match offer, or fallback listing. Seller checkout review consumes that snapshot as the entry contract and fails
closed when it is missing, stale, blocked, or unresolved.

Product-level lines without a selected sale action stay in Sell List review/readiness. Payout, ship-from, label, and
provider readiness facts must come from their owning contexts and later seller-checkout slices; Checkout does not trust
client input to manufacture those facts.
