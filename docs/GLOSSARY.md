# Marketplace Glossary

Aggregate language and projection language may differ. When they do, each model name must be used exactly within its surface: the Ordering aggregate is `Order`, the buyer read model is `Purchase`, and the seller read model is `Sale`.

## Buyer

A **Buyer** is an account acting in the buyer role when it purchases products as part of an order.

Notes:

- Buyer is a role played by an Account, not a separate root entity.
- Buyer behavior is modeled primarily in Discovery, Marketplace, Ordering, Payments, and Settlement.

## Seller

A **Seller** is an account acting in the seller role when it lists, sells, and ships products.

Notes:

- Seller is a role played by an Account, not a separate root entity.
- Seller behavior is modeled primarily in Inventory, Commercial Terms, Marketplace, Fulfillment, Settlement, Pricing, and Insights.

## Listing

A **Listing** is a seller-published ask to sell a specific resolved product at a defined price and quantity.

Notes:

- Listing is owned by the Marketplace bounded context.

## Offer

An **Offer** is an account-submitted purchase proposal for a specific resolved product at a defined price and quantity.

Notes:

- Offer is owned by the Marketplace bounded context.
- The submitting account sees its projection as a **Submitted Offer**.
- Accounts with matching supply see the demand as an **Offer Match**.

## Order

An **Order** is the commercial commitment between a buyer account and a seller account created when a listing is purchased or an offer is accepted.

Notes:

- Order is owned by the Ordering bounded context.
- A buyer-facing order projection is a **Purchase**.
- A seller-facing order projection is a **Sale**.

## Inventory Item

An **Inventory Item** is a seller's stock for one specific product and storage location.

Notes:

- Inventory Item is owned by the Inventory bounded context.

## Shipment

A **Shipment** is the physical delivery of products from a seller account to a buyer account to fulfill an order.

Notes:

- Shipment is owned by the Fulfillment bounded context.

## Review

A **Review** is a post-transaction evaluation one account records about another, scoped to a completed order.

Notes:

- Review is owned by the Reputation bounded context.

## Account

An **Account** is the root entity that owns commercial activity in the marketplace.

Notes:

- Account is owned by the Identity bounded context.
- Buyer and Seller are roles an Account plays in downstream commerce contexts.

## Catalog Item

A **Catalog Item** is the canonical parent definition of a thing that can have one or more resolved products.

Notes:

- Catalog Item is owned by the Catalog bounded context.
- Downstream commerce should reference resolved products rather than bare catalog items.

## Product

A **Product** is a valid sellable combination of selected options under a Catalog Item.

Notes:

- Product identity is derived by Catalog from the Catalog Item, canonical dimension order, and selected options.
- Inventory, Marketplace, Ordering, Pricing, and downstream commerce use product-scoped references.

## Commercial Terms Resolution

A **Commercial Terms Resolution** is the deterministic result of selecting the applicable fee schedule and account-specific agreement for an account at a point in time.

Notes:

- Commercial Terms owns the policy and resolution.
- Ordering freezes the resolved Commercial Terms snapshot when an order is created.

## Payment

A **Payment** is the external charge workflow associated with one or more orders.

Notes:

- Payment is owned by the Payments bounded context.
- Settlement owns internal ledger truth after payment and refund outcomes are known.

## Wallet

A **Wallet** is the balance container for an account within the marketplace ledger.

Notes:

- Wallet is owned by the Settlement bounded context.

## Payout

A **Payout** is the transfer of eligible marketplace funds to an account.

Notes:

- Payout is owned by the Settlement bounded context.
