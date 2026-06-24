# Projection Freshness Audit

## Purpose

Use the `read-after-write.freshness` audit record to diagnose post-write reads that depend on projection-backed read models. The first target flow is guest Buy Now checkout, where a successful checkout-session write can redirect to `/checkout/buy/session/:sessionId` before `checkout_session_pages` has caught up.

The audit record is emitted by the API read consistency middleware. It is intentionally route-template based and must not contain guest emails, contact names, cookies, raw `afterWrite` tokens, checkout session ids, account ids, or event ids.

The generated route inventory at `artifacts/read-after-write-route-inventory.md` is the durable audit index. Each migrated `readAfterWriteRouteInventory` row must include `freshnessSlo.flowClass`, `freshnessSlo.p95Ms`, and `freshnessSlo.p99Ms` so operators can sort critical customer handoffs, important self-refresh routes, and operator/background reads without inspecting route code.

## Field Inventory

| Field | Meaning | Redaction/cardinality rule |
| --- | --- | --- |
| `type` | Always `read-after-write.freshness`. | Fixed low-cardinality label. |
| `outcome` | `missing-receipt`, `fresh`, or `timeout`. | Fixed low-cardinality label. |
| `method` | API method, usually `GET` or `HEAD`. | Fixed low-cardinality label. |
| `mountPath` | API mount such as `/api/marketplace`. | Route prefix only; no ids. |
| `routePaths` | Matched `readFreshnessRoutes` templates. | Templates only, for example `/account/checkout-sessions/:sessionId`. |
| `readAfterWriteHeaderPresent` | Whether `Chase-Sets-Read-After-Write` was present. | Boolean only; never log the header value. |
| `readTargetContextHeaderPresent` | Whether `Chase-Sets-Read-Target-Context` was present. | Boolean only. |
| `readTargetContextHeaderValid` | Whether the target-context header matched a context mounted at the path. | Boolean only. |
| `requestedTargetContextName` | Valid requested read context, or `null`. | Context name only. |
| `targetContextNames` | Contexts the gate waited on. | Context names only. |
| `waitMode` | `exact-dependency` or `target-context`. | Fixed low-cardinality label. |
| `durationMs` | Middleware wait duration. | Numeric duration. |
| `receiptSourceContextNames` | Source contexts in the decoded receipt. | Context names only; no event ids. |
| `receiptSourceCount` | Number of source contexts in the receipt. | Numeric count. |
| `receiptEventCount` | Total event count in the receipt. | Numeric count only; no event ids. |
| `dependencies` | Target context and projection group selected for the wait. | Projection names only. |
| `pending` | Timeout-only pending projection source pairs. | Context/projection names, global positions, lag, state, and last-error presence only. |

## Guest Buy Now Classification

For `/api/marketplace/account/checkout-sessions/:sessionId`:

1. Find `type=read-after-write.freshness` and `routePaths` containing `/account/checkout-sessions/:sessionId`.
2. If `outcome=missing-receipt`, the browser route reached the API without a usable commit receipt. Check the buy-checkout-readiness redirect and server-side request forwarding.
3. If `readTargetContextHeaderPresent=false`, the route client did not forward the read target context. On shared mounts this can broaden or misroute the wait.
4. If `waitMode=target-context`, the route either did not match exact `readFreshnessRoutes` dependencies or an active rollout control broadened the wait. Check `READ_CONSISTENCY_EXACT_DEPENDENCY_MODE` and `READ_CONSISTENCY_ROUTE_TUNING_JSON`; for critical Checkout canaries this is acceptable only as a documented rollback state.
5. If `outcome=timeout`, inspect `pending`:
   - `projectionName=checkout.session-projection` and `sourceContextName=checkout` means the checkout session projection did not catch up before the bounded timeout.
   - `globalPositionLag` shows the remaining checkpoint distance at timeout.
   - `state` and `lastError` presence distinguish normal lag from worker error or degraded projection state without logging raw error text.
6. If the browser document returns an opaque 503/504 before the route renders checkout review or preparing-checkout recovery, treat it as a critical route-budget regression. The Checkout session route should use the built-in 900 ms freshness budget; inspect Platform API config, `READ_CONSISTENCY_ROUTE_TUNING_JSON`, and gateway/proxy timeout changes before increasing the budget.
7. If `outcome=fresh` but the route still renders a not-found state, investigate the route loader and API handler because the projection gate completed before the read.

## Privacy Review

Allowed in audit records:

- Context names.
- Route templates.
- Projection group names.
- Source context names.
- Global positions and lag.
- Duration, counts, wait mode, and boolean header presence.
- Sanitized projection runner state and last error.

Forbidden in audit records:

- Raw `afterWrite` values.
- Cookies or guest tokens.
- Contact name or email.
- Checkout session id or payment id.
- Account id, user id, tenant id, membership id, or guest id.
- Event ids.
- Full request URLs or paths with identifiers.

The shared observability logger redacts fields whose names look sensitive, but route and middleware code must still avoid putting sensitive values into the audit record.

## Metrics And Alerts

The audit callback also emits OpenTelemetry metrics through `@chase-sets/observability`:

