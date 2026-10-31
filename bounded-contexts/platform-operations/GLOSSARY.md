# Platform Operations Glossary

## Provider Connection

A **Provider Connection** is a read-only operator view of a Catalog integration provider or a Channels Channel Connection. Catalog retains Provider Integration Profile and credential readiness ownership; Channels retains connection and Channel Health ownership. Platform Operations composes their reported state without owning credentials or connection actions.

## Public Doc Article Review

A **Public Doc Article Review** is the operator attention item opened when a revised policy is cited by a public Help Article. It remains visibly aged in Policy Console until an operator confirms that the surrounding prose still matches the revised policy or updates the article before confirmation.

## Commercial Terms Effective-Date Attention

**Commercial Terms Effective-Date Attention** is the Platform Operations projection of upcoming Commercial Terms schedules and active account overrides with a future expiry. Commercial Terms publishes policy-document facts; Platform Operations owns ordering and presentation in the Policy Console attention queue.

## Support Request

A **Support Request** is the Platform Operations-owned case through which an account and operators record evidence, responses, escalations, resolutions, returns, and closure for a marketplace support concern.

## Legacy Referenced

**Legacy Referenced** means a storage key occurs in a v1 evidence reference in a complete Support Request history at a recorded gap-safe global horizon, whether or not an Attachment Operation exists. `seed://support/` placeholders are not storage references.

## Legacy Evidence Inventory

A **Legacy Evidence Inventory** is a private, digest-bound, one-shot classification of the `support-evidence/` namespace against reconstructed history. Listing exhaustion is not snapshot authority. Missing history, listing, drained-deployment boundary or separate snapshot authority requires indefinite retention. Only the exact approved manifest may enter guarded deletion; legacy bytes are never moved or rewritten.

## Support Request Participant Attempt

A **Support Request Participant Attempt** is one account's intended mutation of one Support Request within its authenticated tenant. Its opaque attempt id locates a private receipt; action and canonical request hash are immutable comparisons, not identity partitions. An exact retry returns the first result without another command. Another authorized owner may independently use the same opaque id. Attachment Operations remain separate staging identities.

## Any-case Evidence Access

**Any-case Evidence Access** requires the current Identity `support.evidence.any-case` assignment on the Auth-resolved actor and the independent Support base permission. A role or capability declaration grants no access. Without that assignment, attachment access is limited to buyer or seller participation in the authoritative Support Request stream. Audit reads and operations submissions with attachments require the assignment; participant submissions with attachments remain participant-only.

## Evidence Access Attempt

An **Evidence Access Attempt** is one immutable authorization decision on `support.evidence-access-{supportRequestId}`, appended before attachment parsing or provider access and before returning a denial. An allowed read records authorization to attempt access, never byte delivery. A failed audit append releases no bytes. Records contain only bounded identity, assignment, action, decision, reason, participation, correlation and UTC instant fields. Audit reads append one attempt, without recursively auditing that append, and expose at most 50 records with an explicit continuation cursor. The cleanup runner's service attempt names only its Support Evidence Cleanup Binding id and revision, with no user, account or membership. Malformed case identifiers return the same non-disclosing 404 without an event.

## Reference Claim

A **Reference Claim** binds one Support Attachment Operation's complete ordered stored batch to evidence for its owning case and account. Claiming guards the complete case history; submission atomically guards the claimed operation version. Confirmation is separate and recoverable from committed case evidence. Release requires a complete case history proving no reference committed and an atomic guard on that history. Elapsed time never releases a claim, and no serial append substitutes for the atomic fence.

## Support Attachment Operation

A **Support Attachment Operation** identifies one photo batch with `sao_` plus a canonical ULID, created by the client before dispatch and retained through retries. Only an explicit new-photo-batch action replaces it. Ownership is tenant, initiating account and Support Request together; the id alone is never access authority. The required `x-support-attachment-operation-id` header names the operation.

