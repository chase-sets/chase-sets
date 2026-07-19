# Guest Buy Now Freshness Probe

This runbook owns the synthetic Buy Now → Checkout readiness probe for the projection freshness contract. It is the symptom-level guard for the checkout failure where a shopper reached `/checkout/buy/session/:sessionId` before `checkout_session_pages` caught up and either saw permanent checkout-session-not-found recovery or waited well past the readiness budget (the original staging incident exceeded 15 seconds). Issue #1227 tightened this probe into a release gate for the push-first projection rollout (Milestone #19).

## Gate

The staging deployment workflow runs both flows against the deployed staging marketplace:

```powershell
# Guest flow (signed-out Buy Now, guest contact handoff)
pnpm run guest-buy-now:freshness-probe -- --flow guest --environment staging --base-url https://marketplace.staging.chasesets.com --admin-base-url https://admin.staging.chasesets.com --search-query "air balloon" --fixture-key <fixture-key> --guest-email <probe-namespace-email> --ready-slo-ms 10000 --attempts 3

# Account flow (signed-in Buy Now direct to checkout session)
pnpm run guest-buy-now:freshness-probe -- --flow account --environment staging --base-url https://marketplace.staging.chasesets.com --admin-base-url https://admin.staging.chasesets.com --search-query "air balloon" --fixture-key <fixture-key> --ready-slo-ms 10000 --attempts 3
```

Before a staging probe opens the marketplace page, it authenticates to the admin host and polls `GET /api/platform/projections/wake-status` until wake runtime is capable of servicing fresh writes: at least one active wake-capable worker and an active projection-wake relay lease. If that preflight does not become ready within the budget, the probe writes evidence with `failureReason: "wake-runtime-not-ready-before-probe"` and `attemptCount: 0` instead of creating a misleading checkout readiness miss. Local ad hoc probes can omit `--admin-base-url`; those artifacts record no preflight and must not be used to close post-deploy wake-readiness blockers.

The gate promotes only when, for each flow, at least one attempt reaches a pay-ready checkout (Continue to payment / Checkout Summary / Payable total) within the readiness SLO budget **and** the negative invalid-session probe shows permanent recovery. Temporary preparing-checkout recovery is still the user-safe state, but it does not promote by itself: a run that stays temporary past the budget records `checkout-ready-slo-exceeded`.

Until the #1237 numeric SLO/load proof ratifies the budget, `checkout-ready-slo-exceeded` with a user-safe final state (`pass` beyond SLO, or `temporary`) **warns instead of aborting** (issue #1323): the probe exits `0`, records `promotionDecision: "warn"` in evidence and release health, and the release proceeds. Unsafe states (permanent not-found, missing receipt/cookie, platform error page, undetected checkout state, negative-probe failures) always abort. Set `--slo-mode gate` (`GUEST_BUY_NOW_PROBE_SLO_MODE=gate`, sourced from the `GUEST_BUY_NOW_CANARY_SLO_MODE` repo Actions variable) to restore hard SLO gating once the budget is ratified.

- `--ready-slo-ms` (`GUEST_BUY_NOW_PROBE_READY_SLO_MS`, default `10000`): per-attempt write-to-checkout-ready budget, the ratified #1237 single-write SLO; see [Projection Freshness SLOs](../architecture/projection-freshness-slos.md).
- `--slo-mode` (`GUEST_BUY_NOW_PROBE_SLO_MODE`, default `warn`): `warn` records SLO breaches with user-safe states as release-health warnings without blocking; `gate` aborts the release on any SLO breach.
- `--attempts` (`GUEST_BUY_NOW_PROBE_ATTEMPTS`, default `1`; the workflow passes `3`): `checkout-ready-slo-exceeded`, controlled `browser-navigation-timeout`, and transient 5xx setup outcomes are retried, matching the rollout decision to hold after repeated live-readiness misses instead of a single flaky browser or platform edge sample. Hard failures (permanent not-found, missing receipt/cookie, platform error page, non-5xx auth/setup failures, negative-probe failures) abort immediately without retry.
- `--admin-base-url` (`GUEST_BUY_NOW_PROBE_ADMIN_BASE_URL`): enables wake-runtime preflight. Requires `PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD` or the probe-specific admin credential variables.
- `--wake-runtime-ready-budget-ms` / `--wake-runtime-ready-poll-interval-ms` (`GUEST_BUY_NOW_PROBE_WAKE_RUNTIME_READY_BUDGET_MS`, default `120000`; `GUEST_BUY_NOW_PROBE_WAKE_RUNTIME_READY_POLL_INTERVAL_MS`, default `5000`): post-deploy wake-runtime preflight budget before the probe writes.

