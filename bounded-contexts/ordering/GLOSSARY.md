# Ordering Domain Glossary

This glossary defines the canonical terminology for the Ordering bounded context.

## Cart

A **Cart** is the buyer's in-progress checkout state before one or more orders are created.

## Order

An **Order** is the commercial commitment between a buyer account and a seller account created from a listing purchase or accepted offer.

Notes:

- Orders are owned by Ordering.
- Fulfillment and Payments react to order facts but do not define orders.

## Order Line

An **Order Line** is a committed item, quantity, and price snapshot captured on an order.

## Commercial Terms Snapshot

A **Commercial Terms Snapshot** is the immutable capture of prices, fees, and rebate inputs used when the order is created.

## Order Status

**Order Status** is the pre-fulfillment lifecycle state of an order.

Examples:

- Pending Payment
- Confirmed
- Cancelled
- Ready for Fulfillment

## Order Split

An **Order Split** is the decomposition of a buyer checkout into one or more seller-specific orders.
