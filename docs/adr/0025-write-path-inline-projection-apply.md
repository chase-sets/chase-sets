# 0025 Write-Path Inline Projection Apply

## Status

Accepted

## Context

ADR 0009 rejected projection catchup inside a customer read request. That decision remains sound: reads must not acquire projection ownership, duplicate the worker runtime, or turn an arbitrary backlog into customer-facing work. ADR 0010 subsequently introduced push-driven worker execution, but the measured write-to-fresh-read path still crosses the event-store notification, relay, wake-intent, runner, readiness, and read-wait stages. The measured path costs roughly 20–30 database round trips, and production proof canaries under the polling posture did not make Checkout ready within 10 seconds.

A command already has a much narrower opportunity after its event append commits. It can retain its own committed stored events in process and apply only those events to an explicitly declared same-context projection. This is bounded work rather than catchup: it never scans or drains backlog and never moves a projection checkpoint.

## Decision

Adopt post-commit, in-request, best-effort **Inline Apply** for explicitly eligible projection handler sets.

The command transaction commits first. The write middleware then attempts the request's own committed events in a separate projection transaction. Inline Apply is allowed only when the projection group is single-source, its source and target are the same bounded context, its handler kind is `projection`, and it is not cascade-capable. Cross-context, multi-source, reaction, and cascade work remains asynchronous.

Inline Apply uses `event_subscription_applications`, the same application ledger as the subscription runner. Its claim is non-stealing and non-blocking: an existing `applied` row suppresses duplicate execution; any other existing row, lock contention, blocked stream, or predecessor gap defers to the asynchronous runner. A predecessor may be applied inline only when the prior stream event is already `applied` or the durable subscription checkpoint has passed it. Successful handler work and the ledger transition to `applied` commit atomically. Inline Apply never writes checkpoints.

The mechanism has a hard request budget and projection statement timeouts. Handler failures, timeouts, and contention roll back or defer silently; the durable event remains available to the unconditional asynchronous runner. `PROJECTION_INLINE_APPLY_ENABLED` is an environment kill switch and defaults off. Outcome counters record applied, deferred, and failed attempts without event payloads or entity identifiers. Projection eligibility is an explicit handler-set declaration, not a feature flag in a decider or evolver.

## ADR 0009 Reopening Criteria

This decision reopens only the write-side case and discharges ADR 0009's checklist as follows:

- **Measured SLO evidence and healthy topology:** the push-wake SLO/load proof and worker-capacity evidence isolate the remaining multi-stage latency after the worker topology improvements.
- **Kill switch:** `PROJECTION_INLINE_APPLY_ENABLED` defaults off and disables all inline database work.
- **Per-projection eligibility:** each eligible handler set opts in; runtime validation rejects unsafe projection-group shapes.
- **Rate limiting / bounded work:** a request can apply only its own captured committed events within one hard time budget; it cannot read backlog.
- **Duplicate suppression:** the application ledger is the shared idempotency authority for inline and runner paths.
- **Lease and fencing preservation:** Inline Apply never acquires or steals a projection-group lease or an existing application claim; the runner remains authoritative reconciliation.
- **Statement timeouts:** Inline Apply uses the shared projection transaction wrapper with a budget-derived transaction and statement timeout.
- **Poison and degraded handling:** blocked streams skip inline work, and every failure falls back to the existing runner recovery path.
- **Audit metrics:** support-safe per-attempt outcome and duration metrics distinguish applied, deferred, and failed work.
- **Rollback evidence:** disabling the environment switch returns the runtime to zero inline statements; environment enablement and the operational drill are separate rollout work.

ADR 0009's rejection of read-path inline catchup and its prohibition on hidden synchronous drains remain unchanged.

## Rejected Options

### Same-Transaction Projection Application

Rejected because projection code would be able to fail durable command writes and couple command latency and availability to read-model behavior.

### A Separate Inline Idempotency Store

Rejected because poison recovery and the subscription runner reason from the application ledger. A second record would silently split idempotency and recovery truth.

### Inline Checkpoint Advancement

Rejected because a command sees only its own events, not the complete source ordering. The asynchronous runner remains the sole checkpoint authority.

## Consequences

- Same-context hot projections can make a follow-up exact freshness check succeed without traversing the complete wake pipeline.
- Command durability never depends on projection success, but enabled requests may pay a small bounded latency cost.
- A commit-to-inline window remains; concurrent runner wins are safe because Inline Apply defers instead of stealing.
- The asynchronous subscription runner remains mandatory and reconciles every deferred or failed attempt.
- Freshness predicate changes, Checkout enablement/evidence, and parallel application require separate changes and decisions.
