# Projection Operations

Use `/api/platform/projections` for snapshot-first projection status. The summary endpoint is intentionally cheap during incidents; load blocked stream details with `/api/platform/projections/:projectionKey/blocked-streams` only when needed.

Projections are normally woken by the push-first pipeline (event-store wake notifications -> relay -> durable wake intents -> wake scheduler); the worker poll loop is the correctness fallback, not the primary trigger. If the question is "why is freshness slow" rather than "why is this projection broken", start with Grafana's `Projection Wake Pipeline` dashboard and the [Push-Wake Operations](./push-wake-operations.md) runbook. Return to this console when the next action is retry, rebuild, cancel, or inspecting durable projection operation state.

## Admin Console

Open Admin > Operations > Projection Operations.

The console is owned by the Platform Operations bounded context. It should be used as an attention-first triage surface, not as a raw table dump:

1. Start with the summary band and confirm whether the console says `Healthy`, `Running`, `Review`, `Stale`, or `Needs attention`.
2. Review the Attention tab before scanning routine projection groups.
3. Select a failed operation, degraded projection group, blocked stream, stale worker, or stale revision to open its detail panel.
4. Retry blocked streams only from blocked-stream detail after the handler or data issue is fixed.
5. Rebuild a projection group only from projection-group detail and only when replay is the safer repair path.
6. Cancel queued or running operations from operation detail when the work should stop at the next safe lease or transaction boundary.

## Backlog

- Check `sourceLagEventCount` for drain distance.
- Check `applicableLagEstimate` for the number of events that match the projection subscription filters. If it is absent, use source lag only as scan distance.
- Check worker heartbeats and runner statuses to confirm active capacity.
- A projection can be `running` with source lag while a worker is draining it; `idle` should not be interpreted as caught up.

## Operation Queue

- Admin rebuild and retry actions enqueue durable projection operations.
- Workers claim queued operations from the control plane and execute them under worker leases.
- Rebuild operations also acquire the target projection-group runner lease before resetting checkpoints or replaying events.
- If an operation is `running` but the claiming worker disappears, wait for the claim TTL to expire; another worker can then reclaim it.
- If an operation is `cancel_requested`, the owning worker should stop at the next lease guard or transaction boundary and mark it `cancelled`.
- Non-projection job runners use the same deployment discipline: check the worker
  signal and lease guard before claims, between batch items, before provider
  calls, and before completion writes. Deployment cancellation should preserve
  progress and release or expire the claim rather than record business failure.
- Use the Operations tab in Admin to inspect queued, running, succeeded, failed, cancel-requested, and cancelled operations.
- The operation history API supports filters for `contextName`, `projectionName`, `state`, and `requestedByUserId`.
- Operation summaries expose queued count, running count, failed count, cancel-requested count, oldest queued/running timestamps, and average operation duration.

### Attempts, Backoff, Timeouts, and Dead-Lettering

- Every claim charges an attempt (`attempt_count`) and sets an eligibility horizon (claim TTL plus exponential backoff), so an operation whose worker dies without a terminal write is reclaimed only after backoff and never hot-loops at the head of the queue.
- An operation that cannot acquire its projection-group runner lease waits briefly for the lease (the idle degraded group runner yields it between passes), and on sustained contention is requeued as retryable with backoff instead of failing terminally.
- An operation that exceeds its execution deadline (`WORKER_PROJECTION_OPERATION_TIMEOUT_MS`, rebuilds use `WORKER_PROJECTION_OPERATION_REBUILD_TIMEOUT_MS`) is aborted and recorded as failed with a timeout message; a hung operation can no longer pin an executor runner while renewing its claim forever.
- Once `attempt_count` reaches `WORKER_PROJECTION_OPERATION_MAX_ATTEMPTS`, the claim sweep dead-letters the operation: state `failed` with error code `attempts_exhausted`, preserving the last recorded error. Re-request the retry or rebuild after fixing the underlying cause.
- Operation executors run in the dedicated `operations` worker runner group (`WORKER_PROJECTION_OPERATION_RUNNER_COUNT` runners, cluster-wide leases), so queued recovery operations are not starved by projection-group backlog.

