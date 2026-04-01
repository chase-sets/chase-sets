# Marketplace Domain Glossary

This glossary defines the canonical terminology for the Marketplace bounded context.

Browse, search, filters, and item detail terminology are owned by the Discovery bounded context.

## Listing

A **Listing** is a seller-published offer to sell a specific catalog item at a defined price and quantity.

Notes:

- Listings are owned by Marketplace.
- Listings reference inventory availability but do not own stock truth.

## Offer

An **Offer** is a buyer-proposed purchase for a specific item version, price, and quantity submitted as marketplace-wide demand.

Notes:

- Offers are owned by Marketplace.
- In v1, offers are not tied to a specific seller, listing, or inventory record.
- Sellers can review offers only when they have matching active listings.
- When accepted, an offer becomes a seller-specific commitment input for Ordering.

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
- Accepted

## Commerce Commitment Request

A **Commerce Commitment Request** is the integration fact emitted when Marketplace determines an accepted purchase should become an order.

## Offer Acceptance

**Offer Acceptance** is the seller action that ends marketplace-wide demand visibility for an offer and emits the fact Ordering uses to create an order.
