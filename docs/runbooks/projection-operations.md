# Projection Operations

## Triage

Use Admin Web `/operations/projections`.

1. Check `Status`, `Source Lag`, active workers, stale workers, and blocked streams.
2. For a lagging projection, compare the subscription row state with Worker Runners.
3. Treat `behind` as queued or waiting for worker capacity.
4. Treat `running` with rising positions as healthy draining.
5. Treat `behind` with no fresh runner update and active workers as possible starvation.
6. Treat `degraded` as stream-isolated poison work.

## Worker Capacity

Projection runners are isolated from bulk jobs and dispatchers. Increase projection catch-up capacity with:

```text
WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS
```

Keep database pool capacity in mind. If runner concurrency exceeds available database connections, increasing worker concurrency can make lag worse.

Default shared-resource worker concurrency is intentionally conservative:

- projections: `2`
- bulk jobs: `1`
- dispatchers: `1`
- scheduled jobs: `1`

Raise these only after checking database CPU, IO, connection pool saturation, and worker memory. On DigitalOcean shared-resource App Platform, prefer increasing projection capacity gradually or splitting heavy jobs into a separate worker deployable instead of letting all runner groups compete inside one small container.

`/internal/workers/status` reports configured runner concurrency, database pool size, per-group runner counts, active runners, and lease misses. Treat `overPoolCapacity: true` as a tuning warning, especially when projection backlog is growing.

Bulk jobs use:

```text
WORKER_JOB_MAX_CONCURRENT_RUNNERS
```

Dispatchers use:

```text
WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS
```

Scheduled jobs use:

```text
WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS
```

## Stale Workers

The operations API classifies worker heartbeats:

- `active`: heartbeat is fresh.
- `stale`: heartbeat is old enough to distrust for capacity.
- `expired`: heartbeat is historical restart noise.

Use active workers for capacity decisions. Stale and expired workers should not be counted as live drain capacity.

## Blocked Streams

When a projection is `degraded`:

1. Open the blocked stream details on the projection page.
2. Inspect the poison event message and stream id.
3. Fix the handler or data issue.
4. Retry the blocked stream.
5. Confirm deferred events drain and the projection returns to `caught-up` or `behind`.

Only the same projection plus stream is blocked. Other streams continue to process.

## Rebuild

Use rebuild when read-model state is suspect or when projection revision changes require a full replay.

- Rebuild group: truncates one projection group's owned tables, clears its checkpoints and application rows, then replays.
- Rebuild context: rebuilds all projection groups in one context.

Do not rebuild during peak write volume unless the degraded read model is worse than temporary catch-up pressure.

## Idempotency And Ledger Growth

Projection application rows are operational state, not business state. `applied` rows protect replay after checkpoint failures; `poison` and `transient` rows support repair. Keep an eye on table growth for `event_subscription_applications`, especially during full rebuilds or large catalog promotions.

Handlers that receive a transaction-scoped `db` handle should use it for all read-model writes in that event application. That makes the handler write and application ledger completion commit together.

The runtime compacts `applied` rows once they are more than 10,000 global positions behind the durable checkpoint. If an operator resets or rebuilds a projection, the projection key's checkpoints, application rows, poison events, and blocked stream state are cleared or superseded by the rebuild path.

## Healthy Catch-Up

Healthy catch-up looks like:

- Active worker count greater than zero.
- Runner rows updating recently.
- `last_processed` regularly above zero for lagging projections.
- Source lag decreasing or source head stabilizing.
- No blocked streams.

If source lag does not decrease:

1. Check active worker count.
2. Check runner concurrency configuration.
3. Check database CPU, IO, and connection pool saturation.
4. Check for degraded projections.
5. Scale projection workers or reduce competing job concurrency.

## Write Consistency

API writes should return after durable event append. They should not wait for projector drain unless an endpoint has an explicit compatibility requirement. Use `Chase-Sets-Commit-Position` and bounded read retries to diagnose read-your-writes behavior.