The workflow discovers active buyable item candidates from `/api/marketplace/items?search=<query>&includeTotal=true`, pins exact listing ids in the item detail route, and skips checkout-start recovery candidates when the selected listing is not checkout-ready. The staging workflow search query defaults to `STAGING_GUEST_BUY_NOW_CANARY_SEARCH_QUERY`, then `air balloon`, so the Buy Now gate stays tied to an active checkout-ready fixture instead of the broader marketplace E2E search term. `STAGING_GUEST_BUY_NOW_CANARY_ITEM_PATH` is an optional override for a known checkout-ready item detail route. The fixture key defaults to `staging-guest-buy-now-fixture` but should be set to a stable operator-owned identifier when staging representative commerce state is refreshed. In the account flow, fixture discovery runs through the signed-in browser session and prefilters candidates with Ordering checkout preview, so it also works on hosts that gate the marketplace API behind sign-in.

### Flows

| Flow | Identity | Handoff checks |
| --- | --- | --- |
| `guest` | Guest contact form on `/checkout/buy/readiness`; probe-namespaced email | `afterWrite` receipt plus `chase_sets_guest_checkout` cookie |
| `account` | On staging, a run-unique synthetic `buy-now-probe+account-*@chasesets.test` account provisioned through the platform-admin invitation path. Direct callers may explicitly provide `GUEST_BUY_NOW_PROBE_ACCOUNT_EMAIL`/`PASSWORD`; production proof requires those dedicated credentials. | `afterWrite` receipt plus `chase_sets_session` cookie; signed-in Buy Now redirects straight to `/checkout/buy/session/:sessionId` |

The browser probe follows the current fresh-state routes: signed-out Buy Now opens `/checkout/buy/readiness`, guest contact submission redirects to `/checkout/buy/session/:sessionId`, and signed-in Buy Now redirects directly to `/checkout/buy/session/:sessionId`. Item-page and route-transition waits stop at browser commit; checkout document readiness is then measured separately, so a slow document load is recorded in the document/readiness segment instead of being collapsed into route navigation.

## States And Gate Decisions

The probe uses the shared Checkout state model with the tightened #1227 gate:

| State | Gate result | Meaning |
| --- | --- | --- |
| `pass` within SLO | Promote | Checkout review reached a payable state inside the readiness budget with receipt and cookie handoff intact. |
| `pass` beyond SLO | Warn in `slo-mode=warn` (default), abort in `gate` (`checkout-ready-slo-exceeded`) | Checkout eventually became payable but slower than the ratified single-write readiness SLO. |
| `temporary` without pay-ready | Warn in `slo-mode=warn` (default), abort in `gate` (`checkout-ready-slo-exceeded`) | Fresh receipt valid and recovery user-safe, but the page never became pay-ready inside the budget. |
| `fail` | Abort | Checkout start recovery (`checkout-start-recovery-visible`), permanent checkout-session-not-found, lost receipt/cookie handoff, platform error page, or no recognizable checkout state. |
| any non-abort state + failed negative probe | Abort (`negative-probe-*`) | Recovery is masking real errors; see below. Probe failures override SLO warnings. |

Exit codes: `0` promote or warn (warning logged and recorded in evidence), `1` abort with evidence written, `2` configuration error or unexpected script failure before the probe can build evidence. Controlled browser navigation/load timeouts are probe failures, not blind runtime exits: they record `failureReason: "browser-navigation-timeout"`, include a redacted `runtimeFailure` stage/message, skip the negative probe, and retry within the configured attempt budget before failing closed. Transient 5xx account setup failures record `platform-temporary-unavailable` and use the same bounded retry policy.

## Negative Invalid-Session Probe

After the main flow, the probe navigates the same browser context to a synthetic unknown checkout session id with no `afterWrite` receipt and requires a **permanent** recovery state — `Checkout access required` (401) or `Checkout session not found` — with a non-5xx document. This proves the #1226 recovery path distinguishes true invalid checkout sessions from projection readiness delays:

- `negative-probe-masked-invalid-session`: the invalid session rendered preparing-checkout recovery or checkout review. Recovery is hiding real errors; block promotion and treat as a Checkout recovery regression.
- `negative-probe-platform-error`: the invalid session surfaced the platform 5xx wrapper instead of Checkout-owned recovery.
- `negative-probe-unexpected-state`: no recognizable recovery state rendered.

`--skip-negative-probe` (`GUEST_BUY_NOW_PROBE_SKIP_NEGATIVE_PROBE=true`) disables the probe for local debugging only; the deploy gate always runs it. Expired-token negative coverage stays with the deterministic #1074 integration suite — a live probe cannot wait out token expiry, so the probe covers the invalid-session symptom class.

## Redacted Evidence

