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

Blocked-stream operations require `security.manage`:

- `GET /api/platform/projections/:projectionKey/blocked-streams` lists active blocked stream and poison details for one projection key.
- `POST /api/platform/projections/:projectionKey/blocked-streams/:streamId/retry` replays one blocked stream in stream-version order.

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
