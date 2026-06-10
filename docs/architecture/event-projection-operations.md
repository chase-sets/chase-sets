# Event Projection Operations

Projection operations are durable control-plane records for operator-triggered projection work. Admin APIs enqueue operations and return immediately; workers claim and execute them. Publishers remain unaware of projectors.

## Push-Driven Migration Note

Milestone #19 is governed by [ADR 0010: Push-Driven Projection Runtime](../adr/0010-push-driven-projection-runtime.md) and the [Push-Driven Projection Runtime Phase Map](./push-driven-projection-runtime-phase-map.md). Projection operation event notifications and waits use the platform work-signal composite, while operation rows, event rows, leases, and fencing remain the durable control-plane contract.

## Operation Lifecycle

- `queued`: operation is durable and unclaimed.
- `running`: a worker claimed the operation with a claim owner, claim TTL, and fencing token.
- `cancel_requested`: an operator asked a running worker to stop. The worker polls operation state while holding the projection lease and aborts at the next lease or transaction boundary.
- `succeeded`, `failed`, `cancelled`: terminal states.

Workers reclaim `queued` operations and expired `running` operations with `FOR UPDATE SKIP LOCKED`, so multiple workers can compete without double-claiming the same operation.

## Lease And Fencing Rules

Rebuild and retry operations acquire the same `projection-group:<context>.<projection>` lease used by ordinary projection draining. That makes rebuild and drain mutually exclusive for the target projection group.

Every leased projection run receives a `ProjectionRunContext` with owner ID, fencing token, operation ID, abort signal, statement timeout, and a `throwIfLeaseLost` guard. Runtime code checks the guard before and after checkpoint, ledger, reset, replay, retry, and handler transactions.

Checkpoint saves, checkpoint deletion, subscription ledger claims, subscription ledger completion, runner status, and projection status snapshots reject stale fencing tokens. If a worker loses or outlives its lease, newer leased work wins.

Control-plane runner leases keep a durable fencing-token floor per lease name, separate from the active lease row. Releasing a lease may remove the active ownership row, but the next claim must still receive a higher fencing token than any prior claim for the same runner. This keeps context-local subscription checkpoints from rejecting legitimate post-release workers as stale after restarts, deployments, or operation handoffs.

## Rebuild Semantics

Projection groups that own tables must declare a reset strategy:

- `replay-only`: reset checkpoints and replay events without clearing visible read-model rows.
- `append-only-no-reset`: reset checkpoints but preserve append-only/outbox rows.
- `truncate-owned-tables`: truncate declared owned tables before replay. Use only for operator-hidden state where temporary emptiness is acceptable.
- `generation-cutover`: use generation/shadow state and atomically cut visible reads to the rebuilt generation after catch-up.

The runtime stores projection generation metadata so generation-aware rebuilds can track active, rebuilding, failed, and cutover state. `generation-cutover` fails closed unless a projection supplies an adapter that writes and reads generation-scoped state.

After successful cutover, the previous generation remains recorded with a retention deadline. Workers run generation-retention maintenance separately from hot projection draining, and only clear previous-generation metadata after the retention window has expired.

## Transaction Contract

Projection handlers that mutate read models must write through the transaction-scoped `context.db`. The runtime still supports projection-aware pools as compatibility, but wrapper handlers must forward context and side effects must be durable writes in the same transaction.

New read-model handlers should use `createTransactionalProjectorHandlerMap` so tests and direct calls fail when the transaction-scoped projection database is missing.

## Operations Observability

Operators should monitor:

- queued/running operation count and oldest queued operation age;
- failed/cancelled operation count and last error;
- projection source lag and applicable lag;
- runner lease misses and lease renew failures;
- ledger rows by status and compaction lag;
- blocked stream and poison event counts.

Worker deployables emit structured logs for runner completion/failure, lease misses, lease renew failures, and projection operation start/completion/failure. Every projection operation log includes operation ID, operation kind, context, projection key/name, stream ID when present, worker ID, owner ID, and fencing token.
