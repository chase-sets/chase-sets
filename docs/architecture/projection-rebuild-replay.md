# Projection Rebuild Replay

Bounded contexts own their read models, projection handlers, projection tables, and projection group declarations. Shared runtime owns the generic replay mechanism.

## Projection Revisions

Each projection group can declare a `projectionRevision` in `context.json`. The value is a positive integer and defaults to `1` when omitted.

Bump `projectionRevision` when a projection group needs a full rebuild to make existing read-model rows match the current projection definition. Common examples:

- a handler now derives different values for already-recorded events
- a projection table changes in a way that cannot be safely backfilled incrementally
- a projection starts reading additional historical event types or source contexts
- a projection group changes its owned table set or reset behavior

Do not bump the revision for handler refactors that preserve read-model output, additive columns with safe defaults, or changes that only affect future events.

## Runtime Behavior

During projection-group sync, runtime compares the declared `projectionRevision` with the last successfully synced revision stored in the target context database.

- If no revision has been stored yet, runtime treats the current declaration as the baseline after the next successful sync.
- If the stored revision differs from the declared revision, runtime rebuilds the projection group before marking the new revision.
- Rebuild truncates the projection group's owned tables, resets its subscription checkpoints, replays source events through the group subscriptions, and stores the declared revision only after replay succeeds.
- If replay fails, the old stored revision remains. Health status reports the projection group as stale until a later sync succeeds.

Workers must run cross-context catch-up through projection group runners, not raw subscription runners. That keeps long-running catch-up on the same revision-aware path as bootstrap and explicit sync: stale groups reset once, replay batch-by-batch, and mark the new revision only after they catch up.

## Ownership Rules

- The bounded context that owns the read model owns the revision bump.
- Deployables must not encode projection-specific rebuild policy.
- Shared infrastructure may provide reset, replay, status, and health reporting, but it must not infer business meaning from projection names or tables.
- Keep projection groups aligned with stable published facts from source contexts. Integration events publish facts, not rebuild commands.

## Operational Checks

Before merging a projection change that bumps `projectionRevision`:

- Confirm the projection group declares every owned table that must be cleared.
- Confirm handlers are idempotent across full replay.
- Confirm side-effect projections either use durable idempotency/outbox keys or are excluded from destructive replay until they can be rebuilt safely.
- Run the bounded-context runtime projection replay tests and any context tests that cover the changed projection.
