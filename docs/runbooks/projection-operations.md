# Projection Operations

Use `/api/platform/projections` for snapshot-first projection status. The summary endpoint is intentionally cheap during incidents; load blocked stream details with `/api/platform/projections/:projectionKey/blocked-streams` only when needed.

## Backlog

- Check `sourceLagEventCount` for drain distance.
- Check worker heartbeats and runner statuses to confirm active capacity.
- A projection can be `running` with source lag while a worker is draining it; `idle` should not be interpreted as caught up.

## Poison Events

- Poison handling is stream-isolated.
- Retry only the blocked stream after fixing the handler or data issue.
- Other streams for the same projection continue to apply.

## Rebuild

- Projection rebuilds replay from checkpoints without truncating live read tables.
- If a projection needs destructive replacement, add a projection-specific generation/shadow cutover before enabling that operation.

## Ledger Maintenance

Workers run `projection-ledger-compaction` as a separate maintenance runner. It removes applied ledger rows older than the durable checkpoint safety window and should not be run inline with event application.
