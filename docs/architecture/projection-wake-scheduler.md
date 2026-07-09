# Projection Wake-Intent Scheduler

## Purpose

The wake-intent scheduler is the worker-side consumer of the durable control-plane work-signal store. The relay and API wake-before-wait paths enqueue coalesced projection wake intents; the scheduler turns due intents into safe projection runs without bypassing any existing runner protection. It is the bridge between "durable wake accepted" and "projection checkpoint advanced".

## Consumption Topology

Scheduler lane runners live in the platform worker's `wakes` runner group and claim intents from `platform_projection_wake_intents` through pooled control-database query connections. Ordinary workers never hold source-database listeners; the active relay remains the only `LISTEN` owner. Each claim filters by:

- the runner's priority lane (`hot`, `standard`, or `bulk`), and
- the target context names whose projection groups the worker actually hosts.

Claims use the indexed due-claim path (`FOR UPDATE SKIP LOCKED`, fencing tokens, claim TTLs), so multiple workers and lane runners can claim concurrently without duplicate execution.

## Execution Contract

A claimed intent maps to a projection group by `targetContextName` + `projectionName` and to a subscription by `checkpointKey`. Execution preserves the polling runtime's protections:

1. If the subscription's durable checkpoint already satisfies the claimed required position, the intent completes without running anything. Duplicate and out-of-order wake hints terminate here instead of creating work churn.
2. Otherwise the scheduler runs the projection group under the same control-plane lease name the polling loop uses (`projection-group:<target>.<projection>`), so a push wake can never run a projection concurrently with the fallback poller or another wake runner. Leases, fencing, ledgers, blocked-stream and poison handling are unchanged because the run goes through the same projection-group runner.
3. Inside one claim the scheduler drains toward the claimed required position for up to `maxRunsPerClaim` batches, stopping early when the checkpoint stops advancing, so a multi-batch backlog does not burn one claim cycle per batch.
4. Wake runs never reset projection state: a projection group with a stale revision pending rebuild defers the intent (`revisionStaleRetryMs`) and leaves rebuilds to the polling and operations paths.
5. If the group lease is busy, the intent defers with a short retry after re-checking the durable checkpoint, because the concurrent holder may already be advancing it. The polling loop cooperates: it releases a projection-group lease after every idle pass (`processed == 0`) instead of holding it, so a wake runner — usually on another worker — acquires the lease on its next claim and read-after-write freshness runs at wake latency rather than polling-rotation latency. Only actively draining groups (processed > 0) keep their lease across passes (issue #4730: a hoarded idle lease forced a checkout hot intent through ~180 one-second claim/defer cycles until the holder's rotation happened to advance the checkpoint itself).
6. Completion is tied to durable positions only: the intent completes when the refreshed checkpoint reaches the claimed required position. The store re-queues an intent whose required position advanced past the claimed snapshot while it ran, and the scheduler reports that distinctly as a requeued completion.
7. On completion the scheduler records checkpoint readiness in the work-signal store, which satisfies registered API freshness waiters for that checkpoint.

## Fairness, Backpressure, And Poison Behavior

- Lane runners are dedicated per priority lane with configurable instance counts, so hot-path bursts cannot starve standard or bulk intents indefinitely. Lane runner loop leases are single flight per lane instance **within a hosted-context cohort**: the lease identity binds the lane instance to the worker's sorted, deduped hosted target-context set (a `ctx-<digest>` token). Workers with an identical hosted-context set share one lease, so lane throughput and the wake connection budget still scale with configured runner counts rather than worker instance count. Because claims are scoped to the claiming worker's hosted contexts, a fleet that is heterogeneous in hosted contexts (rolling deploys, an App Platform + DOKS estate cutover on one control database, a `WORKER_WAKE_DISABLED_PROJECTIONS` split, or a runtime-profile divergence) gets one lane lease per cohort. This guarantees every hosted target context always has a lane runner that can claim its intents; a lane lease held by a worker that does not host a given context can never starve that context's intents platform-wide (issue #4643 / #4633).
- Hot-lane runners are the `wakes` runner loop's reserved-capacity class (see Reserved Hot-Lane Capacity below), so a hot wake can never wait behind in-flight standard/bulk passes for a loop slot.
- Each runner pass claims at most `maxClaimsPerRun` intents; the runner loop's poll interval and lease bound the pass.
- Retries that made checkpoint progress requeue quickly (`deferredRetryMs`) without escalating; retries with no progress use exponential backoff on `next_eligible_at` (`retryBackoffBaseMs` to `retryBackoffMaxMs`).
- Store-level failures propagate to the runner loop's failure backoff, which slows claiming while the control database is unhealthy. A projection run failure durably retries the intent and ends the pass without backing off the whole lane.
- Intents whose target projection group or checkpoint is not hosted by the claiming worker fail with a longer retry so another worker or a newer deploy can claim them.
- Crossing `maxAttempts` without progress emits a single attempts-exhausted observer event for alerting; bounded `expires_at` retention reaps intents that never become satisfiable. Expiry is safe because durable event rows remain the source of truth and fallback polling still drains the projection.

## Reserved Hot-Lane Capacity

The `wakes` runner group is its own worker loop with its own concurrency budget (`WORKER_WAKE_MAX_CONCURRENT_RUNNERS`), so projection polling, jobs, dispatch, and scheduled runners can never consume wake capacity. Within that loop, hot/standard/bulk lane runners used to compete round-robin for the same slots, which let a long standard/bulk pass (up to `maxClaimsPerRun` claims of `maxRunsPerClaim` projection batches each) delay a critical checkout/payment/proof wake by a whole pass. The loop now reserves capacity for the hot lane:

- Hot-lane runners are flagged as the loop's reserved-capacity class. Reserved slots fill first on every scheduling pass and accept only hot-lane runners; standard/bulk runners can never occupy them. A hot wake therefore always finds a slot, no matter how saturated the shared lanes are.
- The platform worker requests `WORKER_WAKE_HOT_LANE_RUNNER_COUNT` reserved slots for the wakes loop. The loop clamps the effective reservation to `min(hot lane runner count, WORKER_WAKE_MAX_CONCURRENT_RUNNERS - 1)` whenever non-hot lanes exist, so standard/bulk (and the rest of the shared rotation) always keep at least one slot — the reservation can protect the hot path but can never starve normal lanes, reconciliation, or cleanup work.
- Beyond the reservation, hot-lane runners compete fairly in the original shared rotation, so extra hot runners do not preempt shared capacity.
- Bypass stops at scheduling: claimed hot intents still run through the same projection-group lease, fencing tokens, ledgers, blocked-stream/poison handling, and durable-position completion as every other lane.
- With wake concurrency 1, the clamp makes the reservation zero and the loop degrades to the previous fair rotation; nothing breaks, but the hot lane loses its guarantee. Keep `WORKER_WAKE_MAX_CONCURRENT_RUNNERS >= WORKER_WAKE_HOT_LANE_RUNNER_COUNT + 1` wherever hot-path wakes are enabled.

The effective reservation is observable: each loop's status (in `/internal/workers/status` under `loops`) reports `reservedRunnerSlots` and `activeReservedSlotCount`, and `projectionWakeControls.hotLaneReservedRunnerSlots` surfaces the wakes-loop value next to the lane runner counts.

### Capacity Guidance For Hot-Path Lanes

Before enabling an additional hot-path source context (registry `priorityLane: "hot"`) or raising lane throughput, walk the chain:

1. **Worker loop:** `WORKER_WAKE_MAX_CONCURRENT_RUNNERS >= WORKER_WAKE_HOT_LANE_RUNNER_COUNT + 1`. Raise the hot lane runner count when the hot-lane queue age p95 alert (`platform-worker-wake-alerts`) fires or the wake-intent summary shows sustained queued hot intents with idle standard/bulk lanes; raise wake concurrency alongside it to keep the reservation real.
2. **Worker database pool:** the sum of all runner group concurrencies (projections, operations, jobs, inventory import, dispatch, scheduled, wakes) must stay at or below `DATABASE_POOL_MAX`; the worker capacity assertion fails startup and the Terraform `worker_runner_capacity` check fails the plan otherwise. App Platform staging runs wake concurrency 3 with 1/2/1 lane runners (reserved hot slot 1, two shared wake slots) and a worker pool maximum of 14. DOKS staging uses the compact runner baseline plus the same wake headroom, so its generated staging Helm overlay sets pool 9. Production runs wake concurrency 2 with 1/1/1 lane runners and a worker pool maximum of 8, so any production wake increase needs `worker_database_pool_max` raised first.
3. **Control-plane wake store:** every lane runner adds one claim query per poll interval plus claim/complete/fail traffic per intent against `platform_projection_wake_intents`; the registry's `wakeStoreLoadEstimate` for the new source context indicates expected intent volume. Watch the wake-intent summary (stale claims, oldest ages) after enabling.
4. **Cluster connection budget and deployment overlap:** pool maxima, relay listener connections, and rolling-deploy doubling are modeled in the plan-time `wake_connection_budget` check; see `docs/architecture/push-wake-connection-budget.md` before changing pool sizes or instance counts.

Load-level proof that hot paths stay near real time under representative background backlog and relay reconnect bursts is owned by the SLO/load-proof work (#1237) in staging and production proof mode.

## Fallback Polling

The existing projection-group runners in the `projections` group are untouched. They remain the reconciliation path for missed notifications, relay restarts, listener loss, disabled wake rollout, and disaster recovery. Disabling the scheduler (`WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED=false`) removes push acceleration only; exact read-after-write waits and polling freshness are unaffected.

## Retention Cleanup

A scheduled `work-signals.cleanup` runner claims a control-plane scheduled-runner slot and runs the work-signal store cleanup (expiring overdue intents and pruning completed/expired intents, stale readiness rows, and stale waiters) on a bounded interval, operationalizing the store's retention contract.

## Configuration

Platform worker environment variables, all with safe defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED` | `true` | Consumer-side kill switch for the wake scheduler runners. |
| `WORKER_WAKE_MAX_CONCURRENT_RUNNERS` | `2` (`3` in staging) | Concurrency budget for the `wakes` runner group (counted by the worker capacity assertion and the Terraform worker capacity check). Keep it at least the hot lane runner count + 1 so the hot-lane reservation is effective. |
| `WORKER_WAKE_POLL_INTERVAL_MS` | `1000` | Poll cadence of the `wakes` runner group loop. |
| `WORKER_WAKE_HOT_LANE_RUNNER_COUNT` | `1` | Hot lane runner instances; also the requested reserved-slot count for the wakes loop (clamped to wake concurrency - 1 while other lanes exist). |
| `WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT` | `1` (`2` in staging) | Standard lane runner instances. |
| `WORKER_WAKE_BULK_LANE_RUNNER_COUNT` | `1` | Bulk lane runner instances. |
| `WORKER_WAKE_MAX_CLAIMS_PER_RUN` | `10` | Bounded claims per runner pass. |
| `WORKER_WAKE_CLAIM_TTL_MS` | `120000` | Wake-intent claim TTL; expired claims become reclaimable. |
| `WORKER_WAKE_RETRY_BACKOFF_BASE_MS` | `1000` | Per-intent retry backoff base. |
| `WORKER_WAKE_RETRY_BACKOFF_MAX_MS` | `60000` | Per-intent retry backoff ceiling. |
| `WORKER_WAKE_MAX_ATTEMPTS` | `10` | Attempt budget before attempts-exhausted alerting. |
| `WORK_SIGNAL_CLEANUP_INTERVAL_MS` | `60000` | Work-signal retention cleanup interval. |

Staging and production share this contract; only scale values differ. The Terraform worker capacity check includes the wake concurrency so deployed concurrency cannot exceed the worker database pool.

## Observability

Scheduler observer events separate claim, completion (ran vs. already satisfied), not-ready retry, lease-busy deferral, unknown target, run failure, attempts exhausted, lost claims, and readiness record failures, each carrying lane, origin, attempt count, and queue age. The worker status endpoint exposes the live wake-intent summary (queued, claimed, failed, expired, stale claims, oldest ages) for dashboards and the milestone's commit-to-checkpoint latency segmentation.

### Wake Pipeline Metrics

The platform worker emits `chase_sets_projection_wake_*` metrics from the relay and scheduler log observers: relay catch-up passes (count, duration, events), fan-out outcomes (enqueued/skipped/failed with reason and lane, enqueued intent counts, notification age), and wake-intent outcomes (per outcome/lane/origin/target with queue age and processing duration), plus `chase_sets_projection_freshness_wake_requests_total`, `chase_sets_projection_freshness_wake_enqueue_duration_ms`, and `chase_sets_projection_freshness_work_signal_errors_total` from the API freshness audit and wake-before-wait gateway paths. The Projection Wake Pipeline Grafana dashboard (`chase-sets-projection-wake-pipeline`) charts these series, and the `platform-worker-wake-alerts` provisioning group alerts on fan-out failures, attempts-exhausted intents, hot-lane queue age p95, and work-signal error rate. Emission-side notification metrics (`chase_sets_projection_wake_notifications_total`) land with the per-context event-store emission observer seam.

## API Wake-Before-Wait And Checkpoint Readiness

Read-after-write freshness waits integrate with the work-signal store through a check-then-wake contract:

1. The read-consistency middleware performs its first durable freshness check against projection checkpoints. Only when dependencies are actually behind the commit receipt does it issue one wake batch — exact `api-wait` wake intents on the hot lane for precisely the pending `(source, target, projection, checkpoint)` tuples.
2. Wake batches are bounded on the request path: deduplicated per checkpoint, capped per wait, clamped to the durable source head (commit receipts are unauthenticated client input), and raced against a small time budget so a slow control database can never hold a freshness wait past its own timeout. A batch that loses the race completes in the background.
3. The bounded durable poll continues unchanged as the unconditional fallback, so a wake landing between the check and the wait can never strand a request, and disabling the gateway never removes exact waits.
4. API processes only write wake-intent rows through pooled control-database queries; they hold no listener connections. Durable checkpoint-waiter registration exists in the gateway but stays off by default until the readiness-notification wait path that consumes waiter rows lands.
5. Checkpoint readiness is recorded from durable checkpoints only: wake-driven scheduler completions record it, and polling-path projection runs record it for subscriptions whose checkpoints advanced. Empty-batch skip-ahead checkpoint advances do not record readiness; the durable poll covers that gap. Readiness rows are cleared when a projection group resets for a revision rebuild or an operator rebuild so stale positions cannot outlive their checkpoints, and bounded readiness TTLs reap anything cleared out-of-band.
6. Wake-request counts and work-signal errors appear in the read-after-write freshness audit records for dashboards. Public freshness-timeout responses redact raw projection errors and internal checkpoint topology; the audit record keeps the detail.
7. Rollout: `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED` defaults off and rides a staging-first ramp in Terraform; production enablement follows the milestone rollout-control gates and the post-deploy synthetic probe and freshness-SLO evidence.

## Boundaries

- The scheduler does not listen to source databases and does not parse wake notifications; that is the relay's job.
- The scheduler does not decide rollout; source enablement stays in the source-context wake registry, and no intents exist for disabled sources.
- The platform-worker landing profile currently relies on fallback polling for admin support workloads; its wake consumption lands with the projection-group migration inventory work. The platform-api landing profile likewise runs without the wake-before-wait gateway until its contexts enter the rollout inventory.
