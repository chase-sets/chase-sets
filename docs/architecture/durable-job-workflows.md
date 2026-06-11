# Durable Job Workflows

Durable jobs are the platform pattern for user- or operator-triggered work that can outlive one HTTP request, API process, worker process, or deployment.

## Push-Driven Migration Note

Milestone #19 is governed by [ADR 0010: Push-Driven Projection Runtime](../adr/0010-push-driven-projection-runtime.md) and the [Push-Driven Projection Runtime Phase Map](./push-driven-projection-runtime-phase-map.md). Durable job event notifications, waits, and SSE replay are migration candidates for the platform work-signal composite, but context-owned durable job and event tables remain the source of truth. Request paths must continue to enqueue or observe durable work instead of streaming long-running work inline.

Use this pattern when a workflow:

- loops over a variable number of records,
- calls external providers or cross-context gateways,
- mutates more than one aggregate or read model row,
- needs user-visible progress,
- needs retry, reconnection, or deployment durability.

Do not stream long-running work from the request path with NDJSON or ad hoc polling. The request path enqueues work and returns `202`.

## Contract

Each durable job workflow has four parts:

1. Context-owned job tables for the private worker job snapshot and ordered public event snapshots.
2. A `POST` endpoint that validates intent, persists the job, appends the first event, and returns `202`.
3. A worker runner that claims one job turn, records progress, completes or fails the job, and releases work through persisted state.
4. A `GET /jobs/:jobId/events` SSE endpoint that replays ordered events after `Last-Event-ID` and waits on database notifications between replay checks.

The shared infrastructure is intentionally small:

- `durable-job-store.ts` provides the Postgres claim/update/event mechanics, notification wakeups, claimed release, and terminal-row pruning.
- `durable-job-work-units.ts` provides same-job work-unit claim mechanics for workflows that need bounded parallel lanes without turning every row into a platform runner.
- `durable-job-events.ts` provides SSE cursor parsing, keepalive, event formatting, stream limiting, and polling fallback.
- `work-signal-composite.ts` is the supported platform surface for new notification envelopes, Postgres `pg_notify` emission, dedicated `LISTEN` waiters, payload safety checks, timeout fallback, and observer hooks.

Direct durable-job and realtime notification helpers predate the composite. Treat them as compatibility adapters pending #1238/#1230 migration work, not as patterns for new job, operation, projection, or realtime wake paths.

Domain payloads, progress language, result shapes, permissions, and worker composition stay in the owning bounded context. The payload is worker-private. API and SSE responses must return public job status snapshots that exclude worker payload, event context, claim owner, and claim expiration fields.

## Schema Shape

Context schemas should add tables with `durableJobSchemaSql`:

```ts
durableJobSchemaSql({
  jobsTable: "inventory_import_batch_jobs",
  eventsTable: "inventory_import_batch_job_events",
  notifyChannel: "inventory_import_batch_job_events",
});
```

The job table stores the latest private worker snapshot. The event table stores append-only public status snapshots with a monotonically increasing `sequence` per job. SSE clients use that sequence as the event id.

State transitions and event appends must be committed atomically. The shared Postgres store wraps enqueue, claim, progress, release, requeue, cancel, complete, and fail transitions with their corresponding event append, then emits a `pg_notify` wakeup after the event row is written. Notification waits are best-effort because some deployed runtime pool URLs are PgBouncer transaction pools; if `LISTEN` is unavailable or a waiter fails, the SSE route must fall back to a short poll timeout. Listener setup failures are circuit-broken before retry so open streams do not repeatedly churn pooled transaction connections. A missed notification is acceptable because SSE replay always reloads ordered events.

Do not store large request bodies directly in a durable job payload when the job will emit many progress events. Stage bulky or sensitive inputs in context-owned storage and put only a stable staging reference in the job payload.

