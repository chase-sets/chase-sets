# Checkout Bounded Context

## Purpose

Checkout owns buyer purchase intent and the active purchase workflow before payment.

## Owns

- Buyer cart intent
- Checkout session lifecycle
- Checkout review state
- Selected shipping option
- Orchestration into Ordering and Payments
- Cart and checkout buyer routes

## Does Not Own

- Order aggregates
- Payment aggregates
- Shipment aggregates
- Listing and inventory rules

## Invariants

1. Cart is mutable saved buyer intent.
2. Checkout session is an active purchase snapshot from cart or buy-now.
3. Buy Now creates a checkout session directly and never uses cart as a workaround.
4. Ordering creates seller-specific orders only after Checkout confirms a session.
5. Payments initializes external money movement only after orders exist.

## Development Data

Checkout seeds a demo buyer cart and a started cart checkout session owned entirely by this context. Ordering seeds only order commitments and must not recreate cart data.

This is a greenfield codebase, so local development environments should reset/bootstrap schemas when moving across the cart ownership change. Obsolete Ordering cart read-model tables can be dropped during a dev refresh; Checkout owns `checkout_cart_line_pages` and `checkout_session_pages`, while Payments owns payment read models.
