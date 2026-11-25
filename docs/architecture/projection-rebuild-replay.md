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
- A rebuild resets the group's subscription checkpoints, replays source events through the group subscriptions, and stores the declared revision only after replay succeeds.
- If replay fails, the old stored revision remains. A failure does not undo a committed reset or earlier replay batches. For a revision bump, health status reports the projection group as stale until a later sync succeeds.

Each group declares its `resetStrategy` in its `projectionGroups` entry in the bounded context's `context.json`. The runtime's default reset refuses a group that owns tables and declares no strategy.

- `truncate-owned-tables`: The default reset truncates the declared owned tables before replay.
- `replay-only`: The default reset does not truncate owned tables. Replay uses the rows already there.
- `append-only-no-reset`: The default reset does not truncate owned tables. Despite the name, a rebuild still resets the subscription checkpoints and replays events.
- `generation-cutover`: The runtime does not truncate owned tables. It requires a context-provided reset adapter and starts a rebuilding generation before reset and replay. It records the generation as active and stores the revision only after replay succeeds. If replay fails in `rebuildProjectionGroup`, it records the rebuilding generation as failed.

Workers must run cross-context catch-up through projection group runners, not raw subscription runners. That keeps long-running catch-up on the same revision-aware path as bootstrap and explicit sync: stale groups reset once, replay batch-by-batch, and mark the new revision only after they catch up.

## Ownership Rules

- The bounded context that owns the read model owns the revision bump.
- Deployables must not encode projection-specific rebuild policy.
- Shared infrastructure may provide reset, replay, status, and health reporting, but it must not infer business meaning from projection names or tables.
- Keep projection groups aligned with stable published facts from source contexts. Integration events publish facts, not rebuild commands.

## Operational Checks

Before merging a projection change that bumps `projectionRevision`:

- For `truncate-owned-tables`, confirm the group declares every owned table that must be cleared.
- For `replay-only`, `append-only-no-reset`, or any rebuild that keeps existing rows for replay, confirm handlers apply only event revisions newer than those stored on the affected rows so replay cannot regress them.
- For `generation-cutover`, confirm the context provides the reset adapter the runtime requires, and that the adapter's own reset is safe to run again after a failed generation.
- For every strategy, confirm handlers are idempotent across full replay.
- Confirm side-effect projections either use durable idempotency/outbox keys or are excluded from destructive replay until they can be rebuilt safely.
- Run the bounded-context runtime projection replay tests and any context tests that cover the changed projection.
