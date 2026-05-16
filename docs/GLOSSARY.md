# Marketplace Glossary

This file is the cross-context index for marketplace language. Detailed definitions live in the owning bounded context glossary; use those local glossaries as the source of truth when changing behavior, events, schemas, APIs, or UI copy.

Aggregate language and projection language may differ. When they do, each model name must stay within its surface: the Ordering aggregate is `Order`, the buyer read model is `Purchase`, and the seller read model is `Sale`.

## Account Role Language

Use **Account** for identity, permissions, setup, wallet, inventory ownership, listings, navigation, and account settings.

Use **Buyer** and **Seller** only when naming transaction endpoints: the buyer account pays and receives products, while the seller account provides products and receives settlement. When both meanings could be confused, use phrases such as "buyer account in this order" or "seller account for this sale."

Preferred account-language examples include account cart, account inventory, listing owner, inventory owner, purchasing account, selling account, and payout-ready account. Avoid language that implies separate buyer-capable or seller-capable account classes.

Do not rename durable event fields, persisted columns, provider metadata, or transaction projections merely to remove buyer or seller. Rename only when the term describes account identity or account capability rather than the endpoint role inside a commerce transaction.

## Term Ownership

| Term | Owning source | Notes |
| --- | --- | --- |
| Account | [Identity](../bounded-contexts/identity/GLOSSARY.md) | Root identity for marketplace participation. |
| Shipping Address | [Identity](../bounded-contexts/identity/GLOSSARY.md) | Account-owned recipient destination reused during checkout; not an Inventory storage location or Fulfillment ship-from location. |
| Buyer | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Transaction role played by an Account. |
| Seller | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Transaction role played by an Account. |
| Catalog Item | [Catalog](../bounded-contexts/catalog/GLOSSARY.md) | Canonical parent definition of a thing. |
| Product | [Catalog](../bounded-contexts/catalog/GLOSSARY.md) | Valid sellable option combination under a Catalog Item. |
| Inventory Item | [Inventory](../bounded-contexts/inventory/GLOSSARY.md) | Account-owned stock for one resolved product and storage location. |
| Listing | [Marketplace](../bounded-contexts/marketplace/GLOSSARY.md) | Seller-published ask before an order exists. |
| Offer | [Marketplace](../bounded-contexts/marketplace/GLOSSARY.md) | Account-submitted purchase proposal before an order exists. |
| Seller Listing Availability | [Marketplace](../bounded-contexts/marketplace/GLOSSARY.md) | Account-level overlay that temporarily prevents active listings from creating new seller commitments without changing listing status. |
| Cart | [Checkout](../bounded-contexts/checkout/GLOSSARY.md) | Mutable saved purchase intent. |
| Checkout Session | [Checkout](../bounded-contexts/checkout/GLOSSARY.md) | Active purchase workflow before orders and payment. |
| Offer Intent | [Checkout](../bounded-contexts/checkout/GLOSSARY.md) | Checkout-owned source intent that captures purchase intent before submitting a Marketplace-owned Offer. |
| Order | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Commercial commitment between buyer and seller accounts. |
| Purchase | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Buyer-facing order projection. |
| Sale | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Seller-facing order projection. |
| Self-Service Purchase Cancellation | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Buyer-initiated cancellation of a paid purchase before Fulfillment starts package preparation. |
| Shipment | [Fulfillment](../bounded-contexts/fulfillment/GLOSSARY.md) | Physical delivery execution for an order. |
| Cancellation Cutoff | [Fulfillment](../bounded-contexts/fulfillment/GLOSSARY.md) | Shipment state boundary that closes self-service purchase cancellation. |
| Review | [Reputation](../bounded-contexts/reputation/GLOSSARY.md) | Post-transaction account evaluation. |
| Payment | [Payments](../bounded-contexts/payments/GLOSSARY.md) | External charge or refund workflow. |
| Buyer-Paid Share | [Payments](../bounded-contexts/payments/GLOSSARY.md) | Captured payment amount attributable to a cancelled order, including allocated checkout fee. |
| Wallet | [Settlement](../bounded-contexts/settlement/GLOSSARY.md) | Marketplace ledger balance container. |
| Payout | [Settlement](../bounded-contexts/settlement/GLOSSARY.md) | Transfer of eligible funds to an account. |
| Commercial Terms Resolution | [Commercial Terms](../bounded-contexts/commercial-terms/GLOSSARY.md) | Deterministic seller-side fee policy resolution. |
| Marketplace Sales Fee | [Commercial Terms](../bounded-contexts/commercial-terms/GLOSSARY.md) | Seller-side marketplace fee policy. Confirmation rules live in [Marketplace Seller Fee Confirmation](../bounded-contexts/marketplace/docs/seller-fee-confirmation.md). |
| Marketplace Sales Fee Snapshot | [Marketplace](../bounded-contexts/marketplace/docs/seller-fee-confirmation.md) | Seller-confirmed per-unit fee snapshot consumed by Ordering. |
| Marketplace Checkout Fee | [Payments](../bounded-contexts/payments/GLOSSARY.md) | Buyer-side payment-level fee policy. Current policy lives in [Payments Marketplace Checkout Fee Policy](../bounded-contexts/payments/docs/marketplace-checkout-fee-policy.md). |
| Tax Quote | [Tax](../bounded-contexts/tax/GLOSSARY.md) | Provider-agnostic sales tax calculation. |
| Price Signal | [Pricing](../bounded-contexts/pricing/GLOSSARY.md) | Observed input for product-scoped price estimation. |
| Notification Center | [Notifications](../bounded-contexts/notifications/GLOSSARY.md) | Account-level surface for recent marketplace updates and simple notification actions. |
| Notification Feed Item | [Notifications](../bounded-contexts/notifications/GLOSSARY.md) | Account-visible update projected into the Notification Center. |
| Notification Preference | [Notifications](../bounded-contexts/notifications/GLOSSARY.md) | Account-level setting that controls notification delivery or notification-center behavior. |
| Product Alert | [Discovery](../bounded-contexts/discovery/GLOSSARY.md) | Account-owned watch on one resolved Catalog Product for listing or limited offer-demand notifications. |
| Platform Feedback | [Experience](../bounded-contexts/experience/GLOSSARY.md) | Internal product feedback, not public account reputation. |
| Sign-In Identifier | [Auth](../bounded-contexts/auth/GLOSSARY.md) | Contact value Auth accepts to start an authentication journey, such as email or phone. |
| Phone Code | [Auth](../bounded-contexts/auth/GLOSSARY.md) | Short-lived Auth challenge sent over SMS and consumed to start or continue a session. |
| Social Login | [Auth](../bounded-contexts/auth/GLOSSARY.md) | Auth-owned sign-in or registration journey through an external provider. |
| Social Login Provider | [Auth](../bounded-contexts/auth/GLOSSARY.md) | External identity provider configured for Social Login, starting with Google and Facebook. |
| Social Login Link | [Identity](../bounded-contexts/identity/GLOSSARY.md) | Identity-owned User fact linking one external provider identity to one User. |
| UCP Profile | [Architecture](./architecture/ucp-agent-commerce.md) | Public `/.well-known/ucp` document that advertises supported Universal Commerce Protocol services and capabilities. |
| UCP Capability | [Architecture](./architecture/ucp-agent-commerce.md) | Standards-facing protocol capability such as catalog search, checkout, or order read; maps to existing bounded-context behavior instead of owning domain state. |
| Linked Platform Authorization | [Identity](../bounded-contexts/identity/GLOSSARY.md) | User/account consent that lets an external platform act through UCP scopes. |
| Payment Handler | [Payments](../bounded-contexts/payments/GLOSSARY.md) | UCP-facing payment method declaration and instrument-processing contract owned by Payments. |
| AP2 Mandate | [Payments](../bounded-contexts/payments/GLOSSARY.md) | Verifiable autonomous-payment authority required before headless checkout completion can bypass trusted UI handoff. |

## Local Glossaries

Each bounded context keeps its own `GLOSSARY.md` beside its `README.md`. Add terms there first, then add or update this index only when the term crosses context boundaries or appears in product/API docs.
