# Projection Freshness Worker Capacity

## Purpose

Critical read-after-write routes depend on projection workers keeping read models close to source events. This audit captures the platform worker topology and capacity posture for the first critical path: guest Buy Now checkout from `checkout-start` to `/checkout/:sessionId`, backed by `checkout.session-projection` and `checkout_session_pages`.

The historical staging incident cannot be attributed to a specific worker outage or backlog because the read-after-write audit fields were added after the failure. The strongest supported classification remains projection lag escaping as permanent not-found recovery. Current closure therefore depends on proving the present topology can meet the SLO and that operators can see worker absence, degraded projections, and lag.

## Current Topology

| Environment posture | Marketplace platform components | Worker instances | Per-worker projection concurrency | Per-worker total runner concurrency | Per-worker DB pool | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Preview | `platform-api` and `platform-worker` when marketplace platform is enabled | 1 | 2 | 5 | 8 | Smallest non-production posture; preview bootstrap may drain scenario projections. |
| Staging | Full `platform-api` and `platform-worker` | 2 | 2 | 8 | 8 | Provides four concurrent projection runner slots across two workers. |
| Production landing/admin-only | `admin-support-api` and admin-support worker; no public marketplace flow | 1 admin-support worker | 2 | 5 | 6 | Guest Buy Now public marketplace is not exposed in this posture. |
| Production proof/public marketplace | `platform-api`, `platform-worker`, marketplace web, and commerce databases | 1 by default, overrideable | 2 | 5 | 6 | Required before production marketplace proof or public launch can exercise guest Buy Now. |

Terraform enforces that per-worker projection, job, dispatch, and scheduled runner concurrency does not exceed `worker_database_pool_max`. The relevant settings are:

- `worker_instance_count`: optional instance override, with staging defaulting to two workers and preview/production defaulting to one.
- `worker_database_pool_max`: optional worker `DATABASE_POOL_MAX` override, defaulting to `8` for non-production and `6` for production.
- `WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS`: currently `2` per worker.
- `WORKER_JOB_MAX_CONCURRENT_RUNNERS`: staging defaults to `4`, production/preview to `1`.
- `WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS`: `1`.
- `WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS`: `1`.

## Checkout Freshness Capacity Conclusion

The Checkout session projection was optimized before this audit:

- it subscribes only to `checkout.session-` streams;
- it checkpoints every applied session event;
- it writes through the runner transaction-scoped projection database;
- command continuations no longer depend on `checkout_session_pages` before appending follow-up session events.

Given that shape, staging's four total projection runner slots are enough for the first guest Buy Now SLO target unless workers are absent, restarting, blocked by poison events, or the database tier cannot keep up. Production proof/public marketplace starts with two total projection runner slots and should be treated as launch minimum capacity, not headroom for broad traffic.

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
- runner status for `projection-group:checkout.checkout.session-projection`;
- projection status snapshot source, source lag, applicable lag, blocked stream count, and poison event count for `checkout.session-projection`;
- confirmation that exact-dependency wait mode stayed enabled for normal canary runs.

The canary fails the platform freshness gate when:

- no worker heartbeat is active while a critical Checkout read times out;
- `checkout.session-projection` is degraded or has blocked streams during the canary;
- timeout rate exceeds the SLO while source or applicable lag remains above zero;
- the route falls back to target-context mode without a documented rollback;
- a permanent not-found renders while the fresh receipt is still valid.

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
