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

## Listing Evidence

**Listing Evidence** is the typed, policy-classified evidence collection attached to a Listing. Its current entries are seller-supplied images.

Notes:

- Listing Evidence is owned by Marketplace.
- Evidence image uploads are normalized into Chase Sets-owned WebP asset variants before storage.
- Evidence metadata is recorded on Marketplace Listing events; raw image bytes are stored in the environment asset bucket.
- Publication and Offer Acceptance evaluate the current evidence against the Listing's resolved requirement snapshot.

## Listing Evidence Policy

A **Listing Evidence Policy** is the versioned Marketplace policy document that resolves stable Catalog identities and Marketplace facts into additive Listing Evidence Requirements.

Notes:

- A Policy Version has an immutable policy hash, effective interval, and audit history.
- Matching Policy Rules combine additively in stable priority and rule-id order; later rules do not silently replace earlier requirements.
- Activation requires validation, a semantic diff, a Policy Impact Preview, an explicit effective time, and impact acknowledgment.

## Policy Rule

A **Policy Rule** is one named selector-and-outcome clause in a Listing Evidence Policy. Selectors use stable Catalog item, Product, Blueprint, Category, Dimension and Option identities or typed Marketplace facts such as graded-item presence, price band, and seller trust or risk.

## Listing Evidence Requirement

A **Listing Evidence Requirement** is the resolved minimum photo count, named Evidence Slots, image constraints, seller-trust conditions, and buyer-acknowledgment posture produced by matching Policy Rules.

## Listing Evidence Requirement Snapshot

A **Listing Evidence Requirement Snapshot** is the immutable policy identity, policy hash, matched rules, explanation codes, resolved requirements, and requirement hash recorded on a Listing. Marketplace refreshes it from stable Listing, Catalog, and seller facts before publication and Offer Acceptance, then evaluates the current evidence against that exact snapshot.

## Evidence Slot

An **Evidence Slot** is a policy-defined named view such as condition, slab, front, or back, with optional minimum pixel dimensions and maximum evidence age.

## Policy Impact Preview

A **Policy Impact Preview** is the deterministic count and bounded sample of existing Listings whose resolved Listing Evidence Requirements would change under a validated draft. Its hash is acknowledged at activation so stale validation cannot be activated.

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

A **Lock-Preserving Mutation** changes a Listing without changing its identity or locked terms. Price edits requote every tranche from its own locked formula. Purchase-limit edits, Listing Evidence additions, pause, automated unlisting, and resuming the same Listing preserve its Fee Locks.

## Lock-Breaking Mutation

A **Lock-Breaking Mutation** requires a new Listing identity and current Commercial Terms. Withdrawal is terminal; relisting, delete-and-recreate behavior, inventory-item substitution, Product substitution, and condition-selection substitution must create a new Listing. Marketplace has no command that mutates those identity fields in place.

## Listing Evidence Readiness

**Listing Evidence Readiness** is Marketplace's generic decision that the current active evidence and seller-trust facts satisfy every clause in a Listing Evidence Requirement Snapshot. Readiness uses stable machine codes and never infers requirements from condition labels or other display text.

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
- Disabling records `disabledBy`: `"seller"` for an explicit seller action, `"scheduled"` for the Away Window start sweep consuming its own pending window. Events recorded before this field existed read back as `"seller"`.

## Resume Instant

The **Resume Instant** is the authoritative point in time when a Seller Listing Availability away period ends and listings become eligible to resume, recorded as `availableAgainAt` on the disabling fact.

Notes:

- The Resume Instant is owned by Marketplace.
- It is optional: absent means an indefinite away period with no planned return.
- It is captured client-side as the seller's own local start-of-day for their chosen return date; Marketplace never infers a seller's timezone server-side.
- Only a disabling fact that carries a Resume Instant participates in an automated resume; a bare `availableAgainOn` display date never does.

## Scheduled Restore

A **Scheduled Restore** is the automated enable the auto-resume sweep issues once a Resume Instant has passed. It records `enabledBy: "scheduled"` on the resulting Seller Listing Availability enabled fact, distinguishing it from a seller-initiated enable.

Notes:

- A Scheduled Restore is owned by Marketplace.
- The sweep is compare-and-swap protected: if the seller re-disables or pushes the Resume Instant forward between the sweep observing an account as due and its enable command reaching the aggregate, the command no-ops rather than overriding the seller's own concurrent action.
- A Scheduled Restore emits a seller notification ("Your listings are live again") from the enabled fact itself, not from the sweep runner, so replays and read-model rebuilds never re-notify.
- An **Away Window** (below) is a second trigger for a Scheduled Restore: once its start sweep disables the account with the window's `endsAt` as the Resume Instant, the end boundary rides this same sweep back to available.

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


