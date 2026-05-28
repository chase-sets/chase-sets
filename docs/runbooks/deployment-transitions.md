# Deployment Transitions

Frequent CI/CD deployments are normal operating conditions. Runtime behavior must
make a deploy look like a brief reconnect or worker handoff, not like lost work.

## HTTP Lifecycle

Node deployables use the shared platform runtime lifecycle helper.

On `SIGTERM` or `SIGINT`:

1. Mark the process as draining.
2. Return degraded readiness from `/health/ready` and `/api/health/ready`.
3. Stop accepting new HTTP connections.
4. Stop background timers and worker loops that can start new work.
5. Wait for active request and response streams within the configured grace
   window.
6. Abort long-lived streams after `STREAM_DRAIN_GRACE_MS`.
7. Close provider clients, database pools, and observability.

Liveness remains `ok` until the process exits. Load balancers should remove a
draining process from rotation based on readiness, not liveness.

## SSE And Status Streams

Realtime SSE and Catalog job-status streams are resumable. During drain, new
realtime streams are rejected with `503 process_draining`; existing streams can
close after the stream drain grace period. Clients reconnect using durable
cursors or job ids.

Expected client behavior:

- Realtime clients reconnect with `Last-Event-ID` or cursor query state.
- Catalog job clients reconnect to `/bulk-jobs/:jobId/events` or
  `/integration-jobs/:jobId/events`.
- A temporary `429 too_many_realtime_streams` can be retried with backoff while
  forced-exit leases expire.

## Worker Jobs

Worker runners receive a cancellation signal and a lease guard. Long-running
jobs should check those guards before claims, between batch items, before
provider calls, and before final completion writes.

On cooperative stop, jobs should preserve progress and release or let their
claim expire. They should not mark deployment cancellation as business failure.

Catalog Source Observation bulk/reapply/promote/reject work and Catalog
authoring bulk work are durable job-first. Legacy mutating endpoints enqueue
jobs and return `202`; progress endpoints stream from durable job state.
Progress writes renew durable job ownership, while completion and failure writes
are rejected after lease loss so a replacement worker can safely resume.

## Scheduled Cadence

Scheduled worker cadence is stored in the platform control plane. A worker claims
a scheduled runner only when its durable `next_run_at` is due, then advances the
next run before executing the job. Deploy restarts therefore do not reset
payment reconciliation, seller funds release, or payout reconciliation cadence.

The worker lease still prevents concurrent execution. The scheduled runner table
owns cadence only.

## External Providers

Any provider call that can succeed outside the database transaction must have a
durable local operation intent before the call and a deterministic idempotency or
reconciliation key. Payments, Fulfillment, and Settlement own their own provider
operation state and business facts.

## Operational Checks

- Readiness should flip to degraded immediately when drain starts.
- Active request and stream counts should fall before pool close.
- Realtime `process_draining`, `sync.required`, and `too_many_realtime_streams`
  rates should settle after deployment.
- Worker active runner count should fall to zero during drain.
- Catalog job progress should resume after worker replacement.
- Scheduled runner `next_run_at` should not jump backward after restart.
- Provider-operation backlogs should be monitored by owning context.

## Verification

Before changing deployment-transition behavior:

```powershell
pnpm run typecheck
pnpm run test:fast
pnpm run check:structure
```

With Postgres available, include platform runtime DB tests and a staging deploy
where an SSE client and a Catalog job remain active across the rollout.