Replayable create-style jobs must also store the deterministic target id they will mutate. Inventory import create jobs, for example, persist the target `batchId` in the job payload before row validation begins and derive row ids from `(batchId, rowNumber)`. If a worker loses its claim after partial inserts, the next worker resumes the same batch instead of creating a second one.

Large single-parent jobs should use context-owned work-unit tables when one runner turn cannot use available worker capacity. The parent durable job remains the public SSE/status aggregate. Work units store deterministic unit ids, small private payloads, claim owner, fencing token, claim expiry, attempt count, and terminal outcome. Lane runners claim units with `FOR UPDATE SKIP LOCKED`; parent progress and event append are recorded in the same transaction as the unit terminal transition.

Same-job parallelism must have two budgets:

- Workflow active-claim cap: limits total active units for one durable workflow so it cannot consume the worker job group.
- Parent-job active-claim cap: limits active units for one parent job so a massive job cannot starve a second eligible job.

Use fair claim ordering by fewest active claims per parent job, then oldest parent job and unit. Expired unit claims are eligible for reclaim. Deployment cancellation should release the live unit claim or let it expire without recording a business failure. Work-unit payloads are worker-private; operator status may expose counts, active/expired claims, lane identity, parent job id, and budget reason, but not private payloads.

When a lane finds no claimable unit, the owning workflow should reconcile active parent jobs whose known work units are all terminal. The reconciliation must lock the parent, verify that no queued or running units remain, recompute the public progress/result from carried outcomes plus terminal unit outcomes, append the final status event atomically, and clear stale parent claim metadata. Stale requested totals from pre-work-unit migration or changing filter eligibility must not keep a parent job active after every resolvable unit has a terminal outcome; preserve any real mixed failures in the final result instead of hiding them.

Projection operations are platform control-plane jobs rather than bounded-context jobs, but they follow the same durability contract: progress writes renew the claim to `now + ttl`, terminal writes require the live claim, operation state and event append commit together, SSE uses work-signal-composite notification-backed waits, and event sequence numbers are reserved through the operation row instead of recomputing from event history. Long rebuild and retry operations must renew the operation claim while the inner projection-group lease is held, and the inner operation must abort when either claim is lost.

## API Shape

Use explicit job endpoints rather than overloading synchronous result language:

- `POST /.../run` or `POST /.../commit` returns the public job status snapshot with `202`.
- `GET /.../jobs/:jobId` returns the current public job status snapshot.
- `GET /.../jobs/:jobId/events` streams status events.

Event streams must use `text/event-stream`, must honor `Last-Event-ID`, and must terminate after `completed`, `failed`, or the domain terminal state. Reconnects whose `Last-Event-ID` already points past the terminal event must also close by checking the current public job snapshot. Stale cursors must have a replay budget; if replay would send too many events or bytes, emit `sync.required` with the current public snapshot and resume from the advanced event id.

Bounded-context job SSE routes must pass the store `waitForEvents` hook into `createDurableJobEventStream`; the structure check rejects new bounded-context durable job routes that omit this hook.

Every durable job SSE stream is subject to the shared stream limiter. Routes should pass a stable authenticated account or actor key as `streamLimitKey`; proxy IP headers are only a fallback. When the limiter is exhausted the route returns `429 too_many_durable_job_streams`; clients should retry with backoff and reconnect with the last received event id. The Postgres limiter maintains bounded counter rows for global and per-key counts; production can use the Redis limiter when stream churn is high.

## Worker Shape

Workers should register a `job` runner that:

- claims queued or expired running work with `FOR UPDATE SKIP LOCKED`,
- passes a worker id as `claimOwnerId`,
- persists progress before and after meaningful phases, renewing the durable job claim while progress is written,
- renews cheaply between public checkpoints when processing hot per-row or per-card loops,
- checks abort and lease-loss callbacks between batches or external calls,
- treats failed claimed writes as lease loss instead of silently continuing,
- completes with a domain result or fails with an error message.

