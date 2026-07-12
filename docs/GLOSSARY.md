# Marketplace Glossary

This file is the cross-context index for marketplace language. Detailed definitions live in the owning bounded context glossary; use those local glossaries as the source of truth when changing behavior, events, schemas, APIs, or UI copy.

Aggregate language and projection language may differ. When they do, each model name must stay within its surface: the Ordering aggregate is `Order`, the buyer read model is `Purchase`, and the seller read model is `Sale`.

## Language Constitution

Bounded contexts own behavior and the words for that behavior. A context-local `GLOSSARY.md` is the source of truth for local terms; this master glossary indexes cross-context terms, external-facing terms, and language families that are easy to confuse.

Ubiquitous language must use natural marketplace words that can appear in code, API docs, operator docs, and account-facing copy without translation. If a term is too internal for product copy, keep it out of the domain glossary or name the domain concept more plainly.

Shared words are allowed only when the owning behavior stays clear. When two contexts need the same plain word for different behavior, the local glossary must qualify the term, and the master glossary must disambiguate the family before the word spreads into schemas, events, APIs, or UI copy.

## Adaptation Rules

Use the owning context's term unchanged when consuming its published fact. For example, a projection that consumes Inventory hold events still says Inventory Hold, Hold Purpose, or Hold Release Reason.

Name a qualified local term when the behavior changes ownership or lifecycle. For example, Settlement uses Payout Release Hold because it blocks wallet availability, not Inventory stock.

Adapters translate provider, protocol, or transport vocabulary at the boundary. Domain code and durable docs keep the Chase Sets term unless the external word is itself the marketplace term users see.

Avoid generic family names as standalone durable terms outside their owner. Do not introduce bare Policy, Channel, or Hold in a new context; qualify the behavior, owner, or surface.

## Ratchet Rules

Every new `context.json` owned noun and declared event noun must resolve to a local glossary term heading before it ships.

Every new repeated or overloaded glossary heading must either reuse the same behavior owner or add a Cross-Context Disambiguation row here.

The glossary coverage baseline is only a migration ledger. Existing rows may be removed as local glossaries catch up, but new drift belongs in the same guard and should not create a parallel allowlist.

## Account Role Language

Use **Account** for identity, permissions, setup, wallet, inventory ownership, listings, navigation, and account settings.

Use **Buyer** and **Seller** only when naming transaction endpoints: the buyer account pays and receives products, while the seller account provides products and receives settlement. When both meanings could be confused, use phrases such as "buyer account in this order" or "seller account for this sale."

Preferred account-language examples include account cart, account inventory, listing owner, inventory owner, purchasing account, selling account, and payout-ready account. Avoid language that implies separate buyer-capable or seller-capable account classes.