## Away Window

An **Away Window** is a seller-scheduled future away period on Seller Listing Availability: a start instant and an optional end instant, set in advance so listings disable and resume automatically without a same-day manual action.

Notes:

- An Away Window is owned by Marketplace and lives on the Seller Listing Availability aggregate -- it is part of the same lifecycle, not a separate concept.
- At most one pending window may exist per account at a time. Rescheduling is cancel-then-schedule; there is no amend command.
- Scheduling requires the account to currently be `available`; `startsAt` must be in the future and, when present, `endsAt` must be strictly after `startsAt`. An indefinite window (`endsAt` absent) goes away and stays away until a manual enable.
- The Away Window start sweep disables the account once `startsAt` has passed, carrying the window's `reasonCategory` and `endsAt` forward as the Resume Instant, with `disabledBy: "scheduled"`. The disable consumes the pending window.
- A manual seller disable while a window is pending pre-empts it: the window is explicitly cancelled (a `.away-window-cancelled` fact), not silently dropped -- one source of away-state truth.

## Report

A **Report** is an account or visitor submission that flags Marketplace content for Trust & Safety review.

Notes:

- Reports are owned by Marketplace.
- Reports are grouped by reported target and reporter; one reporter may report the same target once.
- Listing Reports can automatically unlist an active Listing when the distinct-reporter threshold is reached.
- Review Reports require an authenticated account, use a structured reason with an optional explanation, and never automatically remove the Review.
- Review reporting is independent of Scoring Disposition and Review Response: reporting does not change either fact, and neither fact changes reporting eligibility.
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

## Review Response

A **Review Response** is the single public response the reviewed account may attach to a revealed, active Review. It appears with the Review wherever that Review is presented; it is not a thread, cannot receive nested replies, and remains subject to moderation. A held or private Review cannot receive or expose a response.

## Review Eligibility

**Review Eligibility** is the order-lifecycle fact that determines whether a transaction can support directional feedback. Delivery establishes eligibility by default. A seller-responsible cancellation can establish buyer-to-seller eligibility without delivery once the cancellation is recorded; a buyer-caused, mutually agreed, external, or indeterminate cancellation does not automatically establish it.

## Review Hold

A **Review Hold** is Marketplace's order-scoped record that one or more review-affecting Support requests are open. Each request is identified by its stable Support request id and holds both review directions unless Support explicitly identifies narrower directions. The first open request places the affected directions on hold; further concurrent requests extend that hold without pausing time again; the final terminal request releases it. Duplicate, reordered, and replayed facts converge, including a terminal fact that arrives before its open fact. Reopening a terminal request with a later open timestamp starts a new hold.

While held, feedback cannot be submitted, revealed, changed, withdrawn, replied to, reminded, published, or counted in reputation aggregates. Already revealed feedback becomes private until release, while its stored content remains unchanged except through moderation. The public state is the neutral **Review paused** status and never reveals the Support request, allegations, remedy, responsibility, or either party's feedback content.

## Paused Review Clock

A **Paused Review Clock** preserves the remaining submission time when a Review Hold begins. Only the first concurrent hold pauses the clock. When the final hold ends, Marketplace sets the effective deadline to the greater of the preserved remaining duration or 14 days from release. A clock that expired before the hold is not revived, a submitted direction receives no second submission opportunity, and a later reopen pauses the then-current remaining duration. Reminder eligibility is re-armed once for each completed hold cycle.

## Directional Review Disposition

A **Directional Review Disposition** is Marketplace's canonical policy decision for one reviewer and subject on an Order. It combines transaction eligibility, submission state (`allowed`, `held`, `expired`, or `ineligible`), visibility state (`double-blind-pending`, `held`, `revealed`, or `suppressed`), Scoring Disposition, a neutral reason code, and any effective submission deadline. Buyer and Seller are transaction roles, so the same Account may receive either direction on different Orders.

Support owns factual Resolved Responsibility (`seller`, `buyer`, `carrier`, `platform`, `shared`, or `undetermined`). Marketplace alone maps that fact to a Directional Review Disposition. Buyer-to-seller feedback is Included only for seller responsibility or normal completion; seller-to-buyer feedback is Included only for buyer responsibility or normal completion. All other resolved responsibility values are Context-only in both directions. A remedy, refund amount, return, replacement, or monetary outcome never determines the disposition.

## Scoring Disposition