| Metric | Meaning | Primary labels |
| --- | --- | --- |
| `chase_sets_projection_freshness_evaluations_total` | Count of freshness gate evaluations expanded by bounded route, dependency, and source labels. | `outcome`, `method`, `mount_path`, `route_path`, `target_context`, `projection`, `source_context`, `wait_mode`, `receipt`, `target_context_header` |
| `chase_sets_projection_freshness_wait_duration_ms` | Freshness gate wait duration histogram. | Same as evaluations. |
| `chase_sets_projection_freshness_pending_total` | Timeout-only pending projection/source pairs. | `route_path`, `target_context`, `projection`, `source_context`, `wait_mode`, `state`, `last_error` |
| `chase_sets_projection_freshness_pending_lag` | Timeout-only global-position lag histogram. | Same as pending count. |

Grafana provisions a `Projection Freshness` dashboard with p95/p99 duration, outcome rate, missing receipt or target-context regressions, wait-mode mix, pending lag, and matching audit logs. Starter alerts cover the Checkout `checkout.session-projection` SLO and pending projection errors.

Safe Checkout session queries:

```promql
histogram_quantile(0.95, sum by (le) (rate(chase_sets_projection_freshness_wait_duration_ms_bucket{route_path="/account/checkout-sessions/:sessionId",target_context="checkout",projection="checkout.session-projection",source_context="checkout",outcome="fresh"}[30m])))
```

```promql
sum(rate(chase_sets_projection_freshness_evaluations_total{route_path="/account/checkout-sessions/:sessionId",target_context="checkout",projection="checkout.session-projection",source_context="checkout",outcome="timeout"}[30m])) / clamp_min(sum(rate(chase_sets_projection_freshness_evaluations_total{route_path="/account/checkout-sessions/:sessionId",target_context="checkout",projection="checkout.session-projection",source_context="checkout"}[30m])), 1)
```

```promql
sum by (route_path, target_context, projection, source_context, wait_mode) (rate(chase_sets_projection_freshness_evaluations_total{route_path="/account/checkout-sessions/:sessionId"}[5m]))
```

```promql
sum by (route_path, target_context, projection, source_context, state, last_error) (rate(chase_sets_projection_freshness_pending_total{route_path="/account/checkout-sessions/:sessionId"}[5m]))
```

Safe audit log query:

```logql
{service_name=~"platform-api|admin-support-api"} | json | type="read-after-write.freshness" | routePaths =~ ".*checkout-sessions.*"
```

Do not add labels or log filters for checkout session ids, account ids, event ids, guest email, contact name, cookies, full URLs, or raw `afterWrite` token values.

## Operator Triage

1. Open Grafana > `Projection Freshness` and filter for `/account/checkout-sessions/:sessionId`.
2. If `missing-receipt` is non-zero, inspect the source redirect, cookie-backed handoff when present, and server-side request forwarding. This is a route-wiring failure, not projection lag; do not change worker capacity for this class.
3. If `target_context_header` is `missing` or `present_invalid`, inspect the request client and shared mount routing before changing projection code.
4. If `wait_mode=target-context` on Checkout without an active rollback note, inspect `READ_CONSISTENCY_EXACT_DEPENDENCY_MODE`, `READ_CONSISTENCY_ROUTE_TUNING_JSON`, and the context manifest `readFreshnessRoutes`.
5. If `outcome=timeout`, check `pending` labels. Route-template `timeout` with pending projection/source labels is projection lag; growing lag or `last_error=present` points to worker capacity, poison, or projection handler health.
6. Open Admin > Operations > Projection Operations or call `GET /api/platform/projections` to confirm worker heartbeat, source lag, applicable lag, blocked stream count, poison event count, and runner state for the projection group.
7. If the browser sees a generic platform 503/504 while the audit shows valid receipt and target context, treat the incident as a document route budget regression. The route should surface Checkout-owned temporary recovery before the edge timeout.
8. If `outcome=fresh` but the browser still renders permanent not-found, treat it as a route/API read or readiness bug. Check authorization, ownership, semantic readiness/source contracts, and read-model query behavior before treating it as lag.

Repair follows the owning runbook:

- Worker absent, stale heartbeat, or source lag: use [Projection Operations](./projection-operations.md) and [Projection Freshness Worker Capacity](../architecture/projection-freshness-worker-capacity.md).
- Poison or degraded projection: use [Projection Poison Events](./projection-operations.md).
- Missing receipt, target context, or exact dependency: fix the route/request/platform contract before tuning timeouts.
- Timeout with customer-safe temporary recovery but sustained SLO breach: hold rollout expansion and open a capacity or projection-performance follow-up.

## Follow-Up Use

Attach the relevant redacted audit record summary to #1077 when closing the staging root-cause report. The summary should classify the failed platform contract as one of:

- Missing write receipt.
- Missing server-side receipt forwarding.
- Missing or invalid target-context forwarding.
- Exact dependency not declared or not matched.
- Projection lag beyond timeout.
- Projection worker/degraded state.
- Route fallback after a successful freshness wait.

Use #1078 for SLO thresholds, #1082 for worker capacity conclusions, #1074 for E2E reproduction, and #1086 for synthetic canary coverage.

The current critical Checkout thresholds are defined in [Projection Freshness SLOs](../architecture/projection-freshness-slos.md). Use that document as the source of truth for p95/p99 duration targets, timeout-rate gates, zero permanent-not-found tolerance, and guest Buy Now canary pass/fail language.
