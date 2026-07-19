# Push-Wake SLO And Load Proof

Status: living evidence record for #1237 (Milestone #19). Last consolidated: 2026-06-11.

This document consolidates the numeric SLO, load, and capacity evidence for the push-first projection runtime: what is ratified, what is interim, what live runs have proven, the analysis of the production proof-mode misses, and exactly what remains open. Threshold definitions live in [Projection Freshness SLOs](./projection-freshness-slos.md); segment ownership lives in the [Push-Wake Operations latency stage map](../runbooks/push-wake-operations.md); drills that produce recurring evidence live in [Push-Wake Recovery Drills](../runbooks/push-wake-recovery-drills.md).

## Evidence Ledger (live, dated)

| Evidence | Source | Result |
| --- | --- | --- |
| Staging write-to-checkout-ready, guest Buy Now | Platform Deploy run `27349556941` (2026-06-11), artifact `staging-buy-now-freshness-canaries`, correlation `github-27349556941-1-guest` | **1,158 ms** (`pass`, segments: write→redirect 1,134 / redirect→document 1 / document→ready 23) |
| Staging write-to-checkout-ready, account Buy Now | Same run, correlation `github-27349556941-1-account` | **4,774 ms** (`pass`, 202 document then ready; write→redirect 2,219 / document→ready 2,555; temporary recovery observed before ready) |
| Staging write-to-checkout-ready, guest / account | Platform Deploy run `27356677438` (2026-06-11), staging gate | **1,799 ms / 2,046 ms** (both `pass`, first attempt) |
| Staging gate posture | `.github/workflows/platform-production.yml` staging job | The 10,000 ms / 3-attempt write-to-checkout-ready gate is a release gate; **every deploy re-proves it** after a wake-runtime preflight and aborts promotion on failure |
| Staging push loop | Source-context wake registry (wave-1 `checkout`/`marketplace`/`ordering`/`payments`, wave-2 `catalog`/`identity`/`inventory`, and wave-3 `platform-operations`/`public-presence`/`settlement` = `staging-enabled`, emission + relay fan-out on) | `checkout` live since 2026-06-10 ~21:00 UTC; staging canary latencies above are push-accelerated checkout evidence. Wave-1 remainder enabled 2026-06-11 (with the #1224 migration inventory). `catalog` is staging-enabled for Source Observation import/review freshness; `identity` is staging-enabled for User presentation preference and account/security freshness; `inventory` is staging-enabled for reservation outcome and supply freshness; `settlement` is staging-enabled for payout-readiness projection freshness that gates seller checkout readiness; `platform-operations` is staging-enabled for platform feedback admin freshness; `public-presence` is staging-enabled for waitlist signup-to-admin-review freshness. |
| Production proof-mode canary | Run `27356677438`, attempts 1 and 2, correlations `github-27356677438-1-production-proof`, `github-27356677438-2-production-proof` | **Failed**: 3 attempts per run, all `temporary`, never pay-ready inside 10 s (analysis below) |
| Staging reconciliation drill (single write) | Run `27366542777` (2026-06-11), artifact `staging-wake-drill-reconciliation` | **1,067 ms** write-to-ready; relay cursor gap 0; durable convergence in 613 ms |
| Staging bounded burst drill (6 iterations × concurrency 2, same fixture) | Run `27366686651` (2026-06-11), artifact `staging-wake-drill-load` | All 6 writes `temporary`/`checkout-ready-slo-exceeded` (no per-write ready inside 10 s); **durable convergence 50.9 s** after the burst — relay cursor and all checkout checkpoints reached head, nothing lost. Worst-case contention shape: every iteration buys the same staging fixture item through the platform-wide single-flight checkout projection group. Current drill artifacts must record `loadReadinessDecision` when this accepted burst posture is used; warning-only readiness misses without that decision are not acceptable closure evidence. |
| Connection/capacity budgets | [Push-Wake Connection Budget](./push-wake-connection-budget.md) + Terraform plan-time checks `wake_connection_budget`, `wake_connection_budget_tier_upgrade_trigger`, `wake_listener_topology_parity` + CI-safe `pnpm run ops push-wake:capacity-evidence` | Staging steady-state 51/94, deploy overlap 62/94; production steady-state 38/94, deploy overlap 72/94. Production has one additional direct listener context before the 80% trigger; the remaining wave-2 direct LISTEN expansion, a 3rd `platform-api` instance, or a 2nd `platform-worker` instance requires `db-s-4vcpu-8gb` or production transaction pools first. |
| Captured load artifact evaluator | CI-safe `pnpm run ops push-wake:load-evidence -- --artifact <staging-wake-drill-load.json>` and the staging wake-drills workflow post-load step | No-secret budget gate for captured load artifacts (`push-wake-load-evidence/v1`). `bounded-staging` validates the current 6x2 bounded drill budget; `representative-volume` validates a stricter 12x4 artifact with wake-status snapshots. When intent breakdown rows are present, the evaluator attributes queued pressure to hot-lane versus standard/bulk/unknown lanes so support can distinguish checkout-route contention from background backlog. This creates repeatable pass/fail evidence from uploaded artifacts, but does not itself generate production-like volume. |
| Recovery/reconciliation drills | [Staging wake drills workflow](../runbooks/push-wake-recovery-drills.md) (`workflow_dispatch`) | Tooling live; produces dated convergence + bounded-burst evidence per dispatch |
| Checkout SLO Prometheus posture | Projection Freshness dashboard and the starter PromQL queries in [Observability](../runbooks/observability.md) | Observation-only posture over existing freshness wait, timeout-rate, and pending-lag metrics. Non-zero means at least one Checkout session freshness SLO clause failed in the review window; hard promotion still relies on the Buy Now canary and production proof gates until a new automated comparison policy is intentionally reintroduced. |

## Segment SLO Inventory

Classes: **ratified** (numeric gate enforced today; see Dual-SLO Ratification), **instrumented** (measured, alerting where noted, no numeric gate yet), **fallback-classed** (no push SLO; bounded by documented polling/replay), **not-instrumented** (gap).

| Segment (#1237 scope) | Class | Where measured / enforced |
| --- | --- | --- |
| Full write-to-ready, single write (Checkout hot path, guest + account) | **ratified: ≤ 10,000 ms per attempt, ≥ 1 pay-ready attempt in 3** (Dual-SLO Ratification below) | Deploy-gating canary; `readyLatencyMs` + browser segments in canary evidence; SLO doc canary row |
| Burst/saturation (concurrent writes into one projection group) | **ratified as durable convergence, not per-write readiness**: relay cursor + the active checkpoints required by the stimulated route dependency reach the event-store head within the poll-bounded drill budget (≤ 120 s default; drill-proven 50.9 s for the 6×2 worst case); for Buy Now this is `checkout.session-projection`, while unrelated checkpoint lag is diagnostic unless all-checkpoint mode is intentionally dispatched; per-write readiness is best-effort under group saturation | Staging wake drills `load` mode (exact-dependency convergence audit + per-iteration latencies); reconciliation drill on demand |
| API freshness wait (`outcome=fresh`) | **ratified: p95 ≤ 1,000 ms / p99 ≤ 2,250 ms (30 min rolling)**; timeout rate ≤ 0.1% | `read-after-write.freshness` audits; freshness audit runbook queries |
| Notification receipt (commit → notify) | instrumented | `chase_sets_projection_wake_notifications_total`, `chase_sets_projection_wake_notification_age_ms` (p95 panel) |
| Relay catch-up (restart/failover recovery) | instrumented | `chase_sets_projection_wake_relay_catch_up_duration_ms` / `_events_total`; takeover drill in recovery-drills runbook |
| Relay high-water lag (review-update segment) | instrumented + drill-audited | Wake panel cursor age; reconciliation drill `relayCursorGap` (fails on sustained gap) |
| Relay fan-out | instrumented + alerted | `chase_sets_projection_wake_relay_fan_out_total` failure-rate alert (`platform-worker-wake-alerts`) |
| Control-plane store enqueue/claim | instrumented | `chase_sets_projection_wake_intent_enqueue_outcomes_total` by enqueue outcome/lane/origin/routing mode; `chase_sets_projection_wake_intents_total` by scheduler outcome; intent processing p95 |
| Worker queue age (hot lane) | **alert-gated: hot-lane queue age p95 SLO alert** | `chase_sets_projection_wake_intent_queue_age_ms{priority_lane="hot"}` |
| Projection execution → checkpoint advance | instrumented + drill-audited | Projection group lag surfaces; reconciliation drill checkpoint gaps |
| Checkpoint readiness (persistence-to-wake) + waiter registration | instrumented | Wake-status `checkpointSignals` (readiness/waiter counts and ages) |
| Wake-before-wait enqueue latency | instrumented | `chase_sets_projection_freshness_wake_enqueue_duration_ms` by outcome/lane/route template/context/projection; `chase_sets_projection_freshness_work_signal_errors_total` remains the error-rate alert |
| API wait completion (route-wait) | **ratified per route**: checkout-session route budget 900 ms inside the 2,500 ms global timeout | Route tuning pinned in code; freshness audits |
| Durable job SSE wake/replay | fallback-classed | Replay from durable job-event rows; composite waiter with bounded polling fallback ([Work-Signal Composite](./work-signal-composite.md)) |
| Projection operation SSE wake/replay | fallback-classed | Same composite path; operator-class latency |
| Realtime SSE wake/replay | fallback-classed | Outbox-cursor replay; 1 s polling fallback where listeners are best-effort |
| Interest-index lookup time/staleness | partially instrumented | Index version per cursor + full summary (status, stale reason, generatedAt, disabled/opt-out counts) on worker status; no lookup-latency metric — accepted gap (in-memory map) |
| Safe over-wake rate | instrumented | `chase_sets_projection_wake_intent_enqueue_outcomes_total` with `routing_mode=safe_over_wake`; raw additive routing hints are not stored |
| Cleanup lag | instrumented | `work-signals.cleanup.completed` logs + expired counts on wake-status; observation drill 10 |
| Provider outbox enqueue-to-claim / claim-to-dispatch / retry / terminal recording | fallback-classed, **excluded from push-first SLO gates** | Scheduled/poll dispatchers over durable outbox rows (documented exception in the composite origin inventory); recovery drill 9 |

Class separation (#1237 scope): Checkout/payment hot paths carry the ratified gates above; other read-after-write routes inherit the flow-class table in the SLO doc; operator durable jobs / projection operations and background projections are operator-class (bounded, no customer gate); realtime user-visible updates are fallback-classed pending composite load proof.

## Production Proof-Mode Miss Analysis (2026-06-11 addendum)

Required by the #1237 addendum: analyze `github-27356677438-1-production-proof` and `github-27356677438-2-production-proof`.

**Observed** (artifacts `production-release-health` for run `27356677438` attempts 1-2): both proof canaries ran the account flow against the proof marketplace host minutes after the production rollout started (attempt 1: deploy 15:19:01Z, canary 15:25:42-15:26:48Z; attempt 2: deploy 15:30:51Z, canary 15:35:01-15:36:14Z). All 3 attempts in each run ended `temporary` with `checkout-ready-slo-exceeded`: the checkout document returned 202 with preparing-checkout recovery and never became pay-ready inside 10 s. Handoff was intact (receipt + session cookie), the negative invalid-session probe passed (404 + permanent recovery), and `writeToRedirectMs` was 3,623 ms / 3,071 ms (vs 1,769-2,219 ms staging same release) — the write committed; the page redirect was slow but inside budget.

**Segment determination**:

- *Relay, control-plane store, worker wake claim*: **structurally excluded.** Production runs with `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED=false`, `WORKER_PROJECTION_WAKE_RELAY_ENABLED=false`, `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED=false` (Terraform locals; rollout-controls runbook). No push segment participated.
- *Route wait*: behaved as designed — bounded 900 ms route budget expired and Checkout-owned temporary recovery rendered (202). Not the cause.
- *Fixture/data shape*: excluded — the proof fixture produced a valid checkout session, receipt, and recovery; the same release passed staging canaries within ~2 s.
- *Remaining candidate*: **`checkout.session-projection` checkpoint advance under polling-only production posture in the post-deploy window.** Production runs 1 worker instance (projection concurrency 1) with a 1 s poll interval; both canary windows sat 4-7 minutes after a production rollout began, inside the rolling-deploy overlap where workers restart and re-acquire leases. A checkpoint older than 10+ s across 3 attempts in both windows means projection execution was not draining within budget at that time.

**What the artifacts cannot decide**: whether the lag was post-deploy cold start/lease re-acquisition (transient) or sustained production worker under-capacity. Splitting them requires the production window telemetry: `read-after-write.freshness` timeout-rate for the route around 15:25-15:37Z, `checkout.session-projection` checkpoint-age series, and worker heartbeat/lease timelines (Projection Wake Pipeline dashboard + projection console). The elevated `writeToRedirectMs` on both runs is consistent with general post-deploy cold start.

**Recommended action set (for #1237 closure to ratify)**:

1. **Rollout hold stands** (the gate already enforces it): no production proof pass, no public Buy Now exposure — correct behavior, not a gate defect.
2. **Post-deploy readiness gate before the proof canary** — **delivered**: the production deploy job now runs `scripts/production-readiness-gate.mjs` after the smoke check and before the Stage 1 and proof canaries, polling until the audited contexts' projection checkpoints reach the event-store head or a bounded budget (default 5 min, `PRODUCTION_READINESS_GATE_BUDGET_MS`) expires. Warn-and-proceed by design: a `budget-expired` outcome is recorded in the step summary and the `production-readiness-gate.json` release-health artifact, and the canary then measures (and reports) post-deploy catch-up honestly — the proof canary remains the promotion gate. This removes the dominant cold-start confound from the miss analysis.
3. **Capacity review** per [Projection Freshness Worker Capacity](./projection-freshness-worker-capacity.md) if a steady-state rerun still misses: raise `worker_instance_count`/concurrency for production only with a matching profile-aware connection-budget update and release-health evidence.
4. **Priority-lane reservation / push enablement in production proof** (`checkout` registry `production-proof` + relay/emission switches) only after 2-3 fail to produce a pass — the budget already reserves listener headroom for it.
5. If the steady-state rerun passes, record the cold-start window as a **documented launch posture note** (proof canary measures steady state; deploys briefly degrade to >10 s readiness with safe temporary recovery), not a launch blocker. A persistent steady-state miss instead requires scale-up before launch-enable; "launch-disabled/deferred" stays the posture meanwhile.

Cross-link requirement: this analysis must be referenced from #1123 and #1116 before the Shopify-simple checkout launch closes (issue-side action when this evidence is posted).

## Load Proof: Delivered Vs Deferred

**Delivered now** (bounded, staging): the `load` mode of the [staging wake drills workflow](../runbooks/push-wake-recovery-drills.md) — up to 12 canary iterations at concurrency ≤ 4 through the real deployed write path, reporting write-to-ready min/p50/p95/max, readiness pass rate, and post-burst durable convergence (relay cursor + gated checkpoints). Covers the "guest Buy Now spike (small burst)" and "repeated user refreshes" shapes at bounded scale, plus relay reconnect/catch-up when combined with drill 6. The workflow now also runs `push-wake-load-evidence/v1`, a no-secret evaluator for the captured artifact. Its `bounded-staging` profile guards the current drill budget in CI; its `representative-volume` profile is available when an operator intentionally dispatches the hard-cap artifact shape and needs a repeatable budget verdict. Both profiles include support-safe wake-pressure attribution when wake-status intent breakdown rows are present, distinguishing hot-lane contention from standard/bulk/background queueing.

**Deferred (recorded ownership)** — production-like topology and representative volume load proof. #1237 closes with this scope explicitly deferred: per the milestone anti-ratchet rule, each line below that becomes actionable gets its own fixed-scope issue (the milestone-closure review owns spawning them); none blocks the ratified dual SLOs, which gate on staging release evidence plus bounded drills:

- Control-plane wake store under sustained write/claim load: indexed claim query shape is verified by tests and the EXPLAIN tooling (`scripts/explain-event-projection-backlog.mjs` pattern), but upsert-rate/lock-contention/table-growth/backpressure numbers under volume are unmeasured.
- Composite origin load (durable job events, projection operation events, realtime outbox wake/replay, scheduled/manual triggers, combined listener connection usage) — Phase 2 scope; adapters are live but unloaded.
- Provider-outbox load (claim query shape, retry rate, provider latency budget, worker capacity) — excluded from push-first gates (documented exception) but still owed a dispatch-volume proof.
- Burst scenarios at production scale: background projection backlog, rolling-deploy overlap under load, relay reconnect under high-volume commits.
- Production proof mode rerun with measured notifications/relay/fan-out/claims/waits (action 2-4 above).
- CI-safe connection budget evidence for #1363/#1364 now exists (`push-wake-capacity-evidence/v1`), but it is not a production-like volume load proof. It records a current production overlap envelope of `58/94`; the wave-2 direct-listener proposal raises it to `64/94`, below both the hard limit and the `75/94` tier trigger.
- CI-safe captured-artifact evaluation now exists (`push-wake-load-evidence/v1`), but it validates only the uploaded artifact against declared budgets. It does not create volume, broaden staging data shape, or prove production steady-state capacity by itself.

Path: extend the drill workflow's load mode (synthetic event generators per source context, off the customer path) or accept a dedicated load environment; either needs an owner decision on staging data hygiene before iterations are raised above the current caps. Until that work lands, "production-like volume" evidence does not exist and this document says so; any future SLO tightening must wait for it.

## Rollout Gates By Segment

| Failing signal | Required action |
| --- | --- |
| Staging canary write-to-ready gate (any flow) | Promotion aborts automatically (release gate); diagnose via canary runbook segment correlation |
| Production proof canary | Release not marked; rollout hold + addendum action set above |
| API freshness p95/p99 or timeout-rate | Hold rollout expansion; worker capacity review before any threshold change |
| Hot-lane queue age p95 alert | Scale wake lane consumers / check control-plane DB pressure; fallback-only mode (disable wake origins) if store is the bottleneck |
| Relay fan-out failure-rate alert | Source-context disablement (registry) for envelope bugs; relay disable (env switch) for store-side failures — polling owns freshness meanwhile |
| Reconciliation drill non-convergence | P1 wake-pipeline incident; kill-switch rollback recipes; canary must stay green on polling before closing |
| Connection-budget plan check | Blocks the Terraform change outright (cannot deploy an over-budget topology) |

## Phase Mapping (#1249)

- **Phase 1 (Checkout hot path)**: staging proof complete and continuously re-proven (gate + drills); production proof **open** on the addendum analysis. Phase 1 closure needs a green steady-state production proof run (or a ratified launch-posture note per action 5).
- **Phase 2 (composite migration)**: durable-job/realtime/projection-operation origins ride the composite with fallback classes; their load proof is deferred (above). Phase 1 evidence must not be cited as Phase 2 proof.
- **Phase 3 (expansion/closure)**: combined-origin load, non-Checkout route validation, and recurring drills (now tooled) gate closure.

## Dual-SLO Ratification (#1237, 2026-06-11)

The burst drill made the single-write and saturation regimes numerically distinct, so #1237 ratifies them as **two separate SLOs** rather than one conflated number:

1. **Single-write checkout ready SLO — ratified: ≤ 10,000 ms write-to-checkout-ready per attempt, ≥ 1 pay-ready attempt in 3 (guest and account Buy Now).** Staging-proven at 1,158-4,774 ms across the gating runs (worst observed account-flow 4,774 ms ≈ 2.1× headroom); enforced on every deploy; it has caught a real production regression (the proof miss above), which is exactly the behavior a gate value must demonstrate. Do not tighten yet: account-flow variance (4,774 vs 2,046 ms across consecutive runs) is too wide for a 5 s gate — revisit per the SLO doc review cadence with the 10-successful-runs window plus load-drill p95 series.
2. **Burst/saturation SLO — ratified as durable convergence, not per-write readiness.** When concurrent writes saturate one projection group, the contract is: relay cursor and the active projection checkpoints required by the stimulated route dependency reach the event-store head within the poll-bounded drill budget (default 120 s; drill-proven **50.9 s** for the 6-iteration × concurrency-2 worst-case same-fixture burst, run `27366686651`), with zero lost writes. For Buy Now, the gated checkpoint is `checkout.session-projection`; unrelated cart or sell-list checkpoint lag is diagnostic unless the operator explicitly dispatches all-checkpoint convergence. Per-write readiness under group saturation is explicitly **best-effort** per the latency-hint contract (wakes accelerate, durable polling bounds): projection groups are platform-wide single-flight by design — one fenced lease per group serializes concurrent session writes behind one runner, bounding per-group throughput in exchange for ordering and correctness (correctness over parallelism). A burst that degrades per-write readiness while converging durably inside the budget **meets** this SLO; non-convergence within the gated scope is a P1 wake-pipeline incident (reconciliation drill row in the gate table).

Supporting decisions:

- **API freshness p95/p99 thresholds stay ratified** (unchanged from the SLO doc; staging audits hold under push acceleration).
- **Numeric per-segment SLOs (notify/relay/store/claim) stay instrumented-not-gated** until the deferred load proof produces distributions worth gating on; gating on unloaded numbers would ratify noise.
- **Capacity levers for the burst regime (recorded baseline: the 6x2 finding)**: production `worker_instance_count` / wake-lane runner counts with a matching profile-aware connection-budget update, projection-group optimization per [Projection Freshness Worker Capacity](./projection-freshness-worker-capacity.md), and, as the future structural lever, per-group sharding of single-flight projection groups, which requires its own design issue before any burst-SLO tightening. Expected concurrent checkout volume at public launch must be reviewed against this baseline before push enablement raises traffic expectations.

## Honest Gaps

- Production-like volume load proof: not done (deferred scope above, with owners/path recorded there). The dual SLOs above are ratified on staging gate evidence plus bounded drills; production-scale distributions may justify revisiting the numbers but do not block the ratified values from gating today.
- Safe over-wake is measured as a bounded routing-mode classification on enqueue outcomes; per-payload attribution remains intentionally unavailable.
- Wake-before-wait enqueue latency and interest-index lookup latency now have histograms; the remaining open reporting gap is sustained-window automation and release-health comparison, not raw segment emission.
- Staging wake drill artifacts now include `segmentSlo` summaries for browser-visible canary segments, scoped durable convergence, and metric gaps. Missing checkout-ready observations remain unmeasured rather than zero-latency. Load artifacts that miss per-write readiness must also include `loadReadinessDecision` naming the accepted burst/saturation SLO; server-side notify/relay/store/claim distributions are still joined through Grafana by the drill/canary correlation window rather than embedded in the artifact.
- Sustained-observation windows (30-day p95 by segment) have no automated reporting; dashboards exist, reporting is manual.
- Production proof miss root cause is localized to projection execution under polling in the post-deploy window but not split between cold start and capacity without the production telemetry pull named above. The post-deploy readiness gate (delivered, action 2) splits the regimes going forward: a `ready` gate outcome followed by a canary miss is a steady-state capacity signal, not cold start.
