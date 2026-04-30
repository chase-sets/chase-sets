# Chase Sets Language Standard

Chase Sets uses **Account** for marketplace identity. Every registered account can participate in buying and selling workflows, subject to account status, permissions, inventory validity, payout readiness, and normal domain rules.

## Account Language

Use **account** for identity, registration, permissions, wallet, payout setup, inventory ownership, listings, navigation, account settings, and API surfaces owned by the authenticated marketplace participant.

Preferred examples:

- account cart
- account inventory
- listing owner
- inventory owner
- purchasing account
- selling account
- payout-ready account

Avoid language that implies separate buyer-capable or seller-capable account classes.

## Transaction Role Language

Use **buyer** and **seller** when naming the two endpoints of a transaction:

- the buyer account pays and receives products
- the seller account provides products and receives settlement

Buyer and seller terms are valid in orders, purchases, sales, shipments, reviews, payments, fees, settlement records, durable event payloads, provider metadata, and customer-facing protection or economics copy.

Allowed transaction-facing terms include:

- Buyer Protection
- Seller Protection
- Seller net
- Purchase
- Sale
- buyerAccountId
- sellerAccountId

When the meaning could be confused with account capability, spell out the context: "buyer account in this order" or "seller account for this sale."

## Naming Rule

Do not rename durable event fields, persisted columns, provider metadata, or transaction projections merely to remove buyer or seller. Rename only when the term describes account identity or account capability rather than the endpoint role inside a commerce transaction.
