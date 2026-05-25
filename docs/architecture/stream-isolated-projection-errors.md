# Stream-Isolated Projection Errors

Projection consumers own read-model catch-up. Publishers append durable events and do not know which projectors or projection groups consume those events.

API write paths should not synchronously drain projections as the default consistency strategy. Publishers communicate commit positions; projection consumers catch up independently.

When a projection handler fails on one stream, the default failure boundary is the projection plus the source stream. Runtime records the poison event and blocked stream, advances that projection's global checkpoint, and continues draining unrelated streams. Later events from the blocked stream are deferred for that projection until the poison event is repaired or the projection is rebuilt.

## Policies

- `strict-per-stream` is the default for stream-addressable projections. It preserves ordering within the failed stream while letting unrelated streams continue.
- `global-strict` is available for projections whose correctness depends on total global order or cross-stream invariants.
- Transient infrastructure failures do not advance checkpoints. Handlers can throw a transient projection error when retrying the same event later is the correct behavior.

## Runtime Behavior

For each event in a checkpointed global batch:

1. Ignore and checkpoint events that are outside the projection's event type, stream prefix, or handler map.
2. If the stream is already blocked for this projection, record the event as deferred, advance the checkpoint, and do not invoke the handler.
3. If the handler succeeds, advance the checkpoint.
4. If the handler fails under `strict-per-stream`, record a poison event, mark the stream blocked, advance the checkpoint, and continue.
5. If the handler fails under `global-strict`, or the failure is transient, do not advance the checkpoint and let the worker report `error`.

The event store retains `streamId`, `streamVersion`, and `globalPosition`, so repair can replay a blocked stream in stream-version order without requiring publishers to re-emit events.

## Health

Projection consumers report:

- `caught-up`: no available work and no blocked streams
- `running`: processed work and no blocked streams
- `degraded`: still making progress, but at least one stream is blocked
- `error`: cannot make progress for this turn because of infrastructure, lease loss, or `global-strict` failure

Operators should treat `degraded` as actionable but not globally stopped. Related read models may be stale for the blocked stream; unrelated streams should continue to catch up.

## Ownership

- Bounded contexts own projection handlers, read models, and whether a projection requires `global-strict`.
- Shared runtime owns generic checkpoint, poison, blocked-stream, and health mechanics.
- Deployables compose workers and APIs only. They do not contain projection-specific repair policy.
- Publishers do not drain, retry, skip, or repair projector consumers.

## Rebuilds

Projection definition changes still use projection revisions and rebuild replay. Rebuild reset should clear or supersede poison and blocked-stream state for the rebuilt projection key so stale poison state does not survive a successful replay.