The script writes one evidence file per flow (`artifacts/release-health/guest-buy-now-freshness-probe.json`, `account-buy-now-freshness-probe.json`, and `production-proof-buy-now-freshness-probe.json` in proof mode) with:

- schema version (`guest-buy-now-freshness-probe/v2`), checked timestamp, environment, flow, fixture key;
- diagnostic correlation id (the join key for server-side segment metrics);
- final state, promotion decision, failure reason, attempt count, per-attempt summaries;
- readiness SLO budget and write-to-checkout-ready latency;
- `wakeRuntimePreflight`, when the probe has admin wake-status access: initial/final worker count, relay lease state/owner, relay lease renewal/expiry timestamps, the relay owner's matching worker heartbeat state when present, readiness reasons, sample count, and time to ready;
- browser-measured segments: write→redirect, redirect→document, document→ready, write→ready;
- redacted browser runtime failure stage/message when navigation or load timeouts prevent a normal observation;
- `segmentReferences` naming the #1228 server-side segments (commit-to-notify, notify-to-relay, relay-to-control-plane-store, control-plane-claim-to-worker, checkpoint-readiness, route-wait) and where to join them;
- wait mode when visible, checkout document status, known-state wait outcome;
- negative probe outcome and document status;
- booleans for `afterWrite`, guest/session cookies, checkout-start recovery, permanent not-found, temporary recovery (final and observed-at-any-point), checkout review visibility, and the platform generic error wrapper.

The evidence must not contain guest email, contact name, guest token, account email/password, session token, cookie values, raw `afterWrite`, checkout session ids, account/user ids, event ids, or full URLs. The script fails closed if redaction guards detect a leak.

## Segment Correlation (#1228)

The probe measures the browser-visible segments directly and links the server-side wake pipeline segments by correlation id instead of scraping `security.manage` admin APIs:

1. Take `diagnosticCorrelationId` from the evidence (the workflow uses `github-<run>-<attempt>-<flow>`).
2. Route wait segment: query `read-after-write.freshness` audit records for `/account/checkout-sessions/:sessionId` (see [Projection Freshness Audit](./projection-freshness-audit.md)) in the probe window.
3. Relay, control-plane store, and worker segments: use the Grafana **Projection Wake Pipeline** dashboard (`chase-sets-projection-wake-pipeline`) and `GET /api/platform/projections/wake-status` for the same window; the [Push-Wake Operations](./push-wake-operations.md) latency stage map says which component owns each segment.
4. A failed gate plus healthy wake segments points at projection execution or route wiring; a failed gate plus a stalled wake segment points at the relay/store/scheduler stage named by the dashboard.

## Fixture Ownership

- Operations owns the staging fixture search contract through `STAGING_GUEST_BUY_NOW_CANARY_SEARCH_QUERY`, with `STAGING_GUEST_BUY_NOW_CANARY_ITEM_PATH` available only for deliberate path pinning.
- The resolved fixture must be an item detail route with Buy Now available to signed-out shoppers (guest flow), signed-in shoppers (account flow), and Ordering-preview checkout-ready supply for the selected listing.
- Representative commerce state refreshes must preserve at least one active buyable item for the probe search query or intentionally update the query and fixture key together.
- If discovery or the pinned fixture is unavailable, the probe fails closed. Fix representative marketplace state or update the query/path variable before promoting.

## Guest Data And Side Effects

- The workflow uses `guest-buy-now-probe+<run>-<attempt>@chasesets.test` for the guest flow and a synthetic `buy-now-probe+account-*@chasesets.test` registration for the staging account flow. It deliberately omits the broad deployed E2E actor credentials so advisory and blocking jobs never mutate the same actor concurrently.
- Guest checkout token/session cleanup is TTL-based unless an environment cleanup hook exists; probe-created checkout sessions for the account flow rely on the same TTL/abandonment semantics.
- The probe stops at checkout review or temporary preparing-checkout recovery, in every environment and flow.
- The probe must never click checkout confirmation, create payment intents, create orders, reserve inventory beyond normal checkout preview semantics, or trigger customer-visible fulfillment work. The negative probe only loads an unknown session id and creates nothing.

## Production Decision (Proof Mode)

A public production guest browser probe remains not feasible: it would create persistent guest checkout artifacts without a cleanup contract. The production evidence path required by #1227 is the **authenticated proof-mode probe**:

