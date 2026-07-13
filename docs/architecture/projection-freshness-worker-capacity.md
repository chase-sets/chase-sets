# Projection Freshness Worker Capacity

## Purpose

Critical read-after-write routes depend on projection workers keeping read models close to source events. This audit captures the platform worker topology and capacity posture for the first critical path: guest Buy Now checkout from `buy-checkout-readiness` to `/checkout/buy/session/:sessionId`, backed by `checkout.session-projection` and `checkout_session_pages`.

The historical staging incident cannot be attributed to a specific worker outage or backlog because the read-after-write audit fields were added after the failure. The strongest supported classification remains projection lag escaping as permanent not-found recovery. Current closure therefore depends on proving the present topology can meet the SLO and that operators can see worker absence, degraded projections, and lag.

## Current Topology

| Environment posture | Marketplace platform components | Worker instances | Per-worker projection concurrency | Per-worker total runner concurrency | Per-worker DB pool | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Preview | `platform-api` and `platform-worker` when marketplace platform is enabled | 1 | 1 | 7 | 7 | Smallest non-production posture; preview bootstrap may drain scenario projections. |
| Staging | Full `platform-api` and `platform-worker` | 2 | 2 | 11 | 11 | Provides four concurrent projection runner slots across two workers. |
| Production landing/admin-only | Profiled `platform-api` and `platform-worker`; no public marketplace flow | 1 platform worker | 1 | 7 | 7 | Guest Buy Now public marketplace is not exposed in this posture. |
| Production proof/public marketplace | `platform-api`, `platform-worker`, marketplace web, and commerce databases | 1 by default, overrideable | 1 | 7 | 7 | Required before production marketplace proof or public launch can exercise guest Buy Now. |

Terraform enforces that per-worker projection, job, dispatch, and scheduled runner concurrency does not exceed `worker_database_pool_max`. The relevant settings are:

- `worker_instance_count`: optional instance override, with staging defaulting to two workers and preview/production defaulting to one.
- `worker_database_pool_max`: optional worker `DATABASE_POOL_MAX` override, defaulting to `11` for staging and `7` elsewhere.
- `WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS`: `2` per worker in staging and `1` elsewhere by default.
- `WORKER_JOB_MAX_CONCURRENT_RUNNERS`: staging defaults to `4`, production/preview to `1`.
- `WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS`: `1`.
- `WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS`: `1`.

## Checkout Freshness Capacity Conclusion

The Checkout session projection was optimized before this audit:

- it subscribes only to `checkout.session-` streams;
- it checkpoints every applied session event;
- it writes through the runner transaction-scoped projection database;
- command continuations no longer depend on `checkout_session_pages` before appending follow-up session events.

Given that shape, staging's four total projection runner slots are enough for the first guest Buy Now SLO target unless workers are absent, restarting, blocked by poison events, or the database tier cannot keep up. Production proof/public marketplace starts with one total projection runner slot so the current database tier can also budget the direct Identity wake listener; treat that as launch minimum capacity, not headroom for broad traffic.

The platform API can still serve reads while projection workers are absent or restarting. That is intentional: API readiness should not fail merely because an eventually consistent worker is temporarily draining. The customer contract is:

- exact dependency wait for `checkout.session-projection`;
- temporary checkout recovery on `projection_freshness_timeout`, fresh-write not-found, or route-bounded gateway/service timeout;
- canary and operator evidence when timeout or lag persists.

Do not "fix" worker absence by removing the read consistency gate or widening normal traffic to target-context waits. Use route tuning only as an incident rollback with an owner and evidence link.

## Required Evidence For Critical Freshness

For guest Buy Now staging canary or release evidence, collect:

- `read-after-write.freshness` records for `/account/checkout-sessions/:sessionId`;
- `outcome=fresh` p95 and p99 wait durations against the SLO in `docs/architecture/projection-freshness-slos.md`;
- timeout records with pending `checkout.session-projection` state, required global position, last global position, and global-position lag;
- worker heartbeats from `/api/platform/projections`, with at least one active `platform-worker` during the observation window;
- worker status from `/internal/workers/status`, including `databasePoolPressure`, runner loop status, and `projectionWakeIntentBreakdown`;
- runner status for `projection-group:checkout.checkout.session-projection`;
- projection status snapshot source, source lag, applicable lag, blocked stream count, and poison event count for `checkout.session-projection`;
- confirmation that exact-dependency wait mode stayed enabled for normal canary runs.

For a live first read during an incident, call `GET /internal/workers/hot-lag-evidence` on the platform worker (same non-public-ingress surface as `/internal/workers/status`). It computes the same `primaryCause` (`worker-absent-or-stale`, `database-pool-pressure`, `projection-repair-needed`, `projection-group-lease-contention`, `hot-lane-queueing`, `background-work-pressure`, or `no-hot-lag-evidence`) in-process from current worker status and projection status snapshots, so an operator gets an attributed answer from one call instead of capturing two JSON files and running the CLI. It has no `--wake-outcomes` or `--background-controls` input (those come from Grafana/log exports outside a single process), so `projection-group-lease-contention` on this endpoint is only detected from runner `last_error` text, not from wake-outcome counters; treat a live `hot-lane-queueing` result with `confidence: "low"` as a prompt to pull the fuller offline evidence below, not as the final word.

