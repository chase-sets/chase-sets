# Marketplace Bounded Context

## Purpose

Marketplace owns the buy and sell interaction layer before an order exists.

Marketplace supply and demand are product-scoped. Listings and offers target products, not bare catalog items:

- `catalogItemId`
- `productId`
- normalized `selectedOptions`

If an item uses a `condition` dimension, that condition is part of the selected product options. Marketplace does not carry a separate condition field.

## Owns

- Listing lifecycle
- Offer capture and review
- Seller asking prices
- Available sell quantity exposed to buyers
- Buyer proposed prices
- Requested quantity
- Listing visibility and activation state
- Seller Listing Availability
- Order Capacity setting (the seller-set cap on Open Orders; inert until the ordering-owned enforcement slice consumes it)
- Marketplace-wide demand visibility for matching seller supply
- Source liquidity lists that let sellers send selected offers to Checkout Sell List
- Post-transaction reviews, ratings, written feedback, review eligibility, and canonical review summaries (`features/reviews`)
- Account and visitor content reports plus report-driven Listing visibility policy (`features/reports`)
- Versioned Listing Evidence Policy configuration, validation, impact previews, activation, and audit history (`features/listing-evidence-policy`)
- Resolved Listing Evidence Requirement Snapshots and generic publication/Offer Acceptance readiness gates (`features/listings`)

## Does Not Own

- Inventory cost basis
- Browse, search, and item detail discovery experiences
- Cart checkout orchestration
- Durable Buy Cart or Sell List execution-plan state
- Final order settlement
- Shipping execution

## Ubiquitous Language

Marketplace terminology is defined in [GLOSSARY.md](./GLOSSARY.md).
Marketplace sales fee confirmation rules are documented in [Marketplace Sales Fee Confirmation](./docs/marketplace-sales-fee-confirmation.md).
Limited Product Alert demand visibility is documented in [Limited Offer Demand Signals](./docs/limited-offer-demand-signals.md).
Seller Listing Availability is documented in [Seller Listing Availability](./docs/seller-listing-availability.md).
Order Capacity is documented in [Seller Order Capacity](./docs/seller-order-capacity.md).
Standard listing Inventory disclosure is documented in [Standard Listing Inventory Disclosure](./docs/standard-listing-inventory-disclosure.md).
Offer abuse controls are documented in [Offer Abuse Controls](./docs/offer-abuse-controls.md).
Listing evidence configuration is documented in [Listing Evidence Policy](./docs/listing-evidence-policy.md).

Offer Matches is a Marketplace source list. It can surface matching demand and post selected offer ids to the Checkout-owned Sell List route, but it must not own durable Sell List review, fee readiness, payout, fulfillment, or seller checkout orchestration.

## Core Aggregates and Process Managers

- Listing
- Offer
- Seller Listing Availability
- Seller Order Capacity
- Listing Publication Policy
- Listing Evidence Policy Document
- Report
- Offer Visibility Projection

## Incoming Dependencies

- Identity for account references and transaction-party references
- Catalog for canonical item and product references
- Inventory for sellable availability signals

## Outgoing Integration Events

- `ListingPublished`
- `ListingUpdated`
- `ListingWithdrawn`
- `SellerListingAvailabilityDisabled`
- `SellerListingAvailabilityEnabled`
- `SellerOrderCapacitySet`
- `SellerOrderCapacityCleared`
- `OfferSubmitted`
- `OfferAccepted`

## Invariants

1. Listings and Offers share the same negotiation boundary and stay in one context.
2. Marketplace may expose product quantity but does not own inventory truth.
3. Submitted offers remain marketplace-wide demand until a seller accepts one.
4. Offer submission is a signed-in account capability, not a seller workflow capability.
5. Buyer and Seller are transaction roles played by accounts, not Marketplace-specific entities or account classes.
6. A review is always attached to an Order; only counterparties on the same completed order may review each other, with at most one active review per order, per direction.
7. The canonical review summary is derived only from active reviews, and review flows stay downstream of commerce execution without blocking ordering, payment, or fulfillment.
8. Listing Evidence requirements are resolved from stable policy facts, recorded on the Listing, and evaluated generically before publication and Offer Acceptance; display text never creates a requirement.