- Runs only when `PRODUCTION_MARKETPLACE_PROOF_ENABLED=true` (the proof marketplace host is gated by sign-in plus `security.manage`; see [Marketplace Production Promotion](./marketplace-production-promotion.md)).
- Requires operator credentials and the approved proof reference (`PRODUCTION_MARKETPLACE_PROOF_REFERENCE`); the workflow reads dedicated `PRODUCTION_PROOF_CANARY_EMAIL`/`PRODUCTION_PROOF_CANARY_PASSWORD` secrets first and falls back to the existing required `PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD` secret pair while launch proof accounts are being separated. The script rejects `--environment production` outright and rejects proof mode without the account flow, credentials, and reference.
- Uses the same logical topology as staging: same script, same readiness SLO and attempt budget, same negative probe, same evidence schema — only credentials and rollout flags differ.
- A failing proof-mode probe fails the Deploy Production job before the release is marked, so the production branch and release tag do not advance.

## Release Gates, Rollback Decisions, And Checklists

- **Staging promotion gate**: both staging flows must promote before the Deploy Production job runs; evidence uploads as the `staging-buy-now-freshness-probes` artifact (30-day retention) and the job summary records state, decision, failure reason, ready latency, and correlation ids. The staging probe result and promotion decision flow into the staging release-health record.
- **Production promotion gate**: with proof mode enabled, the proof-mode probe must promote before the release is marked; its result folds into the production release-health `CANARY_RESULT`/`CANARY_PROMOTION_DECISION` and uploads with `production-release-health`.
- **Rollback decisions**: after any push-wake kill switch or rollback flip, rerun this probe as the read-after-write invariant check ([Push-Wake Rollout Controls](./push-wake-rollout-controls.md)); after an emergency rollback deploy, a passing probe on the rolled-back build is the recovery proof ([Push-Wake Operations](./push-wake-operations.md) checkout triage step 5).
- **Release checklists**: the [deployment runbook](./digitalocean-platform-deployment.md) step list includes both staging probes and the proof-mode probe; do not mark a Milestone #19 rollout expansion complete without a passing probe run recorded in release health.

## Failure Triage

1. Inspect the probe evidence final state, failure reason, attempt summaries, and segments.
2. If `wake-runtime-not-ready-before-probe`, inspect `wakeRuntimePreflight.final.reasons` and the wake-status endpoint. `no-active-wake-capable-workers` points at worker deployment/lease hygiene; `projection-wake-relay-lease-not-active` points at relay takeover or startup lag; `projection-wake-relay-owner-not-renewing-lease` means the relay owner was still heartbeating while the lease was expired; `projection-wake-relay-owner-heartbeat-not-active` means the relay owner's heartbeat had already gone stale or expired. Rerun after the runtime is active before treating checkout readiness as the root cause.
3. If `missing-after-write`, `missing-guest-cookie`, or `missing-session-cookie`, check Checkout guest/account start and document redirect behavior.
4. If `permanent-checkout-session-not-found`, check API freshness middleware, `checkout.session-projection`, worker lag, and the Checkout temporary recovery path. This is the original incident class; treat as P1 and block promotion.
5. If `checkout-ready-slo-exceeded`, first verify `wakeRuntimePreflight.ready === true` when present. Then localize the slow segment: browser segments in the evidence first, then the [Push-Wake Operations](./push-wake-operations.md) latency stage map joined by correlation id. Repeated staging occurrences require a `checkout.session-projection` lag and worker capacity review before promotion.
6. If `negative-probe-masked-invalid-session`, the recovery route is hiding real errors behind preparing-checkout; treat as a Checkout recovery regression and block promotion.
7. If fixture discovery reports no active buyable item, refresh representative commerce state or update `STAGING_GUEST_BUY_NOW_CANARY_SEARCH_QUERY`.
8. If `platform-error-page-detected` or `negative-probe-platform-error`, check whether ingress or a customer-facing checkout recovery is returning a generic 5xx document. Temporary checkout recovery should render with a non-5xx document status while internal API freshness timeouts can remain 503 JSON.
9. If `checkout-start-recovery-visible`, the checkout start route rendered its own recovery before creating a session. Check the resolved fixture first: a stale or checkout-unsafe active listing can keep the probe on `/checkout/buy/readiness` with "Checkout needs attention" instead of redirecting. Treat this as a fixture/supply readiness blocker, not a browser wait failure.
10. If `browser-navigation-timeout`, inspect `runtimeFailure.stage` first. `wait-guest-buy-readiness` points at Buy Now routing from item detail to `/checkout/buy/readiness`; `wait-buy-checkout-session` points at checkout session creation/redirect to `/checkout/buy/session/:sessionId`; `load-buy-now-item-page` points at marketplace item detail availability or edge latency. The runtime message is redacted, so use the correlation id and Playwright artifacts rather than raw URLs.
11. If `checkout-review-state-not-detected`, confirm the resolved fixture still exposes Buy Now and reaches checkout review copy.
12. Correlate the diagnostic id with read-after-write freshness audit records, the projection wake pipeline dashboard, and projection operations.
