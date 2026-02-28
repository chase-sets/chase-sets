# Ordering Bounded Context

## Purpose

Ordering owns checkout normalization and the commercial commitment between buyer and seller.

## Owns

- Cart-to-order decomposition
- Order creation from listing purchases and accepted offers
- Order lines
- Commercial term snapshots
- Buyer and seller pairing per order
- Pre-fulfillment order status
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

## Incoming Dependencies

- Identity for buyer and seller organization references
- Marketplace for accepted purchase decisions

## Outgoing Integration Events

- `CheckoutStarted`
- `OrderCreated`
- `OrderSplit`
- `OrderCancelled`
- `OrderReadyForFulfillment`
- `OrderRefundRequested`

## Invariants

1. Cart and checkout stay inside Ordering.
2. Ordering freezes commercial terms at checkout time.
3. A buyer checkout may produce one or more seller-specific orders.
4. Ordering owns the order until fulfillment execution begins.

## Open Extraction Candidates

- Tax calculation can be extracted later if it grows beyond order-term enrichment.
