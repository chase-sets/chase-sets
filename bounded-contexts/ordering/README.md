# Ordering Bounded Context

## Purpose

Ordering owns checkout normalization and the commercial commitment between buyer and seller.

## Owns

- Buyer cart intent capture
- Cart-to-order decomposition
- Order creation from listing purchases and accepted offers
- Order lines
- Commercial term snapshots
- Buyer and seller pairing per order
- Pending-payment and cancelled order status
- Pre-shipment cancellation rules

## Does Not Own

- Listing negotiation
- Payment processor state
- Shipment tracking
- Seller payout accounting

## Ubiquitous Language

Ordering terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Cart
- Order
- Order Line
- Checkout Orchestrator
- Accepted Offer Commitment Projector

## Incoming Dependencies

- Identity for buyer and seller account references
- Marketplace for active supply and accepted offer decisions
- Inventory for reservation execution at commitment time

## Outgoing Integration Events

- `OrderCreated`
- `OrderSplit`
- `OrderCancelled`

## Invariants

1. Cart and checkout stay inside Ordering.
2. Ordering freezes commercial terms at checkout time.
3. Cart lines express buyer intent for an item version; concrete listing and inventory matching happen only when commitment occurs.
4. A buyer checkout may produce one or more seller-specific orders.
5. Inventory holds are placed only when an order is committed and released if the order is cancelled while pending.
6. In v1, orders remain `Pending Payment` or `Cancelled`; confirmation and fulfillment-readiness stay out of scope.

## Open Extraction Candidates

- Tax calculation can be extracted later if it grows beyond order-term enrichment.
