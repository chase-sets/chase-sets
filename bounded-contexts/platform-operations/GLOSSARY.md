# Platform Operations Glossary

- Projection Operation: A durable control-plane request for operator-triggered projection work such as rebuild, retry, or cancellation.
- Projection Group: A bounded-context declared projection owner for one read-model group and its source subscriptions.
- Subscription: A projection group's declared source-context event consumer and checkpoint boundary.
- Blocked Stream: A source stream paused for one projection after a poison event while unrelated streams continue draining.
- Poison Event: An event that failed projection handling and requires repair, retry, or rebuild before that stream can continue.
- Worker: A runtime process that claims projection groups, jobs, dispatch work, or scheduled work.
- Runner: A leased worker activity responsible for draining or maintaining a specific runtime workload.
- Snapshot Freshness: Whether the displayed projection status came from a fresh worker snapshot, stale snapshot, or runtime memory.
- Source Lag: The source-context event distance between a subscription checkpoint and the source head.
- Applicable Lag: The estimated count of source events after the checkpoint that match a subscription's filters.
- Attention: Any operator-facing condition that should be triaged before routine healthy rows, including failed operations, cancel-requested operations, degraded projections, blocked streams, poison events, stale snapshots, stale workers, and stale revisions.
