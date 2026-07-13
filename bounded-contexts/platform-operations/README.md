# Platform Operations

## Purpose

Platform Operations owns internal operator workflows for cross-context platform runtime health.

## Owns

- Projection operation console journeys (`features/projection-operations`)
- Platform operation UI language
- Platform operation admin route modules
- Platform operation API clients
- Platform operation workflow tests
- Cross-context analytical KPI dashboard-read-model contracts and dashboard query language (`features/insights-dashboards`)
- Platform feedback submission, prompt dismissal, review queue status, reporting read models, and internal admin review surfaces (`features/platform-feedback`)
- Public Help Article policy-revision review queue, visible aging, and confirmation workflow inside Policy Console (`features/public-doc-reviews`)
- Reported content moderation queue read models and internal Trust & Safety surfaces (`features/reported-content`)
- Risk alert operator queue read models and internal Trust & Safety surfaces for account velocity signals (`features/risk-alerts`)
- Structured marketplace support requests, support flows, evidence, and resolutions (`features/support-requests`)

## Does Not Own

- Projection handlers, read models, or projection group declarations owned by business contexts
- Projection replay, retry, rebuild, lease, or fencing semantics
- Source-context event facts
- Bounded-context business repair policy
- Deployable runtime composition
- Business-context decisions about whether a released capability should exist
- Transactional decisions, order lifecycle invariants, or payment authorizations behind analytical reporting
- Account reviews, reputation summaries, or support tickets behind platform feedback

## Ubiquitous Language

Platform Operations terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Platform Feedback
- Support Request, driven by the `support-requests` flow catalog

## Incoming Dependencies

- Marketplace for report, listing, and review facts that feed the reported-content moderation queue and insights dashboards.
- Identity for account-creation facts that feed insights dashboards and risk alerts.
- Payments for payment and dispute facts that feed insights dashboards and risk alerts.
- Ordering for order lifecycle facts that feed insights dashboards and guide support-request flows.
- Fulfillment for shipment lifecycle facts that feed insights dashboards and guide support-request flows.
- Commercial Terms for shared `platform-policy.document.revised` facts that reopen reviews for articles citing those policies. The source is optional and consumed only when Commercial Terms is mounted.
- The generated `@chase-sets/public-docs` citation contract published from Public Presence frontmatter; Platform Operations never imports Public Presence behavior.

## Outgoing Integration Events

- `support.support-request.opened`
- `support.support-request.escalated`
- `support.support-request.resolved`
- `support.support-request.closed`
- `support.support-request.cancelled`
- `platform-operations.public-doc-article-review.confirmed`

Marketplace, Ordering, Payments, and Settlement subscribe to these `support.*` facts. Other `support.*` streams (`.affected-line-items-recorded`, `.evidence-submitted`, `.offer-accepted`, `.offer-declined`, `.response-recorded`) and the `platform-operations.reported-content.action-recorded` / `platform-operations.risk-alert.action-recorded` facts stay internal to Platform Operations today; only its own projections subscribe to them.

## Invariants

1. Platform feedback is immutable after submission; only admin review status (new/reviewed/archived) and operator notes may change afterward, and archived feedback cannot be reviewed again.
2. A support request can be opened only by a requester role its flow definition allows, and must include the order total at open time.
3. A return refund resolution requires completed return checklist evidence; a high-value return refund requires support-role review rather than buyer/seller self-resolution.
4. An offer or adjudication refund amount must be greater than zero and cannot exceed the selected affected line totals; an older case without the additive source fact retains the stamped order-total fallback.

## Tests

Run `pnpm --filter @chase-sets/platform-operations run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/platform-operations run test` before opening a PR.

## Platform Feedback

Platform Operations hosts the former Experience bounded context as the `platform-feedback` slice. Platform feedback is internal-only product signal: a user submission is immutable after it is sent, admin lifecycle state is limited to new/reviewed/archived, and follow-up consent records permission to use existing contact methods only. Marketplace and inventory routes embed the `PlatformFeedbackPrompt` from the `./server` surface, and the feedback API stays mounted at `/api/experience`.

## Support Requests

Platform Operations hosts the former Support bounded context as the `support-requests` slice. Support requests keep order workflows inside guided, auditable steps so common issues can be resolved without direct account-to-account negotiation. The `support-requests` slice uses a flow catalog for issue-specific requirements; new support flows should add a catalog entry and tests before changing aggregate lifecycle behavior. The support API stays mounted at `/api/marketplace`, and durable `support.*` event streams keep their names.

Support consumes Ordering's published line totals and Payments' payment currency through the local affected-line amount source projection. That contract gives offers and adjudications a canonical line-level cap; Payments and Settlement remain the owners of refund accounting and ledger effects.

Cross-context outcomes stay with the context that owns the consequence:

- Payments listens for refund-producing support resolutions and issues order-scoped refunds.
- Settlement listens for open support requests and keeps seller proceeds on hold so payouts cannot include disputed order funds.
- Marketplace removes review eligibility while an order is under support review and restores it only when the outcome does not change the transaction.
- Ordering and Fulfillment remain the source of truth for order and shipment state that support uses to guide available flows.

Buyer cancellation after Fulfillment records package preparation uses the `buyer-cancel-request` flow. Before package preparation, Ordering owns self-service purchase cancellation and support must not create a parallel workflow. Refund-style outcomes keep settlement funds held until the money movement and seller-ledger reconciliation have completed.

Support operations readiness lives in [Support operations readiness](docs/support-operations-readiness.md).

## Boundary Notes

Platform Operations gives staff a coherent way to inspect and act on platform runtime signals. Shared infrastructure still owns generic projection runtime behavior, while each bounded context owns the projections and read models it declares.

Software delivery is not modeled by this application. Release health, release locks, emergency releases, post-deploy production verification, feature rollout, and kill-switch behavior live in CI (`.github/workflows`), `scripts/`, and `infrastructure/`. See [Release Process Evolution](../../docs/runbooks/release-process-evolution.md). Platform Operations does not host release dashboards, release controls, or rollout-policy surfaces.

Deployables compose Platform Operations routes. They should not own page behavior, view models, workflow state, or route tests.
