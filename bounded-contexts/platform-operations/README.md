# Platform Operations

Platform Operations owns internal operator workflows for cross-context platform runtime health.

## Owns

- Projection operation console journeys (`features/projection-operations`)
- Platform operation UI language
- Platform operation admin route modules
- Platform operation API clients
- Platform operation workflow tests
- Cross-context analytical KPI dashboard-read-model contracts and dashboard query language (`features/insights-dashboards`)
- Platform feedback submission, prompt dismissal, review queue status, reporting read models, and internal admin review surfaces (`features/platform-feedback`)
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

## Platform Feedback

Platform Operations hosts the former Experience bounded context as the `platform-feedback` slice. Platform feedback is internal-only product signal: a user submission is immutable after it is sent, admin lifecycle state is limited to new/reviewed/archived, and follow-up consent records permission to use existing contact methods only. Marketplace, inventory, and payments routes embed the `PlatformFeedbackPrompt` from the `./server` surface, and the feedback API stays mounted at `/api/experience`.

## Support Requests

Platform Operations hosts the former Support bounded context as the `support-requests` slice. Support requests keep order workflows inside guided, auditable steps so common issues can be resolved without direct account-to-account negotiation. The `support-requests` slice uses a flow catalog for issue-specific requirements; new support flows should add a catalog entry and tests before changing aggregate lifecycle behavior. The support API stays mounted at `/api/marketplace`, and durable `support.*` event streams keep their names.

Cross-context outcomes stay with the context that owns the consequence:

- Payments listens for refund-producing support resolutions and issues order-scoped refunds.
- Settlement listens for open support requests and keeps seller proceeds on hold so payouts cannot include disputed order funds.
- Reputation removes review eligibility while an order is under support review and restores it only when the outcome does not change the transaction.
- Ordering and Fulfillment remain the source of truth for order and shipment state that support uses to guide available flows.

Buyer cancellation after Fulfillment records package preparation uses the `buyer-cancel-request` flow. Before package preparation, Ordering owns self-service purchase cancellation and support must not create a parallel workflow. Refund-style outcomes keep settlement funds held until the money movement and seller-ledger reconciliation have completed.

Support operations readiness lives in [Support operations readiness](docs/support-operations-readiness.md).

## Boundary Notes

Platform Operations gives staff a coherent way to inspect and act on platform runtime signals. Shared infrastructure still owns generic projection runtime behavior, while each bounded context owns the projections and read models it declares.

Software delivery is not modeled by this application. Release health, release locks, emergency releases, post-deploy production verification, feature rollout, and kill-switch behavior live in CI (`.github/workflows`), `scripts/`, and `infrastructure/`. See [Release Process Evolution](../../docs/runbooks/release-process-evolution.md). Platform Operations does not host release dashboards, release controls, or rollout-policy surfaces.

Deployables compose Platform Operations routes. They should not own page behavior, view models, workflow state, or route tests.
