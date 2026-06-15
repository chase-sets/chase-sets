# Account Cart Consistency Canary

## Purpose

Use `scripts/account-cart-consistency-canary.mjs` to record release evidence for account cart post-write consistency without storing account, cart, checkout, token, or URL identifiers. The script is intentionally a doc-backed observation canary: the Checkout/runtime owner supplies a redacted observation from a browser smoke, runtime test, or deployed probe, and the script turns it into a stable gate artifact.

The script does not create live cart mutations. Full automation needs account-cart fixture ownership, cleanup, and route selectors from the runtime/UI owner. Until that exists, this artifact is the privacy-safe handoff format for issue #1810 closeout evidence.

## Required Observation

Create a private observation JSON with only structural booleans and timings:

```json
{
  "strategy": "optimistic-with-correction",
  "strategyConfigured": true,
  "optimisticApplied": true,
  "reconciliationObserved": true,
  "staleResponseDiscarded": true,
  "rollbackObserved": true,
  "rollbackReasonCategory": "validation_conflict_probe",
  "latencyMs": 150,
  "reconciliationLatencyMs": 420,
  "staleResponseAgeMs": 75
}
```

Passing evidence must observe:

- `optimistic_applied`: the account cart shows the intended local state immediately after the write.
- `reconciliation`: the server-confirmed state replaces or confirms the local state.
- `stale_response_discard`: an older command/read response cannot overwrite a newer local or server-confirmed cart state.

Optional `rollback` evidence is allowed when it comes from an intentional validation/conflict probe. Set `unexpectedRollback: true` when rollback happened on the happy path; the canary aborts.

The canary aborts on `missing_strategy`, `freshness_timeout`, missing optimistic application, missing reconciliation, missing stale-response discard, unexpected rollback, or any sensitive value in the observation.

## Run

```powershell
node ./scripts/account-cart-consistency-canary.mjs `
  --observation-file artifacts/private/account-cart-observation.json `
  --out artifacts/release-health/account-cart-consistency.json `
  --environment staging `
  --release-commit <40-char-main-commit> `
  --evidence-reference STAGING-ACCOUNT-CART-CONSISTENCY-YYYY-MM-DD
```

The committed or PR-visible evidence should be the generated artifact or a summary of it, not the private observation if that observation was collected from a browser or production-like account. Use `--evidence-reference` to point to the private run record when needed.

## Privacy Rules

Allowed in the observation and generated evidence:

- Strategy name, route template, context/surface, outcome codes, boolean state, latency buckets or durations, rollback reason category, and an operator evidence reference.

Forbidden everywhere in canary input, output, logs, PR comments, and launch checklist evidence:

- Account ids, cart ids, user ids, emails, names, cookies, bearer tokens, session tokens, raw `afterWrite` values, event ids, checkout session ids, payment ids, order ids, full URLs, item details, provider payloads, or screenshots containing those values.

The script fails before writing output when the input contains common sensitive patterns. That is a guardrail, not permission to collect sensitive values and rely on detection. Collect structural evidence only.

## Telemetry Cross-Check

`@chase-sets/observability` exposes `chase_sets_post_write_consistency_events_total` with these labels:

- `type="post-write.consistency"`
- `context`
- `surface`
- `strategy`
- `outcome`
- `route_id`
- `route_template`
- `correction_source`
- `actor_mode`
- `recovery_action`
- `freshness_outcome`

For account cart, the expected low-cardinality label set is `context="checkout"`, `surface="account-cart"`, `route_id="account-cart"`, `route_template="/account/cart"`, `strategy="optimistic-with-correction"`, `correction_source="fresh-read:loader-revalidation"`, and outcomes from:

- `missing_strategy`
- `optimistic_applied`
- `freshness_timeout`
- `rollback`
- `reconciliation`
- `stale_response_discard`

Safe Prometheus check for release monitoring:

```promql
sum(rate(chase_sets_post_write_consistency_events_total{context="checkout",surface="account-cart",outcome=~"missing_strategy|freshness_timeout"}[15m]))
```

This query must remain zero. Do not add labels for account id, cart id, checkout session id, item id, event id, or full URL.
