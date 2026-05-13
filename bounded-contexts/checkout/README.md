# Checkout Bounded Context

## Purpose

Checkout owns account purchase intent and the active purchase workflow before payment.

## Owns

- Cart intent
- Checkout session lifecycle
- Checkout review state
- Selected shipping option
- Purchase-intent capture for offer-intent checkout
- Orchestration into Ordering and Payments
- Cart and checkout account routes

## Does Not Own

- Order aggregates
- Payment aggregates
- Shipment aggregates
- Listing and inventory rules

## Invariants

1. Cart is mutable saved buyer intent.
2. Checkout session is an active purchase snapshot from cart, buy-now, or offer-intent.
3. Buy Now creates a checkout session directly and never uses cart as a workaround.
4. Offer Intent captures buyer demand through Checkout but submits a Marketplace-owned Offer instead of creating an order or payment.
5. Ordering creates orders grouped by seller account only after Checkout confirms a cart or buy-now session.
6. Payments initializes external money movement only after orders exist.

## Development Data

Checkout seeds a demo account cart and a started cart checkout session owned entirely by this context. Ordering seeds only order commitments and must not recreate cart data.

This is a greenfield codebase, so local development environments should reset/bootstrap schemas when moving across the cart ownership change. Obsolete Ordering cart read-model tables can be dropped during a dev refresh; Checkout owns `checkout_cart_line_pages` and `checkout_session_pages`, while Payments owns payment read models.
