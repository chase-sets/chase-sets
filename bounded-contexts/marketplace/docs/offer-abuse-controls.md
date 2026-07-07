# Offer Abuse Controls

Marketplace owns offer abuse controls because offers and offer matches are Marketplace behavior before an order exists.

## Active policy

Policy version: `marketplace-offer-abuse-controls-v1`

Defaults:

- Buyer daily offer submission cap: `25` submitted offers per rolling 24 hours.
- Buyer listing daily offer cap: `3` active or seller-declined offers per listing per rolling 24 hours.
- Minimum offer price: `50%` of the matching Listing ask.
- Repeat-lowball cooldown: after `2` seller declines below ask, offers from the same buyer to that seller/listing must be at least the last declined amount for `7` days.

## Scope

Offers stay product-scoped and marketplace-wide. Listing-specific controls evaluate the current active listings the offer would match, then seller-specific mutes, declines, floors, and cooldowns filter the Offer Match surface.

Seller-configurable per-listing floors are intentionally deferred; the first policy uses the Marketplace default floor for every listing.
