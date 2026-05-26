# Event Projections

Chase Sets projections are consumer-owned bounded-context subscriptions. A context declares the facts it consumes, the projection group that owns the resulting read model, and the source contexts that feed it.

## Runtime Rules

- Publishers append domain events only. They do not call projectors.
- Workers lease projection groups and run source subscriptions with bounded parallelism.
- Operator-triggered rebuild, retry, and replay requests are durable projection operations. APIs enqueue operations; workers claim and execute them.
- Rebuild operations must acquire the same projection-group runner lease as normal drain work before deleting checkpoints or replaying subscriptions.
- Every applicable event is claimed in `event_subscription_applications` before handler execution and completed in the same target-context transaction as handler writes when handlers use the transaction-scoped `context.db`.
- Poison events block only their stream for that projection. Other streams continue draining.
- Rebuild/reset deletes checkpoints and replays subscriptions. It does not truncate live owned tables unless a projection declares `resetStrategy: "truncate-owned-tables"` or supplies explicit generation/shadow cutover behavior.
- Leased projection operations poll cancellation state, propagate an abort signal, and apply a local statement timeout around projection transactions.
- Subscription ledger compaction runs as maintenance, outside the hot drain loop.

## Lag Metrics

- `sourceLagEventCount` is the global source-head distance from the subscription checkpoint.
- `applicableLagEstimate` is the count of matching events after the checkpoint for the subscription's declared event types and stream prefixes. When absent, operators should treat source lag as drain distance rather than business-event count.
- `outstandingEventCount` is retained as a compatibility alias for source lag during the UI/API transition.

## Projection Operations

Projection operations live in the platform control plane so they survive API restarts and can be claimed by any active worker. Operation state is monotonic from `queued` to `running` and then to `succeeded`, `failed`, or `cancelled`.

Workers claim operations with a claim TTL and fencing token. Rebuild operations then acquire the target projection-group runner lease before invoking rebuild logic. That shared lease prevents normal projection draining and operator rebuild from mutating the same checkpoints or read models concurrently.

Projection operations are the required path for admin rebuild and retry actions. The admin API must not synchronously rebuild projections in the request path.

## Ownership

Each owned table must appear in only one projection group per context. Shared outbox tables must either have one combined projection group owner or be explicitly partitioned by source/generation. Projection groups that own tables must declare a reset strategy: `replay-only`, `append-only-no-reset`, `truncate-owned-tables`, or `generation-cutover`.