It durably stages one ordered canonical evidence manifest on `support.attachment-operation-{supportRequestId}-{operationId}` before any storage write. Its fingerprint binds the owner, client operation, canonical hashes, profile and encoder fingerprint. Each put has a version-guarded admission and is settled only by an actual provider response; ambiguous outcomes remain unresolved. Only independent byte verification records Stored. Exact retries match the manifest, resume unstored items and never re-put a stored item. Known failures record CleanupRequired at once, as do a support.manage any-case human request and 24 hours without activity; only a Cleanup Claim removes bytes.

## Cleanup Claim

A **Cleanup Claim** is the worker's fenced attempt to delete one CleanupRequired Support Attachment Operation's bytes. It is appended only after a complete case-history read shows no evidence referencing the batch, atomically guarding the operation version, that case history and the observed Support Evidence Cleanup Binding receipt, and only when every admitted put has settled. The last put plus its storage deadline plus five minutes is eligibility only; an unsettled put retains the bytes indefinitely. The claim records the binding id and revision and fences out further puts and reference claims. Deleted-unreferenced is recorded only when every key reports deleted or absent and a confirming read finds each absent; any other outcome records a cleanup failure and a later claim retries. Deleted-unreferenced is terminal, and referenced operations are never claimed.

## Support Evidence Cleanup Binding

A **Support Evidence Cleanup Binding** is the environment- and instance-scoped deployment declaration (`SUPPORT_EVIDENCE_CLEANUP_BINDING_JSON`, scoped like the capability administration authority by `CHASE_SETS_DEPLOYMENT_INSTANCE`) that mounts the platform-worker's `support-evidence-operation-cleanup` runner. Absent, invalid or inactive bindings leave it not mounted with one bounded denial. A valid binding compare-and-records its receipt on `support.evidence-cleanup-binding`; a process whose receipt was superseded cannot claim. It grants deletion, absence verification and the runner's own operational audit read only, never upload, download, administration or human HTTP access. Revocation is a higher inactive revision deployed after old workers drain.

## Support Evidence Attachment

A **Support Evidence Attachment** is one private, canonical image referenced by `support-attachment:v1`. New attachment ids are `sea_` plus the complete 52-character lowercase, unpadded base32 SHA-256 of the versioned tenant/account/case/operation/index/canonical-hash tuple. Legacy ids, references, object keys and bytes remain unchanged and readable. A reference is returned only when the entire operation is verified Stored, never from put success, a provider key or ETag.

## Platform Remedy Policy

The **Platform Remedy Policy** is the versioned Platform Operations policy that determines which support reasons are eligible for platform funding, capability-based amount and percentage limits, split funding, return requirements, refund triggers, dual control, reservation expiry, and exception or escalation reasons.

## Remedy Approval

A **Remedy Approval** is an immutable human decision on a proposed remedy after any required Protection Coverage reservation succeeds. Policy may require distinct operators, multiple approvals, and elevated authority before Support can authorize execution.

## Seller Compliance Cohort

A **Seller Compliance Cohort** is the policy-configured rolling-window membership state for seller accounts, derived from recorded seller-compliance sale facts. It is inert until an operator publishes an activated, fully configured policy and does not itself make a statutory applicability claim.

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

The **Foregone Fee Estimate** is the offer-economics monitor's projection of what the Locked-Fee Listing Cohort's realized Gross Merchandise Value would have cost in marketplace sales fees under Commercial Terms' published standard schedule -- the standard schedule's percentage applied to the cohort's realized GMV, plus its fixed component applied once per locked trade. It is an estimate against the _current_ published schedule, not a historical replay of whatever schedule was standard on each trade's date.

## Locked-Cohort Sell-Through

**Locked-Cohort Sell-Through** is the offer-economics monitor's cumulative ratio of the Locked-Fee Listing Cohort's trade count to its listings-created count, computed week-over-week since the reporting window opened. It is a distinct metric from Pricing's canonical Sell-Through Rate (`bounded-contexts/pricing/GLOSSARY.md`), which is a per-product 30-day-window ratio against a Product Market Aggregate -- this one is cohort-scoped and cumulative, tracking whether the founders cohort's inventory is converting faster or slower as it matures, not any single product's liquidity.

## Reported Content

