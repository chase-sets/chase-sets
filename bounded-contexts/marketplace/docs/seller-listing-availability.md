# Seller Listing Availability

Seller Listing Availability is Marketplace's account-level overlay for temporarily turning active listings off without changing each listing's own lifecycle status.

## Model

- The overlay is scoped by account id and is event-sourced on a Marketplace-owned stream.
- The states are `available` and `unavailable`.
- Disabling may record a structured reason category and optional `availableAgainOn` date.
- `availableAgainOn` is informational in the first implementation. It does not automatically turn listings back on.
- Enabling availability requires an explicit seller action.

## Invariants

1. Turning availability off does not mutate Listing Status.
2. Active listings from unavailable sellers are not shown in buyer browse, search, item-detail purchase sections, seller listing lists, sitemap listing output, or listing product-alert notifications.
3. Direct listing URLs remain reachable and render as unavailable with no purchase action.
4. Ordering must reject stale checkout attempts for unavailable seller listings.
5. Offer Matches remain visible while unavailable, but Offer Acceptance is blocked.
6. Existing carts, checkout sessions, orders, payments, fulfillment, and account buying ability are not changed by this overlay.

## Cross-Context Facts

Marketplace publishes:

- `marketplace.seller-listing-availability.disabled`
- `marketplace.seller-listing-availability.enabled`

Discovery projects these facts into public seller/listing views. Ordering projects them into supply eligibility. Downstream contexts consume the facts; they do not decide seller availability truth.
