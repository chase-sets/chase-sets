# Marketplace Bounded Context

## Purpose

Marketplace owns the buy and sell interaction layer before an order exists.

## Owns

- Listing lifecycle
- Offer lifecycle
- Seller asking prices
- Available sell quantity exposed to buyers
- Buyer proposed prices
- Requested quantity
- Listing visibility and activation state
- Negotiation and expiration rules

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
- Offer Negotiation Workflow

## Incoming Dependencies

- Identity for buyer and seller account references
- Catalog for canonical item references
- Inventory for sellable availability signals

## Outgoing Integration Events

- `ListingPublished`
- `ListingUpdated`
- `ListingWithdrawn`
- `OfferSubmitted`
- `OfferAccepted`
- `OfferDeclined`
- `OfferExpired`
- `CommerceCommitmentRequested`

## Invariants

1. Listings and Offers share the same negotiation boundary and stay in one context.
2. Marketplace may expose sellable quantity but does not own inventory truth.
3. Marketplace emits the decision that an order should be created, but it does not own order state.
4. Buyer and Seller are account roles, not Marketplace-specific entities.

## Open Extraction Candidates

- Auctions or advanced market-making can be extracted later if they introduce distinct pricing and negotiation rules.
