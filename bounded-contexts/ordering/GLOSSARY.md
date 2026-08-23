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

## Money Timeline

A **Money Timeline** is the customer-facing order projection of paid, refund, and proceeds-hold progress.

Notes:

- Payments remains authoritative for Refund progress and actual per-order refunded amounts.
- Settlement remains authoritative for Payout Release Hold reconciliation.
- Ordering projects those facts alongside Support case context so Purchase and Sale surfaces can explain money state without cross-context database reads.

## Order Line

An **Order Line** is a committed product, quantity, and price snapshot captured on an order.

Notes:

- Order lines reference one `CatalogItemId`, one `ProductId`, and one normalized selection snapshot.
- If condition matters for the item, it appears only through the selected product dimensions.

## Line Item Amount Publication

A **Line Item Amount Publication** is the additive Ordering fact that publishes each committed order line's canonical decimal-string total for downstream contexts. Ordering publishes the amount; it does not decide support remedies or refunds.

## Order Economics Snapshot

An **Order Economics Snapshot** is the immutable capture of price, shipping, Marketplace-provided fee, and seller-net inputs used when the order is created.

Notes:

- Listing purchases consume the locked Marketplace sales fee snapshot already carried by listing supply.
- Accepted offers consume the seller-confirmed fee snapshot emitted by Marketplace at offer acceptance time.
- Ordering does not resolve Commercial Terms for normal listing purchases.

## Order Protection

**Order Protection** is the immutable 1% of item subtotal included with every order, rounded up to the nearest cent.

Notes:

- The seller-funded fulfillment allowance funds Order Protection first and shipping second.
- Ordering snapshots the amount and its allowance-funded and overage-funded shares.
- Buyers see only the combined fulfillment overflow as one Shipping amount, never an Order Protection fee line.

## Order Status

**Order Status** is the pre-fulfillment lifecycle state of an order.

Examples:

- Pending Payment
- Cancelled

Notes:

- `ordering.order.cancelled` publishes the Order Status held immediately before the cancelled transition.

## Self-Service Purchase Cancellation

**Self-Service Purchase Cancellation** is the buyer-initiated cancellation of a paid purchase while the Fulfillment-owned shipment is still awaiting package preparation.

Notes:

- Ordering owns the cancellation decision.
- Fulfillment owns the operational cutoff.
- Payments owns any refund created from the cancellation.
- After package preparation starts, buyers use the Support-owned buyer cancellation request flow.
- It shares the same pre-packing window as Self-Service Sale Cancellation.

## Self-Service Sale Cancellation

**Self-Service Sale Cancellation** is the seller-initiated cancellation of a paid sale while the Fulfillment-owned shipment is still awaiting package preparation.

Notes:

- Ordering owns the cancellation decision.
- Fulfillment owns the operational cutoff.
- Payments owns the buyer's full refund created from the cancellation.
- The cancellation remains recorded as `seller-cancelled` for the seller cancellation rate.
- After package preparation starts, sellers use the Support-owned cannot-fulfill flow.

## Order Split

An **Order Split** is the decomposition of a checkout session into one or more orders grouped by seller account.

## Order Source Claim

An **Order Source Claim** is the command-side identity record that binds one checkout source identity to its complete order-id set before any order is created.

Notes:

- The claim is authoritative for checkout retry idempotency while order projections catch up.
- A pending claim prevents another caller from creating a different order set.
- A created claim returns the original order ids without consulting a read model.

## Shipping Quote Policy

A **Shipping Quote Policy** is the Ordering-owned rule that estimates provisional shipping charges and discounts while checkout compares seller split plans.

Notes:

- Shipping quotes use Catalog-provided product measure snapshots, seller origin, destination address, item value, requested shipping option, and package-planning policy.
- Letter eligibility is part of Shipping Quote Policy, not Catalog product truth.
- Orders store an immutable shipping plan snapshot so later profile or carrier-policy changes do not rewrite committed order economics.

