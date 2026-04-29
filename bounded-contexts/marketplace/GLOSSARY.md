# Marketplace Domain Glossary

This glossary defines the canonical terminology for the Marketplace bounded context.

Browse, search, filters, and item detail terminology are owned by the Discovery bounded context.

Aggregate language and projection language may differ. The Marketplace aggregate is `Buyer Offer`; buyer projections use `Submitted Buyer Offer`, and seller projections use `Buyer Offer Match`.

## Listing

A **Listing** is a seller-published offer to sell a specific product at a defined price and quantity.

Notes:

- Listings are owned by Marketplace.
- Listings reference one `CatalogItemId`, one `ProductId`, and one normalized selection snapshot.
- Listings reference inventory availability but do not own stock truth.

## Buyer Offer

A **Buyer Offer** is a buyer-proposed purchase for a specific product, price, and quantity submitted as marketplace-wide demand.

Notes:

- Buyer Offers are owned by Marketplace.
- Buyer Offers reference one `CatalogItemId`, one `ProductId`, and one normalized selection snapshot.
- In v1, buyer offers are not tied to a specific seller, listing, or inventory item.
- Buyers see their submitted demand as Submitted Buyer Offers.
- Sellers can review Buyer Offer Matches only when they have matching active listings.
- When accepted, a buyer offer becomes a seller-specific commitment input for Ordering.

## Listing Status

**Listing Status** is the lifecycle state of a listing.

Examples:

- Draft
- Active
- Paused
- Withdrawn
- Sold Out

## Buyer Offer Status

**Buyer Offer Status** is the lifecycle state of a buyer offer.

Examples:

- Submitted
- Accepted

## Commerce Commitment Request

A **Commerce Commitment Request** is the integration fact emitted when Marketplace determines an accepted purchase should become an order.

## Buyer Offer Acceptance

**Buyer Offer Acceptance** is the seller action that ends marketplace-wide demand visibility for a buyer offer and emits the fact Ordering uses to create an order.