Parallel workflows should register lanes with `createDurableJobLaneRunners`. Lane names are stable (`job:<workflow>.lane-1`, `job:<workflow>.lane-2`, ...), so each lane uses the existing platform runner lease. Lane count controls possible platform leases; work-unit budgets control how much of that possible capacity a workflow and parent job may actually use.

Use `createDurableJobExecutionContext` for long side-effect loops. It exposes `throwIfCancelled`, `renew`, and `checkpointProgress`, and it converts failed claimed writes into lease-loss errors. Use `createDurableJobProgressCheckpoint` when a loop can process many records quickly; it writes public progress at bounded intervals while renewing the claim for intermediate records. `updateProgress` renews the claim. `releaseClaim` requeues bounded-turn jobs only for the live claim owner. `complete` and `fail` only succeed for the live claim owner before claim expiry. A processor must check those boolean results and stop work when ownership is lost.

External or cross-context calls inside a durable job need a checkpoint or renew immediately before the call and again before recording the resulting domain fact. If a create operation can be replayed, pass a deterministic target id or provider idempotency key. Pricing recommendation apply jobs use this rule when creating marketplace draft listings. Lease-loss or cancellation errors are job control-flow outcomes, not business failures; per-item failure handlers must rethrow them instead of recording domain failure facts.

Retention belongs outside hot execution. Workers run the `durable-jobs.retention` scheduled runner, which prunes terminal durable job rows after the context retention window and removes orphaned staged Inventory import inputs. Retention must never remove staged inputs referenced by queued or running jobs. Event rows cascade from job deletion.

Scheduled jobs can remain scheduled triggers, but a manual operator trigger should enqueue a durable job when it needs visible progress or provider durability.

## Current Migrations

- Platform Projection Operations persist `platform_projection_operation_events` and expose `/api/platform/projections/operations/:operationId/events`.
- Inventory Import Batch create and commit persist `inventory_import_batch_jobs` and stream `/api/inventory/import-batches/jobs/:jobId/events`.
- Pricing Recommendation refresh/apply/dismiss persists `pricing_recommendation_jobs` and streams `/api/marketplace/account/recommendation-jobs/:jobId/events`.
- Settlement manual payout reconciliation persists `settlement_payout_reconciliation_jobs` and streams `/api/settlement/payouts/reconciliation/jobs/:jobId/events`.
- Catalog Source Observation import, reapply, promote, and reject already use durable context-owned job tables and SSE.
- Catalog Source Observation bulk review uses same-job work units for promote/reject/reapply observation ids while preserving the existing public job snapshot.
- Catalog authoring bulk lifecycle, Catalog Item bulk publish, and Catalog Item bulk edit persist `catalog_authoring_bulk_jobs` and stream `/api/catalog/bulk-authoring-jobs/:jobId/events`.
- Catalog authoring bulk `catalog.authoring.items.publish` uses same-job work units, one unit per Catalog Item. Other authoring bulk job kinds stay on the parent claim until their target selection can be materialized without changing action semantics.
- Catalog Source Observation integration `reapply` uses same-job work units, one unit per observation id. Integration `import` remains sequential discovery plus durable per-expansion turns because provider expansion discovery and set import are the durable unit today.
- Inventory Import Batch `create` jobs use same-job work units, one unit per source row, while the staged private input remains the canonical replay source. Import `commit` remains capped at one parent claim until target-level inventory/listing conflict fencing is introduced.
- Pricing Recommendation `dismiss` jobs use same-job work units, one unit per recommendation. `apply` remains capped at one parent claim until listing/inventory target fencing is part of the shared work-unit contract.
- Settlement manual payout reconciliation jobs use same-job work units, one unit per payout candidate, instead of claiming payout rows through `settlement_work_claims`. Scheduled payout reconciliation remains a scheduled trigger and can be upgraded to enqueue durable jobs when operator-visible progress is needed.
