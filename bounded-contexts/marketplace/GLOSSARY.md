# Marketplace Domain Glossary

This glossary defines the canonical terminology for the Marketplace bounded context.

Browse, search, filters, and item detail terminology are owned by the Discovery bounded context.

Aggregate language and projection language may differ. The Marketplace aggregate is `Offer`; account-submitted projections use `Submitted Offer`, and matching-supply projections use `Offer Match`.

## Listing

A **Listing** is a seller-published offer to sell a specific product at a defined price and quantity.

Notes:

- Listings are owned by Marketplace.
- Listings reference one `CatalogItemId`, one `ProductId`, and one normalized selection snapshot.
- Listings reference inventory availability but do not own stock truth.

## Offer

An **Offer** is an account-submitted purchase proposal for a specific product, price, and quantity submitted as marketplace-wide demand.

Notes:

- Offers are owned by Marketplace.
- Offers reference one `CatalogItemId`, one `ProductId`, and one normalized selection snapshot.
- In v1, offers are not tied to a specific seller, listing, or inventory item until accepted.
- Any signed-in account may submit product-scoped offers; offer submission does not require listing, inventory, or seller-management permissions.
- Submitted offers are public marketplace-wide demand on product detail surfaces. Public offer rows expose the same account-level attribution style as public listings and must not expose shipping destinations or private contact details.
- Accounts see their submitted demand as Submitted Offers.
- Accounts can review Offer Matches only when they have matching active listings.
- Discovery Product Alerts may consume limited offer demand signals for subscribed accounts without exposing buyer identity or full Offer detail.
- When accepted, an offer leaves public marketplace-wide demand and becomes a commitment input for the selling account in Ordering.

## Limited Offer Demand Signal

A **Limited Offer Demand Signal** is the restricted fact that submitted demand exists for a Product and satisfies a Product Alert price threshold.

Notes:

- Marketplace owns the underlying Offer and full Offer visibility policy.
- Discovery Product Alerts may use limited offer demand signals for notifications.
- Limited offer demand signals do not expose buyer identity, shipping destination, or full Offer detail.

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

**Offer Acceptance** is the selling-account action that ends marketplace-wide demand visibility for an offer and emits the fact Ordering uses to create an order.
