# Marketplace Domain Glossary

This glossary defines the canonical terminology for the Marketplace bounded context.

Browse, search, filters, and item detail terminology are owned by the Discovery bounded context.

Aggregate language and projection language may differ. The Marketplace aggregate is `Offer`; account-submitted projections use `Submitted Offer`, and matching-supply projections use `Offer Match`.

## Listing

A **Listing** is a seller-published offer to sell a specific product at a defined price and quantity.

Notes:

- Listings are owned by Marketplace.
- Listings reference one `CatalogItemId`, one `ProductId`, and one normalized selection snapshot.
- Listings reference inventory availability but do not own stock truth.

## Listing Photo

A **Listing Photo** is seller-supplied evidence imagery attached to a Listing.

Notes:

- Listing Photos are owned by Marketplace.
- Listing photo uploads are normalized into Chase Sets-owned WebP asset variants before storage.
- Listing photo metadata is recorded on Marketplace Listing events; raw image bytes are stored in the environment asset bucket.
- Pristine and Mint Listings require at least one Listing Photo before publication.

## Offer

An **Offer** is an account-submitted purchase proposal for a specific product, price, and quantity submitted as marketplace-wide demand.

Notes:

- Offers are owned by Marketplace.
- Offers reference one `CatalogItemId`, one `ProductId`, and one normalized selection snapshot.
- In v1, offers are not tied to a specific seller, listing, or inventory item until accepted.
- Any signed-in account may submit product-scoped offers; offer submission does not require listing, inventory, or seller-management permissions.
- Submitted offers are public marketplace-wide demand on product detail surfaces. Public offer rows expose the same account-level attribution style as public listings and must not expose shipping destinations or private contact details.
- Accounts see their submitted demand as Submitted Offers.
- Offers may be captured through Checkout Offer Intent, but Marketplace remains the owner of validation, lifecycle, visibility, matching, and acceptance.
- Accounts can review Offer Matches only when they have matching active listings.
- Offer Match source lists can add selected offers to Checkout Sell List; Checkout owns durable Sell List review state.
- Discovery Product Alerts may consume limited offer demand signals for subscribed accounts without exposing buyer identity or full Offer detail.
- When accepted, an offer leaves public marketplace-wide demand and becomes a commitment input for the selling account in Ordering.

## Limited Offer Demand Signal

A **Limited Offer Demand Signal** is the restricted fact that submitted demand exists for a Product and satisfies a Product Alert price threshold.

Notes:

- Marketplace owns the underlying Offer and full Offer visibility policy.
- Discovery Product Alerts may use limited offer demand signals for notifications.
- Limited offer demand signals do not expose buyer identity, shipping destination, or full Offer detail.

## Listing Status

**Listing Status** is the lifecycle state of a listing.

Examples:

- Draft
- Active
- Paused
- Withdrawn
- Sold Out

## Fee Lock

A **Fee Lock** is the immutable Commercial Terms formula snapshot bound to a Listing identity for a defined number of units. Marketplace records the percentage, fixed amount, per-item cap, Shipping Allowance, schedule/agreement source, and resolution time; Ordering copies the resulting locked fee amounts into the Order fact consumed by Settlement.

## Fee-Lock Tranche

A **Fee-Lock Tranche** is a contiguous quantity of units on one Listing that shares one Fee Lock. Listing creation makes the first tranche. Increasing quantity adds a tranche at current Commercial Terms without changing earlier tranches. Quantity reductions retire the most recently added units first, and retired capacity never regains its former lock.

## Lock-Preserving Mutation

A **Lock-Preserving Mutation** changes a Listing without changing its identity or locked terms. Price edits requote every tranche from its own locked formula. Purchase-limit edits, Listing Photo additions, pause, automated unlisting, and resuming the same Listing preserve its Fee Locks.

## Lock-Breaking Mutation

A **Lock-Breaking Mutation** requires a new Listing identity and current Commercial Terms. Withdrawal is terminal; relisting, delete-and-recreate behavior, inventory-item substitution, Product substitution, and condition-selection substitution must create a new Listing. Marketplace has no command that mutates those identity fields in place.

## High-Dollar Listing Publication Policy

A **High-Dollar Listing Publication Policy** is the Marketplace-owned publication rule that blocks expensive Listings from becoming Active until seller evidence and account trust signals clear.

Notes:

- High-dollar Listing drafts can exist before the policy clears.
- A high-dollar Listing requires Listing Photo evidence before publication.
- A high-dollar Listing also requires trusted seller status or established account reputation.
- Marketplace consumes Identity-owned Account Badges and Reputation-owned review signals for this policy, but Marketplace owns the Listing publication decision.

## Seller Listing Availability

**Seller Listing Availability** is the account-wide Marketplace overlay that controls whether an account's active listings can create new seller commitments.

Notes:

