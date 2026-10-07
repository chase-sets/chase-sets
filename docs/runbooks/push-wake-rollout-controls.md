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

Helm is the flag authority: `infrastructure/helm/platform/runtime-values.json` supplies the base component env and `productionEnvOverrides`; `scripts/render-platform-helm-values.mjs` supplies staging overlays (`doksStagingWorkerEnvOverrides` and `doksStagingApiOverrides`). The renderer generates `infrastructure/helm/platform/values.yaml`, `infrastructure/helm/platform/values.staging.yaml`, and `infrastructure/helm/platform/values.production.yaml`. Staging/production merge their overlay over the base; previews use the base. Editing a source or re-rendering alone changes no running process: changes take effect only through a Platform Deploy.

| Helm-pinned flag | Preview | Staging | Production | Source |
| --- | --- | --- | --- | --- |
| `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED` | `false` | `false` | Helm base component env and `productionEnvOverrides` in `runtime-values.json` (values above); env var locally | Base component env; `productionEnvOverrides` |
| `WORKER_PROJECTION_WAKE_RELAY_ENABLED` | `false` | `true` | Helm base worker env, renderer staging overlay, and `productionEnvOverrides` (values above) | Base worker env; `doksStagingWorkerEnvOverrides`; `productionEnvOverrides` |
| `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED` | `false` | `false` | Helm base API env in `runtime-values.json`; `false` in every environment | Base API env |
| `READ_CONSISTENCY_READINESS_NOTIFICATIONS_ENABLED` | `false` | `false` | Helm base API env in `runtime-values.json`; `false` in every environment | Base API env |
| `REALTIME_WAKE_SIGNAL_ENABLED` | `false` | `false` | `true` | Base API env; `productionEnvOverrides` |
| `REALTIME_BACKGROUND_MAINTENANCE_ENABLED` | `false` | `false` | `true` | Base API env; `productionEnvOverrides` |
| `PROJECTION_INLINE_APPLY_ENABLED` | `false` | `true` | `false` | Base API env; `doksStagingApiOverrides.envOverrides` |
| `WORKER_WAKE_MAX_CONCURRENT_RUNNERS` | `2` | `3` | `2` | Base worker env; `doksStagingWorkerEnvOverrides` |
| `WORKER_WAKE_HOT_LANE_RUNNER_COUNT` / `WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT` / `WORKER_WAKE_BULK_LANE_RUNNER_COUNT` | `1` / `1` / `1` | `1` / `2` / `1` | Helm base worker env in `runtime-values.json`; renderer staging overlay sets standard lane to `2` (values above) | Base worker env; staging overrides the standard lane |
| `WORKER_WAKE_STATEMENT_TIMEOUT_MS` | `30000` | `30000` | `30000` | Base worker env |

