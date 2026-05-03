# Ordering Domain Glossary

This glossary defines the canonical terminology for the Ordering bounded context.

Aggregate language and projection language may differ. `Order` is the aggregate and event-stream term; buyer read models and routes use `Purchase`, while seller read models and routes use `Sale`.

## Order

An **Order** is the commercial commitment between a buyer account and a seller account created from a listing purchase or accepted offer.

Notes:

- Orders are owned by Ordering.
- Fulfillment and Payments react to order facts but do not define orders.

## Purchase

A **Purchase** is the buyer-facing projection of an order.

## Sale

A **Sale** is the seller-facing projection of an order.

## Order Line

An **Order Line** is a committed product, quantity, and price snapshot captured on an order.

Notes:

- Order lines reference one `CatalogItemId`, one `ProductId`, and one normalized selection snapshot.
- If condition matters for the item, it appears only through the selected product dimensions.

## Order Economics Snapshot

An **Order Economics Snapshot** is the immutable capture of price, shipping, Marketplace-provided fee, and seller-net inputs used when the order is created.

Notes:

- Listing purchases consume the locked Marketplace fee snapshot already carried by listing supply.
- Accepted offers consume the seller-confirmed fee snapshot emitted by Marketplace at offer acceptance time.
- Ordering does not resolve Commercial Terms for normal listing purchases.

## Order Status

**Order Status** is the pre-fulfillment lifecycle state of an order.

Examples:

- Pending Payment
- Cancelled

## Order Split

An **Order Split** is the decomposition of a checkout session into one or more orders grouped by seller account.

## Shipping Quote Policy

A **Shipping Quote Policy** is the Ordering-owned rule that estimates provisional shipping charges and discounts while checkout compares seller split plans.
