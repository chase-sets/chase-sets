# Platform Operations Glossary

- Projection Operation: A durable control-plane request for operator-triggered projection work such as rebuild, retry, or cancellation.
- Projection Group: A bounded-context declared projection owner for one read-model group and its source subscriptions.
- Subscription: A projection group's declared source-context event consumer and checkpoint boundary.
- Blocked Stream: A source stream paused for one projection after a poison event while unrelated streams continue draining.
- Poison Event: An event that failed projection handling and requires repair, retry, or rebuild before that stream can continue.
- Worker: A runtime process that claims projection groups, jobs, dispatch work, or scheduled work.
- Runner: A leased worker activity responsible for draining or maintaining a specific runtime workload.
- Snapshot Freshness: Whether the displayed projection status came from a fresh worker snapshot, stale snapshot, or runtime memory.
- Source Lag: The source-context event distance between a subscription checkpoint and the source head.
- Applicable Lag: The estimated count of source events after the checkpoint that match a subscription's filters.
- Attention: Any operator-facing condition that should be triaged before routine healthy rows, including failed operations, cancel-requested operations, degraded projections, blocked streams, poison events, stale snapshots, stale workers, and stale revisions.
- Analytical Projection: A read-only dashboard-read-model built from integration events across multiple bounded contexts.
- KPI: A named metric used to track marketplace or account performance. Canonical KPI contracts are Sales Performance KPI (`insights.dashboards.sales-performance-kpi.query`, `/dashboards/sales-performance-kpi`), Fulfillment Latency KPI (`insights.dashboards.fulfillment-latency-kpi.query`, `/dashboards/fulfillment-latency-kpi`), and Conversion Order KPI (`insights.dashboards.conversion-order-kpi.query`, `/dashboards/conversion-order-kpi`).
- Dashboard View: The presentation-focused projection used to render operational or commercial reporting.
- Forecast Model: The analytical model used to estimate future demand, pricing, or operational outcomes.
- Report Slice: A filtered analytical view scoped by time, account, or product dimensions.
- Platform Feedback: An internal record of a user's experience with Chase Sets. It evaluates the platform (not another account), is visible to internal users only, and carries a rating, topic, optional comment, source workflow, and source context.
- Platform Feedback Rating: The numeric experience score inside Platform Feedback, an integer from `1` through `5`.
- Platform Feedback Topic: The required high-level area the feedback is about, such as ease of use, pricing/fees, product data/search, checkout/payment, selling/inventory, performance/reliability, or other.
- Platform Feedback Comment: The optional written narrative attached to Platform Feedback.
- Source Workflow: The user task that produced a platform-feedback prompt, such as checkout payment, listing publish, offer submit, offer accept, inventory create, or inventory adjust.
- Prompt Dismissal: A record that a user chose not to leave platform feedback for a Source Workflow at that time.
- Review Queue Status: The internal lifecycle state for Platform Feedback: new, reviewed, or archived.
## Ops Dashboard

The **Ops Dashboard** is the platform-wide, operator-facing analytics surface showing Gross Merchandise Value, order/trade counts, active buyer/seller counts, and liquidity indicators over a selectable date range, with time-series charts and a top-catalog-items breakdown. It reads pricing's published Platform Daily Rollup and Trades Tape query API exclusively -- Platform Operations never computes a second Gross Merchandise Value figure of its own.

## GMV Reconciliation Run

A **GMV Reconciliation Run** is a recorded comparison, for one calendar month, between pricing's tape-derived Gross Merchandise Value and settlement's ledger 'sale' credit total -- a drift-alarm sanity check (not a penny-accurate fee reconciliation) that flags implausible gaps between the two for operator review.

## Offer Economics Summary

The **Offer Economics Summary** is the offer-economics monitor's (#4075) live-computed report for a date range: the Locked-Fee Listing Cohort's listing volume, realized Gross Merchandise Value and its share of platform GMV, a Foregone Fee Estimate, and its Locked-Cohort Sell-Through trend. It is never persisted -- every field is recomputed on request from Marketplace's, Pricing's, and Commercial Terms' own published data via the `offerEconomicsCrossContext` host port, matching the Ops Dashboard's own live-compute convention. This summary is the substantiation source for public campaign claims about seller fees; see `docs/campaigns/offer-economics-claims-substantiation.md`.

## Locked-Fee Listing Cohort

The **Locked-Fee Listing Cohort** is the set of Marketplace listings whose listing-time fee snapshot resolved to a 0% marketplace sales fee through a Commercial Terms agreement (the founders-offer fee-lock mechanism), rather than the standard schedule. Membership is read directly off each listing's own locked fee snapshot (`terms_agreement_id` set, `marketplace_sales_fee_unit_amount` zero) -- never re-resolved from current-state commercial terms, so a cohort listing stays in the cohort even after its founder's window later expires.