- Seller Listing Availability is owned by Marketplace.
- Turning it off does not mutate individual Listing Status values.
- While off, active listings are hidden from buyer browse and purchase flows, direct listing URLs remain reachable as unavailable, and Offer Acceptance is disabled.
- Existing carts, checkout sessions, orders, payments, fulfillment, and account buying ability are not changed by this overlay.
- `availableAgainAt` is the authoritative Resume Instant: an optional timestamp asserted to be after the disable time, captured client-side from the seller's own local timezone. It is the only field an automated resume sweep may act on.
- `availableAgainOn` is a display-only date derived from `availableAgainAt` for continuity. A bare `availableAgainOn` with no `availableAgainAt` -- including every event recorded before the Resume Instant existed -- is informational only and never triggers an automatic resume.
- A seller may re-disable while already unavailable to change the reason or Resume Instant without an enable/disable flap; this emits a new disabled fact.
- Enabling records `enabledBy`: `"seller"` for an explicit seller action, `"scheduled"` for an automated resume. Events recorded before this field existed read back as `"seller"`.

## Resume Instant

The **Resume Instant** is the authoritative point in time when a Seller Listing Availability away period ends and listings become eligible to resume, recorded as `availableAgainAt` on the disabling fact.

Notes:

- The Resume Instant is owned by Marketplace.
- It is optional: absent means an indefinite away period with no planned return.
- It is captured client-side as the seller's own local start-of-day for their chosen return date; Marketplace never infers a seller's timezone server-side.
- Only a disabling fact that carries a Resume Instant participates in an automated resume; a bare `availableAgainOn` display date never does.

## Seller Order Capacity

**Seller Order Capacity** is the account-level Marketplace setting that records a seller's Order Capacity: the maximum number of concurrently Open Orders the account will accept before new order intake pauses.

Notes:

- Seller Order Capacity is owned by Marketplace; Order Capacity is the ubiquitous-language term for the cap this setting records.
- The setting is scoped by account id and is event-sourced on a Marketplace-owned stream. `maxOpenOrders: null` means unlimited, the default -- no stream exists until a seller sets a cap for the first time.
- Setting a cap requires a whole number of at least 1. Re-setting the same value is a no-op; changing it emits a fresh fact. Clearing returns the account to unlimited.
- This slice is additive and inert: the setting and its events publish, but nothing consumes them yet. Ordering owns Open Order truth and Order Capacity enforcement -- computing At Capacity and refusing new order intake -- as a later slice.
- This setting never gates in-flight orders, payments, fulfillment, refunds, or the account's buying ability -- only new order intake.

## Order Capacity

**Order Capacity** is the seller-set maximum number of concurrently Open Orders a seller account will accept before new order intake pauses, recorded by Seller Order Capacity.

## Open Order

An **Open Order** is an order that has been created and is neither cancelled nor dispatched, used as the numerator against Order Capacity. Open Order truth and counting are owned by Ordering.

## At Capacity

**At Capacity** is the seller state when Open Order count meets or exceeds Order Capacity: new order intake pauses while everything already in flight proceeds unaffected. At Capacity is computed and enforced by Ordering, analogous to Seller Listing Availability but driven by order volume rather than a seller-declared away period.

## Report

A **Report** is a buyer or visitor submission that flags Marketplace content for Trust & Safety review.

Notes:

- Reports are owned by Marketplace.
- Reports are grouped by reported target and reporter; one reporter may report the same target once.
- Listing Reports can automatically unlist an active Listing when the distinct-reporter threshold is reached.
- Platform Operations consumes Report facts to render the operator moderation queue, but Marketplace owns report capture and listing visibility consequences.

## Offer Status

**Offer Status** is the lifecycle state of an offer.

Examples:

- Submitted
- Accepted

## Commerce Commitment Request

A **Commerce Commitment Request** is the integration fact emitted when Marketplace determines an accepted purchase should become an order.

## Offer Acceptance

**Offer Acceptance** is the selling-account action that ends marketplace-wide demand visibility for an offer and emits the fact Ordering uses to create an order.

## Offer Decline

An **Offer Decline** is a seller action that hides one Offer Match from that seller's listing-specific match surface without ending the marketplace-wide Offer.

## Buyer Offer Mute

A **Buyer Offer Mute** is a seller action that hides current and future Offer Matches from one buyer account for a specific Listing until removed.

## Review

A **Review** is the full post-transaction evaluation record one account records about another, scoped to a single order.

Notes:

- Reviews are transactional and require an `OrderId`.
- A Review contains a numeric Review Rating (integer `1` through `5`) and optional written Feedback.
- A review is always attached to an Order, never directly to a listing or shipment.
- Only accounts that were counterparties on the same completed order may review each other, with at most one active review per order, per direction.

## Review Eligibility

**Review Eligibility** is the rule that determines when a review may be submitted for an order. Eligibility depends on completed commerce and is unlocked by delivery-complete signals by default.

## Review Summary

A **Review Summary** is the canonical aggregate snapshot for an account derived from active reviews, including average rating, review count, and distribution. Review summaries are projected read models, not emitted domain events.

## Seller Reliability