Do not create buyer-specific or seller-specific account profiles, onboarding identities, or endpoint families. Public profile and trust surfaces should be account profile/reputation surfaces, with buyer or seller labels added only inside a concrete transaction, listing, offer, purchase, sale, shipment, support, fee, or payout context.

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
| Product Measure Profile | [Catalog](../bounded-contexts/catalog/GLOSSARY.md) | Reusable physical measurement rule for Products that share size, weight, stack behavior, and physical flags. |
| Resolved Product Measure | [Catalog](../bounded-contexts/catalog/GLOSSARY.md) | Per-Product measurement snapshot published for shipping quote and fulfillment use. |
| Product Contents | [Catalog](../bounded-contexts/catalog/GLOSSARY.md) | Catalog-owned relationship describing what one configured Product contains. |
| Product Content Type | [Catalog](../bounded-contexts/catalog/GLOSSARY.md) | Configured Catalog data that names and orders the meaning of a Product Content Line. |
| Product Content Inclusion Policy | [Catalog](../bounded-contexts/catalog/GLOSSARY.md) | Configured Catalog data that describes exact, variable, random, optional, choice-based, or other inclusion semantics. |
| Reference Type | [Catalog](../bounded-contexts/catalog/GLOSSARY.md) | Reusable kind of rich descriptive catalog value, such as Expansion, Series, or Product Line. |
| Reference Record | [Catalog](../bounded-contexts/catalog/GLOSSARY.md) | Rich reusable catalog value that can be selected by item fields and carry attributes or relationships. |
| Inventory Item | [Inventory](../bounded-contexts/inventory/GLOSSARY.md) | Account-owned stock for one resolved product and storage location. |
| Hold | [Inventory](../bounded-contexts/inventory/GLOSSARY.md) | Inventory-owned block against available stock. |
| Hold Purpose | [Inventory](../bounded-contexts/inventory/GLOSSARY.md) | Structured vocabulary for why stock is held; Marketplace mirrors it from Inventory events. |
| Hold Release Reason | [Inventory](../bounded-contexts/inventory/GLOSSARY.md) | Structured vocabulary for why held stock returned to availability without consumption. |
| Restock Decision | [Inventory](../bounded-contexts/inventory/GLOSSARY.md) | Seller choice for returned stock after dispatch; outcomes are `restocked` and `written-off`, with `return-restocked` as the restock adjustment reason. |
| Listing | [Marketplace](../bounded-contexts/marketplace/GLOSSARY.md) | Seller-published ask before an order exists. |
| Offer | [Marketplace](../bounded-contexts/marketplace/GLOSSARY.md) | Account-submitted purchase proposal before an order exists. |
| Seller Listing Availability | [Marketplace](../bounded-contexts/marketplace/GLOSSARY.md) | Account-level overlay that temporarily prevents active listings from creating new seller commitments without changing listing status. |
| Cart | [Checkout](../bounded-contexts/checkout/GLOSSARY.md) | Internal Checkout term for mutable saved buyer purchase intent. Use `Buy Cart` in marketplace UI when seller-side Sell List is also present. |
| Buy Cart | [Checkout](../bounded-contexts/checkout/GLOSSARY.md) | Account-facing buyer review surface for selected listings and product-level Smart Match listing lines before checkout commitment. |
| Sell List | [Checkout](../bounded-contexts/checkout/GLOSSARY.md) | Account-facing seller review surface for selected offers and product-level Smart Match offer lines before sale commitment. Marketplace Offer Matches can source selected offers into it, but Checkout owns the durable review state. |
| Smart Match | [Checkout](../bounded-contexts/checkout/GLOSSARY.md) | User-facing label for Checkout-owned matching and optimization over product-level Buy Cart or Sell List lines. |
| Checkout Session | [Checkout](../bounded-contexts/checkout/GLOSSARY.md) | Active purchase workflow before orders and payment. |
| Offer Intent | [Checkout](../bounded-contexts/checkout/GLOSSARY.md) | Checkout-owned source intent that captures purchase intent before submitting a Marketplace-owned Offer. |
| Order | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Commercial commitment between buyer and seller accounts. |
| Line Item Amount Publication | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Additive Ordering fact publishing canonical line totals for downstream validation. |
| Purchase | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Buyer-facing order projection. |
| Sale | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Seller-facing order projection. |
| Self-Service Purchase Cancellation | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Buyer-initiated cancellation of a paid purchase before Fulfillment starts package preparation. |
| Shipment | [Fulfillment](../bounded-contexts/fulfillment/GLOSSARY.md) | Physical delivery execution for an order. |
| Package Plan | [Fulfillment](../bounded-contexts/fulfillment/GLOSSARY.md) | Immutable package dimensions, weight, mailpiece class, and measurement-version snapshot executed by Fulfillment. |
| Letter Mailpiece | [Fulfillment](../bounded-contexts/fulfillment/GLOSSARY.md) | Non-parcel shipment path for eligible low-risk raw-card orders. |
| Shipping Evidence Tier | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Evaluated delivery-evidence level committed to the order shipping plan and consumed by Fulfillment. |
| Carrier Insurance Required | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Postage policy result requiring carrier insurance on the label request for high-value orders. |
| Cancellation Cutoff | [Fulfillment](../bounded-contexts/fulfillment/GLOSSARY.md) | Shipment state boundary that closes self-service purchase cancellation. |
| Review | [Marketplace](../bounded-contexts/marketplace/GLOSSARY.md) | Post-transaction account evaluation. |
| Payment | [Payments](../bounded-contexts/payments/GLOSSARY.md) | External charge or refund workflow. |
| Payment Dispute Evidence | [Payments](../bounded-contexts/payments/GLOSSARY.md) | Processor dispute evidence assembled from Payments-owned order mirrors and Fulfillment-owned shipment facts. |
| Buyer-Paid Share | [Payments](../bounded-contexts/payments/GLOSSARY.md) | Captured payment amount attributable to a cancelled order, including allocated checkout fee. |
| Wallet | [Settlement](../bounded-contexts/settlement/GLOSSARY.md) | Marketplace ledger balance container. |
| Payout | [Settlement](../bounded-contexts/settlement/GLOSSARY.md) | Transfer of eligible funds to an account. |
| Commercial Terms Resolution | [Commercial Terms](../bounded-contexts/commercial-terms/GLOSSARY.md) | Deterministic seller-side fee policy resolution. |
| Marketplace Sales Fee | [Commercial Terms](../bounded-contexts/commercial-terms/GLOSSARY.md) | Marketplace sales fee policy. Confirmation rules live in [Marketplace Sales Fee Confirmation](../bounded-contexts/marketplace/docs/marketplace-sales-fee-confirmation.md). |
| Marketplace Sales Fee Snapshot | [Marketplace](../bounded-contexts/marketplace/docs/marketplace-sales-fee-confirmation.md) | Account-confirmed per-unit fee snapshot consumed by Ordering. |
| Marketplace Checkout Fee | [Payments](../bounded-contexts/payments/GLOSSARY.md) | Buyer-side payment-level fee policy. Current policy lives in [Payments Marketplace Checkout Fee Policy](../bounded-contexts/payments/docs/marketplace-checkout-fee-policy.md). |
| Promo Bar Message | [Public Presence](../bounded-contexts/public-presence/GLOSSARY.md) | Public marketplace copy shown in the site promo bar for marketplace-wide information. |
| Cohort Quality Signal | [Public Presence](../bounded-contexts/public-presence/GLOSSARY.md) | Wave-1 campaign field (games sold, store link, inventory size) captured only from sell/both-intent Waitlist Signups. |
| Qualified Seller Signup | [Public Presence](../bounded-contexts/public-presence/GLOSSARY.md) | Sell/both-intent Waitlist Signup with a real Cohort Quality Signal (named game plus inventory-size bucket). |
| Wave-1 Admission Bar | [Public Presence](../bounded-contexts/public-presence/GLOSSARY.md) | Pre-declared campaign pass/fail threshold: qualified sellers, five-game coverage, and overall signup floor. |
| Campaign Channel Attribution | [Public Presence](../bounded-contexts/public-presence/GLOSSARY.md) | Durable per-channel Waitlist Signup breakdown by UTM source/medium/campaign. |
| Tax Quote | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Provider-agnostic sales tax calculation. |
| Tax Nexus Readiness | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | State-by-state sales-tax threshold and collection-provider readiness. |
| Collection-Required Jurisdiction | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Jurisdiction where Chase Sets must collect sales tax before accepting covered marketplace orders. |
| Price Signal | [Pricing](../bounded-contexts/pricing/GLOSSARY.md) | Observed input for product-scoped price estimation. |
| Market Price Snapshot | [Pricing](../bounded-contexts/pricing/GLOSSARY.md) | Recorded fair-value output for a resolved product over a defined time window. |
| Notification Center | [Notifications](../bounded-contexts/notifications/GLOSSARY.md) | Account-level surface for recent marketplace updates and simple notification actions. |
| Notification Feed Item | [Notifications](../bounded-contexts/notifications/GLOSSARY.md) | Account-visible update projected into the Notification Center. |
| Notification Preference | [Notifications](../bounded-contexts/notifications/GLOSSARY.md) | Account-level setting that controls notification delivery or notification-center behavior. |
| Product Alert | [Discovery](../bounded-contexts/discovery/GLOSSARY.md) | Account-owned watch on one resolved Catalog Product for listing or limited offer-demand notifications. |
| Wake Intent | [Projection Wake-Intent Scheduler](./architecture/projection-wake-scheduler.md) | Durable control-plane request for a projection group to catch up to a required checkpoint; the scheduler owns claiming, execution, retry, and completion semantics. |
| Projection Wake Relay | [Projection Wake Relay](./architecture/projection-wake-relay.md) | Worker-owned bridge that consumes source event-store wake hints and fans them out into durable projection wake intents. |
| Projection Interest Index | [Projection Interest Index](./architecture/projection-interest-index.md) | Versioned source-to-projection lookup used by the relay and API wake-before-wait paths to decide which checkpoints need wake intents. |
| Source-Context Wake Registry | [Source-Context Wake Registry](./architecture/source-context-wake-registry.md) | Platform rollout source of truth for which source contexts may emit event-store wake notifications and relay fan-out. |
| Platform Work-Signal Composite | [Platform Work-Signal Composite](./architecture/work-signal-composite.md) | Shared internal wake-notification envelope, emitter, waiter, fallback, redaction, metrics, and disposition inventory for wake families. |
| Google Shopping Export Row | [Architecture](./adr/0007-google-shopping-merchant-center-integration.md) | Discovery-owned public export row for one Marketplace Listing submitted or dry-run-evaluated for Google Merchant Center. |
| Merchant Offer ID | [Architecture](./adr/0007-google-shopping-merchant-center-integration.md) | Stable Google-facing offer id derived from immutable Chase Sets Listing identity. |
| External Seller ID | [Architecture](./adr/0007-google-shopping-merchant-center-integration.md) | Google marketplace seller identifier derived from Chase Sets Account identity for multi-seller Merchant Center submissions. |
| Platform Feedback | [Platform Operations](../bounded-contexts/platform-operations/GLOSSARY.md) | Internal product feedback, not public account reputation. |
| Affected Line Item Amount | [Platform Operations](../bounded-contexts/platform-operations/GLOSSARY.md) | Order-line amount and currency fact used by Support to cap offers and adjudications; Payments and Settlement still own accounting. |
| Affected Line Item Amount Contract | [Platform Operations](../bounded-contexts/platform-operations/GLOSSARY.md) | Support validation boundary for selected lines, one currency, and a non-exceeding remedy amount. |
| Sign-In Identifier | [Auth](../bounded-contexts/auth/GLOSSARY.md) | Contact value Auth accepts to start an authentication journey, such as email or phone. |
| Phone Code | [Auth](../bounded-contexts/auth/GLOSSARY.md) | Short-lived Auth challenge sent over SMS and consumed to start or continue a session. |
| Social Login | [Auth](../bounded-contexts/auth/GLOSSARY.md) | Auth-owned sign-in or registration journey through an external provider. |
| Social Login Provider | [Auth](../bounded-contexts/auth/GLOSSARY.md) | External identity provider configured for Social Login, starting with Google and Facebook. |
| Social Login Link | [Identity](../bounded-contexts/identity/GLOSSARY.md) | Identity-owned User fact linking one external provider identity to one User. |
| UCP Profile | [Architecture](./architecture/ucp-agent-commerce.md) | Public `/.well-known/ucp` document that advertises supported Universal Commerce Protocol services and capabilities. |
| UCP Capability | [Architecture](./architecture/ucp-agent-commerce.md) | Standards-facing protocol capability such as catalog search, checkout, or order read; maps to existing bounded-context behavior instead of owning domain state. |
| Linked Platform Authorization | [Identity](../bounded-contexts/identity/GLOSSARY.md) | User/account consent that lets an external platform act through UCP scopes. |
| Payment Handler | [Payments](../bounded-contexts/payments/GLOSSARY.md) | UCP-facing payment method declaration and instrument-processing contract owned by Payments. |
| Shared Payment Token | [Payments](../bounded-contexts/payments/GLOSSARY.md) | Provider-scoped agent payment credential grant processed without raw card handling. |
| AP2 Mandate | [Payments](../bounded-contexts/payments/GLOSSARY.md) | Verifiable autonomous-payment authority required before headless checkout completion can bypass trusted UI handoff. |
| Authenticity Case | [Authenticity](../bounded-contexts/authenticity/GLOSSARY.md) | Judgment record for one authenticity-checked order; forwarded on a passed verdict, returned on a failed or inconclusive verdict. |