Flags not pinned in Helm use the consuming reader's defaults in every environment. `deployables/platform-worker/src/config.ts` reads `WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED=true` and `WORKER_WAKE_PUSH_DISPATCH_ENABLED=true` when unset; neither is a Helm declaration. Push dispatch controls the scheduler's push-driven dispatch path, not durable polling. Other unset worker controls and their defaults are listed below and in the [scheduler configuration](../architecture/projection-wake-scheduler.md#configuration).

| Control | Scope | Values | Where set | Effect | What it never affects |
| --- | --- | --- | --- | --- | --- |
| Source-context wake registry (`infrastructure/platform-runtime/source-context-wake-registry.ts`) | One source context, all environments | `rolloutState` (`not-eligible`, `eligible`, `staging-enabled`, `production-proof`, `production-enabled`, `disabled`, `opted-out`) plus `enablement.eventStoreWakeNotifications` / `enablement.relayFanOut` | Code change + deploy; validators enforce reasons for `disabled`/`opted-out` and production gate evidence (#1243, #1244, #1246, #1249) | Gates write-side wake emission per source (every context derives its config via `createEventStoreWakeNotificationConfigForSourceContext`) and relay fan-out per source (`listSourceContextWakeRelayConfigs`) | Event persistence, projection checkpoints, fallback polling |
| `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED` | One environment, all components that host write-side services (platform-api, platform-worker, bootstrap/seed jobs) | Unset/empty = enabled; `1`/`true`/`yes`/`on` = enabled; anything else = disabled | Helm base component env and `productionEnvOverrides` in `runtime-values.json` (values above); env var locally | Forces every registry-derived emission config off, so no `pg_notify` wake leaves any event store commit | Event commits, fallback polling, exact waits |
| `WORKER_PROJECTION_WAKE_RELAY_ENABLED` | One environment's platform-worker | Boolean env, default `true` in code | Helm base worker env, renderer staging overlay, and `productionEnvOverrides` (values above) | Stops the relay supervisor: no LISTEN sessions, no catch-up passes, no control-plane wake-intent fan-out | Source event rows, durable wake-store rows already enqueued, polling |
| `WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED` | One environment's platform-worker | Boolean env, default `true` | Unset in Helm; effective default `true` from `deployables/platform-worker/src/config.ts` | Removes the `wakes` runner group: durable wake intents stop being claimed/run; queued intents age out via TTL + cleanup | Fallback polling (`projections` group), projection leases, rebuilds |
| `WORKER_WAKE_HOT_LANE_RUNNER_COUNT` / `WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT` / `WORKER_WAKE_BULK_LANE_RUNNER_COUNT` | One priority lane on the platform-worker | Non-negative integer, default `1`; `0` disables the lane (empty/invalid values keep the default, they do not zero the lane) | Helm base worker env in `runtime-values.json`; renderer staging overlay sets standard lane to `2` (values above) | A zero-count lane gets no scheduler runners; intents in that lane stay queued until TTL expiry | Other lanes, polling, intent enqueueing |
| `WORKER_WAKE_DISABLED_PROJECTIONS` | One or more projection groups on the platform-worker | Comma-separated `<target-context>:<projection-name>` keys (registry `affectedProjectionNames` format, e.g. `checkout:checkout.cart-projection`); malformed entries fail worker startup | Unset in Helm; effective default empty list from `deployables/platform-worker/src/config.ts` | Marks the projection disabled in the relay interest index (no new relay fan-out intents) and removes it from the wake scheduler's hosted groups (this worker never wake-runs it) | Fallback polling for the same projection, exact waits, other projections |
| `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED` | One environment's platform-api (`api-wait` origin) | Boolean env, default `false` | Helm base API env in `runtime-values.json`; `false` in every environment | API stops enqueueing exact `api-wait` wake intents before read-after-write waits | The waits themselves: bounded durable polls run unchanged |
| `READ_CONSISTENCY_READINESS_NOTIFICATIONS_ENABLED` | One environment's platform-api read-after-write wait loop | Boolean env, default `false` | Helm base API env in `runtime-values.json`; `false` in every environment | API LISTENs for checkpoint-ready work-signal notifications to release the next freshness re-check before the poll interval | Durable checkpoint polling, timeout budgets, wake enqueueing |
| `READ_CONSISTENCY_ROUTE_TUNING_JSON` (+ `READ_CONSISTENCY_TIMEOUT_MS`, `READ_CONSISTENCY_POLL_INTERVAL_MS`, `READ_CONSISTENCY_EXACT_DEPENDENCY_MODE`) | One route's wait behavior on platform-api | JSON array of `{mountPath, routePath, timeoutMs, pollIntervalMs, exactDependencyMode}` | Unset in Helm; effective defaults from `deployables/platform-api/src/config.ts`: critical route tuning, timeout `2500` ms, poll `75` ms; `infrastructure/platform-runtime/config-schema.ts` supplies exact dependency mode `enabled` | Tunes per-route wait budget and dependency mode. This is a tuning knob, not a wake kill switch: there is no per-route wake disable (see scope assessment) | Wake enqueueing, polling correctness |
| `WORKER_WAKE_*` tunables (`WORKER_WAKE_MAX_CONCURRENT_RUNNERS`, `WORKER_WAKE_POLL_INTERVAL_MS`, `WORKER_WAKE_MAX_CLAIMS_PER_RUN`, `WORKER_WAKE_CLAIM_TTL_MS`, `WORKER_WAKE_RETRY_BACKOFF_BASE_MS`/`_MAX_MS`, `WORKER_WAKE_MAX_ATTEMPTS`, `WORK_SIGNAL_CLEANUP_INTERVAL_MS`, `WORKER_WAKE_RELAY_*`) | Worker wake throughput/backoff | Positive numbers | Helm pins max concurrency and statement timeout (values above); other tunables are unset in Helm, with effective defaults from `deployables/platform-worker/src/config.ts` | Throttles wake consumption under pressure without disabling it | Polling, lease single-flight |

`REALTIME_WAKE_SIGNAL_ENABLED` (SSE wake) is a separate realtime transport control covered by the [Realtime SSE runbook](./realtime-sse.md); production config requires it `true`, so it is not usable as a production kill switch.

`PROJECTION_INLINE_APPLY_ENABLED` remains the inline-apply kill switch required by [ADR 0025](../adr/0025-write-path-inline-projection-apply.md), with the Helm values above; wake-before-wait and readiness notifications remain under the in-flight #2512 rollout. Unset relay tunables use `deployables/platform-worker/src/config.ts` defaults: catch-up batch `100`, standby retry `15000` ms, no-sources retry `60000` ms, failure backoff `5000` ms and maximum backoff `60000` ms.

## Scope Assessment (Honest)

Issue #1229 asks for kill switches scoped by environment, phase, source context, projection group, route, priority lane, and work-signal origin. Current truth:

| Scope | Status | How / gap |
| --- | --- | --- |
| Environment | Covered | Helm pins the environment values listed above: production emission/relay on, staging emission off/relay on, previews both off; api-wait/readiness off everywhere. |
| Source context | Covered | Registry `rolloutState` + `enablement` per source context, enforced by validators. Limitation: the registry is environment-global, so a per-context change is a code deploy, not an env flip. |
| Projection group | Covered on the worker (this change) | `WORKER_WAKE_DISABLED_PROJECTIONS` disables relay fan-out and wake-runs for the group. Limitation: platform-api does not read this env, so `api-wait` intents for a disabled group are still enqueued; the scheduler retires them as `unknown-target` retries until TTL expiry (bounded, logged, polling unaffected). |
| Route | Partial | `READ_CONSISTENCY_ROUTE_TUNING_JSON` tunes per-route wait budgets, and `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED` kills the whole `api-wait` origin, but there is no per-route wake disable. Gap accepted: route waits remain correct without wakes, so the per-deployment origin switch is the operative control. |
| Priority lane | Covered (this change) | Lane runner count `0` disables a lane's consumers. Before this change `0` silently fell back to the default of `1`; the config now accepts zero explicitly. |
| Work-signal origin | Partial | `relay` origin: `WORKER_PROJECTION_WAKE_RELAY_ENABLED`. `api-wait` origin: `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED`. The `reconciliation` and `operator` origins exist in the schema but have no emitters yet, so no switches exist for them. |
| Delivery phase | Not a runtime switch | Phases (`phase-1` through `phase-3`) are registry metadata gated by required-issue validators; "disabling a phase" means returning its source contexts to non-active rollout states (code change) or using the environment switches. There is no single phase-level env toggle. |
| Composite origins (durable jobs, outbox dispatchers, realtime; #1248) | Partial | The composite envelope/waiter primitives exist (`infrastructure/platform-runtime/work-signal-composite.ts`) and projection-operation events already emit composite `projection-operation.event` envelopes, but durable-job and realtime wake paths still use their own pre-composite `pg_notify` payloads (opaque ids only) pending the #1248 adapters, so no composite-wide rollout controls exist yet. Provider-outbox dispatchers continue on their own durable claim/poll loops untouched by every switch above. |

## Rollback Recipes

### Disable push for one source context

1. Edit `infrastructure/platform-runtime/source-context-wake-registry.ts`: set the entry's `rolloutState: "disabled"`, add a `disabledReason`, and remove the `enablement` block (both flags must return to `false`; validators reject active enablement on a disabled state).
2. Ship through a Platform Deploy. Write-side emission for that context turns off and the relay drops it from fan-out configs.
3. For a worker-side stop without changing the source registry, use `WORKER_WAKE_DISABLED_PROJECTIONS` with the context's `affectedProjectionNames` keys and/or the environment-level switches below. These changes still require a Platform Deploy; they are not an immediate live env flip.

### Disable push entirely in one environment

1. Set `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED=false` in the applicable Helm source above (including the production override) to stop new wake notifications from every component, including bootstrap jobs.
2. Set `WORKER_PROJECTION_WAKE_RELAY_ENABLED=false` in the applicable Helm source above (including the staging/production override) to stop relay listening, catch-up, and fan-out.
3. Leave `WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED=true` so already-queued intents drain; set it `false` only if the scheduler itself is the problem (queued intents then expire via TTL and the cleanup runner).
4. Optionally set `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED=false` to stop `api-wait` enqueues; with the scheduler still on this is not required for correctness.

Production currently has emission and relay on; staging has emission off and relay on; previews have both off. Re-render with `node scripts/render-platform-helm-values.mjs`, check with `node scripts/render-platform-helm-values.mjs --check`, then ship through a Platform Deploy. For normally unset worker controls, configure the worker env in the applicable Helm source only when an override is needed; unset continues to use the reader default.

### Disable one priority lane

1. Set the lane's runner count to zero in the base worker env in `infrastructure/helm/platform/runtime-values.json` or the renderer's staging worker overlay, e.g. `WORKER_WAKE_HOT_LANE_RUNNER_COUNT=0`; re-render/check and ship through a Platform Deploy.
2. Set the value to exactly `0` — empty or non-numeric values keep the default of `1` by design.
3. Expect intents in that lane to sit queued until `expires_at` (default 5 minutes) and be reaped by cleanup; the affected projections fall back to poll-bounded freshness.

### Disable api-wait wakes

1. Set `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED=false` in the base API env in `infrastructure/helm/platform/runtime-values.json` (already `false` everywhere), re-render with `node scripts/render-platform-helm-values.mjs`, check with `--check`, and ship through a Platform Deploy.
2. Read-after-write routes keep their exact durable waits and route tuning; they lose only the wake acceleration.

### Disable push for one projection group

1. Set `WORKER_WAKE_DISABLED_PROJECTIONS=<target-context>:<projection-name>[,...]` on the platform-worker, e.g. `WORKER_WAKE_DISABLED_PROJECTIONS=checkout:checkout.cart-projection`.
2. Configure the worker env in the applicable Helm source, re-render/check with `scripts/render-platform-helm-values.mjs`, and ship through a Platform Deploy. Startup logs `projection-wake.controls.projections_disabled` including any keys that match no hosted projection group (typo check).
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
4. Confirm the invariant: run the [Buy Now Freshness Probe](./guest-buy-now-freshness-probe.md) (`pnpm run guest-buy-now:freshness-probe`) against the affected environment and verify it still reaches pay-ready checkout within the readiness budget on polling alone; cross-check the route audit via the [Projection Freshness Audit runbook](./projection-freshness-audit.md). A rollback that leaves the probe failing is not a completed rollback — keep the release held and escalate per [Push-Wake Operations](./push-wake-operations.md).

## Related Documents

- [Source-Context Wake Registry](../architecture/source-context-wake-registry.md) — rollout states, validators, production evidence gates.
- [Push-First Projection Migration Inventory](../architecture/push-first-projection-migration.md) — disposition per projection group and route entry, opt-out policy.
- [Projection Interest Index](../architecture/projection-interest-index.md) — fan-out mapping, coarse-payload lookup, stale-index policy.
- [Push-Wake Recovery Drills](./push-wake-recovery-drills.md) — kill-switch flip drill procedure and post-flip convergence verification.
- [Projection Wake Relay](../architecture/projection-wake-relay.md) — relay runtime, catch-up, degraded modes.
- [Projection Wake-Intent Scheduler](../architecture/projection-wake-scheduler.md) — lanes, retries, fallback polling guarantees.
- [Push-Driven Projection Runtime Phase Map](../architecture/push-driven-projection-runtime-phase-map.md) — phase gates and rollout waves.
- [Push-Wake Connection Budget](../architecture/push-wake-connection-budget.md) — listener/pool budget when re-enabling.
