# 0010 Push-Driven Projection Runtime

## Status

Accepted

## Context

Milestone #19 responds to the staging guest Buy Now failure where a shopper could reach `/checkout/:sessionId` before the Checkout session read model was ready. ADR 0009 rejected route-time projection catchup because API requests must not duplicate the worker runtime or bypass projection leases, fencing, ledgers, poison handling, and statement timeouts.

The platform still needs near-real-time projection readiness. The existing polling-era model is too slow for critical read-after-write pages, and related runtime surfaces already use similar but separate wake patterns:

- projection workers drain bounded-context projection groups from durable event-store rows;
- read-after-write API gates wait on exact projection checkpoints;
- durable jobs append public job events and wake SSE waiters;
- platform projection operations append operation events and wake operator status streams;
- realtime SSE writes durable outbox rows and wakes browser streams;
- scheduled/manual work can enqueue durable work or trigger worker runners.

DigitalOcean infrastructure constrains the design. Staging uses Terraform-created per-context PgBouncer transaction pools for normal query traffic, while PR previews use disposable in-cluster Postgres and remain fallback-first. `LISTEN` requires a direct or session-compatible connection, and the current staging context pool shape already consumes the practical pool-count budget. Production has historically used App Platform database bindings for context URLs, so production must be aligned to the same logical query/listener/control-plane topology as staging before push enablement.

## Decision

Adopt a push-first projection runtime built from a worker-owned wake relay, a durable control-plane wake store, and a phased platform work-signal composite.

`pg_notify` is a wake signal only. Durable source rows remain the source of truth:

- source-context event-store rows for projections;
- projection checkpoints and ledgers for projection readiness;
- context-owned durable job and event tables for job progress;
- platform projection operation rows and events for operator projection work;
- realtime outbox rows for browser realtime patches.

The active worker-owned relay listens to enabled source-context event-store notifications through direct/session-compatible connections. It catches up from durable event-store rows, maps source-scoped positions/cursors through the projection interest index, coalesces wake intents, and writes them to the durable control-plane wake store. Ordinary workers and API freshness waiters consume control-plane wake/readiness state and continue to use pooled query URLs. API routes may request an exact wake before waiting, but they must not run projection handlers or long-running durable work inline.

The durable control-plane wake store starts in the existing control database. It owns projection wake intent and checkpoint-readiness rows that need cross-process fan-out. It must support source-scoped cursors, schema/payload versions, coalescing keys, indexed worker claims, lease/fencing-compatible execution, bounded retention, cleanup, rate limits, backpressure, and rolling-deploy compatibility. The store has at-least-once wake semantics; consumers must be idempotent and able to replay from their durable source rows after missed or duplicate wakes.

The platform work-signal composite consolidates shared wake/listen/wait/metrics primitives across projection wakes, checkpoint readiness, durable job event waits, projection operation events, realtime SSE wake signals, scheduled/manual work triggers, and reconciliation wakeups. It does not collapse durable state into one generic table. Each owner keeps its own durable source-of-truth tables and domain semantics.

The composite must expose one owning runtime/API surface for shared emission, listener, waiter, claim, fallback, redaction, and metrics contracts. Projection wakes, checkpoint readiness, durable jobs, projection operations, realtime, scheduled/manual work, and reconciliation should use thin adapters over that surface. Direct use of raw `LISTEN`, `pg_notify`, ad hoc wait loops, or ad hoc wake tables is allowed only when the phase map or an implementation issue records a reviewed, budgeted exception.

The migration is phased:

- Phase 0: ADR, terminology, source-of-truth boundaries, phase map, and static guardrails.
- Phase 1: Checkout/projection hot path, relay, durable wake store, scheduler, checkpoint readiness, staging/prod topology parity, and proof gates.
- Phase 2: durable job, projection operation, realtime SSE, scheduled/manual trigger adapters, and stale helper cleanup.
- Phase 3: full composite load proof, production proof mode, rollout expansion, and milestone debt closure.

Phase 0 gates production push enablement and broad consumer rollout. Foundational implementation slices may land behind flags before every Phase 0 artifact is complete, but the ADR and phase-gate review must validate, amend, or supersede those contracts before Phase 1 enablement.

## Constraints

- Do not add route-time projection execution.
- Do not send full event payloads, PII, payment data, guest email, provider private payloads, or durable job private payloads in wake notifications or wake-store rows.
- Do not add one session pool per context or every-process source database listeners under the current DigitalOcean topology.
- Do not add Redis, Kafka, or another paid broker for the initial implementation unless a later ADR proves Postgres/control-plane primitives cannot meet SLO, cost, or operational requirements.
- Do not block Phase 1 Checkout readiness on a full durable job/realtime rewrite; use compatibility adapters and phase gates.

## Consequences

- ADR 0009 remains correct that API routes must not run projection handlers inline. This ADR supersedes only the earlier no-go on worker wake signals before polling.
- Checkout and other critical read-after-write routes can actively wake the required projection while preserving worker-owned execution.
- Staging and production must use the same logical query/listener/control-plane/composite contract, with environment-specific scale and rollout flags only.
- Existing durable job, projection operation, and realtime wake paths must be migrated to shared primitives or kept as documented, budgeted exceptions until their phase lands.
- New direct `LISTEN`, `pg_notify`, job event wait, or wake-store helper patterns require a reviewed composite disposition.
- Grafana is the canonical surface for wake pipeline rates, percentiles, logs, and alerts. Admin Projection Operations remains the action/read-model surface for blocked-stream retry, projection rebuild, operation cancel, durable operation state, and links to wake runbooks/dashboards.

## Closure Evidence

Milestone #19 cannot close until these artifacts exist and are linked from the relevant implementation PRs:

- accepted phase map and dependency gates;
- durable wake-store schema and load proof;
- relay and scheduler implementation with failover tests;
- Checkout guest Buy Now proof in staging and production proof mode;
- staging/prod topology parity evidence;
- connection-budget and Terraform safety checks;
- composite migration disposition for durable jobs, projection operations, realtime SSE, and scheduled/manual work;
- stale listener/polling helper cleanup or approved exceptions;
- Grafana dashboards/alerts, runbooks, security/privacy review, and recovery drills.
