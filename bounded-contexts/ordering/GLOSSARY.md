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

- Listing purchases consume the locked Marketplace sales fee snapshot already carried by listing supply.
- Accepted offers consume the seller-confirmed fee snapshot emitted by Marketplace at offer acceptance time.
- Ordering does not resolve Commercial Terms for normal listing purchases.

## Order Status

**Order Status** is the pre-fulfillment lifecycle state of an order.

Examples:

- Pending Payment
- Cancelled

## Self-Service Purchase Cancellation

**Self-Service Purchase Cancellation** is the buyer-initiated cancellation of a paid purchase while the Fulfillment-owned shipment is still awaiting package preparation.

Notes:

- Ordering owns the cancellation decision.
- Fulfillment owns the operational cutoff.
- Payments owns any refund created from the cancellation.
- After package preparation starts, buyers use the Support-owned buyer cancellation request flow.

## Order Split

An **Order Split** is the decomposition of a checkout session into one or more orders grouped by seller account.

## Shipping Quote Policy

A **Shipping Quote Policy** is the Ordering-owned rule that estimates provisional shipping charges and discounts while checkout compares seller split plans.

Notes:

- Shipping quotes use Catalog-provided product measure snapshots, seller origin, destination address, item value, requested shipping option, and package-planning policy.
- Letter eligibility is part of Shipping Quote Policy, not Catalog product truth.
- Orders store an immutable shipping plan snapshot so later profile or carrier-policy changes do not rewrite committed order economics.

## Postage Policy

A **Postage Policy** is the Ordering-owned, admin-versioned package-planning policy that determines when an order requires parcel handling, when letter handling remains eligible, and when carrier label purchase must request signature delivery confirmation.

Notes:

- Postage Policy is evaluated during checkout preview, checkout confirmation, and accepted-offer order creation.
- Orders store the policy version and evaluated parcel/signature results in the immutable shipping plan snapshot.
- Fulfillment and Checkout consume the snapshot. They do not re-evaluate the mutable active policy.
- Policy changes affect new orders only.

## Parcel Required

**Parcel Required** means the active Postage Policy determined a shipment cannot use the letter mailpiece path.

Examples:

- Shipping option requires parcel handling.
- Quantity, weight, thickness, declared value, or product physical flags exceed letter policy.
- Product measurement data is missing.

## Signature Required

**Signature Required** means the active Postage Policy determined the carrier label request must include signature delivery confirmation.

Examples:

- Shipping option requires signature.
- Declared item value exceeds the signature threshold.
- Product physical flags require signature.
