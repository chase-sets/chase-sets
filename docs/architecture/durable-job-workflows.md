# Durable Job Workflows

Durable jobs are the platform pattern for user- or operator-triggered work that can outlive one HTTP request, API process, worker process, or deployment.

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
- `durable-job-events.ts` provides SSE cursor parsing, keepalive, event formatting, stream limiting, and polling fallback.

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

State transitions and event appends must be committed atomically. The shared Postgres store wraps enqueue, claim, progress, release, complete, and fail transitions with their corresponding event append, then emits a `pg_notify` wakeup after the event row is written. Notification waits are best-effort because some deployed runtime pool URLs are PgBouncer transaction pools; if `LISTEN` is unavailable or a waiter fails, the SSE route must fall back to a short poll timeout. Listener setup failures are circuit-broken before retry so open streams do not repeatedly churn pooled transaction connections. A missed notification is acceptable because SSE replay always reloads ordered events.

Do not store large request bodies directly in a durable job payload when the job will emit many progress events. Stage bulky or sensitive inputs in context-owned storage and put only a stable staging reference in the job payload.

Replayable create-style jobs must also store the deterministic target id they will mutate. Inventory import create jobs, for example, persist the target `batchId` in the job payload before row validation begins and derive row ids from `(batchId, rowNumber)`. If a worker loses its claim after partial inserts, the next worker resumes the same batch instead of creating a second one.

Projection operations are platform control-plane jobs rather than bounded-context jobs, but they follow the same durability contract: progress writes renew the claim to `now + ttl`, terminal writes require the live claim, operation state and event append commit together, SSE uses notification-backed waits, and event sequence numbers are reserved through the operation row instead of recomputing from event history. Long rebuild and retry operations must renew the operation claim while the inner projection-group lease is held, and the inner operation must abort when either claim is lost.

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
- Catalog authoring bulk lifecycle, Catalog Item bulk publish, and Catalog Item bulk edit persist `catalog_authoring_bulk_jobs` and stream `/api/catalog/bulk-authoring-jobs/:jobId/events`.
