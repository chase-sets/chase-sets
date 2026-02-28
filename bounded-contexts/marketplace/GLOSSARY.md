# Marketplace Domain Glossary

This glossary defines the canonical terminology for the Marketplace bounded context.

## Listing

A **Listing** is a seller-published offer to sell a specific catalog item at a defined price and quantity.

Notes:

- Listings are owned by Marketplace.
- Listings reference inventory availability but do not own stock truth.

## Offer

An **Offer** is a buyer-proposed purchase for a specific item, price, and quantity submitted against market supply.

Notes:

- Offers are owned by Marketplace.
- Accepted offers trigger order creation in Ordering.

## Listing Status

**Listing Status** is the lifecycle state of a listing.

Examples:

- Draft
- Active
- Paused
- Withdrawn
- Sold Out

## Offer Status

**Offer Status** is the lifecycle state of an offer.

Examples:

- Submitted
- Countered
- Accepted
- Declined
- Expired
- Withdrawn

## Commerce Commitment Request

A **Commerce Commitment Request** is the integration fact emitted when Marketplace determines an accepted purchase should become an order.
