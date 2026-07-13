# Seller Order Capacity

Seller Order Capacity is Marketplace's account-level setting for the maximum number of Open Orders a seller account will accept at once (the Order Capacity term).

## Model

- The setting is scoped by account id and is event-sourced on a Marketplace-owned stream (`marketplace.seller-order-capacity-{accountId}`).
- State is `{ accountId, maxOpenOrders }`. `maxOpenOrders: null` means unlimited -- the default, and no stream exists until a seller sets a cap for the first time.
- `SetSellerOrderCapacity` requires `maxOpenOrders` to be a whole number of at least 1. Re-setting the same value is a no-op (idempotent double-submit protection); changing the value emits a fresh `.set` fact.
- `ClearSellerOrderCapacity` returns the account to unlimited. Clearing while already unlimited is a no-op.

## Invariants

1. This setting gates NEW order intake only -- it never affects in-flight orders, payments, fulfillment, refunds, or the account's buying ability.
2. Offer Acceptance creates an order, so once enforcement lands, an At-Capacity seller's accepts are refused with clear copy through the same ordering seam offer-checkout already flows through.
3. This slice is additive and INERT: the setting and its events publish, but nothing consumes them yet. No order intake is refused, and no Open Order count is computed, until the enforcement slice lands.
4. There is no seller-facing UI in this slice.

## Cross-Context Facts

Marketplace publishes:

- `marketplace.seller-order-capacity.set`
- `marketplace.seller-order-capacity.cleared`

Ordering owns Open Order truth (counting orders that are neither cancelled nor dispatched) and enforcement -- computing the At Capacity signal, excluding at-capacity sellers' supply from new commitments, and refusing new order intake once a seller is at capacity. That consumption is out of scope for this slice; see the Order Capacity enforcement milestone (plan-stage claims, supply exclusion, the At Capacity signal).