**Reported Content** is a target-level Trust & Safety queue item created from Marketplace Report and Identity Account Profile Report facts. Its closed targets are `listing`, `review` and `account-profile`, and each target accepts exactly its own moderation actions (`features/reported-content/api/contracts.ts`). An `account-profile` target is the reported Account, which is also its owner. A target is actionable only once a report has queued it. Operators see the minimum reporter evidence: reporter kind, reason, details, submission time and a distinct reporter count, never a reporter identifier.

An **Account Profile Report** is Identity's closed v1 fact that one Account reported another Account's profile (`contracts/event-core/public-event-payloads/identity.ts`); an Account never reports itself.

`contact-account` records that an operator asked the reported Account to correct its profile. `redact-profile-display-name` records, with a required note, the operator's decision that the Account's profile display name be redacted; Identity owns the redaction itself.

## Listing Removal Directive

A **Listing Removal Directive** is the operator's intent to unlist one Listing, recorded atomically after its Reported Content action audit. Marketplace owns the removal decision and its durable enforcement identity; the directive is not removal authority. Only newly authored directives are delivered, never historical audit actions.

Disabling delivery retains the Listing aggregate reader and all visibility consumers. Stored removals remain readable and hidden, and pending directives resume when delivery is enabled again. After the first operator removal event, roll forward rather than reverting the aggregate reader; never delete events or checkpoints.

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

## Support Remedy

A **Support Remedy** is the action selected to resolve a Support Request, such as a full or partial refund, return for refund, replacement, cancellation, or no remedy. A remedy describes what happens next; it does not imply who was responsible.

## Remedy Execution

**Remedy Execution** is the Support Request-owned, `remedyId`-correlated lifecycle that begins when a monetary remedy is
authorized and ends only after every required physical and financial effect is satisfied or permissibly waived. A made
decision is not execution completion.

## Remedy Effect

A **Remedy Effect** is one required outcome derived from the authorized liability allocation, return directive, and refund
trigger, such as coverage reservation, label availability, a carrier or facility milestone, refund completion, or
Settlement reconciliation. Effect state is projected from correlated facts as pending, satisfied, retryably failed,
terminally failed, or waived. Financial truth cannot be created by a Support override.

## Support Responsibility

**Support Responsibility** is Support's factual, auditable finding of whose controllable action primarily caused the order problem: `seller`, `buyer`, `carrier`, `platform`, `shared`, or `undetermined`. `shared` means both transaction parties materially contributed. `undetermined` is used when evidence cannot support another value. Support owns this fact but does not own rating weights, review eligibility, public reputation labels, or other Marketplace consequences.

## Support Evidence Basis

A **Support Evidence Basis** is the structured indication of how Support established responsibility: `party-accepted-resolution`, `deterministic-policy`, `operator-finding`, `insufficient-evidence`, or `legacy`. It includes a stable reference to the accepted offer, policy rule, adjudication workflow, insufficiency finding, or compatibility rule without exposing private evidence contents or internal notes.

## Support Evidence Raster Profile

The **Support Evidence Raster Profile** (`support-evidence-raster/v1`) is Support's versioned raster canonicalization for evidence images. It accepts only JPEG, PNG, and WebP whose declared media type matches their signature, at most 10 MiB encoded and 24,000,000 pixels, with exactly one frame and no decoder warning. It applies orientation, strips all metadata, converts to sRGB, and re-encodes only the decoded pixels in the matching format: baseline 4:4:4 JPEG at quality 90 with alpha flattened onto white, non-paletted truecolor PNG at compression 9, or lossless WebP at effort 6, keeping PNG and WebP alpha. Canonical output above 10 MiB is rejected. It is raster canonicalization, not malware detection: no caller metadata, trailing data, or encoding choice survives, but it judges nothing about what an image depicts or whether the original file was malicious.

## Encoder Fingerprint

An **Encoder Fingerprint** identifies the encoder that produced canonical evidence bytes: the profile, resolved Sharp version, libvips version, platform, architecture, and libc family. One fingerprint yields one byte sequence for a given input. Golden canonical hashes are recorded per fingerprint; opened for a production-like host, the canonicalizer is certified only when that host's fingerprint has goldens its startup self-test reproduces exactly, and otherwise reports itself unavailable. Opened for development or test, it canonicalizes under its own uncertified fingerprint and never certifies goldens. Evidence upload intake does not use the canonicalizer yet; #9390 composes it.

