# Push-Wake Operations

Incident playbook for the push-first projection runtime (Milestone #19, [ADR 0010](../adr/0010-push-driven-projection-runtime.md)): event-store wake notifications, the worker-owned relay, the durable control-plane wake store, the wake-intent scheduler, checkpoint readiness/waiters, and the API wake-before-wait path. Kill switches and rollback recipes live in [Push-Wake Rollout Controls](./push-wake-rollout-controls.md); this runbook is for diagnosing where latency or failure sits and acting on it.

## Operating Invariant (read first)

No wake-path failure loses data or permanently stalls projections:

- Fallback polling: the worker `projections` runner group drains every projection group on its poll interval (`WORKER_POLL_INTERVAL_MS`, default 1s) regardless of wake state.
- Exact read-after-write waits: bounded durable polls against projection checkpoints run unconditionally; wakes only accelerate them.
- Durable catch-up: the relay replays from durable event rows on lease takeover, so missed `pg_notify` wakes are recovered, not lost.
- TTL reaping: unconsumed wake intents expire (`expires_at`, default 5 min) and the `work-signals.cleanup` runner (default every 60s) prunes them; readiness rows default to a 10 min TTL, waiters to 5 min.

A broken wake path degrades freshness from push-accelerated to poll-bounded. Treat "data is wrong" as a projection/event problem ([Projection Operations](./projection-operations.md)), not a wake problem.

## Where To Look

| Surface | What it answers | Access |
| --- | --- | --- |
| Admin console > Projection Operations > **Push wakes** tab (`/platform/projections?tab=wake`) | Wake-intent queue by lane/origin/state with oldest ages, stale claims, relay lease owner + per-source cursors + interest-index version, checkpoint readiness/waiter counts, wake-capable workers, registry rollout state per source context, push-first migration status per projection group (owner, status, enabled/total sources, opt-outs — #1224) | Admin web, `security.manage` |
| `GET /api/platform/projections/wake-status` | Same data as the console tab, JSON (structural fields only — no payloads, no stream ids); migration inventory under `migration` | platform-api / admin-support-api, `security.manage` |
| Worker status endpoint `GET /internal/workers/status` | The worker's **effective** config: `projectionWakeControls` (scheduler/relay enabled, lane runner counts, hot-lane reserved slots, disabled projection keys), `projectionWakeRelay` supervisor state (`running`, `lastSessionStatus`, `lastError`, listener sources, live `interestIndexVersion`, and `interestIndex` — full index summary: status/stale reason, `generatedAt`, enabled/disabled entry counts, enabled source contexts, route-dependency count, per-source/per-lane counts), `projectionWakeIntents` summary, runner loops, leases | Internal port only; not publicly routable — use the deployment platform's console/exec |
| Grafana dashboard **Projection Wake Pipeline** (`chase-sets-projection-wake-pipeline`) | Rates and percentiles: fan-out outcomes, intents enqueued by lane, notification age p95, catch-up duration, queue age p95 by lane/origin, intent processing p95, intent outcomes, freshness wake requests and work-signal errors, wake pipeline logs | Grafana (#1228) |
| Alerts `platform-worker-wake-alerts` | Fan-out failure rate, attempts-exhausted rate, hot-lane queue age p95 SLO, freshness work-signal error rate | Grafana provisioning (`infrastructure/observability/stack/grafana/provisioning/alerting/platform-worker-wake-alerts.yml`); environments share fields, thresholds are environment-specific |
| Logs | Relay: `projection-wake-relay.session.ended`, `projection-wake-relay.listener.*`, `projection-wake-relay.catch_up.*`, `projection-wake-relay.fan_out.*`. Scheduler: `projection-wake.intent.claimed/completed/not_ready/deferred/unknown_target/run_failed/attempts_exhausted`, `work-signals.cleanup.completed`. Controls: `projection-wake.controls.projections_disabled`. API: `read-after-write.freshness` audit records | Loki / platform logs |

Staging and production expose the same fields on every surface; only alert thresholds and the rollout switches differ (production currently runs with emission/relay/api-wait off by default — see the rollout-controls runbook).

## Latency Stage Map

When "reads are stale" or "checkout is slow", localize the stage before acting:

1. **Notification** (source commit -> `pg_notify`): emission disabled? `chase_sets_projection_wake_notifications_total` flat while commits continue. Registry/emission switches.
2. **Relay** (notify -> fan-out): relay lease missing/expired, listener down, catch-up loop failing. Cursor age grows on the wake panel while source events advance.
3. **Control-plane store** (fan-out -> durable intent row): fan-out failures, store errors, cleanup lag. `projection-wake-relay.fan_out.*` failures; intent counts not growing despite fan-out.
4. **Worker scheduling** (queued -> claimed): queue age p95 growing, lane runner count zero, no wake-capable workers, stale claims.
5. **Projection execution** (claimed -> checkpoint advance): `run_failed`/`attempts_exhausted`, blocked streams, poison events — this is projection repair, not wake repair.
6. **Checkpoint readiness** (checkpoint -> waiter satisfied): readiness rows stale/expired, pending waiters aging out.
7. **Durable job / realtime wake/replay**: durable-job SSE and realtime SSE have their own wake channels and replay from durable rows/cursors; see [Realtime SSE](./realtime-sse.md) and [Durable Job Workflows](../architecture/durable-job-workflows.md).
8. **API waits** (`api-wait`): route freshness timeouts and 503s; see [Projection Freshness Audit](./projection-freshness-audit.md).

For provider delivery (transactional email / notifications), the wake pipeline is not involved: localize across **outbox enqueue -> claim -> retry/backoff -> provider send -> webhook/provider acknowledgement -> terminal recording** using the outbox dispatcher's durable rows (`infrastructure/transactional-email-outbox`, `infrastructure/notification-outbox`), the worker status endpoint's `durableWorkflows` summaries, and [Email Operations](./email-operations.md). Composite work-signal adapters for these origins are #1248 and do not exist yet.

## Failure Classes

### Wake backlog growing / queue-age alert firing

Symptoms: hot-lane queue age p95 alert; Push wakes tab shows queued counts climbing and oldest queued age in minutes.

1. Confirm consumers exist: Push wakes tab > Wake schedulers. Zero wake-capable workers means the scheduler is disabled (`WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED`) or every lane runner count is 0. Check `/internal/workers/status` `projectionWakeControls.laneRunnerCounts` for the effective values.
2. If consumers exist but one lane backs up, check that lane's breakdown row. A zeroed lane is a deliberate kill switch (rollout-controls runbook); intents in it will TTL-expire — expected, not an incident.
3. Check intent outcomes on the dashboard: a high `deferred`/`not_ready` rate means the projection lease is contended or the group is busy — the backlog drains once the projection catches up; fallback polling covers correctness meanwhile.
4. If queue age grows with healthy runners and low outcomes, suspect control-plane DB pressure (claim queries) — check pool saturation and [Projection Freshness Worker Capacity](../architecture/projection-freshness-worker-capacity.md) before scaling.
5. Recovery timeline: after fixing consumption, backlog drains at lane concurrency x `maxRunsPerClaim`; anything older than the wake TTL (default 5 min) expires and is reaped by cleanup within ~1 min. Freshness is poll-bounded throughout.

### Relay lease bouncing / no stable owner

Symptoms: wake panel lease owner changes repeatedly or shows `expired`; logs show `projection-wake-relay.session.ended` cycling with short sessions.

1. Read `lastSessionStatus`/`lastError` from `/internal/workers/status` `projectionWakeRelay` on each worker. `lease-missed`/standby cycling across two workers is normal (one active, one standby retrying every ~15s). Rapid `error` sessions are not.
2. Lease renewal failures usually mean control-plane DB latency or connection exhaustion — check the [Push-Wake Connection Budget](../architecture/push-wake-connection-budget.md) ledger before scaling workers.
3. A wedged active session is bounded: worker drain waits at most 30s for the relay before shutdown, and the lease TTL expires so a standby takes over. Verify cursors resume advancing (cursor age on the wake panel) after takeover; the new owner runs a durable catch-up pass first (`projection-wake-relay.catch_up.*`).
4. If ownership must move now: restart the active worker (drain releases the lease) or set `WORKER_PROJECTION_WAKE_RELAY_ENABLED=false` on that worker only. Expect standby takeover within the standby retry interval (~15s) plus catch-up.

### Listener reconnect storms

Symptoms: `projection-wake-relay.listener.*` reconnect/error logs repeating; notification age p95 rising while cursors only advance via catch-up.

1. Listeners need direct (non-PgBouncer-transaction) connections; reconnect storms usually follow database failovers, connection-limit pressure, or topology drift — re-check the connection budget and listener URL topology ([Projection Wake Relay](../architecture/projection-wake-relay.md)).
2. Correctness is preserved by periodic catch-up from durable rows; the cost is added latency. If the storm persists, disable the relay (environment switch) and let polling own freshness while the database issue is fixed.
3. After recovery, confirm `listenerSourceContextNames` matches `configuredSourceContextNames` on the worker status endpoint.

### Fan-out failures

Symptoms: `platform-worker-wake-alerts` fan-out failure rate alert; `projection-wake-relay.fan_out.*` failure logs.

1. Failure reasons are structural: malformed notification envelopes, interest-index misses, or wake-store write errors. Wake-store write errors point at control-plane DB health; envelope errors point at a source-context emission bug (find the source context in the log fields).
2. An interest-index miss for a projection that should exist means the relay's loaded index is stale or the projection is disabled (`WORKER_WAKE_DISABLED_PROJECTIONS`, visible in `projectionWakeControls.disabledProjectionKeys`). Compare the cursor's `interestIndexVersion` on the wake panel with the live `projectionWakeRelay.interestIndexVersion` on the worker status endpoint; a worker restart reloads the index from current projection declarations.
3. Fallback polling keeps affected projections fresh; fix the cause, then verify fan-out outcome rates recover on the dashboard.

### Attempts exhausted

Symptoms: attempts-exhausted alert; `projection-wake.intent.attempts_exhausted` logs; failed counts on the wake panel.

1. An intent retired after `WORKER_WAKE_MAX_ATTEMPTS` (default 10) means the underlying projection run kept failing — go to the projection console's Attention tab for the blocked stream / poison event / degraded group and repair per [Projection Operations](./projection-operations.md) and [Projection Poison Events](./projection-poison-events.md).
2. `unknown-target` retirements mean intents target a projection this worker does not host (commonly `api-wait` intents for a group disabled on the worker). Bounded and safe; silence it by disabling the source context or api-wait origin per the rollout-controls runbook.
3. Do not replay exhausted intents: once the projection is repaired, polling (or the next wake) advances the checkpoint; the retired intent is irrelevant and will be pruned.

### Checkpoint readiness stale / waiter leaks

Symptoms: wake panel shows expired readiness rows, pending waiters aging, or expired pending waiters climbing.

1. Expired pending waiters mean api-wait callers timed out before the checkpoint advanced — the user-facing symptom is slower (poll-bounded or timeout) reads, already covered by the freshness audit. Diagnose the projection lag stage (4-5 above), not the waiter table.
2. Readiness rows are advisory with a 10 min TTL; expired rows are reaped by cleanup. A persistently empty readiness table while the scheduler completes intents suggests the worker's readiness recording is failing — check worker logs for work-signal store errors.
3. Steadily growing satisfied/expired waiter totals without pruning indicate the cleanup runner is behind (next class).

### Cleanup lag

Symptoms: `work-signals.cleanup.completed` absent or pruned counts pinned at the batch limit every run; expired counts on the wake panel growing without bound.

1. The cleanup runner deletes in bounded batches (default 500 per table per run, every `WORK_SIGNAL_CLEANUP_INTERVAL_MS`, default 60s). Sustained max-batch runs mean production of expired rows exceeds reaping — usually a disabled lane/scheduler quietly accumulating intents. Turn off the producer (emission/relay/api-wait switches) rather than tuning cleanup first.
2. Table bloat from expired rows is an operational nuisance, not a correctness risk; the claim indexes are partial on live states.

### api-wait 503 spikes / route freshness timeouts

Symptoms: route-level 503/504s or `read-after-write.freshness` timeout outcomes spiking; `chase_sets_projection_freshness_work_signal_errors_total` alert.

1. Follow [Projection Freshness Audit](./projection-freshness-audit.md) to classify by receipt, dependency, and wait mode — that runbook owns the route-side triage, including the Checkout document-route budget rules.
2. Work-signal errors on the API host mean the wake-before-wait enqueue is failing (control-plane DB reachability from platform-api). The waits themselves still run; you can set `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED=false` to stop the error noise without changing correctness.
3. Cross-check the wake panel: if hot-lane `api-wait` intents are queued but old, the bottleneck is worker scheduling (class 1), not the API.

### Durable-job / realtime wake fallback

Symptoms: durable-job SSE progress or realtime patches arrive on poll cadence instead of promptly; reconnect loops.

1. Both transports replay from durable rows/cursors; their wakes (`REALTIME_WAKE_SIGNAL_ENABLED`, durable-job notify channels) are accelerators with their own pre-composite `pg_notify` payloads (opaque ids only). Diagnose via [Realtime SSE](./realtime-sse.md) operational checks and the worker status endpoint `durableWorkflows` section.
2. There is no composite-wide wake control for these origins yet (#1248); do not look for them in the wake store — `durable-job` and `realtime` rows will not appear there.

## Checkout Incident Triage (the Milestone #19 origin pattern)

Pattern: guest Buy Now writes a checkout session, redirects to `/checkout/:sessionId`, and the page 503s or shows stale state because `checkout` projections lag ([root cause](./guest-buy-now-projection-lag-root-cause.md)).

1. **Classify the read**: pull `read-after-write.freshness` audits for `/account/checkout-sessions/:sessionId` (fields and Loki queries in the [freshness audit runbook](./projection-freshness-audit.md)). `outcome=timeout` with valid receipt -> projection-side lag; missing receipt/dependency -> route wiring bug.
2. **Localize the stage** with the Push wakes tab:
   - `checkout` rollout row shows emission/fan-out enabled? If disabled in this environment, push acceleration is off by design and the budget must hold on polling — go to worker capacity.
   - Hot-lane `api-wait`/`relay` intents queued with growing age -> worker scheduling (class 1).
   - Relay cursor for `checkout` stale while the lease is active -> relay/listener (classes 2-3).
   - Intents completing but waits still timing out -> projection execution or checkpoint readiness (classes 5-6); check the `checkout` group's lag and blocked streams in the console.
3. **Verify worker capacity**: active wake-capable workers on the wake panel; `projections` group heartbeats; [Projection Freshness Worker Capacity](../architecture/projection-freshness-worker-capacity.md) audit for the checkout-session route.
4. **Mitigate**: projection repair (retry blocked stream / rebuild) for execution failures; kill switches (rollout-controls runbook) if the wake pipeline itself is misbehaving — checkout stays correct on exact waits + polling within its 900 ms route budget, and the page's preparing-checkout recovery covers the rest.
5. **Prove recovery**: run the [Guest Buy Now Freshness Canary](./guest-buy-now-freshness-canary.md) (`pnpm run guest-buy-now:freshness-canary`) and re-check the checkout-session freshness p95 query from the audit runbook.

## Operator Actions

| Action | How | Expected timeline |
| --- | --- | --- |
| Drain relay ownership from a worker | Restart that worker (drain stops the supervisor, bounded 30s, and releases the lease) or set `WORKER_PROJECTION_WAKE_RELAY_ENABLED=false` on it | Standby takes the lease within ~15s, then runs durable catch-up |
| Disable a source context | Registry `rolloutState: "disabled"` + reason (code deploy), or worker-side `WORKER_WAKE_DISABLED_PROJECTIONS` for its projection keys — full recipes in [Push-Wake Rollout Controls](./push-wake-rollout-controls.md) | Emission/fan-out stop on deploy; residual intents TTL-expire within 5 min |
| Force reconciliation | None needed for wakes: fallback polling reconciles every projection group each poll interval. For deeper repair use the console's Refresh status / retry blocked stream / rebuild actions ([Projection Operations](./projection-operations.md)). The `reconciliation` wake origin has no emitter yet | Poll-bounded (~seconds) for drain; rebuilds are queued operations |
| Inspect wake-store rows safely | Prefer the wake-status endpoint/panel (aggregated). If you must query: `SELECT wake_intent_id, source_context_name, target_context_name, projection_name, checkpoint_key, priority_lane, origin, state, attempt_count, created_at, next_eligible_at, claimed_until, expires_at FROM platform_projection_wake_intents ORDER BY created_at DESC LIMIT 50;` — do **not** select `metadata` or `last_error` into tickets/chat; the store denylists sensitive keys at write time (#1235) but the columns are still not for sharing | Read-only |
| Inspect durable-job / realtime wake health | `/internal/workers/status` `durableWorkflows`; [Realtime SSE](./realtime-sse.md) checks; durable job tables per [Durable Job Workflows](../architecture/durable-job-workflows.md) | Read-only |
| Verify Checkout readiness | Checkout triage above: freshness audit query, wake panel `checkout` rows, freshness canary | Canary run ~minutes |

## Honest Gaps

- **Composite origins (#1248)**: durable-job and realtime wake notifications now ride the work-signal composite (versioned envelopes, shared waiters, bounded fallback), and the wake-status endpoint lists every origin's disposition under `origins` (see [Platform Work-Signal Composite](../architecture/work-signal-composite.md)). Their *health* still lives on their own surfaces (linked above), not in the wake store: scheduled/manual and reconciliation kinds have no emitters yet, and provider-outbox dispatch remains a documented scheduled/outbox exception with no wake signals.
- **Live failover/recovery drills (#1234)**: the executable drills (missed-fan-out reconciliation audit, bounded burst) run on demand from the `Platform Staging Wake Drills` workflow, and the operator-driven drills (relay failover, kill-switch flips, cursor loss, DB failover) have production-ready procedures in [Push-Wake Recovery Drills](./push-wake-recovery-drills.md). Remaining gap: the operator drills require a live operator session per execution, and no production-environment drill cadence exists yet.
- **Topology parity / connection-budget evidence (#1243)**: parity status and budget ledgers are documented in [Push-Wake Connection Budget](../architecture/push-wake-connection-budget.md) and Terraform checks; the wake panel shows rollout state, not Terraform-level parity proofs.
- **Interest-index route coverage**: the worker status endpoint now reports the full index summary (status, stale reason, age, disabled/opt-out counts, enabled source contexts), and route-dependency push posture is reported registry-side in the [push-first migration inventory](../architecture/push-first-projection-migration.md); the worker's own index reports zero route dependencies because it builds without resolved API mounts, and a live per-route coverage view still needs the #1248 composite route metadata.

## Related Documents

- [Push-Wake Rollout Controls](./push-wake-rollout-controls.md) — kill-switch matrix, rollback recipes, verification.
- [Push-Wake Recovery Drills](./push-wake-recovery-drills.md) — drill catalog, executable staging drill workflow, operator drill procedures.
- [Projection Wake Relay](../architecture/projection-wake-relay.md) / [Projection Wake-Intent Scheduler](../architecture/projection-wake-scheduler.md) — runtime contracts.
- [Source-Context Wake Registry](../architecture/source-context-wake-registry.md) — rollout states and evidence gates.
- [Projection Operations](./projection-operations.md) — backlog, repair, rebuild triage.
- [Projection Freshness Audit](./projection-freshness-audit.md) — read-after-write route triage.
- [Observability](./observability.md) — local LGTM stack for the dashboards above.
