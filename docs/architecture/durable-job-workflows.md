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

1. Context-owned job tables for the job snapshot and ordered event snapshots.
2. A `POST` endpoint that validates intent, persists the job, appends the first event, and returns `202`.
3. A worker runner that claims one job turn, records progress, completes or fails the job, and releases work through persisted state.
4. A `GET /jobs/:jobId/events` SSE endpoint that replays ordered events after `Last-Event-ID`.

The shared infrastructure is intentionally small:

- `durable-job-store.ts` provides the Postgres claim/update/event mechanics.
- `durable-job-events.ts` provides SSE cursor parsing, keepalive, and event formatting.

Domain payloads, progress language, result shapes, permissions, and worker composition stay in the owning bounded context.

## Schema Shape

Context schemas should add tables with `durableJobSchemaSql`:

```ts
durableJobSchemaSql({
  jobsTable: "inventory_import_batch_jobs",
  eventsTable: "inventory_import_batch_job_events",
});
```

The job table stores the latest snapshot. The event table stores append-only snapshots with a monotonically increasing `sequence` per job. SSE clients use that sequence as the event id.

## API Shape

Use explicit job endpoints rather than overloading synchronous result language:

- `POST /.../run` or `POST /.../commit` returns the job snapshot with `202`.
- `GET /.../jobs/:jobId` returns the current job snapshot.
- `GET /.../jobs/:jobId/events` streams status events.

Event streams must use `text/event-stream`, must honor `Last-Event-ID`, and must terminate after `completed`, `failed`, or the domain terminal state.

## Worker Shape

Workers should register a `job` runner that:

- claims queued or expired running work with `FOR UPDATE SKIP LOCKED`,
- passes a worker id as `claimOwnerId`,
- persists progress before and after meaningful phases,
- checks abort and lease-loss callbacks between batches or external calls,
- completes with a domain result or fails with an error message.

Scheduled jobs can remain scheduled triggers, but a manual operator trigger should enqueue a durable job when it needs visible progress or provider durability.

## Current Migrations

- Platform Projection Operations persist `platform_projection_operation_events` and expose `/api/platform/projections/operations/:operationId/events`.
- Inventory Import Batch create and commit persist `inventory_import_batch_jobs` and stream `/api/inventory/import-batches/jobs/:jobId/events`.
- Pricing Recommendation refresh/apply/dismiss persists `pricing_recommendation_jobs` and streams `/api/marketplace/account/recommendation-jobs/:jobId/events`.
- Settlement manual payout reconciliation persists `settlement_payout_reconciliation_jobs` and streams `/api/settlement/payouts/reconciliation/jobs/:jobId/events`.
- Catalog Source Observation import, reapply, promote, and reject already use durable context-owned job tables and SSE.
- Catalog authoring bulk lifecycle, Catalog Item bulk publish, and Catalog Item bulk edit persist `catalog_authoring_bulk_jobs` and stream `/api/catalog/bulk-authoring-jobs/:jobId/events`.
