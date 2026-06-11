# Platform Operations

Platform Operations owns internal operator workflows for cross-context platform runtime health.

## Owns

- Projection operation console journeys
- Release health and release dashboard operator language
- Release lock and emergency release workflow language
- Feature rollout, allowlist, opt-out, and kill-switch policy
- Platform operation UI language
- Platform operation admin route modules
- Platform operation API clients
- Platform operation workflow tests
- Cross-context analytical KPI dashboard-read-model contracts and dashboard query language (`features/insights-dashboards`)
- Platform feedback submission, prompt dismissal, review queue status, reporting read models, and internal admin review surfaces (`features/platform-feedback`)

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

## Boundary Notes

Platform Operations gives staff a coherent way to inspect and act on platform runtime signals. Shared infrastructure still owns generic projection runtime behavior, while each bounded context owns the projections and read models it declares.

Release controls and release dashboards are operator-facing platform controls, not business ownership transfers. Platform Operations owns the rollout, lock, production-currency, and release-health language, deterministic evaluation rules, and operator audit policy. The bounded context that owns the behavior still decides the domain invariant and calls the rollout decision only as an exposure guard.

Deployables compose Platform Operations routes. They should not own page behavior, view models, workflow state, or route tests.