## Responsibility Reason Code

A **Responsibility Reason Code** is the stable, machine-readable, flow-prefixed cause supporting a Support Responsibility finding. The selected support flow defines which reason codes and responsibility values are consistent; for example, `product-not-received.carrier-loss` supports carrier responsibility while `product-not-as-described.seller-misdescription` supports seller responsibility.

## Case Status

A **Case Status** describes where a Support Request is in its lifecycle, such as waiting on a party, ready for Support, resolved, closed, or cancelled. It is independent from the remedy and responsibility facts recorded at resolution.

## Feature Flags

A **Feature Flag Definition** is the platform-owned declaration of a flag key and its **Flag Fallback Value**. The fallback is the definition's value when no authored environment document supplies a value; it is not a targeting default.

A **Feature Flag Document** is the versioned, owner-attributed record of one flag's staging and production **Flag Environment State** values, including targeting inputs and the **Targeting Default** for each environment.

A **Flag Environment State** is the closed per-environment state of a Feature Flag Document: enablement, account and badge targeting, percentage basis points, and its Targeting Default.

A **Targeting Default** is the environment document's boolean value used by a future flag reader when its targeting rules do not select an account or badge. It is distinct from a Feature Flag Definition's Flag Fallback Value.

A **Targeting Rule** is a future evaluation rule that selects whether a Flag Environment State applies to an eligible account or request. Evaluation behavior is not part of this contract.

A **Flag Revision** is one immutable authored revision of a Feature Flag Document, identified by its document id and update instant.

A **Flag Evaluation Context** is reserved for #7185; no type or evaluation behavior is shipped by this contract.

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

## Seller Compliance Sale

A **Seller Compliance Sale** is one recorded, replayable fact about a platform-processed sale: the `(payment_id, order_id)` pair a Payments capture creates against an Ordering order, together with Ordering's authoritative seller, the capture occurrence instant, the gross money decomposition in cents when every source value is present and reconciles, the recorded per-line classification inputs, cancellation, and the cumulative refund total and cap when a refund has affected that order.

It is an observation, not a verdict. It asserts no statutory applicability, evaluates no threshold, and classifies no seller; a later policy evaluator reads these facts. It is distinct from **Risk Alert**, which is an operator-facing Trust & Safety queue item raised by velocity thresholds, whereas a Seller Compliance Sale raises nothing and simply records what Ordering and Payments published.

## Appealable Enforcement Action

An **Appealable Enforcement Action** is one Identity account enforcement (suspension, reactivation, or closure, keyed `enf_`) or Marketplace listing enforcement (operator or automatic unlisting, keyed `lea_`) that Platform Operations has recorded as a complete registry tuple: the owning account, the source event type, and the source stream id and version, all taken from the published fact and never from a caller.

The tuple is immutable. A later fact that claims the same action with a different tuple marks it conflicted for good. Only a present, complete, non-conflicted action owned by the asking account is returned; an action not yet projected, owned by another account, or conflicted reads as one indeterminate answer, never as `not appealable`. Reactivations and closures stay appealable. It narrows the planned **Enforcement Action** to the actions that source contexts have actually published.

## Account Appeal

An **Account Appeal** is the private Platform Operations aggregate that records a seller's statement about one Appealable Enforcement Action and its operator review. Filing and withdrawal require a carried seller file capability; review and outcome require a carried operator review capability. Its stream is `platform-operations.account-appeal-<appealableActionId>`.

### Appeal Status

**Appeal Status** is the aggregate lifecycle: `filed`, `in-review`, `upheld`, `reversed`, `modified`, or `withdrawn`. Terminal statuses are steady and immutable; a reversal does not restore the account.

### Appeal Outcome

An **Appeal Outcome** is the private terminal decision `upheld`, `reversed`, or `modified`, together with its trimmed rationale, internal note, and operator identity. These facts remain in the private event and are not public event payloads.