## Postage Policy

A **Postage Policy** is the Ordering-owned, admin-versioned package-planning policy that determines when an order requires parcel handling, when letter handling remains eligible, when carrier label purchase must request signature delivery confirmation, and when carrier insurance is required.

Notes:

- Postage Policy is evaluated during checkout preview, checkout confirmation, and accepted-offer order creation.
- Orders store the policy version, evaluated parcel/signature/insurance results, and Shipping Evidence Tier in the immutable shipping plan snapshot.
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
- Declared item value meets or exceeds the signature threshold.
- Product physical flags require signature.

## Carrier Insurance Required

**Carrier Insurance Required** means the active Postage Policy determined the carrier label request must include carrier insurance for the order value.

Examples:

- Declared item value meets or exceeds the insurance threshold.
- The default marketplace threshold requires insurance at $500 or more.

## Shipping Evidence Tier

A **Shipping Evidence Tier** is the evaluated delivery-evidence level stored with an order's postage policy snapshot.

Notes:

- Tiers are `letter-untracked`, `tracked-parcel`, `signature-confirmed`, and `carrier-insured`.
- Ordering derives the tier from the evaluated parcel, signature, and insurance requirements.
- Fulfillment records the tier on label purchase operations so Trust & Safety and dispute evidence can cite the committed shipping evidence facts.

## Tax Quote

A **Tax Quote** is a provider-agnostic calculation of taxable amount, sales tax amount, jurisdiction, rate, provider identity, and quote timestamp.

Notes:

- Tax quotes are resolved through the injected `taxQuoteResolver` host port when Ordering creates orders.
- Orders store the resulting immutable tax snapshot.

## Destination Address

A **Destination Address** is the shipping or delivery address used to determine the tax jurisdiction for a checkout order.

## Local Tax Rule

A **Local Tax Rule** is a development/test rule used by the local stub resolver to quote deterministic sales tax.

## Tax Readiness Evidence

**Tax Readiness Evidence** is an operator-owned approval reference showing that tax launch posture, provider coverage, nexus scope, remittance ownership, and filing responsibilities have been reviewed before production marketplace order creation opens.

## Tax Nexus Readiness

**Tax Nexus Readiness** is the Ordering-owned state-by-state assessment of Chase Sets marketplace-facilitated sales against reviewed sales-tax thresholds, registration status, collection status, and provider-backed quote readiness.

## Collection-Required Jurisdiction

A **Collection-Required Jurisdiction** is a state or district where tax readiness shows Chase Sets has crossed the reviewed nexus threshold, has registration coverage or a collection start decision, and must collect sales tax before accepting covered marketplace orders.

## Planned Counter Orders

These planned terms pre-register upcoming counter-order language. They are not shipped behavior until Ordering adds the corresponding commerce commitments, drawer accounting, order facts, and read models.

### Counter Order

A **Counter Order** is the planned in-person or counter-originated commercial commitment owned by Ordering.

### Drawer Session

A **Drawer Session** is the planned register or counter accounting window associated with Counter Orders.

## Planned Seller Capacity

This planned term pre-registers the upcoming edge-triggered at-capacity signal (m127 seller time-away & capacity milestone cluster, #4882). It is not shipped behavior until Ordering adds Open Order counting and the crossing-triggered event emission; Discovery and Checkout's buyer-facing messaging and cart-readiness handlers are pre-registered ahead of the producer, the standard parallel-lane pattern (#4883). Marketplace's Order Capacity, Open Order, and At Capacity terms (also planned) define the seller-set setting and the seller-facing vocabulary this signal is derived from.

### Seller Capacity

**Seller Capacity** is the planned Ordering-owned edge-triggered signal (`ordering.seller-capacity.reached` / `.cleared`) emitted exactly once per threshold crossing when a seller's Open Order count crosses their Order Capacity, consumed by Discovery and Checkout to disable purchase actions without filtering the seller out of search/browse.
