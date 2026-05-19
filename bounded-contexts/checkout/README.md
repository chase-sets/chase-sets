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
