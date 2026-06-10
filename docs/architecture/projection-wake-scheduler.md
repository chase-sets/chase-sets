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
5. If the group lease is busy, the intent defers with a short retry after re-checking the durable checkpoint, because the concurrent holder may already be advancing it.
6. Completion is tied to durable positions only: the intent completes when the refreshed checkpoint reaches the claimed required position. The store re-queues an intent whose required position advanced past the claimed snapshot while it ran, and the scheduler reports that distinctly as a requeued completion.
7. On completion the scheduler records checkpoint readiness in the work-signal store, which satisfies registered API freshness waiters for that checkpoint.

## Fairness, Backpressure, And Poison Behavior

- Lane runners are dedicated per priority lane with configurable instance counts, so hot-path bursts cannot starve standard or bulk intents indefinitely. Lane runner loop leases are platform-wide single flight per lane instance, so lane throughput scales with configured runner counts rather than worker instance count.
- Each runner pass claims at most `maxClaimsPerRun` intents; the runner loop's poll interval and lease bound the pass.
- Retries that made checkpoint progress requeue quickly (`deferredRetryMs`) without escalating; retries with no progress use exponential backoff on `next_eligible_at` (`retryBackoffBaseMs` to `retryBackoffMaxMs`).
- Store-level failures propagate to the runner loop's failure backoff, which slows claiming while the control database is unhealthy. A projection run failure durably retries the intent and ends the pass without backing off the whole lane.
- Intents whose target projection group or checkpoint is not hosted by the claiming worker fail with a longer retry so another worker or a newer deploy can claim them.
- Crossing `maxAttempts` without progress emits a single attempts-exhausted observer event for alerting; bounded `expires_at` retention reaps intents that never become satisfiable. Expiry is safe because durable event rows remain the source of truth and fallback polling still drains the projection.

## Fallback Polling

The existing projection-group runners in the `projections` group are untouched. They remain the reconciliation path for missed notifications, relay restarts, listener loss, disabled wake rollout, and disaster recovery. Disabling the scheduler (`WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED=false`) removes push acceleration only; exact read-after-write waits and polling freshness are unaffected.

## Retention Cleanup

A scheduled `work-signals.cleanup` runner claims a control-plane scheduled-runner slot and runs the work-signal store cleanup (expiring overdue intents and pruning completed/expired intents, stale readiness rows, and stale waiters) on a bounded interval, operationalizing the store's retention contract.

## Configuration

Platform worker environment variables, all with safe defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED` | `true` | Consumer-side kill switch for the wake scheduler runners. |
| `WORKER_WAKE_MAX_CONCURRENT_RUNNERS` | `2` | Concurrency budget for the `wakes` runner group (counted by the worker capacity assertion and the Terraform worker capacity check). |
| `WORKER_WAKE_POLL_INTERVAL_MS` | `1000` | Poll cadence of the `wakes` runner group loop. |
| `WORKER_WAKE_HOT_LANE_RUNNER_COUNT` | `1` | Hot lane runner instances. |
| `WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT` | `1` | Standard lane runner instances. |
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

## Boundaries

- The scheduler does not listen to source databases and does not parse wake notifications; that is the relay's job.
- The scheduler does not decide rollout; source enablement stays in the source-context wake registry, and no intents exist for disabled sources.
- The admin-support worker currently relies on fallback polling; its wake consumption lands with the projection-group migration inventory work.
- Recording checkpoint readiness from polling-path runs and the API freshness-wait integration are owned by the checkpoint-readiness issue, not this scheduler.