## Tests

Run `pnpm --filter @chase-sets/marketplace run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/marketplace run test` before opening a PR.

## Reviews

Marketplace owns reviews and rating policy as the `reviews` slice. Reviews are post-transaction evaluations tied to completed commerce: Identity provides author and subject account references, Ordering provides order references and counterparty pairing, Fulfillment delivery-complete signals unlock review eligibility, and Support provides factual resolved responsibility. Support does not decide eligibility, visibility, or rating impact, and remedies such as refunds, returns, replacements, and cancellations never imply responsibility.

The deterministic historical rebuild, invariant report, retry procedure, and rollback boundaries are documented in [Review scoring migration](./docs/review-scoring-migration.md).

The canonical directional policy produces transaction eligibility, submission state, visibility state, scoring disposition, a neutral reason code, and an effective deadline. For an otherwise eligible transaction, its baseline scoring matrix is:

| Support fact | Buyer reviewing seller | Seller reviewing buyer |
| --- | --- | --- |
| Seller responsible | Included | Context-only |
| Buyer responsible | Context-only | Included |
| Carrier, platform, shared, or undetermined | Context-only | Context-only |
| No resolved support case / normal completion | Included | Included |

An open review-affecting Support request places both review directions on hold by default. Marketplace keys each hold to the stable Support request id, so concurrent requests do not multiply paused time and feedback resumes only after the final open request becomes terminal. Opening a hold pauses an allowed review clock at its current remaining duration. Releasing the final hold resumes the clock with the greater of that duration or 14 days; an already expired opportunity is never revived. A later reopen starts a new pause from the then-current deadline. Duplicate, reordered, and replayed lifecycle facts converge, including a terminal fact observed before its corresponding open fact.

Held feedback is neutral and private: submission, reveal, reminders, replies, public reads, and reputation aggregates are suppressed. Feedback that was already revealed is retracted while held and restored after the final release without changing its stored content. The command path loads the hold aggregate authoritatively, while projections provide the compensating path when Support facts arrive after a racing command or reveal. Support owns request lifecycle and factual resolution; Marketplace owns review clocks and visibility.

The reviewed account may publish one response after an active Review is revealed. The response is displayed inline with the Review on account, order-outcome, and public-profile surfaces; it is never a discussion thread. Authenticated accounts may report any active, revealed, non-held Review with a structured reason and optional explanation. Duplicate reports return an explicit status, and reporting never changes Review visibility or scoring by itself.

A seller-responsible cancellation may establish buyer-to-seller transaction eligibility without delivery once Ordering records the cancellation; other undelivered cancellations do not establish eligibility. A missing legacy responsibility is explicitly Context-only, while an unknown future responsibility value is quarantined as `held`; neither can score by accident. Context-only feedback remains publishable when otherwise allowed, but its rating is excluded from reputation calculations. Double-blind reveal and moderation remain independent visibility concerns.

Durable review events use the `marketplace.review.*` namespace, review-hold events use the `marketplace.review-hold.*` namespace, review and hold streams use Marketplace-owned prefixes, and review read-model tables use Marketplace-owned names.

The cross-context fair order-issue and review journeys, their acceptance matrix, traceability, and the Support-Marketplace-Settlement-Notifications diagnosis runbook are documented in [Reputation and Support Fair Journey Acceptance](./docs/reputation-support-fair-journey-acceptance.md).

Marketplace's seed slot runs before Ordering and Fulfillment, so the reviews seed cannot see a delivered shipment on its first pass; it skips and completes during the host's final seed reconciliation pass. The seed dataset therefore contains two delivered orders: the earliest-ready one receives the support-request seeds (which delete review eligibility), and the latest-ready one never does, so seeded reviews always have a review-eligible delivered order to attach to. Seed orders identify by `ready_for_fulfillment_at` (fixed by the payments seed's capture timestamps) because accepted-offer orders can be auto-created with generated ids before the ordering seed pins `reputationReservedSeedIds.orders.reviewEligibleDelivered`.

## Open Extraction Candidates

- Auctions or advanced market-making can be extracted later if they introduce distinct pricing and negotiation rules.
- Trust and safety or moderation can be extracted later if review content governance becomes materially more complex.