## Cross-Context Disambiguation

| Term | Source of truth | Other context use |
| --- | --- | --- |
| Hold family | [Inventory](../bounded-contexts/inventory/GLOSSARY.md) owns stock Holds, Hold Purpose, Hold Source Reference, Hold Expiry, and Hold Release Reason. | [Settlement](../bounded-contexts/settlement/GLOSSARY.md) owns Payout Release Hold for wallet availability. Other contexts consume the qualified Inventory terms or name a qualified local hold. |
| Policy family | The context that owns the decision owns each named policy, such as Ordering Postage Policy, Marketplace High-Dollar Listing Publication Policy, Pricing Repricing Policy, or Payments Marketplace Checkout Fee Policy. | Do not use bare Policy as a durable term. Consumers reference the named policy and its owner, and adapters translate provider policy vocabulary at the boundary. |
| Channel family | [Notifications](../bounded-contexts/notifications/GLOSSARY.md) owns account notification delivery language, while platform architecture docs own wake/listener transport channels. | Qualify channel by surface or transport, such as notification channel, wake channel, or listener channel. Do not let transport channels become notification preferences. |
| Shipping Evidence Tier | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) evaluates and stores the tier in the order shipping plan. | [Fulfillment](../bounded-contexts/fulfillment/GLOSSARY.md) consumes the committed tier during label purchase and records it on postage diagnostics. |