## Poison Events

Poison handling is stream-isolated. A projection group reports `degraded` when it is still draining unrelated streams but at least one stream is blocked by a poison event; `error` means the runner could not make progress for the turn. Unrelated streams continue to drain while one stream is blocked, and later events from the blocked stream remain unapplied for that projection.

### Triage

1. Open Admin > Operations > Projection Operations and start in the Attention tab.
2. Select the blocked stream or degraded projection group and check source lag, applicable lag, blocked stream count, and poison event count.
3. Inspect poison event detail: projection key, event type, stream id, stream version, global position, retry count, first/last seen timestamps, and error message.
4. Decide whether the failure is a handler bug, malformed historical data, missing reference data, or a projection definition change.

Do not ask publishers to re-run the command as the first response. Publishers already wrote durable events; the projection consumer owns catch-up and repair.

### Repair choices

- Fix a handler bug or missing reference data, then retry the blocked stream from the blocked-stream detail panel. Retry must preserve stream order — apply the first blocked event before later deferred events from the same stream.
- Mark a poison event ignored only when the owning context documents why the event is irrelevant or safely lossy for that projection.
- Rebuild the projection group when the projection definition changed or when many blocked streams indicate replay is safer than individual repair.

## Permissions

Projection Operations uses incident-focused permissions instead of the broader Access security gate:

- `projection-operations.view` can inspect projection, wake, worker, blocked-stream, and durable operation state.
- `projection-operations.operate` can refresh live status, retry blocked streams, and request cancellation for queued or running operations.
- `projection-operations.rebuild` can queue projection-group or context rebuilds. Rebuild operations record the requesting user and account in the durable control-plane operation.

Catalog keeps its launch-ready `catalog.view` / `catalog.manage` split for now. The catalog control plane already distinguishes safe reads from destructive writes and enforces `catalog.manage` for provider profile authoring, lifecycle actions, imports, promotion, review, rollback, reapply, and replay. Revisit catalog author/provider/governance sub-tiers after Admin Workflows Staging QA if operator evidence shows the two-tier model blocks real staffing or audit needs.

Blocked-stream operations use those tiers:

- `GET /api/platform/projections/:projectionKey/blocked-streams` lists active blocked stream and poison details for one projection key and requires `projection-operations.view`.
- `POST /api/platform/projections/:projectionKey/blocked-streams/:streamId/retry` replays one blocked stream in stream-version order and requires `projection-operations.operate`.

### Escalate as a projection correctness incident when

- a `global-strict` projection is in `error`,
- blocked stream count grows quickly,
- the same event type poisons many streams,
- outstanding backlog or degraded lag affects operator workflows or customer-facing reads, or
- repair fails after the handler or data fix is deployed.

## Rebuild

- Projection rebuilds are worker-owned queued operations, not synchronous API requests.
- Projection rebuilds replay from checkpoints without truncating live read tables.
- If a projection needs destructive replacement, declare an explicit reset strategy. Prefer projection-specific generation/shadow cutover; use `truncate-owned-tables` only for operator-hidden read models where temporary emptiness is acceptable.
- A failed rebuild should leave the currently visible read model intact unless the projection has explicitly declared a safe generation or shadow-table cutover.
- `generation-cutover` projections must write/read generation-scoped rows and should cut over only after replay catches up. Without a projection-specific adapter, generation cutover fails closed.

Replayable read-model tables use PostgreSQL `UNLOGGED` storage. The source event tables, `event_projection_checkpoints`, and `event_subscription_checkpoints` remain logged. Each checkpoint advance also writes the unlogged `event_projection_recovery_markers` table. PostgreSQL crash recovery truncates that marker together with the unlogged read models while preserving the logged checkpoint, so the next status refresh detects a checkpoint whose recovery marker is missing or behind. The projection-group runner then applies the group's existing reset contract, deletes its durable subscription checkpoint, and replays from checkpoint zero before reporting the group caught up. A legitimately empty projection keeps its marker and does not rebuild merely because its read-model table has no rows.

