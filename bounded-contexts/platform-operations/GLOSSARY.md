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
## Reported Content

**Reported Content** is a target-level Trust & Safety queue item created from Marketplace Report facts.

## Moderation Queue

**Moderation Queue** is the Platform Operations queue that groups content reports by target and highlights auto-unlisted targets for operator review.

## Risk Alert

**Risk Alert** is an operator-facing Trust & Safety queue item created when event-sourced account risk counters cross configured velocity thresholds.

- Support Request: A structured request for help with a marketplace order.
- Support Flow: The issue-specific checklist, response options, and resolution policy for a support request.
- Support Evidence: Structured information supplied by the buyer, seller, or platform on a support request.
- Support Resolution: The final support outcome, such as refund, replacement, return for refund, no action, or support escalation.
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
