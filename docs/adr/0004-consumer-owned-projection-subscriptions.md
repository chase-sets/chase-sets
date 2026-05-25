# 0004 Consumer-Owned Projection Subscriptions

## Status

Accepted

## Decision

Projection execution is owned by bounded-context subscriptions and projection groups. Contexts may declare projection handler sets, but deployables and publishers do not run projection adapters directly. Workers lease projection groups, drain their source subscriptions, record application ledger state, and publish operation snapshots.

Synchronous write drains are opt-in only for explicitly configured consistency experiments. The default write path publishes events and returns eventual-consistency headers.

## Consequences

- Projection backlog cannot make normal API writes wait behind consumer work.
- Rebuilds replay checkpoints without truncating live read tables by default.
- Each owned read-model table has one projection group owner.
- Legacy projector factories and direct `runOnce` adapters are removed from bounded contexts.
- Full generation/shadow-table cutover can be added per projection where an operator needs destructive table replacement without exposing partial state.
