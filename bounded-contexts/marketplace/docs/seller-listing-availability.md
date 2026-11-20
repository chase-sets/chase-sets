# Seller Listing Availability

Seller Listing Availability is Marketplace's account-level Away overlay. It covers Listings, Offers, or both without changing Listing or Offer Status.

## Model

- The overlay is scoped by account id and is event-sourced on a Marketplace-owned stream.
- Each side is independently `available` or `unavailable`, with its own reason, provenance, and Resume Instant.
- A seller's Disable replaces the scope. An internal disable sets only the named sides. An unscoped Disable or scheduled window defaults to Listings, including on replay. An unscoped Enable restores both sides; scheduled restores check the observed Resume Instant on the side being restored.
- Disabling may record a structured reason category, an optional `availableAgainOn` display date, and an optional `availableAgainAt` Resume Instant.
- `availableAgainAt` is the authoritative Resume Instant. When present it is asserted to be strictly after the disable time. It is the only field an automated resume sweep may act on.
- `availableAgainOn` is a display-only date. When both fields are sent, the domain derives `availableAgainOn` from `availableAgainAt` (a UTC calendar-day slice) rather than trusting the two independently, so they can never disagree.
- **Legacy ruling (replay-safe):** historical `.disabled` events recorded before `availableAgainAt` existed carry only `availableAgainOn`. They read back with `availableAgainAt: null` and stay informational only -- they never participate in an automated resume, even after this change ships. Only events carrying an explicit `availableAgainAt` are eligible for automated resume.
- **Instant capture happens at the edge.** The account listings disable form converts its date input to an explicit instant client-side -- the seller's own local start-of-day for the chosen date -- before submitting. The API accepts the instant as sent; it never infers a seller's timezone server-side. If the request arrives without an instant (e.g. JavaScript did not run), the domain falls back to the informational-only `availableAgainOn` date, exactly as before this change.
- **Refresh while away.** `DisableSellerListingAvailability` may be sent again while already `unavailable` to change the reason category or Resume Instant -- e.g. a seller extending or shortening their return date. This emits a new `.disabled` fact rather than being rejected or silently ignored, so a seller never needs an enable/disable flap just to adjust their return date. A repeat command whose reason, display date, and instant are all unchanged from the current state is a no-op (idempotent double-submit protection), not a fresh fact.
- Enabling requires either an explicit seller action or an automated resume, recorded on the `.enabled` fact as `enabledBy: "seller"` or `enabledBy: "scheduled"`. Events recorded before this field existed read back as `"seller"` -- every enable before an automated sweep existed was, definitionally, a seller action. This slice adds no scheduler or sweep; the `"scheduled"` value is available for the auto-resume sweep milestone to use.

## Invariants

1. Turning availability off does not mutate Listing Status.
2. Active listings from unavailable sellers are not shown in buyer browse, search, item-detail purchase sections, seller listing lists, sitemap listing output, or listing product-alert notifications.
3. Direct listing URLs remain reachable and render as unavailable with no purchase action.
4. Ordering must reject stale checkout attempts for unavailable seller listings.
5. Listings away leaves the buyer's Offers visible and still blocks that account from accepting Offers. Offers away hides that buyer's Offers from demand surfaces, alert eligibility, and acceptance. It does not affect that account's Listings or its ability to accept other buyers' Offers.
6. Existing carts, checkout sessions, orders, payments, fulfillment, and account buying ability are not changed by this overlay.
7. A Resume Instant, when present, is always strictly after the disable time that recorded it.

## Cross-Context Facts

Marketplace publishes:

- `marketplace.seller-listing-availability.disabled`
- `marketplace.seller-listing-availability.enabled`
- `marketplace.seller-listing-availability.offers-disabled`
- `marketplace.seller-listing-availability.offers-enabled`

The original events remain Listings-only and continue to drive existing Listing consumers. Discovery and Checkout project the Offers events into their own buyer Offer standing rows. Marketplace checks the buyer's authoritative Away stream before accepting an Offer.
