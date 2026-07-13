# Account Cart Consistency Probe

## Purpose

Use `scripts/account-cart-consistency-probe.mjs` to record release evidence for account cart post-write consistency without storing account, cart, checkout, token, or URL identifiers. The script is intentionally a doc-backed observation probe: the Checkout/runtime owner supplies a redacted observation from a browser smoke, runtime test, or deployed probe, and the script turns it into a stable gate artifact.

The script does not create live cart mutations. Full automation needs account-cart fixture ownership, cleanup, and route selectors from the runtime/UI owner. Until that exists, this artifact is the privacy-safe handoff format for issue #1810 closeout evidence.

## Release gate wiring (#2516)

`.github/workflows/platform-production.yml` runs this probe as the "Staging account-cart freshness canary" step, right after the Buy Now freshness probes, in the `deploy-staging` job:

- When the `STAGING_ACCOUNT_CART_CANARY_OBSERVATION_JSON` repository/environment variable holds a redacted observation (the JSON shape documented below), the step runs the probe and **blocks staging promotion** if it does not promote — the same blocking behavior as the Buy Now probes.
- When that variable is unset, the step **does not block** the release (the probe still cannot self-drive an account-cart mutation), but it emits an explicit `::warning::` and step-summary note so the coverage gap stays visible instead of reading as a silent pass.

`scripts/release-health.mjs` records the outcome as `record.accountCartCanary` and a dedicated `account-cart-critical-canary` gate:

- `severity: "blocking"`, `status: "pass"|"fail"` when an observation was configured for the release.
- `severity: "advisory"`, `status: "warn"` when no observation was configured — this is the documented "release-health explicitly warns" posture required by issue #2516's acceptance criteria until the probe owns fixture-driven self-automation.

This closes the concrete release-gate promotion gap from #2516 for account cart. The remaining named canaries in that issue — Sell List, payout, and listing — already have advisory-level tracking through `scripts/read-consistency-route-matrix-evidence.mjs` and `scripts/release-health-report.mjs` (their `non-buy-now-post-write-freshness-uat/v1` and `read-consistency-route-matrix-evidence/v1` evidence classes), but promoting them to blocking per-release gates the way Buy Now and account-cart are gated needs a payout-ready, listing-owned staging persona that is not yet available (tracked under #2643 and #3321). Do not fabricate that state to force a green gate; keep those three as documented advisory coverage until the persona blocker closes.

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

Optional `rollback` evidence is allowed when it comes from an intentional validation/conflict probe. Set `unexpectedRollback: true` when rollback happened on the happy path; the probe aborts.

The probe aborts on `missing_strategy`, `freshness_timeout`, missing optimistic application, missing reconciliation, missing stale-response discard, unexpected rollback, or any sensitive value in the observation.

## Run

```powershell
node ./scripts/account-cart-consistency-probe.mjs `
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

Forbidden everywhere in probe input, output, logs, PR comments, and launch checklist evidence:

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

The add-to-cart View cart handoff uses the same metric family with `strategy="fresh-read"` and `correction_source="semantic-handoff:checkout.cart.add-line"`. Expected semantic outcomes are:

- `handoff_satisfied`
- `handoff_pending`
- `handoff_expired`
- `handoff_invalid`
- `handoff_malformed`
- `handoff_permanent`

Safe Prometheus check for release monitoring:

```promql
sum(rate(chase_sets_post_write_consistency_events_total{context="checkout",surface="account-cart",outcome=~"missing_strategy|freshness_timeout"}[15m]))
```

This query must remain zero. Do not add labels for account id, cart id, checkout session id, item id, event id, or full URL.
