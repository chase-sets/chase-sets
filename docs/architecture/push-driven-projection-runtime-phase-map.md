# Push-Driven Projection Runtime Phase Map

## Purpose

Milestone #19 moves projection readiness from polling-first to push-first without turning the platform into a big-bang rewrite. This phase map defines the delivery order, blocker classes, source-of-truth boundaries, and evidence required before each rollout expands.

## Ownership Boundaries

Shared Platform Runtime infrastructure owns the generic wake, listener, waiter, lease, worker, and metrics primitives. Platform Operations owns operator-facing rollout, release, and projection operation language. Bounded contexts keep their event facts, durable job tables, read models, projections, route recovery behavior, and durable job semantics.

Durable truth stays where it already belongs:

| Surface | Durable Source Of Truth | Shared Composite Responsibility |
| --- | --- | --- |
| Projection wake | Source event-store rows, projection checkpoints, application ledgers | Wake envelope, relay, coalescing, wake-store claims, metrics |
| Checkpoint readiness | Projection checkpoint rows | Waiter wakeup, readiness coalescing, fallback polling |
| Durable jobs | Context-owned job and job-event tables | Notification/wait adapter, SSE replay helper, metrics |
| Projection operations | `platform_projection_operations` and operation events | Notification/wait adapter, operator status metrics |
| Realtime SSE | Context-owned realtime outbox rows | Wake-signal adapter, stream wait metrics, listener budget |
| Scheduled/manual work | Durable job rows or runner trigger state | Trigger wake, rate limits, rollout controls |

## Milestone Issue Classification

Every milestone issue belongs to at least one blocker class. When an issue spans more than one class, the earliest listed gate is the first gate that can fail rollout.

| Blocker Class | First Gate | Issues | Release Meaning |
| --- | --- | --- | --- |
| Program and architecture fitness | Phase 0 PR readiness | #1217, #1218, #1248, #1249 | The ADR, composite boundaries, source-of-truth ownership, and dependency map are accepted before runtime changes land. |
| Checkout hot-path blocker | Phase 1 Checkout enablement | #1219, #1220, #1221, #1222, #1223, #1225, #1226, #1227, #1231, #1237, #1239, #1240, #1242, #1246 | Guest Buy Now and other critical read-after-write pages can wake, wait, and prove pay-ready readiness without route-time projection execution. |
| Production topology, safety, and rollout blocker | Phase 1 production proof mode | #1228, #1229, #1235, #1236, #1243, #1244 | Production cannot enable push-first Checkout until observability, kill switches, privacy review, listener topology, staging/prod parity, and DigitalOcean budgets pass. |
| Composite migration blocker | Phase 2 composite rollout | #1224, #1232, #1238, #1245 | Projection groups, projection operations, notification utilities, and source-context rollout waves move through shared primitives or carry owner-approved exceptions. |
| Closure and recovery blocker | Phase 3 milestone closure | #1230, #1233, #1234 | Stale polling/listener debt is retired, non-Checkout read-after-write pages are validated, and missed-notification recovery drills pass. |

Issue classification is a rollout control, not just bookkeeping. A later phase may start behind flags, but an earlier gate cannot be considered closed while one of its listed issues still lacks its required evidence.

## Phase 0: Architecture And Guardrails

Goal: make the intended runtime shape hard to misunderstand before implementation begins.

Required work:

- Accept ADR 0010.
- Publish this phase map.
- Add static guardrails that inventory direct `LISTEN`, `UNLISTEN`, `pg_notify`, and direct realtime wake-signal construction.
- Document existing durable job, projection operation, and realtime wake paths as either migration candidates or budgeted exceptions.
- Update docs index entries so the architecture is discoverable.

Exit evidence:

- ADR and phase map are linked from `docs/README.md`.
- Guardrail tests pass and list current approved direct wake/listener files.
- No runtime behavior changes are required for Phase 0.

## Phase 1: Checkout Projection Hot Path

Goal: make the original Checkout failure mode fast and safe without waiting for full composite migration.

Required work:

- Add durable control-plane wake/readiness store in the control database.
- Emit source-context event-store wake notifications after commit.
- Build active/standby worker-owned relay for enabled source contexts.
- Build projection interest index and wake-intent scheduler.
- Add checkpoint-readiness wakeups for API freshness waits.
- Add API wake-before-wait for exact read-after-write dependencies.
- Preserve leases, fencing, ledgers, poison handling, statement timeouts, and fallback polling.
- Align staging and production query/listener/control-plane topology for Checkout.

Hard blockers for Checkout push-first rollout:

- ADR accepted and Phase 1 topology approved.
- Checkout source context enabled in the relay registry.
- Connection budget proves Phase 1 fits staging and production proof mode.
- Guest Buy Now canary proves pay-ready or safe temporary recovery inside SLO.
- Kill switches can disable push wakes without removing exact freshness waits.

## Phase 2: Composite Adapter Migration

Goal: consolidate related job/event wake paths through shared primitives without moving domain-owned durable state.

Required work:

- Adapt durable job event waits to shared notification/waiter/metrics primitives or document a budgeted exception.
- Adapt platform projection operation event waits to the composite.
- Review realtime SSE wake signals against DigitalOcean listener budgets; migrate to the composite listener/relay path or document a budgeted local-listener exception.
- Add structure checks that block new unreviewed direct wake/listener helpers.
- Add compatibility wrappers so old and new helper APIs can overlap safely during rolling deployments.

Hard blockers for Phase 2 rollout:

- Mixed-version API/worker/relay tests pass.
- Durable job SSE replay remains source-of-truth driven.
- Realtime SSE replay remains source-of-truth driven.
- Connection-budget report includes every approved local listener exception.

## Phase 3: Expansion And Closure

Goal: finish milestone-wide rollout and remove stale patterns.

Required work:

- Expand source contexts through the relay registry by owner-approved rollout waves.
- Prove combined projection wake, durable job, projection operation, realtime, and scheduled/manual trigger load.
- Complete production proof mode and promotion evidence.
- Retire stale passive polling assumptions, duplicate listener helpers, obsolete docs, and obsolete tests.
- Run recovery drills for missed notifications, relay outage, control-plane store pressure, realtime wake fallback, durable job SSE wake fallback, and database failover.

Closure blockers:

- Every projection group is push-first eligible or has an owner-approved opt-out.
- Every read-after-write route inventory entry keeps exact waits or has an owner-approved exception.
- Staging and production share the same logical runtime contract.
- Observability can segment commit-to-notify, notify-to-relay, relay-to-control-plane, control-plane-claim-to-runner, checkpoint-to-waiter, durable-job-event-to-SSE, projection-operation-event-to-SSE, and realtime-outbox-to-SSE latency.
- No direct wake/listener pattern remains without a migration disposition or budgeted exception.

## Rollback Rules

Rollback must disable push acceleration without removing durable correctness:

- Exact read-after-write waits stay enabled.
- API routes may return bounded temporary recovery while receipts are fresh.
- Durable job and realtime SSE clients continue to replay from durable event/outbox rows.
- Projection fallback polling and reconciliation remain available.
- Kill switches are scoped by environment, phase, source context, projection group, route, priority lane, and work-signal origin.