**Seller Reliability** is the marketplace-owned rolling-window view of a seller Account's objective, event-derived transaction-outcome behavior: On-Time Shipment Rate, Cancellation Rate, and Dispute Rate. It is a projected read model, not an emitted domain event, computed from `ordering`, `fulfillment`, and `support` events -- never from Review content, and never from data a party can unilaterally game (attribution reuses the same resolution-class taxonomy the review-eligibility matrix already applies). Every metric carries a minimum-order-count display threshold; a metric with too few underlying orders is withheld rather than shown as a misleading rate. The seller's own dashboard shows the full metrics unconditionally; buyer-facing surfaces show only threshold-gated qualitative chips (never raw percentages), behind a rollout gate.

## On-Time Shipment Rate

**On-Time Shipment Rate** is the Seller Reliability metric measuring the share of a seller's dispatched shipments (in the rolling window) that dispatched within the platform's dispatch window of the order becoming ready for fulfillment.

## Dispute Rate

**Dispute Rate** is the Seller Reliability metric measuring the share of a seller's orders (in the rolling window) with a support request resolved against the seller (a refund-class resolution, or a seller-caused cancellation resolved through support).

## Cancellation Rate

**Cancellation Rate** is the Seller Reliability metric measuring the share of a seller's orders (in the rolling window) the seller directly cancelled -- buyer-initiated and payment-deadline cancellations are not seller-caused and are excluded.

## Planned Seller Capacity And Time Away

These planned terms pre-register upcoming seller time-away language (the m127 seller time-away & capacity milestone cluster). They are not shipped behavior until their owning milestone adds events, read models, APIs, and UI. Seller Listing Availability and its Resume Instant, defined above, are already shipped and are the foundation these planned terms build on. Order Capacity, Open Order, At Capacity, and Seller Order Capacity moved out of this Planned section: the seller-set cap setting and its events are shipped (defined above); Open Order counting and At Capacity enforcement remain owned by Ordering as a later slice.

### Away Window

An **Away Window** is the planned scheduled start and end pairing a seller sets in advance so Seller Listing Availability disables and resumes automatically without a same-day manual action.

### Scheduled Restore

A **Scheduled Restore** is the planned automated enable triggered when an Away Window or a Resume Instant sweep determines a seller's away period has ended. It records `enabledBy: "scheduled"` on the resulting Seller Listing Availability enabled fact.

## Planned Reputation And Authenticity

These planned terms pre-register upcoming reputation and authenticity language. They are not shipped behavior until their owning milestone adds events, read models, APIs, and UI.

### Reputation Profile

A **Reputation Profile** is the planned Marketplace-owned public trust summary for an Account.

### Reputation Score

A **Reputation Score** is the planned normalized account trust score derived from eligible reputation signals.

### Reputation Band

A **Reputation Band** is the planned public range label that explains a Reputation Score without exposing private scoring inputs.

### Reputation Signal

A **Reputation Signal** is the planned source fact Marketplace may evaluate when updating account reputation.

### Reputation Event

A **Reputation Event** is the planned append-only Marketplace fact recording a reputation-relevant account outcome.

### Reputation Window

A **Reputation Window** is the planned time range over which reputation signals are considered current.

### Reputation Weight

A **Reputation Weight** is the planned scoring influence assigned to a kind of Reputation Signal.

### Reputation Adjustment

A **Reputation Adjustment** is the planned operator-reviewed change that corrects or annotates an account's reputation state.

### Reputation Hold

A **Reputation Hold** is the planned Marketplace risk block that pauses reputation display or reputation-sensitive actions during review.

### Reputation Appeal

A **Reputation Appeal** is the planned account request to review a Reputation Adjustment, Reputation Hold, or Reputation Band.

### Transaction Review Window

A **Transaction Review Window** is the planned period after eligible order completion when counterparties may submit a Review.

### Review Response

A **Review Response** is the planned account-authored reply attached to a Review.

### Review Revision

A **Review Revision** is the planned edit record for review text, rating, response, or moderation outcome.

### Review Moderation

**Review Moderation** is the planned Marketplace workflow that hides, restores, or annotates Reviews under trust policy.

### Feedback Tag

A **Feedback Tag** is the planned structured label an account can attach to a Review.

### Account Trust Signal

An **Account Trust Signal** is the planned account-level input Marketplace may consume for trust, reputation, or listing publication decisions.

### Buyer Reliability

**Buyer Reliability** is the planned transaction-outcome reputation view focused on payment, cancellation, dispute, and offer behavior.

Seller Reliability, On-Time Shipment Rate, Dispute Rate, and Cancellation Rate moved out of this Planned section (m108, #4271): they are shipped behavior now -- see the main glossary body above.

Authenticity terminology (Authenticity Case, Authenticity Verdict, Verdict Reason Code, and related concepts) moved to the [Authenticity](../authenticity/GLOSSARY.md) bounded context ahead of the m109 Authenticity Check milestone (epic #4284); Marketplace does not own that vocabulary.