## Planned Term Ownership

These sections pre-register upcoming milestone vocabulary so future slices have one canonical term and owning context before implementation. Planned terms do not imply shipped behavior; they reserve language for the owning context and prevent drift in issues, docs, APIs, and UI copy.

| Milestone family | Owning source | Planned terms |
| --- | --- | --- |
| m108 reputation | [Marketplace](../bounded-contexts/marketplace/GLOSSARY.md) | Reputation Profile; Reputation Score; Reputation Band; Reputation Signal; Reputation Event; Reputation Window; Reputation Weight; Reputation Adjustment; Reputation Hold; Reputation Appeal; Transaction Review Window; Review Response; Review Revision; Review Moderation; Feedback Tag; Account Trust Signal; Seller Reliability; Buyer Reliability; On-Time Shipment Rate; Dispute Rate; Cancellation Rate. |
| m109 authenticity (remaining phases) | [Authenticity](../bounded-contexts/authenticity/GLOSSARY.md) | Authenticity Claim; Authenticity Evidence; Authenticity Review; Authenticity Decision; Authenticity Exception; Authenticity Badge; Authenticity Guarantee; Authenticity Dispute; Authenticity Chain Of Custody; Listing Authenticity Requirement; Authenticity Photo Set. Authenticity Case, Authenticity Verdict, Verdict Reason Code, and Authenticity Facility are implemented; see the local glossary. |
| m110 platform policy | [Platform Operations](../bounded-contexts/platform-operations/GLOSSARY.md) | Platform Policy; Policy Version; Policy Scope; Policy Decision; Policy Evaluation; Policy Override; Policy Exception; Policy Review; Policy Incident; Enforcement Action; Moderation Action; Trust Queue; Safety Hold. |
| m111-m113 market analytics and repricing | [Pricing](../bounded-contexts/pricing/GLOSSARY.md) | Price Observation; Market-Value Estimate; Comparable Sale; Active Ask; Demand Bid; Spread; Market Depth; Liquidity Score; Sell-Through Rate; Price Volatility; Confidence Band; Market Segment; Price Index; Price Benchmark; Repricing Run; Repricing Candidate; Repricing Recommendation; Repricing Guardrail; Repricing Anchor; Repricing Tolerance; Terminal Price; Floor Price; Ceiling Price; Target Margin; Margin Band; Markdown; Price Experiment; Pricing Alert; Competitive Position; Market Movement. Trades Tape is implemented; see the local glossary. |
| m116-m121 store and inventory locations | [Inventory](../bounded-contexts/inventory/GLOSSARY.md) | Store; Storefront; Store Profile; Location Group; Stock Zone; Bin; Shelf; Aisle; Location Transfer; Transfer Batch; Transfer Line; Transfer Status; Replenishment Need; Inventory Count; Cycle Count; Count Variance; Stock Ledger; Channel Stock Allocation; Channel Allocation Mode; Channel Allocation; Channel Reservation; Channel Listing Link; Channel Sync; Channel Sync Run; Channel Sync Error; Channel Inventory Snapshot; Channel Fulfillment Rule; Offline Sale. |
| m116-m121 account capabilities and channels | [Identity](../bounded-contexts/identity/GLOSSARY.md) | Account Capability; Capability Grant; Capability Restriction; Capability Requirement; Capability Level; Account Standing; Capability Status; Capability Review; Sales Channel; Channel Connection; BYO Channel; Channel Account; Channel Authorization; Channel Credential; Channel Webhook; Channel Health; Channel Mapping; Store Team; Store Role; Store Invitation. |
| m116-m121 counter ordering | [Ordering](../bounded-contexts/ordering/GLOSSARY.md) | Counter Order; Drawer Session. |
| m116-m121 multi-location fulfillment | [Fulfillment](../bounded-contexts/fulfillment/GLOSSARY.md) | Fulfillment Location; Ship-From Location; Fulfillment Network; Fulfillment Route; Fulfillment Assignment; Origin Selection; Split Shipment; Pickup; Intake; Transfer Shipment; Packing Station; Handoff Scan; Location Service Area. |

## Local Glossaries

Each bounded context keeps its own `GLOSSARY.md` beside its `README.md`. Add terms there first, then add or update this index only when the term crosses context boundaries or appears in product/API docs.
