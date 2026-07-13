# ADR 0021: Customer Feedback Bounded Context and Versioned CSAT Contract

## Status

Accepted for issue #5146 (epic #5144, Wave 2 — Core Commerce Beta Readiness).

## Context

The existing `platform-feedback` slice lives inside Platform Operations, an
acknowledged mixed-responsibility context, even though it owns customer-facing
survey capture, feedback triage, and satisfaction analytics. Its event/data
contract treats any 1–5 rating as generic feedback: there is no survey
instrument/version, anchored question, invitation identity, sampling policy,
presentation denominator, or compatibility contract for future survey changes.
Clients can also claim arbitrary workflow/entity provenance rather than redeeming a
server-issued invitation tied to a real outcome.

Epic #5144 makes customer satisfaction a launch-ready capability. Nine sibling
leaves (#5147–#5155) build on a shared contract; #5146 is the implementation start
gate that must precede every new event, projection, and workflow-placement leaf.

## Decision

Create a canonical **Customer Feedback** bounded context
(`bounded-contexts/customer-feedback`) and make it the home for customer-satisfaction
behavior. This gate establishes the context skeleton and the versioned CSAT
contract; the runtime behavior is added by the sequenced leaves that consume it.

Boundary and cross-context event direction:

- Source contexts publish completed **Outcome Facts** they own. Customer Feedback
  consumes those facts and decides whether/when to issue an invitation. It never
  reaches into another context's aggregate or database.
- Customer Feedback publishes only stable integration facts
  (`customer-feedback.*` invitation-lifecycle events). No downstream context
  imports Customer Feedback internals; Notifications and Platform Operations
  consume published facts through their own contracts.

Versioning / deploy-skew policy:

- Every survey response is pinned to a `(surveyKind, surveyVersion,
  questionVersion)` identity. CSAT combines only identical `transactional-csat`
  versions; other kinds and incompatible question versions are structurally
  excluded from the numerator and denominator.
- This codebase has no event-envelope schema-version field or upcaster registry.
  Native `customer-feedback.*` events therefore carry an explicit
  `eventSchemaVersion` in their payload, evolve additively (new fields optional),
  and are reconciled at the codec `decode` seam via a shared replay-compat
  classifier. Unknown event types are surfaced, not silently dropped, so deploy
  skew fails visibly rather than corrupting metrics.

Migration / reset choice for legacy generic rows: **migrate, not reset.** The
pre-existing `experience.platform-feedback.*` events remain in place and replayable.
Customer Feedback classifies every legacy generic rating under an explicit,
non-CSAT `legacy-experience-rating` survey kind (v0), which is not CSAT-eligible.
Because the CSAT calculation only counts CSAT-eligible `transactional-csat`
submissions, a legacy rating can never silently enter CSAT — the exclusion is
enforced by the data model, not by convention.

## Why not Support, Platform Operations, Notifications, or a shared package

- **Support** owns support cases and resolutions; it is a source of Outcome Facts,
  not the owner of satisfaction instruments and analytics.
- **Platform Operations** already acknowledges mixed responsibilities; adding
  survey, sampling, privacy, and case behavior there would deepen coupling and
  preserve the reversed dependency arrows this epic exists to remove.
- **Notifications** owns delivery channels and reports delivery outcomes through
  its own contract; it does not own survey definitions, eligibility, or CSAT.
- **A shared package** would leak a cross-cutting domain into infrastructure. CSAT
  is domain behavior with its own ubiquitous language, invariants, events, and
  read models — it belongs in a bounded context, exposed to others only through
  stable published facts and its `./server` contract surface.

## Scope of this gate

Delivered here: the context skeleton (`context.json`, README, glossary, workspace
metadata, source-context wake registration) and the versioned contract surface —
survey identity and the v1 instrument, the workflow/outcome allow-list, the Outcome
Fact schema, sampling metadata, the invitation shape and its versioned lifecycle
event contracts, the CSAT/response-rate calculation, and the legacy classification
plus replay-compat base.

Deferred to the sequenced leaves that build on this contract: issuing invitations
(#5147); recording presentation/dismissal/submission and projecting CSAT (#5148);
the feedback case lifecycle, dashboard, and follow-up (#5149/#5153/#5154); privacy
controls (#5155); and the physical removal of the Platform Operations
`platform-feedback` runtime slice once those consumers migrate. This staging matches
the epic dependency graph and avoids duplicating the sibling leaves' work.

Issue #5147 completes the intentionally stubbed invitation surface without
changing the stable survey-identity, Outcome Fact, workflow/outcome allow-list, or
metric contracts. The invitation contract now includes all eight lifecycle states
and versioned events, an opaque public redemption reference, a persisted sampling
decision and policy schema version, and the explicit `issuanceEnabled` kill switch.
The aggregate owns presentation/dismissal/submission transitions because
single-use redemption and expiry are invitation invariants; #5148 remains the
owner of survey UI composition and aggregate CSAT/response-rate analytics.
Per-subject/workflow cooldown uses an internal, versioned
`customer-feedback.sampling.cooldown-claimed` fact. The claim and issued
invitation append atomically to separate event streams, avoiding an eventually
consistent projection read as the concurrency authority.

## Consequences

- Sibling leaves consume one authoritative contract via
  `@chase-sets/customer-feedback/server`; event and metric shapes are fixed at the
  gate and stay replay-stable.
- Customer Feedback is registered as an eligible source context in the wake
  registry. Its first query projection is
  `customer-feedback-csat-invitation-projection`; rollout enablement remains an
  operational push-wake decision.
- Platform Operations retains the legacy `platform-feedback` slice until its
  consumers migrate; both the legacy events and the new `legacy-experience-rating`
  classification keep those rows replayable and permanently out of CSAT.

This decision supports issue #5146 and unblocks #5147–#5155. It supersedes only the
"where does platform-feedback land?" question inside deferred ADR issue #3530; the
broader Support/Insights context decision remains with #3530.
