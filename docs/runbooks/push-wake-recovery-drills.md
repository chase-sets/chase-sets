# Push-Wake Recovery Drills

Disaster-recovery and reconciliation drills for the push-first projection runtime (Milestone #19, #1234). This runbook owns the drill catalog: which drills run on demand from GitHub Actions, which require an operator session, exactly how to run each one, and what evidence each run must produce. Incident diagnosis lives in [Push-Wake Operations](./push-wake-operations.md); kill switches live in [Push-Wake Rollout Controls](./push-wake-rollout-controls.md).

## Operating Invariant

Every drill verifies the same contract: no wake-path failure loses data or permanently stalls projections. Durable event-store rows, projection checkpoints, the durable control-plane wake store, durable job/event rows, realtime outboxes, and provider-delivery outbox rows are the source of truth; `pg_notify` is an accelerator. A passing drill proves the durable surfaces reconverge without manual repair; a failing drill is a P1 against the wake pipeline, not a data-loss event.

## The Drill Workflow

`Platform Staging Wake Drills` (`.github/workflows/platform-staging-wake-drills.yml`, `workflow_dispatch`) runs the executable drills against deployed staging with the same credentials the staging operational workflows already hold (Terraform-state database URLs, staging marketplace/admin domains, platform admin credentials for wake-status snapshots). It wraps `pnpm run wake:drills` (`scripts/staging-wake-drills.mjs`, unit-tested by `scripts/staging-wake-drills.test.mjs`).

What the `reconciliation` drill does:

1. Snapshots `GET /api/platform/projections/wake-status` (admin credentials, structural fields only).
2. Generates one synthetic guest Buy Now write via the existing [freshness probe](./guest-buy-now-freshness-probe.md) (same no-payment/no-order safety rules; `--skip-canary-write` audits without a stimulus).
3. Audits durable positions until convergence or budget exhaustion, per staging-enabled source context:
   - event-store head: `MAX(global_position)` of `event_store_events` for the source context;
   - relay high-water cursor: `platform_projection_wake_relay_cursors.last_fanout_position` (control database);
   - projection checkpoints: `event_subscription_checkpoints.last_global_position` rows for that source context (highest subscription version per projection).
4. Re-snapshots wake-status, writes redacted evidence JSON (`staging-wake-drills/v1`), uploads it as a run artifact, and fails the run if the cursor or any checkpoint stays behind the head past the budget (default 120 s, poll every 5 s).

This is the #1234 review-update reconciliation gate made executable: a missed relay fan-out shows up as `relay-cursor-behind-event-store-head` even when no fresh notification arrives, and a missed projection wake shows up as `projection-checkpoint-behind-event-store-head` (fallback polling should close that gap in seconds, so a sustained gap is a real failure).

Each evidence artifact also includes `segmentSlo`: browser-visible canary segment summaries (`writeToRedirectMs`, `redirectToDocumentMs`, `documentToReadyMs`, `writeToCheckoutReadyMs`), durable convergence posture by source context, and the current metric gaps. Unmeasured readiness segments stay `null`/`not measured`; a missing checkout-ready observation must never be read as zero latency. The artifact intentionally keeps server-side notify/relay/store/claim distributions out of the JSON until those histograms exist; join those stages in Grafana by the drill correlation window.

What the `load` drill adds: a bounded synthetic burst (iterations hard-capped at 12, concurrency hard-capped at 4, guest or account flow) through the same canary machinery, followed by the same convergence audit, reporting write-to-checkout-ready min/p50/p95/max and readiness pass rate. If any load iteration misses the checkout-ready budget, the artifact records `loadReadinessDecision` with the ratified burst/saturation decision from the SLO document; without that explicit decision the captured-artifact evaluator fails the load evidence. This is bounded staging burst evidence for #1237 — explicitly not a production-like volume load test.

After every `load` drill, the workflow runs the no-secret artifact evaluator (`pnpm run ops push-wake:load-evidence`) against the captured JSON and uploads `staging-wake-drill-load-evaluation.json`. The default `bounded-staging` profile checks the current bounded drill budget: at least 6 iterations, concurrency at least 2, zero config errors, every iteration producing evidence, durable convergence inside 120 seconds, no checkout relay/checkpoint gap, an explicit accepted load-readiness decision when per-write readiness misses, and no failed or stale wake intents in the after snapshot when one is present. Operators can dispatch the stricter `representative-volume` profile for a captured artifact that intentionally uses the hard caps (12 iterations, concurrency 4) and requires wake-status snapshots, an available wake store, at least one active wake-capable worker, and a lower post-load queue-age budget. The evaluator is CI-safe because it reads only the uploaded artifact; it does not read secrets or contact staging.

Scheduling guidance: do not dispatch drills while a Platform Deploy run is mid-staging (the deploy's own canaries and worker restarts will skew convergence timing). Check the Actions queue first.

## Drill Catalog

| # | Drill (#1234 scope) | Execution | Status |
| --- | --- | --- | --- |
| 1 | Missed notification / missed relay fan-out detection and durable catch-up | `workflow_dispatch` drill workflow, `reconciliation` | Executable on demand |
| 2 | Worker backlog / wake-store pressure under burst | `workflow_dispatch` drill workflow, `load` (bounded) | Executable on demand (bounded scope) |
| 3 | Relay outage / failover takeover | Operator-driven (worker restart or relay switch) + drill workflow as measurement harness | Procedure documented below; requires operator session |
| 4 | Kill-switch flip, fallback-polling verification, canary rerun | Operator-driven (Terraform/env change) + canary + drill workflow | Procedure documented below; requires operator session |
| 5 | Relay cursor corruption/loss | Operator-driven (staging-only cursor reset) + drill workflow | Procedure documented below; requires operator session |
| 6 | Listener outage during high-volume commits | Operator-driven (relay disable + load drill) | Procedure documented below; requires operator session |
| 7 | Control-plane enqueue failure after notification receipt | Not fault-injectable remotely; detection/recovery path verified by unit/runtime tests (#1222/#1231) + fan-out failure alert | Partially covered; observation procedure below |
| 8 | Durable job / realtime wake fallback | Covered by composite fallback design + [Realtime SSE](./realtime-sse.md) checks; drill = SSE replay verification | Procedure documented below |
| 9 | Provider-delivery outbox recovery (transactional email / notifications) | Outbox dispatcher replay from durable rows; scheduled/poll path, not wake-driven | Procedure documented below |
| 10 | Cleanup lag | Observation drill via wake-status + cleanup logs | Procedure documented below |
| 11 | Database failover / connection-limit catch-up | Operator-driven (DO maintenance window) + drill workflow | Procedure documented below; requires operator session |

Honest status: drills 1-2 are fully executable from Actions on demand and produce uploaded evidence per run. Drills 3-6 and 11 have production-ready procedures but each live staging execution requires an operator (worker restarts, Terraform switches, and DO failovers are not reachable from a repo-scoped workflow). Drill 7 cannot be fault-injected without deploying fault-injection code; its detection surfaces (alerts, logs) and recovery semantics (durable catch-up re-fans-out unacknowledged positions) are covered by the unit-proofed recovery state machine evidence (#1222/#1231: crash-replay/coalescing, fenced takeover, durable catch-up). Do not report a drill as "run in staging" unless a dated workflow run or operator session log exists.

## Drill Procedures

### 1. Missed notification / durable catch-up (executable)

1. Actions > Platform Staging Wake Drills > Run workflow. `drill: reconciliation`, confirm `run staging wake drills`.
2. Pass criteria: run is green; evidence shows `verdict: pass`, `relayCursorGap: 0`, every checkpoint gap `<= 0`, and `convergedAfterMs` well inside the budget. The step summary table shows per-context gaps.
3. Failure handling: `relay-cursor-behind-event-store-head` sustained past budget -> relay stage classes in [Push-Wake Operations](./push-wake-operations.md) (lease, listener, catch-up). `projection-checkpoint-behind-event-store-head` with a healthy cursor -> worker scheduling/projection execution classes. `relay-cursor-missing` -> the relay has never fanned out for that context in this environment; check rollout state on the wake-status endpoint.
4. Audit-only nuance (`skip_canary_write: true`): the relay catches up on startup, reconnect, and incoming notifications — there is no timer. On an idle environment a cursor gap can therefore be a quiescent missed-final-notification that the next write's catch-up will heal, not an outage. Re-run with the canary write enabled before escalating: the default drill (write + convergence) is the proof that missed positions are recovered without manual intervention.
5. Cadence: run after any wake-pipeline change reaches staging, and weekly while Milestone #19 is open. Each run re-proves missed-fan-out detection without waiting for a real incident.

### 2. Bounded burst / worker backlog (executable)

1. Same workflow, `drill: load`, `load_iterations` (cap 12), `load_concurrency` (cap 4), `load_flow: guest`.
2. Pass criteria: green run; all iterations produce evidence (no config errors); post-burst convergence passes; readiness pass rate and p95 recorded in the artifact and step summary.
3. Check `staging-wake-drill-load-evaluation.json`: `verdict: pass` under `bounded-staging` means the captured artifact met the bounded load/convergence/wake-store budget. `representative-volume` is expected to fail unless the dispatch used the 12x4 cap and captured wake-status snapshots.
4. Interpretation: queue-age behavior during the burst is on the **Projection Wake Pipeline** dashboard (`chase_sets_projection_wake_intent_queue_age_ms` by lane) joined by the drill's correlation prefix window; the hot-lane queue-age p95 alert must not fire for a burst this small. If it does, treat as a capacity finding per [Projection Freshness Worker Capacity](../architecture/projection-freshness-worker-capacity.md).
5. This drill does not prove production-like volume; see the load-proof gap in [Push-Wake SLO And Load Proof](../architecture/push-wake-slo-load-proof.md).

### 3. Relay failover (operator-driven)

Goal: prove a standby worker takes the relay lease, runs durable catch-up from the persisted cursor, and no wake evidence is lost.

1. Baseline: dispatch the reconciliation drill (or pull `wake-status`) and record `relay.lease.ownerId`, `fencingToken`, and per-source cursor positions.
2. Restart the active worker (DigitalOcean console > staging app > platform-worker component > restart), or set `WORKER_PROJECTION_WAKE_RELAY_ENABLED=false` on that worker only. Worker drain bounds relay shutdown at 30 s and releases the lease.
3. Expect: standby acquires the lease within ~15 s (+ catch-up). Verify on the wake-status endpoint: new `ownerId`, **strictly higher** `fencingToken`, cursors advancing again; worker logs and Grafana show `projection-wake-relay.catch_up.*` with reason `startup` before steady fan-out.
4. Re-run the reconciliation drill. Pass = convergence within budget under the new owner.
5. Record: before/after wake-status snapshots (drill artifacts), the takeover log lines, and the drill run URLs. Failure (lease bouncing, cursors stuck) -> "Relay lease bouncing" class in Push-Wake Operations.

### 4. Kill-switch flip + fallback polling + canary rerun (operator-driven)

Goal: prove every kill switch degrades freshness to poll-bounded without breaking correctness, per the rollback recipes in [Push-Wake Rollout Controls](./push-wake-rollout-controls.md).

1. Flip one switch per drill pass (emission `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED=false`, relay `WORKER_PROJECTION_WAKE_RELAY_ENABLED=false`, scheduler, one lane count to `0`, or `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED=false`) via Terraform locals + deploy, per the rollout-controls recipes.
2. Verify the flip took effect using the rollout-controls "Verification After Flipping" checklist (worker status endpoint, dashboard series, log events).
3. Run the [Buy Now freshness probe](./guest-buy-now-freshness-probe.md) for both flows: it must still reach pay-ready within the readiness budget on polling alone (staging budget currently 10 s; polling-bound staging evidence is the gate, an SLO miss here is a real capacity finding, not an expected drill outcome).
4. Run the reconciliation drill with `skip_canary_write: false`. Expected per switch: relay off **or** emission off -> `relay-cursor-behind-event-store-head` is the **expected** failure signature (the relay only catches up on startup, reconnect, or an incoming notification, so with no notifications or no relay the cursor freezes) while checkpoint gaps still converge via polling — record the run as pass-with-expected-cursor-freeze; scheduler/lane off -> intents age out via TTL while checkpoints converge via polling and the cursor still advances.
5. Restore the switch, re-verify, re-run the canary and the reconciliation drill green before closing the drill.

### 5. Relay cursor corruption/loss (operator-driven, staging only)

Goal: prove recovery rebuilds from durable event-store/checkpoint state when cursor state is missing or suspect (#1234 review update).

1. Pick a quiet window. Record the current cursor row: `SELECT source_context_name, last_fanout_position, owner_id, fencing_token, updated_at FROM platform_projection_wake_relay_cursors WHERE source_context_name = 'checkout';`
2. Simulate loss (staging control database only, never production without an incident): `DELETE FROM platform_projection_wake_relay_cursors WHERE source_context_name = 'checkout';`
3. Force a catch-up pass: restart the active worker (drill 3). A missing cursor resumes from global position 0 by design: the relay re-reads all source events in bounded batches and re-fans-out; the interest index, intent coalescing, and TTLs bound the wake-store load, and projection idempotency makes re-wakes harmless. This is the documented bounded-load rebuild path — expect elevated catch-up duration (`chase_sets_projection_wake_relay_catch_up_duration_ms`) and fan-out counts while it replays.
4. Verify: `projection-wake-relay.catch_up.*` logs show the replay; the cursor row is recreated and converges to head; the reconciliation drill passes; hot-lane queue age p95 alert stays quiet (small staging event volume) or is acknowledged as drill noise.
5. Operator telemetry contract: a cursor rebuild is operator-visible via the catch-up logs/metrics and the cursor `lastAdvanceReason` metadata on the wake-status endpoint. If checkout's event volume ever makes a from-zero replay too expensive, the documented mitigation is seeding the cursor from a trusted checkpoint minimum before restart — record the decision in the drill log.

### 6. Listener outage during high-volume commits (operator-driven)

Goal: prove correctness is preserved by durable catch-up when LISTEN sessions drop while writes continue.

1. Disable the relay (`WORKER_PROJECTION_WAKE_RELAY_ENABLED=false`, deploy) — this is the controlled stand-in for a listener outage; real reconnect storms are diagnosed per the "Listener reconnect storms" class.
2. Immediately dispatch the `load` drill (writes continue while no listeners exist). Expected: readiness stays inside the polling-bound budget; relay cursor freezes (expected signature).
3. Re-enable the relay, deploy. The relay session start runs durable catch-up: verify cursors jump to head (`catch_up` logs include the drill window's events) and the reconciliation drill passes.
4. Record both drill run URLs plus the catch-up log lines as the drill evidence.

### 7. Control-plane enqueue failure after notification receipt (observation)

Fault injection (failing the wake-store write mid-fan-out) is not reachable from deployed staging without shipping fault-injection code, which #1229's posture rejects. Coverage today:

- Recovery semantics are unit-proofed (#1222/#1231): fan-out failures do not advance the cursor, so the next catch-up pass replays the position — no wake is lost, only delayed.
- Detection is live: `platform-worker-wake-alerts` fan-out failure rate alert + `projection-wake-relay.fan_out.*` failure logs.
- Drill: when a real fan-out failure fires the alert, run the reconciliation drill after mitigation; convergence green closes the loop. Accepted gap: no synthetic injection path. Owner: platform runtime; revisit if a staging fault-injection switch is ever approved.

### 8. Durable job / realtime wake fallback

Both transports replay from durable rows/cursors; wakes only accelerate ([Platform Work-Signal Composite](../architecture/work-signal-composite.md)).

1. Durable jobs: open a long-running admin operation (e.g., projection rebuild from the console), then hard-refresh the SSE page mid-run. The stream must resume from the durable job-event rows (no missed terminal state). Worker status endpoint `durableWorkflows` shows claims/retries.
2. Realtime: per [Realtime SSE](./realtime-sse.md) operational checks — disconnect/reconnect must replay from outbox cursors; with `REALTIME_WAKE_SIGNAL_ENABLED` unavailable, patches arrive on the bounded polling fallback.
3. Pass criteria: no missed public status/events after reconnect in either transport; record the session in the drill log.

### 9. Provider-delivery outbox recovery (transactional email / notifications)

These dispatchers are scheduled/poll-driven over durable outbox rows (documented exception — they do not ride the wake composite; see the origin disposition inventory in the composite doc).

1. Verify pending-claim recovery: pause is not needed — restart the worker mid-dispatch (drill 3 restart) and verify claimed-but-unsent rows are re-claimed after the claim TTL and dispatched exactly once at the provider boundary (provider idempotency keys per [Email Operations](./email-operations.md)).
2. Verify retry/backoff: a provider sandbox timeout (Stripe/SES test modes) must leave the row in a retryable state with backoff, visible in the worker `durableWorkflows` summary; retry exhaustion parks the row as terminal-failed with the durable delivery intent preserved for manual replay.
3. Pass criteria: zero lost outbox rows across a worker restart; record row counts before/after from the outbox tables.

### 10. Cleanup lag (observation)

1. Pull wake-status before and after a load drill: `wakeStore.intentSummary.expiredCount` and checkpoint-signal expired counts must return to steady-state within ~2 cleanup intervals (default 60 s each).
2. `work-signals.cleanup.completed` logs must show pruned counts below the batch cap (500) in steady state. Sustained max-batch runs -> "Cleanup lag" class in Push-Wake Operations.

### 11. Database failover / connection-limit catch-up (operator-driven)

1. Schedule with a DigitalOcean staging maintenance/failover window (DO console > database cluster > settings) — repo workflows cannot trigger cluster failover.
2. During failover, expect: listener drops (relay sessions end), pooled query errors, then reconnect. The connection budget ([Push-Wake Connection Budget](../architecture/push-wake-connection-budget.md)) caps total demand below the post-failover limit, so catch-up must succeed without connection exhaustion: watch the budget ledger surfaces and `projection-wake-relay.listener.*` reconnect logs.
3. After the cluster reports healthy, run the reconciliation drill; pass = convergence within budget and a stable relay lease.
4. Record: failover window, reconnect log spans, drill run URL.

## Evidence And Reporting

- Executable drills: the workflow artifact (`staging-wake-drill-<kind>-<run>-<attempt>`) is the evidence of record — redacted JSON (`staging-wake-drills/v1`), wake-status snapshots, per-iteration canary evidence, the no-secret load evaluation (`push-wake-load-evidence/v1`) for `load` drills, and the step summary. Evidence never contains connection strings, credentials, tokens, or emails (the scripts fail closed on leak detection).
- Release-health reporting: pass the redacted `staging-wake-drill-<kind>.json` artifact to `pnpm run ops release-health:report --file <artifact>` when preparing the release-health summary. The report surfaces wake-before-wait as low-cardinality single-write, load, and durable-convergence segment posture without copying correlation ids, database URLs, credentials, tokens, or full paths.
- Operator drills: record the date, operator, switch/console actions, log line references, dashboard screenshots, and the bracketing drill-run URLs in the milestone issue (#1234) until a recurring drill log home exists.
- Recovery metrics/alerts: every drill observes the #1228 surfaces (Projection Wake Pipeline dashboard, `platform-worker-wake-alerts`); a drill that trips an alert must say so in its record.

## Related Documents

- [Push-Wake Operations](./push-wake-operations.md) — failure classes and triage these drills exercise.
- [Push-Wake Rollout Controls](./push-wake-rollout-controls.md) — kill-switch matrix and verification used by drill 4.
- [Push-Wake SLO And Load Proof](../architecture/push-wake-slo-load-proof.md) — where drill evidence feeds the #1237 SLO/load record.
- [Guest Buy Now Freshness Probe](./guest-buy-now-freshness-probe.md) — the synthetic write generator and release gate.
- [Projection Freshness Worker Capacity](../architecture/projection-freshness-worker-capacity.md) — capacity actions when a drill exposes backlog.
