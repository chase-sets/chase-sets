# Projection Freshness SLOs

## Purpose

Critical post-write reads must feel synchronous to the customer even though Chase Sets keeps read models eventually consistent. The platform contract is receipt propagation plus bounded projection checkpoint gating, not synchronous write-drain.

This document defines the shared SLOs and rollout gates for read-model-backed routes reached immediately after a write. The first critical flow is guest Buy Now checkout: `buy-checkout-readiness` creates a Checkout Session, redirects to `/checkout/buy/session/:sessionId` with `afterWrite`, and the destination reads `checkout_session_pages` through Checkout `/account/checkout-sessions/:sessionId`.

Since the push-first projection runtime (ADR 0010, Milestone #19), the waits these SLOs gate are wake-accelerated where the environment enables push: write-to-ready time decomposes into the push segments commit-to-notify, notify-to-relay, relay-to-control-plane-store, control-plane-claim-to-worker, checkpoint-readiness, and route-wait. The polling-era description of these waits as poll-bounded only is superseded: polling is now the documented fallback bound, not the primary path, in push-enabled environments. Per-segment instrumentation, live evidence, and ratification status are consolidated in [Push-Wake SLO And Load Proof](./push-wake-slo-load-proof.md).

## Flow Classes

| Class | Examples | Customer contract | Freshness target |
| --- | --- | --- | --- |
| Critical customer handoff | Guest Buy Now checkout, payment detail after payment creation | User reaches the intended page or a temporary preparing state while the receipt is fresh. | Strict p95/p99 and zero permanent not-found tolerance. |
| Important self-refresh | Account cart, sell list, listing list after mutations | User sees updated state quickly or bounded temporary refresh guidance. | Measured p95/p99 with route-owned recovery. |
| Operator/background read | Admin diagnostics, bulk job views, reports | User may see lag with explicit status or refresh controls. | SLO may be looser and owned by the operator workflow. |

New route inventory entries must classify the flow in `readAfterWriteRouteInventory[].freshnessSlo`. Normal migrated entries require `flowClass`, `p95Ms`, and `p99Ms`; exceptions remain temporary records with owner, reason, and review date. Critical entries cannot close with an accepted exception unless a dated owner-approved migration issue exists.

| Manifest flow class | p95 target | p99 target | Applies to migrated routes such as |
| --- | ---: | ---: | --- |
| `critical-customer-handoff` | <= 1,000 ms | <= 2,250 ms | Buy Now checkout session, payment create-to-detail, payout request detail, seller accept-to-sales handoff. |
| `important-self-refresh` | <= 2,500 ms | <= 5,000 ms | Account cart, Sell List, listing list/detail, payout setup/readiness, purchase detail, sale detail, seller shipment detail. |
| `operator-background-read` | Context-owned | Context-owned | Operator diagnostics and job/status reads that explicitly expose lag or refresh controls. |

Important self-refresh routes must also name route-owned recovery in the inventory. The target is measured from freshness audit and post-write consistency telemetry; a route can use temporary recovery while within the bounded receipt/retry budget, but generic 5xx/error pages are still route-wiring failures, not acceptable recovery.

## Checkout Session SLO

The first enforced target is Checkout `checkout.session-start-to-detail`:

- Source route: `buy-checkout-readiness`.
- Destination route: `buy-checkout-session`.
- API route: `/api/marketplace/account/checkout-sessions/:sessionId`.
- Read model: `checkout_session_pages`.
- Projection group: `checkout.session-projection`.
- Source context: `checkout`.
- Audit route template: `/account/checkout-sessions/:sessionId`.

Measure only records where `type=read-after-write.freshness`, `routePaths` contains `/account/checkout-sessions/:sessionId`, and `dependencies` contains `checkout.session-projection`.

| Measure | Target | Gate |
| --- | --- | --- |
| API freshness wait duration, `outcome=fresh` | p95 <= 1,000 ms over a rolling 30 minute window; p99 <= 2,250 ms over the same window. | Hold rollout expansion when either threshold fails. |
| API freshness timeout rate | <= 0.1% over a rolling 30 minute window and no more than 3 consecutive canary attempts. | Hold staging promotion for the guest checkout gate; require #1082 capacity review if sustained. |
| Canary write-to-checkout-ready latency, single write (guest and account Buy Now) | <= 10,000 ms per canary attempt, with at least one pay-ready attempt inside 3 attempts. Ratified by the #1237 dual-SLO ratification (2026-06-11; staging-proven 1,158-4,774 ms); override per environment with `STAGING_GUEST_BUY_NOW_CANARY_READY_SLO_MS`. | Abort staging promotion and production proof-mode release marking when no attempt reaches pay-ready inside the budget (`checkout-ready-slo-exceeded`). |
| Burst/saturation durable convergence (concurrent writes into one projection group) | Relay cursor and the active projection checkpoints required by the stimulated route dependency reach the event-store head within the poll-bounded drill budget (default 120,000 ms; drill-proven 50.9 s for the 6x2 worst-case same-fixture burst). For guest/account Buy Now this gated dependency is `checkout.session-projection`; unrelated active checkout checkpoints may be recorded as diagnostic excluded lag unless the drill is intentionally dispatched in all-checkpoint mode. Per-write readiness is best-effort under group saturation per the latency-hint contract: single-flight projection groups serialize concurrent writes by design (correctness over parallelism). | Reconciliation/load drill non-convergence within the gated scope is a P1 wake-pipeline incident; per-write SLO misses under a deliberate burst drill are a capacity-review signal, not a release abort. |
| Permanent not-found while receipt is fresh | 0 allowed. | Fail the canary, fail release evidence, and block milestone closure. |
| Missing receipt for critical route | 0 in canary; <= 0.05% in aggregate telemetry. | Fail the canary; investigate redirect or forwarding regression. |
| Missing or invalid read target context | 0 in canary; <= 0.05% in aggregate telemetry. | Fail the canary; investigate request client or shared mount drift. |
| Exact dependency fallback to target-context wait | 0 for critical Checkout session reads during normal rollout. | Fail structure/release evidence unless an active rollback is documented; route declaration or target context is wrong. |

The single-write and burst rows are deliberately separate SLOs (#1237 dual-SLO ratification, full evidence in [Push-Wake SLO And Load Proof](./push-wake-slo-load-proof.md)): the single-write gate is enforced per deploy, while burst behavior is governed by durable convergence because projection groups are platform-wide single-flight — per-group throughput is bounded by design, and the capacity levers (worker instances, wake-lane runner counts, future group sharding) are recorded against the 6x2 burst baseline in the SLO/load-proof ledger.

Operators report the Checkout session freshness SLO posture from existing Prometheus metrics: p95 and p99 fresh wait histograms, timeout rate, and pending projection lag p95 for the support-safe route template `/account/checkout-sessions/:sessionId`, target context `checkout`, projection `checkout.session-projection`, and source context `checkout`. It is observation-only until production has a stable window of Prometheus evidence and a replacement automated comparison policy is intentionally introduced; a non-zero value means one or more SLO clauses failed during the review window and should hold wake-before-wait rollout expansion even if the hard canary gates remain green.

The current platform freshness wait timeout is 2,500 ms. Critical Checkout reads should normally complete before that timeout. The Checkout session API route has a built-in route-scoped budget of 900 ms with a 50 ms poll interval so the marketplace document route keeps enough request time to render Checkout-owned temporary recovery instead of surfacing a proxy or document timeout. A timeout is not a customer-visible failure by itself only when the route renders temporary preparing-checkout recovery and keeps retry bounded by the original token validity.

Critical fresh-write routes that render a browser document must set a route-scoped freshness budget below the document/proxy timeout, including render and retry overhead. Do not rely only on the global freshness timeout for those routes; if the gate waits until infrastructure times out, the customer loses the route-owned recovery contract.

## Rollout Controls

Platform API exposes read consistency controls for critical freshness changes:

- `READ_CONSISTENCY_TIMEOUT_MS`: global freshness wait timeout, default `2500`.
- `READ_CONSISTENCY_POLL_INTERVAL_MS`: global polling interval, default `75`.
- `READ_CONSISTENCY_EXACT_DEPENDENCY_MODE`: `enabled` by default; set to `target-context` only as an incident rollback that keeps receipt-based gating active while disabling exact-dependency narrowing.
- `READ_CONSISTENCY_ROUTE_TUNING_JSON`: JSON array of route-specific overrides. Each entry requires `mountPath` and `routePath`, and may include `targetContextName`, `timeoutMs`, `pollIntervalMs`, and `exactDependencyMode`. Platform defaults include critical route tuning first; equally specific env entries do not override those defaults. Use a more specific `targetContextName` entry for an intentional operator override.

Example scoped rollback for guest Buy Now:

```json
[
  {
    "mountPath": "/api/marketplace",
    "routePath": "/account/checkout-sessions/:sessionId",
    "targetContextName": "checkout",
    "exactDependencyMode": "target-context",
    "timeoutMs": 2500,
    "pollIntervalMs": 75
  }
]
```

Use route tuning to hold or roll back a route without removing `readFreshnessRoutes`, disabling `afterWrite` receipt waits, or reintroducing permanent stale not-found behavior. Target-context fallback may reduce blast radius during deploy skew or dependency declaration incidents, but it can wait on unrelated projections and does not count as passing the critical Checkout exact-dependency gate.

Targeted fast-path projection catch-up is not part of the current runtime. If #1085 approves #1072, the fast path must ship with an independent kill switch, rate limits, and rollback evidence so operators can disable catch-up without disabling the basic read consistency gate above.

## Customer-Visible Gate

For guest and authenticated Buy Now, the customer-visible gate has three states:

- `pass`: the checkout page reaches a payable review state.
- `temporary`: the route renders preparing-checkout recovery while the same valid `afterWrite` receipt remains fresh.
- `fail`: the route renders permanent checkout-session-not-found, loses the guest cookie or account session handoff, loses the receipt, loses the target context, creates payment/order side effects before explicit confirmation, or loops beyond the token/retry budget.

Since #1227, `temporary` is user-safe but no longer sufficient for promotion: the release gate requires the page to become pay-ready within the canary write-to-checkout-ready budget above. A run that stays `temporary` past the budget, or reaches `pass` slower than the budget, aborts promotion with `checkout-ready-slo-exceeded`. The canary also runs a negative invalid-session probe each run; recovery that masks a truly invalid checkout session as preparing-checkout aborts promotion, so projection-lag recovery cannot hide real errors.

Staging release evidence for the milestone must include guest and account #1086 synthetic canary runs that prove pay-ready within the budget and fail on the original permanent not-found symptom. The API audit must also show the route remained on the exact Checkout dependency and did not degrade into missing receipt, missing target context, or target-context fallback.

Production runs the same canary in proof mode only: when `PRODUCTION_MARKETPLACE_PROOF_ENABLED=true`, the authenticated flow runs against the permission-gated proof marketplace host with operator credentials and the approved proof reference, using the same logical topology, readiness budget, and negative probe as staging; the release is not marked while it fails. A public production guest browser canary remains out of scope (persistent guest checkout artifacts without a cleanup contract), so public production rollout continues to rely on the staging gate, proof-mode evidence, and production telemetry for route errors, projection freshness timeout rate, and worker health. Do not run a production canary that can confirm payment, create orders, mutate inventory, or expose customer-visible fulfillment side effects.

## Rollout Decisions

Use these decisions for critical freshness changes:

| Signal | Decision |
| --- | --- |
| Staging canary sees permanent not-found with fresh receipt | Block promotion and treat as P1. |
| Canary sees repeated temporary states but no pay-ready checkout within the readiness budget across 3 attempts | Promotion aborts automatically with `checkout-ready-slo-exceeded`; inspect `checkout.session-projection` lag and worker capacity. |
| Canary negative probe sees an invalid session rendered as preparing-checkout | Promotion aborts automatically; treat as a Checkout recovery regression that masks real errors. |
| Timeout rate above target but route stays temporary | Hold rollout expansion; #1082 must determine whether worker capacity, deployment skew, or projection optimization is required. |
| `outcome=fresh` but route is not-found | Treat as route/API bug, not projection lag; inspect loader authorization and read-model row content. |
| Missing receipt or target context in canary | Treat as platform contract regression; block release evidence until fixed. |
| SLO passes without fast-path catch-up | #1085 may reject #1072 and close fast-path catch-up as not planned. |
| SLO fails after exact dependency, worker capacity, and Checkout projection optimization | #1085 may approve #1072 with rate limits, fencing, rollout controls, and rollback path. |

## Migrated Critical Post-Write Signals

The migrated critical post-write handoffs are tracked through the same Grafana dashboards and alerts as the rest of projection freshness (see [Observability](../runbooks/observability.md) and the Alert And Dashboard Requirements below). Promotion safety for these signals comes from their SLO alerts, the post-deploy freshness probe, and—when enabled—the DOKS Argo Rollouts analysis gate.

The first migrated browser handoffs after guest Buy Now are sell-rail accept-to-checkout and payout-ready return handoff. Until their telemetry is live they are observed (not alert-gating); once instrumented they get the same dashboard panels and alert families as the critical Checkout session route, with the support-safe labels described below.

## Alert And Dashboard Requirements

#1075 should expose one dashboard panel and alert family per critical route template:

- p95/p99 `durationMs` for `outcome=fresh`.
- timeout rate by route template, target context, projection group, and source context.
- missing receipt count/rate.
- missing or invalid target context count/rate.
- exact-dependency versus target-context wait mode count.
- pending lag for timeout records, including projection group, source context, runner state, and sanitized last-error presence.
- canary-window SLO posture for the Checkout session route using the same support-safe labels as release-health.

Dashboard labels must use route templates and context/projection names only. They must not include full paths, session ids, event ids, guest tokens, cookies, account ids, user ids, contact names, or email addresses.

## Downstream Issue Contract

- #1073 must optimize `checkout.session-projection` against the p95 <= 1,000 ms and p99 <= 2,250 ms API freshness wait target.
- #1082 must prove staging and production worker topology can satisfy the same Checkout target during deploys, restarts, and normal worker polling.
- #1075 must implement alerts and dashboards using the measures above.
- #1079 is satisfied: rollout controls and kill switches can hold or disable new freshness behavior when these gates fail.
- #1074 must include a controlled projection-lag path that fails on permanent not-found and proves temporary recovery plus eventual checkout readiness.
- #1086 must run the symptom-level staging canary against the same `pass`, `temporary`, and `fail` definitions.
- #1085 must use these thresholds when deciding whether targeted fast-path catch-up is necessary.

## Review Cadence

Review the numeric thresholds after ten successful staging canary runs and again after the first public marketplace launch week. Tighten thresholds only when telemetry shows stable headroom. Loosen thresholds only with a linked incident or capacity review that explains why customer trust is still protected.

Current evidence against these thresholds — including the staging canary latency record, the production proof-mode miss analysis, the ratified dual SLOs (single-write readiness and burst durable convergence), and the remaining load-proof gaps — is maintained in [Push-Wake SLO And Load Proof](./push-wake-slo-load-proof.md) (#1237).
