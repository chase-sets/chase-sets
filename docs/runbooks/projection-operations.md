# Projection Operations

Use `/api/platform/projections` for snapshot-first projection status. The summary endpoint is intentionally cheap during incidents; load blocked stream details with `/api/platform/projections/:projectionKey/blocked-streams` only when needed.

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
- For critical read-after-write routes, use the [Projection Freshness Worker Capacity](../architecture/projection-freshness-worker-capacity.md) audit to verify worker heartbeat, runner status, exact dependency mode, source lag, applicable lag, and route-level freshness timeout evidence before changing route code.