Do not convert outboxes, webhook inboxes/provider event ledgers, idempotency or reaction-effect tables, durable jobs/work queues, authentication tokens, provider operations, or other non-event-rebuildable state to unlogged storage. Their rows participate in delivery, deduplication, reconciliation, or authorization and must survive a database crash.

## Rebuild RTO Benchmark

Full projection rebuild wall time is the recovery-time objective for disposable or unlogged projection storage. Measure it against staging-scale representative commerce state before choosing cheaper projection storage, splitting projection stores, or accepting rebuild-on-crash recovery.

Run the benchmark from an operator shell with the same database posture used by the target environment:

```powershell
pnpm run replay:projection -- platform-api benchmark --all --out artifacts/release-health/projection-rebuild-benchmark.json
```

To benchmark one context or only bootstrap-required groups:

```powershell
pnpm run replay:projection -- platform-api benchmark checkout --out artifacts/release-health/projection-rebuild-benchmark-checkout.json
pnpm run replay:projection -- platform-api benchmark --all --required-only --out artifacts/release-health/projection-rebuild-benchmark-required.json
```

The artifact uses `projection-rebuild-benchmark/v1` and records total wall time, per-context wall time, projection group counts, pre/post replay summaries, and an estimated source-event scan rate. The estimate sums source head positions for the projection subscriptions included in the rebuild; when subscription filters are present, treat it as scan-distance evidence, not a distinct business-event count.

Commit or attach the benchmark artifact with the runbook note that cites the measured total and slowest context. Rerun after material projection-handler changes, projection-group topology changes, or event-volume milestones; no calendar schedule is required.

## Ledger Maintenance

Workers run `projection-ledger-compaction` as a separate maintenance runner. It removes applied ledger rows older than the durable checkpoint safety window and should not be run inline with event application.

Workers also run `projection-generation-retention` as maintenance. It clears expired previous-generation metadata only after the retention deadline has elapsed.

## Capacity And Alerts

- Worker runner concurrency must not exceed `DATABASE_POOL_MAX` unless `ALLOW_WORKER_OVER_POOL_CAPACITY=true` is intentionally set for local testing.
- Platform-worker `/internal/workers/status` and worker heartbeat metadata include `databasePoolPressure`; the worker endpoint also includes `projectionWakeIntentBreakdown` by lane/origin/state. Use `waitingClients > 0`, `waitingPoolCount > 0`, or saturated pools to attribute freshness lag to DB-pool pressure instead of hot-lane queueing or projection-group lease contention.
- To make an incident handoff repeatable, capture `GET /internal/workers/status` and `GET /api/platform/projections` JSON during the lag window, then run `pnpm run ops projection:hot-lag-evidence -- --worker-status <worker-status.json> --projection-status <projection-status.json> --out artifacts/projection-hot-lag-evidence.json`. Optional `--wake-outcomes <wake-outcomes.json>` can include redacted Grafana/log outcome counts such as `{ "priorityLane": "hot", "origin": "api-wait", "outcome": "deferred", "count": 2 }` to distinguish projection-group lease contention from generic hot-lane queueing.
- Alert when the oldest queued projection operation is older than the claim TTL, when source lag grows while no worker heartbeat is fresh, or when poison/blocked-stream counts increase.
- During DigitalOcean shared-resource incidents, reduce projection/job/dispatch concurrency before increasing app size so the database pool remains the first-class capacity budget.
- For critical read-after-write routes, use the [Projection Freshness Worker Capacity](../architecture/projection-freshness-worker-capacity.md) audit to verify worker heartbeat, runner status, exact dependency mode, source lag, applicable lag, and route-level freshness timeout evidence before changing route code.
