# Push-Wake Rollout Controls

This runbook covers the kill switches and rollout controls for the push-first projection runtime (Milestone #19, [ADR 0010](../adr/0010-push-driven-projection-runtime.md)): event-store wake emission, the worker-owned relay, the durable wake-intent scheduler, priority lanes, projection-group opt-outs, and the API wake-before-wait path.

## Operating Invariant

No switch in this runbook removes durable correctness. Disabling any push path leaves intact:

- Exact read-after-write waits: the read-consistency middleware's bounded durable polls against projection checkpoints run unconditionally; wake-before-wait only accelerates them.
- Fallback polling: the worker `projections` runner group keeps draining every projection group on its poll interval regardless of wake configuration.
- Durable job and realtime SSE replay: both replay from durable rows/cursors and never depend on a wake being delivered.
- Recovery: wake intents that nothing consumes are bounded by `expires_at` TTLs and reaped by the `work-signals.cleanup` runner; durable event rows remain the source of truth.

Flipping a switch changes freshness latency (push-accelerated to poll-bounded), never data loss.

## Kill-Switch Matrix

| Control | Scope | Values | Where set | Effect | What it never affects |
| --- | --- | --- | --- | --- | --- |
| Source-context wake registry (`infrastructure/platform-runtime/source-context-wake-registry.ts`) | One source context, all environments | `rolloutState` (`not-eligible`, `eligible`, `staging-enabled`, `production-proof`, `production-enabled`, `disabled`, `opted-out`) plus `enablement.eventStoreWakeNotifications` / `enablement.relayFanOut` | Code change + deploy; validators enforce reasons for `disabled`/`opted-out` and production gate evidence (#1243, #1244, #1246, #1249) | Gates write-side wake emission per source (every context derives its config via `createEventStoreWakeNotificationConfigForSourceContext`) and relay fan-out per source (`listSourceContextWakeRelayConfigs`) | Event persistence, projection checkpoints, fallback polling |
| `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED` | One environment, all components that host write-side services (platform-api, platform-worker, bootstrap/seed jobs) | Unset/empty = enabled; `1`/`true`/`yes`/`on` = enabled; anything else = disabled | Terraform `locals.tf` (`event_store_wake_notifications_enabled`: staging `"true"`, production/preview `"false"`); env var locally | Forces every registry-derived emission config off, so no `pg_notify` wake leaves any event store commit | Event commits, fallback polling, exact waits |
| `WORKER_PROJECTION_WAKE_RELAY_ENABLED` | One environment's platform-worker | Boolean env, default `true` in code | Terraform `locals.tf` (`worker_projection_wake_relay_enabled`: staging `"true"`, production/preview `"false"`) | Stops the relay supervisor: no LISTEN sessions, no catch-up passes, no control-plane wake-intent fan-out | Source event rows, durable wake-store rows already enqueued, polling |
| `WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED` | One environment's platform-worker | Boolean env, default `true` | Env var (not currently pinned in Terraform) | Removes the `wakes` runner group: durable wake intents stop being claimed/run; queued intents age out via TTL + cleanup | Fallback polling (`projections` group), projection leases, rebuilds |
| `WORKER_WAKE_HOT_LANE_RUNNER_COUNT` / `WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT` / `WORKER_WAKE_BULK_LANE_RUNNER_COUNT` | One priority lane on the platform-worker | Non-negative integer, default `1`; `0` disables the lane (empty/invalid values keep the default, they do not zero the lane) | Terraform (pinned per environment on the platform-worker since the hot-lane reservation change; flipping a lane now goes through a Terraform deploy) | A zero-count lane gets no scheduler runners; intents in that lane stay queued until TTL expiry | Other lanes, polling, intent enqueueing |
| `WORKER_WAKE_DISABLED_PROJECTIONS` | One or more projection groups on the platform-worker | Comma-separated `<target-context>:<projection-name>` keys (registry `affectedProjectionNames` format, e.g. `checkout:checkout.cart-projection`); malformed entries fail worker startup | Env var | Marks the projection disabled in the relay interest index (no new relay fan-out intents) and removes it from the wake scheduler's hosted groups (this worker never wake-runs it) | Fallback polling for the same projection, exact waits, other projections |
| `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED` | One environment's platform-api (`api-wait` origin) | Boolean env, default `false` | Terraform `locals.tf` (`read_consistency_wake_before_wait_enabled`: staging `"true"`, production/preview `"false"`) | API stops enqueueing exact `api-wait` wake intents before read-after-write waits | The waits themselves: bounded durable polls run unchanged |
| `READ_CONSISTENCY_ROUTE_TUNING_JSON` (+ `READ_CONSISTENCY_TIMEOUT_MS`, `READ_CONSISTENCY_POLL_INTERVAL_MS`, `READ_CONSISTENCY_EXACT_DEPENDENCY_MODE`) | One route's wait behavior on platform-api | JSON array of `{mountPath, routePath, timeoutMs, pollIntervalMs, exactDependencyMode}` | Env var; critical checkout-session tuning is pinned in code | Tunes per-route wait budget and dependency mode. This is a tuning knob, not a wake kill switch: there is no per-route wake disable (see scope assessment) | Wake enqueueing, polling correctness |
| `WORKER_WAKE_*` tunables (`WORKER_WAKE_MAX_CONCURRENT_RUNNERS`, `WORKER_WAKE_POLL_INTERVAL_MS`, `WORKER_WAKE_MAX_CLAIMS_PER_RUN`, `WORKER_WAKE_CLAIM_TTL_MS`, `WORKER_WAKE_RETRY_BACKOFF_BASE_MS`/`_MAX_MS`, `WORKER_WAKE_MAX_ATTEMPTS`, `WORK_SIGNAL_CLEANUP_INTERVAL_MS`, `WORKER_WAKE_RELAY_*`) | Worker wake throughput/backoff | Positive numbers | Env var; `WORKER_WAKE_MAX_CONCURRENT_RUNNERS` in Terraform (`worker_wake_concurrency`) | Throttles wake consumption under pressure without disabling it | Polling, lease single-flight |

`REALTIME_WAKE_SIGNAL_ENABLED` (SSE wake) is a separate realtime transport control covered by the [Realtime SSE runbook](./realtime-sse.md); production config requires it `true`, so it is not usable as a production kill switch.

## Scope Assessment (Honest)

Issue #1229 asks for kill switches scoped by environment, phase, source context, projection group, route, priority lane, and work-signal origin. Current truth:

| Scope | Status | How / gap |
| --- | --- | --- |
| Environment | Covered | Terraform locals set the emission, relay, and api-wait switches per environment (staging on, production/preview off). |
| Source context | Covered | Registry `rolloutState` + `enablement` per source context, enforced by validators. Limitation: the registry is environment-global, so a per-context change is a code deploy, not an env flip. |
| Projection group | Covered on the worker (this change) | `WORKER_WAKE_DISABLED_PROJECTIONS` disables relay fan-out and wake-runs for the group. Limitation: platform-api does not read this env, so `api-wait` intents for a disabled group are still enqueued; the scheduler retires them as `unknown-target` retries until TTL expiry (bounded, logged, polling unaffected). |
| Route | Partial | `READ_CONSISTENCY_ROUTE_TUNING_JSON` tunes per-route wait budgets, and `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED` kills the whole `api-wait` origin, but there is no per-route wake disable. Gap accepted: route waits remain correct without wakes, so the per-deployment origin switch is the operative control. |
| Priority lane | Covered (this change) | Lane runner count `0` disables a lane's consumers. Before this change `0` silently fell back to the default of `1`; the config now accepts zero explicitly. |
| Work-signal origin | Partial | `relay` origin: `WORKER_PROJECTION_WAKE_RELAY_ENABLED`. `api-wait` origin: `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED`. The `reconciliation` and `operator` origins exist in the schema but have no emitters yet, so no switches exist for them. |
| Delivery phase | Not a runtime switch | Phases (`phase-1` through `phase-3`) are registry metadata gated by required-issue validators; "disabling a phase" means returning its source contexts to non-active rollout states (code change) or using the environment switches. There is no single phase-level env toggle. |
| Composite origins (durable jobs, outbox dispatchers, realtime; #1248) | Not yet built | The platform work-signal composite is not implemented in this codebase yet, so no composite rollout controls exist to document. Provider-outbox dispatchers continue on their own durable claim/poll loops untouched by every switch above. |

## Rollback Recipes

### Disable push for one source context

1. Edit `infrastructure/platform-runtime/source-context-wake-registry.ts`: set the entry's `rolloutState: "disabled"`, add a `disabledReason`, and remove the `enablement` block (both flags must return to `false`; validators reject active enablement on a disabled state).
2. Deploy. Write-side emission for that context turns off and the relay drops it from fan-out configs.
3. If you cannot wait for a deploy, use `WORKER_WAKE_DISABLED_PROJECTIONS` with the context's `affectedProjectionNames` keys (worker-side stop) and/or the environment-level switches below.

### Disable push entirely in one environment

1. Set `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED=false` (Terraform: `event_store_wake_notifications_enabled`) — stops new wake notifications from every component, including bootstrap jobs.
2. Set `WORKER_PROJECTION_WAKE_RELAY_ENABLED=false` (Terraform: `worker_projection_wake_relay_enabled`) — stops relay listening, catch-up, and fan-out.
3. Leave `WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED=true` so already-queued intents drain; set it `false` only if the scheduler itself is the problem (queued intents then expire via TTL and the cleanup runner).
4. Optionally set `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED=false` to stop `api-wait` enqueues; with the scheduler still on this is not required for correctness.

Production and previews already run in this posture by default; this recipe is the staging rollback.

### Disable one priority lane

1. Set the lane's runner count to zero on the platform-worker, e.g. `WORKER_WAKE_HOT_LANE_RUNNER_COUNT=0`.
2. Set the value to exactly `0` — empty or non-numeric values keep the default of `1` by design.
3. Expect intents in that lane to sit queued until `expires_at` (default 5 minutes) and be reaped by cleanup; the affected projections fall back to poll-bounded freshness.

### Disable api-wait wakes

1. Set `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED=false` on platform-api (Terraform: `read_consistency_wake_before_wait_enabled`).
2. Read-after-write routes keep their exact durable waits and route tuning; they lose only the wake acceleration.

### Disable push for one projection group

1. Set `WORKER_WAKE_DISABLED_PROJECTIONS=<target-context>:<projection-name>[,...]` on the platform-worker, e.g. `WORKER_WAKE_DISABLED_PROJECTIONS=checkout:checkout.cart-projection`.
2. Restart/redeploy the worker. Startup logs `projection-wake.controls.projections_disabled` including any keys that match no hosted projection group (typo check).
3. Expect residual and `api-wait`-origin intents for the group to retire as `projection-wake.intent.unknown_target` retries until TTL expiry; this is bounded and safe, but noisy — disable the source context or api-wait switch too if the noise matters.
4. Fallback polling keeps the projection fresh on the poll interval.

## Verification After Flipping

1. Worker status endpoint `GET /internal/workers/status` (internal port):
   - `projectionWakeControls`: `schedulerEnabled`, `relayEnabled`, `laneRunnerCounts.{hot,standard,bulk}`, `disabledProjectionKeys` must reflect the flip.
   - `projectionWakeRelay`: `enabled`, `configuredSourceContextNames`, `listenerSourceContextNames`, `interestIndexVersion` (changes when overrides change the index).
   - `projectionWakeIntents`: queued/claimed/failed counts should drain (scheduler on) or age into expiry (scheduler/lane off).
   - `loops`: the `wakes` group disappears when the scheduler is disabled or all lanes are zero.
2. Grafana dashboard `projection-wake-pipeline` (`chase_sets_projection_wake_*` metrics):
   - `chase_sets_projection_wake_notifications_total` stops increasing after an emission kill.
   - `chase_sets_projection_wake_relay_fan_out_total` / `chase_sets_projection_wake_relay_fan_out_intents_total` go to zero for a disabled source context, projection group, or relay.
   - `chase_sets_projection_wake_intents_total` by `outcome`/`priority_lane` and `chase_sets_projection_wake_intent_queue_age_ms` by `origin` show the `api-wait` series disappearing after the api-wait kill and the disabled lane's consumption stopping.
   - Alerts in `platform-worker-wake-alerts.yml` (fan-out failure rate, attempts-exhausted rate, hot-lane queue age p95) confirm the change did not trip failure modes.
3. Log event types:
   - Relay: `projection-wake-relay.session.ended` (status `no-enabled-sources` once idle), `projection-wake-relay.fan_out.*`, `projection-wake-relay.listener.*`, `projection-wake-relay.catch_up.*`.
   - Scheduler: `projection-wake.intent.claimed/completed/not_ready/deferred/unknown_target/run_failed/attempts_exhausted`, `work-signals.cleanup.completed`.
   - Controls: `projection-wake.controls.projections_disabled` (worker startup, includes `unknownDisabledProjectionKeys`).
4. Confirm the invariant: run a read-after-write smoke (for example a checkout session self-refresh) and verify the route still serves fresh data within its wait budget via polling; see the [Projection Freshness Audit runbook](./projection-freshness-audit.md) for the audit record fields.

## Related Documents

- [Source-Context Wake Registry](../architecture/source-context-wake-registry.md) — rollout states, validators, production evidence gates.
- [Projection Wake Relay](../architecture/projection-wake-relay.md) — relay runtime, catch-up, degraded modes.
- [Projection Wake-Intent Scheduler](../architecture/projection-wake-scheduler.md) — lanes, retries, fallback polling guarantees.
- [Push-Driven Projection Runtime Phase Map](../architecture/push-driven-projection-runtime-phase-map.md) — phase gates and rollout waves.
- [Push-Wake Connection Budget](../architecture/push-wake-connection-budget.md) — listener/pool budget when re-enabling.
