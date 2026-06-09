# Projection Freshness Audit

## Purpose

Use the `read-after-write.freshness` audit record to diagnose post-write reads that depend on projection-backed read models. The first target flow is guest Buy Now checkout, where a successful checkout-session write can redirect to `/checkout/:sessionId` before `checkout_session_pages` has caught up.

The audit record is emitted by the API read consistency middleware. It is intentionally route-template based and must not contain guest emails, contact names, cookies, raw `afterWrite` tokens, checkout session ids, account ids, or event ids.

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
2. If `outcome=missing-receipt`, the browser route reached the API without a usable commit receipt. Check the checkout-start redirect and server-side request forwarding.
3. If `readTargetContextHeaderPresent=false`, the route client did not forward the read target context. On shared mounts this can broaden or misroute the wait.
4. If `waitMode=target-context`, the route either did not match exact `readFreshnessRoutes` dependencies or an active rollout control broadened the wait. Check `READ_CONSISTENCY_EXACT_DEPENDENCY_MODE` and `READ_CONSISTENCY_ROUTE_TUNING_JSON`; for critical Checkout canaries this is acceptable only as a documented rollback state.
5. If `outcome=timeout`, inspect `pending`:
   - `projectionName=checkout.session-projection` and `sourceContextName=checkout` means the checkout session projection did not catch up before the bounded timeout.
   - `globalPositionLag` shows the remaining checkpoint distance at timeout.
   - `state` and `lastError` presence distinguish normal lag from worker error or degraded projection state without logging raw error text.
6. If `outcome=fresh` but the route still renders a not-found state, investigate the route loader and API handler because the projection gate completed before the read.

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