A **Scoring Disposition** states whether an otherwise publishable Review is **Included** in aggregate reputation or is **Context-only**. Context-only Review text and rating may be displayed with neutral explanatory status, but its stars do not contribute to rating aggregates or rank/risk consumers. Scoring is binary: there are no fractional weights or hidden penalties. Moderation and double-blind reveal remain independent visibility decisions.

## Review Summary

A **Review Summary** is the canonical aggregate snapshot for an account derived from active, revealed Reviews. It distinguishes total published Reviews from the count of ratings Included in scoring, and derives averages and distributions only from Included ratings. Review summaries are projected read models, not emitted domain events.

## Seller Reliability

**Seller Reliability** is the marketplace-owned rolling-window view of a seller Account's objective, event-derived transaction-outcome behavior: On-Time Shipment Rate, Cancellation Rate, and the Seller-Responsible Issue Rate. It is a projected read model, not an emitted domain event, computed from `ordering`, `fulfillment`, and `support` events -- never from Review content, and never from data a party can unilaterally game. Behavioral standing measures seller-controlled outcomes: Support's factual responsibility classification is the attribution authority, so a remedy or refund the platform issued for a carrier, platform, buyer, shared, or undetermined cause never degrades the seller. Every metric carries a minimum-order-count display threshold; a metric with too few underlying orders is withheld rather than shown as a misleading rate. The seller's own dashboard shows the full metrics unconditionally; buyer-facing surfaces show only threshold-gated qualitative chips (never raw percentages), behind a rollout gate.

## On-Time Shipment Rate

**On-Time Shipment Rate** is the Seller Reliability metric measuring the share of a seller's dispatched shipments (in the rolling window) that dispatched within the platform's dispatch window of the order becoming ready for fulfillment.

## Seller-Responsible Issue Rate

**Seller-Responsible Issue Rate** is the Seller Reliability metric measuring the share of a seller's orders (in the rolling window) that had a resolved support outcome whose Support responsibility fact is `seller`. It is the responsibility-based replacement for the former refund-derived dispute rate: the numerator is a controllable-outcome measure, not a remedy tally. A seller-misdescription outcome counts once whether it was resolved by refund, replacement, or no monetary remedy; carrier, platform, buyer, shared, and undetermined outcomes never count; open requests never count; and multiple support requests on one order count that order at most once. A missing or unrecognized responsibility fact fails safe to exclusion and raises a missing-responsibility operational signal rather than being read as seller fault.

Where an externally-established product name must remain "dispute rate" (for example the seller dashboard label and its `dispute_rate` API field), that name still denotes this seller-responsible measure and must not be described as counting every dispute or every refund against the seller.

**Seller-Responsible Issue Rate** is distinct from two neighboring concepts that must not be conflated with it: the **Transaction Review Rating** (a Review Summary's average star rating, derived from party-authored reviews of an order) measures perceived experience, and **Support CSAT** (owned by the support-experience feedback slice) measures satisfaction with the support interaction itself. The Seller-Responsible Issue Rate is neither: it is an objective, event-derived count of orders the platform determined the seller was responsible for.

## Cancellation Rate

**Cancellation Rate** is the Seller Reliability metric measuring the share of a seller's orders (in the rolling window) the seller directly cancelled -- buyer-initiated and payment-deadline cancellations are not seller-caused and are excluded.

## Planned Seller Capacity And Time Away

These planned terms pre-register upcoming seller time-away language (the m127 seller time-away & capacity milestone cluster). They are not shipped behavior until their owning milestone adds events, read models, APIs, and UI. Seller Listing Availability, its Resume Instant, and Away Window, defined above, are already shipped and are the foundation these planned terms build on. Order Capacity, Open Order, At Capacity, and Seller Order Capacity moved out of this Planned section: the seller-set cap setting and its events are shipped (defined above); Open Order counting and At Capacity enforcement remain owned by Ordering as a later slice.

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

Seller Reliability, On-Time Shipment Rate, the Seller-Responsible Issue Rate, and Cancellation Rate moved out of this Planned section (m108, #4271): they are shipped behavior now -- see the main glossary body above.

Scheduled Restore moved out of this Planned section (m127 seller time-away audit's auto-resume sweep): it is shipped behavior now -- see the main glossary body above. Away Window also moved out of this Planned section (m127 seller time-away audit's scheduled-window feature): it is shipped behavior now -- see the main glossary body above.

Authenticity terminology (Authenticity Case, Authenticity Verdict, Verdict Reason Code, and related concepts) moved to the [Authenticity](../authenticity/GLOSSARY.md) bounded context ahead of the m109 Authenticity Check milestone (epic #4284); Marketplace does not own that vocabulary.
