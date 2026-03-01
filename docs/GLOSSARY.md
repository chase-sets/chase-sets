# Marketplace Glossary

## Buyer

A **Buyer** is an organization acting in the buyer role when it purchases items as part of an order.

Notes:

- Buyer is a role played by an Organization, not a separate root entity.
- Buyer behavior is modeled primarily in the Ordering, Payments, and Settlement bounded contexts.

## Seller

A **Seller** is an organization acting in the seller role when it provides and ships items as part of an order.

Notes:

- Seller is a role played by an Organization, not a separate root entity.
- Seller behavior is modeled primarily in the Inventory, Marketplace, Fulfillment, and Settlement bounded contexts.

## Listing

A **Listing** is a posted offer by a seller to sell specific items at a defined price and quantity.

Notes:

- Listing is owned by the Marketplace bounded context.

## Offer

An **Offer** is a proposed purchase submitted by a buyer to buy specific items at a defined price and quantity.

Notes:

- Offer is owned by the Marketplace bounded context.

## Order

An **Order** is a confirmed transaction between a buyer and a seller created when a listing is purchased or an offer is accepted.

Notes:

- Order is owned by the Ordering bounded context.

## Shipment

A **Shipment** is the physical delivery of items from a seller to a buyer to fulfill an order.

Notes:

- Shipment is owned by the Fulfillment bounded context.

## Review

A **Review** is a post-transaction evaluation one organization records about another.

Notes:

- Review is owned by the Reputation bounded context.
