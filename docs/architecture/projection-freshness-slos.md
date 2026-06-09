# Projection Freshness SLOs

## Purpose

Critical post-write reads must feel synchronous to the customer even though Chase Sets keeps read models eventually consistent. The platform contract is receipt propagation plus bounded projection checkpoint gating, not synchronous write-drain.

This document defines the shared SLOs and rollout gates for read-model-backed routes reached immediately after a write. The first critical flow is guest Buy Now checkout: `checkout-start` creates a Checkout Session, redirects to `/checkout/:sessionId` with `afterWrite`, and the destination reads `checkout_session_pages` through Checkout `/account/checkout-sessions/:sessionId`.

## Flow Classes

| Class | Examples | Customer contract | Freshness target |
| --- | --- | --- | --- |
| Critical customer handoff | Guest Buy Now checkout, payment detail after payment creation | User reaches the intended page or a temporary preparing state while the receipt is fresh. | Strict p95/p99 and zero permanent not-found tolerance. |
| Important self-refresh | Account cart, sell list, listing list after mutations | User sees updated state quickly or bounded temporary refresh guidance. | Measured p95/p99 with route-owned recovery. |
| Operator/background read | Admin diagnostics, bulk job views, reports | User may see lag with explicit status or refresh controls. | SLO may be looser and owned by the operator workflow. |

New route inventory entries must classify the flow. Critical entries cannot close with an accepted exception unless a dated owner-approved migration issue exists.

## Checkout Session SLO

The first enforced target is Checkout `checkout.session-start-to-detail`:

- Source route: `checkout-start`.
- Destination route: `checkout-session`.
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
| Permanent not-found while receipt is fresh | 0 allowed. | Fail the canary, fail release evidence, and block milestone closure. |
| Missing receipt for critical route | 0 in canary; <= 0.05% in aggregate telemetry. | Fail the canary; investigate redirect or forwarding regression. |
| Missing or invalid read target context | 0 in canary; <= 0.05% in aggregate telemetry. | Fail the canary; investigate request client or shared mount drift. |
| Exact dependency fallback to target-context wait | 0 for critical Checkout session reads during normal rollout. | Fail structure/release evidence unless an active rollback is documented; route declaration or target context is wrong. |

The current platform freshness wait timeout is 2,500 ms. Critical Checkout reads should normally complete before that timeout. The Checkout session API route has a built-in route-scoped budget of 900 ms with a 50 ms poll interval so the marketplace document route keeps enough request time to render Checkout-owned temporary recovery instead of surfacing a proxy or document timeout. A timeout is not a customer-visible failure by itself only when the route renders temporary preparing-checkout recovery and keeps retry bounded by the original token validity.

Critical fresh-write routes that render a browser document must set a route-scoped freshness budget below the document/proxy timeout, including render and retry overhead. Do not rely only on the global freshness timeout for those routes; if the gate waits until infrastructure times out, the customer loses the route-owned recovery contract.

## Rollout Controls

Platform API exposes read consistency controls for critical freshness changes:

- `READ_CONSISTENCY_TIMEOUT_MS`: global freshness wait timeout, default `2500`.
- `READ_CONSISTENCY_POLL_INTERVAL_MS`: global polling interval, default `75`.
- `READ_CONSISTENCY_EXACT_DEPENDENCY_MODE`: `enabled` by default; set to `target-context` only as an incident rollback that keeps receipt-based gating active while disabling exact-dependency narrowing.
- `READ_CONSISTENCY_ROUTE_TUNING_JSON`: JSON array of route-specific overrides. Each entry requires `mountPath` and `routePath`, and may include `targetContextName`, `timeoutMs`, `pollIntervalMs`, and `exactDependencyMode`. Platform defaults include Checkout session route tuning first; env entries are applied after those defaults so an equally specific operator override wins by the runtime route-tuning tie breaker.

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

For guest Buy Now, the customer-visible gate has three states:

- `pass`: the checkout page reaches a payable review state.
- `temporary`: the route renders preparing-checkout recovery while the same valid `afterWrite` receipt remains fresh.
- `fail`: the route renders permanent checkout-session-not-found, loses the guest cookie handoff, loses the receipt, loses the target context, creates payment/order side effects before explicit confirmation, or loops beyond the token/retry budget.

Staging release evidence for the milestone must include at least one #1074 E2E or #1086 synthetic canary run that proves `pass` or `temporary` and fails on the original permanent not-found symptom. A `temporary` canary state is acceptable for deploy safety only when the API audit also shows the route remained on the exact Checkout dependency and did not degrade into missing receipt, missing target context, or target-context fallback.

Production canary feasibility is owned by #1086. Until a production-safe variant exists, production rollout uses the staging guest Buy Now gate plus production telemetry for route errors, projection freshness timeout rate, and worker health. Do not run a production canary that can confirm payment, create orders, mutate inventory, or expose customer-visible fulfillment side effects.

## Rollout Decisions

Use these decisions for critical freshness changes:

| Signal | Decision |
| --- | --- |
| Staging canary sees permanent not-found with fresh receipt | Block promotion and treat as P1. |
| Staging canary sees repeated temporary states but no pay-ready checkout after 3 consecutive attempts | Hold promotion; inspect `checkout.session-projection` lag and worker capacity. |
| Timeout rate above target but route stays temporary | Hold rollout expansion; #1082 must determine whether worker capacity, deployment skew, or projection optimization is required. |
| `outcome=fresh` but route is not-found | Treat as route/API bug, not projection lag; inspect loader authorization and read-model row content. |
| Missing receipt or target context in canary | Treat as platform contract regression; block release evidence until fixed. |
| SLO passes without fast-path catch-up | #1085 may reject #1072 and close fast-path catch-up as not planned. |
| SLO fails after exact dependency, worker capacity, and Checkout projection optimization | #1085 may approve #1072 with rate limits, fencing, rollout controls, and rollback path. |

## Alert And Dashboard Requirements

#1075 should expose one dashboard panel and alert family per critical route template:

- p95/p99 `durationMs` for `outcome=fresh`.
- timeout rate by route template, target context, projection group, and source context.
- missing receipt count/rate.
- missing or invalid target context count/rate.
- exact-dependency versus target-context wait mode count.
- pending lag for timeout records, including projection group, source context, runner state, and sanitized last-error presence.

Dashboard labels must use route templates and context/projection names only. They must not include full paths, session ids, event ids, guest tokens, cookies, account ids, user ids, contact names, or email addresses.

## Downstream Issue Contract

- #1073 must optimize `checkout.session-projection` against the p95 <= 1,000 ms and p99 <= 2,250 ms API freshness wait target.
- #1082 must prove staging and production worker topology can satisfy the same Checkout target during deploys, restarts, and normal worker polling.
- #1075 must implement alerts and dashboards using the measures above.
- #1079 must provide feature flags or rollout controls that can hold or disable new freshness behavior when these gates fail.
- #1074 must include a controlled projection-lag path that fails on permanent not-found and proves temporary recovery plus eventual checkout readiness.
- #1086 must run the symptom-level staging canary against the same `pass`, `temporary`, and `fail` definitions.
- #1085 must use these thresholds when deciding whether targeted fast-path catch-up is necessary.

## Review Cadence

Review the numeric thresholds after ten successful staging canary runs and again after the first public marketplace launch week. Tighten thresholds only when telemetry shows stable headroom. Loosen thresholds only with a linked incident or capacity review that explains why customer trust is still protected.
