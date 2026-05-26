# Projection Operations

Use `/api/platform/projections` for snapshot-first projection status. The summary endpoint is intentionally cheap during incidents; load blocked stream details with `/api/platform/projections/:projectionKey/blocked-streams` only when needed.

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
- Use the Projection Operations table in Admin to inspect queued, running, succeeded, failed, and cancelled operations.
- The operation history API supports filters for `contextName`, `projectionName`, `state`, and `requestedByUserId`.
- Operation summaries expose queued count, running count, failed count, cancel-requested count, oldest queued/running timestamps, and average operation duration.

## Poison Events

- Poison handling is stream-isolated.
- Retry only the blocked stream after fixing the handler or data issue.
- Other streams for the same projection continue to apply.

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
- Alert when the oldest queued projection operation is older than the claim TTL, when source lag grows while no worker heartbeat is fresh, or when poison/blocked-stream counts increase.
- During DigitalOcean shared-resource incidents, reduce projection/job/dispatch concurrency before increasing app size so the database pool remains the first-class capacity budget.
