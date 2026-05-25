# Event Projections

Chase Sets projections are consumer-owned bounded-context subscriptions. A context declares the facts it consumes, the projection group that owns the resulting read model, and the source contexts that feed it.

## Runtime Rules

- Publishers append domain events only. They do not call projectors.
- Workers lease projection groups and run source subscriptions with bounded parallelism.
- Every applicable event is claimed in `event_subscription_applications` before handler execution and completed in the same target-context transaction as handler writes when handlers use the transaction-scoped `context.db`.
- Poison events block only their stream for that projection. Other streams continue draining.
- Rebuild/reset deletes checkpoints and replays subscriptions. It does not truncate live owned tables unless a projection supplies explicit generation/shadow cutover behavior.
- Subscription ledger compaction runs as maintenance, outside the hot drain loop.

## Lag Metrics

- `sourceLagEventCount` is the global source-head distance from the subscription checkpoint.
- `applicableLagEstimate` is reserved for filtered work estimates. When absent, operators should treat source lag as drain distance rather than business-event count.
- `outstandingEventCount` is retained as a compatibility alias for source lag during the UI/API transition.

## Ownership

Each owned table must appear in only one projection group per context. Shared outbox tables must either have one combined projection group owner or be explicitly partitioned by source/generation.