For #2515 production-push handoffs, or when the live endpoint's confidence is low, turn the captured worker/projection JSON into a no-secret evidence record:

```powershell
pnpm run ops projection:hot-lag-evidence -- --worker-status <worker-status.json> --projection-status <projection-status.json> --out artifacts/projection-hot-lag-evidence.json
```

Add `--wake-outcomes <wake-outcomes.json>` when Grafana/log counters show `projection-wake.intent.*` outcomes; `outcome: "deferred"` or `reason: "projection-group-lease-busy"` lets the record distinguish projection-group lease contention from hot-lane queueing. The command records only structural counts and never reads URLs, secrets, wake payloads, or database rows directly.

Add `--background-controls <background-controls.json>` when the proof window includes representative refresh, replay/rebuild/backfill, provider import/promotion, bulk authoring, scheduled work, dispatch, or provider-delivery pressure. The JSON should include `workloads` rows with `workload`, `normalControl`, `pauseThrottleEvidence`, and `hotPathProof`; the report records only covered/missing workload keys and missing field names, not private operation ids, provider details, or raw artifacts.

The canary fails the platform freshness gate when:

- no worker heartbeat is active while a critical Checkout read times out;
- `checkout.session-projection` is degraded or has blocked streams during the canary;
- timeout rate exceeds the SLO while source or applicable lag remains above zero;
- the route falls back to target-context mode without a documented rollback;
- a permanent not-found renders while the fresh receipt is still valid.

## Background Workload Controls

Customer-visible freshness incidents must first be attributed before capacity is raised. For #2515 closure, every background workload runbook or drill record should prove the same support-safe control matrix:

| Workload | Normal control | Pause/throttle evidence | Hot-path proof |
| --- | --- | --- | --- |
| Representative commerce refresh | Bounded workflow dispatch, per-step timeout, selected current Catalog Item window. | Record `step_timeout_ms`, the timed-out step if any, and whether the refresh was rerun only after projection backlog was healthy. | Pair the latest representative refresh with a `representative-volume` wake load artifact or state why no refresh overlapped the hot-path window. |
| Projection replay/rebuild/backfill | Operator-owned projection operation with confirm gate and visible operation/job state. | Record the operation id as a private reference, projection group/context, cancel/pause outcome when available, and whether the job was left running during hot-path proof. | Capture `projection:hot-lag-evidence` plus a reconciliation or load drill if customer routes were measured while the operation was active. |
| Provider import/promotion and bulk authoring | Catalog-owned durable job with progress/recovery surface. | Record retry/resume/cancel posture from the admin job surface; keep provider payloads and raw ids private. | Verify wake load pressure attribution shows hot-lane queueing absent or explicitly attributed away from provider/bulk backlog. |
| Scheduled/dispatch/provider-delivery loops | Worker loop concurrency and retry/backoff policy. | Record loop saturation, retry/backoff state, and whether dispatch was paused by provider-safe controls rather than by disabling correctness fallbacks. | `projection:hot-lag-evidence` should attribute any lag to DB pool, lease contention, background pressure, or no observed hot lag. |

Do not disable read-consistency waits, durable catch-up, fallback polling, or projection correctness checks to make a background workload pass. The only acceptable mitigations are: pause or cancel the background owner, reduce its concurrency or batch size, wait for the bounded job to finish, add worker/database capacity within the pool budget below, or open a projection-group split/sharding issue with the drill artifact that proves single-flight lease contention remains.

Support-safe closure evidence for #2515 should include:

- latest `representative-volume` wake load run and paired reconciliation run;
- support-safe pressure attribution from `staging-wake-drill-load-evaluation.json`, especially hot vs standard/bulk/unknown queued counts;
- `projection:hot-lag-evidence` when a route miss, queue-age alert, or background overlap needs attribution;
- explicit statement that background replay/backfill/representative-refresh work was paused, throttled, completed, or intentionally active during the proof window;
- follow-up issue link when projection-group sharding, smaller projection groups, or additional runner capacity is required.

## Operator Response

Use Admin > Operations > Projection Operations first:

1. Confirm worker heartbeat state. Active means heartbeat age is within one minute; stale or expired workers are attention items.
2. Confirm `checkout.session-projection` has a worker snapshot or live-refresh data, not stale runtime memory.
3. Check source lag and applicable lag for the Checkout subscription from source context `checkout`.
4. If lag grows while workers are active, inspect database pool pressure and worker runner concurrency before increasing application size.
5. If blocked streams or poison events exist, use the Projection Poison Events runbook and retry only after fixing the handler or data cause.
6. If workers are absent after deployment, inspect DigitalOcean component health and deployment logs before treating Checkout route code as the cause.

## Capacity Changes

Prefer changes in this order:

1. Fix absent, stale, or crash-looping workers.
2. Resolve poison events or blocked streams.
3. Confirm the database tier and managed pool can support the current worker DB pool.
4. Increase `worker_instance_count` for more projection slots across processes.
5. Increase `worker_database_pool_max` only when the database tier can support the added managed-pool connections.
6. Increase `WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS` only with a matching pool budget and after checking job/dispatch/scheduled runner demand.
7. Apply route-specific read-consistency tuning for the Checkout session route only as a temporary incident rollback.

Sustained Checkout freshness timeout-rate failures after these checks should open a new capacity remediation issue with the canary window, worker heartbeat evidence, projection lag, database pool posture, and route tuning state.