## Foregone Fee Estimate

The **Foregone Fee Estimate** is the offer-economics monitor's projection of what the Locked-Fee Listing Cohort's realized Gross Merchandise Value would have cost in marketplace sales fees under Commercial Terms' published standard schedule -- the standard schedule's percentage applied to the cohort's realized GMV, plus its fixed component applied once per locked trade. It is an estimate against the *current* published schedule, not a historical replay of whatever schedule was standard on each trade's date.

## Locked-Cohort Sell-Through

**Locked-Cohort Sell-Through** is the offer-economics monitor's cumulative ratio of the Locked-Fee Listing Cohort's trade count to its listings-created count, computed week-over-week since the reporting window opened. It is a distinct metric from Pricing's canonical Sell-Through Rate (`bounded-contexts/pricing/GLOSSARY.md`), which is a per-product 30-day-window ratio against a Product Market Aggregate -- this one is cohort-scoped and cumulative, tracking whether the founders cohort's inventory is converting faster or slower as it matures, not any single product's liquidity.

## Reported Content

**Reported Content** is a target-level Trust & Safety queue item created from Marketplace Report facts.

## Moderation Queue

**Moderation Queue** is the Platform Operations queue that groups content reports by target and highlights auto-unlisted targets for operator review.

## Risk Alert

**Risk Alert** is an operator-facing Trust & Safety queue item created when event-sourced account risk counters cross configured velocity thresholds.

## Rate-Limit Policy

**Rate-Limit Policy** is the platform-wide, admin-managed request-volume policy on the shared platform-policy machinery (see `infrastructure/platform-policy`). It carries per-surface overrides (max requests, window, kill switch) and a global incident multiplier that tightens or loosens every rate-limited surface at once. Surfaces register their own compiled fallback rule; unknown surfaces resolve to that fallback unchanged.

- Support Request: A structured request for help with a marketplace order.
- Support Flow: The issue-specific checklist, response options, and resolution policy for a support request.
- Support Evidence: Structured information supplied by the buyer, seller, or platform on a support request.
- Support Resolution: The final support outcome, such as refund, replacement, return for refund, no action, or support escalation.
- Affected Line Item Amount: The canonical decimal-string amount and currency fact for one order line that Support uses to validate an offer or adjudication cap.
- Affected Line Item Amount Contract: The Support-owned validation boundary that selects order lines, requires one currency, and caps an offer or adjudication without performing money accounting.
- Buyer Cancellation Request: The support-owned fallback flow used when a buyer wants to cancel after Fulfillment has started package preparation.
- Seller Condition Attestation: Seller-supplied support evidence confirming the returned item's condition after return delivery.
- Return Investigation: Support-owned review opened when return discrepancy evidence indicates the returned item may not match the original sale condition.

## Planned Platform Policy Enforcement

These planned terms pre-register upcoming platform policy and enforcement language. They are not shipped behavior until Platform Operations adds the corresponding queues, operator workflows, and audit facts.

### Platform Policy

A **Platform Policy** is the planned operator-managed rule set for platform safety, eligibility, or enforcement.

### Policy Version

A **Policy Version** is the planned immutable revision of a Platform Policy.

### Policy Scope

A **Policy Scope** is the planned target area where a Platform Policy applies.

### Policy Decision

A **Policy Decision** is the planned evaluated outcome of a Platform Policy.

### Policy Evaluation

A **Policy Evaluation** is the planned operator or automated assessment that produces a Policy Decision.

### Policy Override

A **Policy Override** is the planned authorized exception to a Policy Decision.

### Policy Exception

A **Policy Exception** is the planned record that explains why normal Platform Policy handling did not apply.

### Policy Review

A **Policy Review** is the planned operator workflow for inspecting a Policy Evaluation, Policy Decision, or Policy Exception.

### Policy Incident

A **Policy Incident** is the planned grouped operational case created when platform policy signals require coordinated response.

### Enforcement Action

An **Enforcement Action** is the planned operator action that limits, restores, or annotates account or content behavior.

### Moderation Action

A **Moderation Action** is the planned operator action taken on reported or policy-violating content.

### Trust Queue

A **Trust Queue** is the planned Platform Operations work queue for account, content, and commerce safety review.

### Safety Hold

A **Safety Hold** is the planned Platform Operations restriction that pauses a risky workflow while review is pending.

### Support Reference Lookup

A **Support Reference Lookup** is the Platform Operations admin surface that resolves any support-safe reference (`ORD-`, `SHP-`, `PYO-`, `SUP-`, `CSG-`, `CS-SL-`) or raw order/shipment/payout/support-request id to the owning record, by routing to that record's owning bounded context.
