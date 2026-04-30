# Marketplace Bounded Context

## Purpose

Marketplace owns the buy and sell interaction layer before an order exists.

Marketplace supply and demand are product-scoped. Listings and offers target products, not bare catalog items:

- `catalogItemId`
- `productId`
- normalized `selectedOptions`

If an item uses a `condition` dimension, that condition is part of the selected product options. Marketplace does not carry a separate condition field.

## Owns

- Listing lifecycle
- Offer capture and review
- Seller asking prices
- Available sell quantity exposed to buyers
- Buyer proposed prices
- Requested quantity
- Listing visibility and activation state
- Marketplace-wide demand visibility for matching seller supply

## Does Not Own

- Inventory cost basis
- Browse, search, and item detail discovery experiences
- Cart checkout orchestration
- Final order settlement
- Shipping execution

## Ubiquitous Language

Marketplace terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Listing
- Offer
- Listing Publication Policy
- Offer Visibility Projection

## Incoming Dependencies

- Identity for account references and transaction-party references
- Catalog for canonical item and product references
- Inventory for sellable availability signals

## Outgoing Integration Events

- `ListingPublished`
- `ListingUpdated`
- `ListingWithdrawn`
- `OfferSubmitted`
- `OfferAccepted`

## Invariants

1. Listings and Offers share the same negotiation boundary and stay in one context.
2. Marketplace may expose product quantity but does not own inventory truth.
3. Submitted offers remain marketplace-wide demand until a seller accepts one.
4. Buyer and Seller are account roles, not Marketplace-specific entities.

## Open Extraction Candidates

- Auctions or advanced market-making can be extracted later if they introduce distinct pricing and negotiation rules.
