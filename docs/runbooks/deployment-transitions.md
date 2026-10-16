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

Realtime SSE and durable job-status streams are resumable. During drain, new
realtime streams are rejected with `503 process_draining`; existing streams can
close after the stream drain grace period. Clients reconnect using durable
cursors or job ids.

Expected client behavior:

- Realtime clients reconnect with `Last-Event-ID` or cursor query state.
- Durable job clients reconnect to the owning context's `/jobs/:jobId/events`
  endpoint with `Last-Event-ID`.
- Temporary `429 too_many_realtime_streams` and
  `429 too_many_durable_job_streams` responses can be retried with backoff while
  stream slots or forced-exit leases clear.

## Worker Jobs

Worker runners receive a cancellation signal and a lease guard. Long-running
jobs should check those guards before claims, between batch items, before
provider calls, and before final completion writes.

On cooperative stop, jobs should preserve progress and release or let their
claim expire. They should not mark deployment cancellation as business failure.

Catalog Source Observation, Catalog authoring bulk work, Inventory import
batch create/commit, Pricing recommendation refresh/apply/dismiss, and manual
Settlement payout reconciliation are durable job-first. Legacy mutating
endpoints enqueue jobs and return `202`; progress endpoints stream from durable
job state. Progress writes renew durable job ownership, bounded-turn jobs
release the live claim back to `queued`, and completion/failure writes are
rejected after lease loss so a replacement worker can safely resume.

Catalog Source Observation bulk review, Catalog Source Observation integration
reapply, Catalog authoring item publish, Inventory import create, Pricing
recommendation dismiss, and manual Settlement payout reconciliation use same-job
work units. During deploy drain, each active lane receives cancellation through
the platform runner lease context and releases its current work-unit claim; if
the process exits first, the unit becomes claimable after its TTL. The parent job
remains the public status/SSE aggregate, and deployment handoff should appear as
a brief pause in progress rather than a failed job.

Replayable jobs should resume the same target after worker replacement.
Inventory import create jobs persist their target batch id before validation and
protect active staged inputs from retention cleanup; Pricing recommendation
apply jobs use deterministic marketplace draft listing ids for replayed create
work.

## Scheduled Cadence

Scheduled worker cadence is stored in the platform control plane. A worker claims
a scheduled runner only when its durable `next_run_at` is due, then advances the
next run before executing the job. Deploy restarts therefore do not reset
payment reconciliation, seller funds release, or payout reconciliation cadence.

The worker lease still prevents concurrent execution. The scheduled runner table
owns cadence only.

The `durable-jobs.retention` scheduled runner prunes terminal job/event rows
after the retention window and removes orphaned staged Inventory import inputs.
It is safe for every worker process to register; the platform control plane
leases the cadence so only one process runs a turn.

## Event Types Added To Existing Subscriptions

The API and worker are separate workloads, so a new producer can append an event
while an old worker still owns a consumer checkpoint. The old worker filters the
new type out of its unchanged subscription and advances its checkpoint past it,
so the upgraded worker never reads that event. When a change adds event types to
existing subscriptions without a new `subscriptionVersion`, its producers stay
behind a default-closed admission and roll out in two phases:

1. Deploy the release with the producer switch off. Every worker heartbeat
   carries `consumedEventTypes`, the event types its subscription runners read.
2. Let the worker rollout finish. A stale heartbeat does not retire a worker,
   because a process whose heartbeat writes fail can keep renewing its leases.
   Only the deployment quiesce retires workers: the bootstrap hook scales
   `platform-worker` to zero, and the bootstrap records the quiesce only when
   no worker pod is left, terminating pods included, within the drain budget.
   A pod still exiting withholds the record without failing the deploy, and a
   later deploy records it. Admission reads
   the control plane on every request and stays closed until a quiesce is
   recorded, while a worker started before it still owns an unexpired lease,
   while any worker that started or heartbeated since it predates
   `consumedEventTypes` or reads the anchor event without the new types,
   whatever its heartbeat age, and until one of those capable workers is active.
3. Open the switch in a later API-only change. Its deployment quiesces the
   workers again. Refusals log the blocking reason and worker ids, so a refusal
   after opening names the worker still in the way.
4. After opening, roll the API back freely but keep the capable workers
   installed. If a worker rollback is unavoidable, close the switch first and
   wait until the consumer projections report caught up in
   [Projection Operations](./projection-operations.md). A returning old worker
   closes admission again when it first heartbeats, but cannot recover events
   it already skipped.

Offer Pause, Resume and Withdraw use this admission:
`CHASE_SETS_OFFER_LIFECYCLE_OPEN` is the switch, refusals return `503
offer_lifecycle_closed` and log `offer_lifecycle_closed_refusal`.

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
- Durable job `too_many_durable_job_streams` rates should be brief and should
  not coincide with sustained Postgres pool pressure.
- Worker active runner count should fall to zero during drain.
- Catalog job progress should resume after worker replacement.
- Same-job work-unit summaries should show active claims falling during drain,
  expired claims recovering after replacement, and no private payloads in worker
  status.
- Scheduled runner `next_run_at` should not jump backward after restart.
- Provider-operation backlogs should be monitored by owning context.

## Same-Job Parallelism Controls

Staging runs two platform-worker instances with four job runners per instance.
Same-job lanes are enabled for the migrated workflows, with workflow caps higher
than per-parent caps so a massive job can use spare capacity without starving a
second job:

- Source Observation bulk review: four lanes, workflow cap four, parent cap two.
- Source Observation integration reapply: four lanes, workflow cap four, parent cap two.
- Inventory import create: four lanes, workflow cap four, parent cap two.
- Catalog authoring item publish: three lanes, workflow cap three, parent cap two.
- Pricing recommendation dismiss: three lanes, workflow cap three, parent cap two.
- Settlement payout reconciliation: two lanes, workflow cap two, parent cap one.

Production defaults stay conservative: one lane and one active claim per parent
job for each migrated workflow. To scale production, raise the workflow's
`*_LANE_COUNT`, then `*_WORKFLOW_MAX_ACTIVE_CLAIMS`, then
`*_MAX_ACTIVE_CLAIMS_PER_JOB` in that order. Keep
`WORKER_JOB_MAX_CONCURRENT_RUNNERS`, worker instance count, and database pool
capacity above the requested active lanes. Roll back by lowering the lane count
or caps; active claims finish, release, or expire under the normal durable job
TTL.

## Verification

Before changing deployment-transition behavior:

```powershell
pnpm run typecheck
pnpm run test:fast
pnpm run check:structure
```

With Postgres available, include platform runtime DB tests and a staging deploy
where an SSE client and a Catalog job remain active across the rollout.
