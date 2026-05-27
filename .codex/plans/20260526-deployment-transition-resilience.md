# Deployment Transition Resilience

## Intent

Frequent CI/CD deployments must not make active connections, long-running work, or external provider side effects brittle. The implementation should make deployment transitions graceful first, then make every operation that can outlive an HTTP request durable, replay-safe, and owned by the bounded context that owns the behavior.

This plan covers the six reviewed findings:

- Deployables do not drain HTTP/SSE before exit.
- Some Catalog Source Observation bulk/reapply paths still execute inside API requests.
- Payment, Fulfillment, and Settlement provider calls can succeed before durable local facts are recorded.
- Scheduled worker cadence is process-local.
- Realtime stream leases can overcount after forced process exits.
- Worker shutdown waits for active jobs, but Catalog job turns do not cooperate with the worker lease signal.

## Worktree

- Path: `D:/Users/ToddS/Source/Repos/chase-sets/.codex/worktrees/20260526-deployment-transition-plan`
- Branch: `codex/deployment-transition-plan`
- Base: freshly fetched `origin/main` at `8e241d18`
- Sandbox id: not created
- Dependency setup status: pnpm dependencies installed by focused verification commands; no local sandbox created
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Shared runtime infrastructure owns generic HTTP lifecycle, readiness state, SSE drain behavior, worker loop cancellation, stream lease cleanup, scheduled runner leasing, and control-plane primitives.
- Deployables own only composition roots and environment wiring. They should call shared lifecycle helpers, not reimplement drain policy.
- Catalog owns Source Observation jobs, status streams, Source Observation reapply/promote/reject behavior, and tests under `bounded-contexts/catalog/features/source-observations`.
- Payments owns buyer charge workflow, payment processor references, payment provider idempotency records, and payment reconciliation.
- Fulfillment owns Shipment, label purchase references, tracking identifiers, and label void facts.
- Settlement owns Wallet, Ledger Entry, Payout, payout provider idempotency records, seller funds release, and payout reconciliation.
- Platform Operations owns operator language and UI around runtime health, but not runtime lease/fencing semantics.

## Repo Evidence

- `docs/runbooks/realtime-sse.md` already defines durable SSE outboxes, `Last-Event-ID` replay, `sync.required`, and active/rejected stream monitoring.
- `docs/runbooks/projection-operations.md` already defines durable projection operations, worker leases, claim TTL recovery, and cancellation at safe lease or transaction boundaries.
- `infrastructure/platform-runtime/worker.ts` passes `ProjectionRunContext.signal` and `throwIfLeaseLost` to runner `runOnce`, renews leases, and aborts on renewal failure.
- `deployables/platform-api/src/main.ts`, `deployables/admin-support-api/src/main.ts`, `deployables/platform-worker/src/main.ts`, and `deployables/admin-support-worker/src/main.ts` call `serve(...)` without retaining a server handle, then close pools and call `process.exit(0)` in signal handlers.
- `infrastructure/platform-runtime/health.ts` computes readiness from dependency checks only; there is no process-draining readiness gate.
- `bounded-contexts/catalog/features/source-observations/api/route.ts` keeps durable job endpoints, but `/reapply`, `/reapply/progress`, `/bulk-promote`, and `/bulk-reject` still have direct request-owned execution paths.
- `bounded-contexts/catalog/features/source-observations/api/runtime.ts` already has queued Source Observation bulk/integration job tables, claim expiry, bounded batch turns, and progress persistence. The missing piece is routing all long-running paths through those jobs and accepting cancellation context inside worker turns.
- `bounded-contexts/payments/features/payments/api/runtime.ts` creates a new `paymentId`, calls the processor using `payments:payment:{paymentId}:create`, then appends the `CreatePayment` event and records provider idempotency.
- `bounded-contexts/fulfillment/features/shipments/api/runtime.ts` calls `postageLabelProvider.purchaseUspsLabel` and `postageLabelProvider.voidLabel` before appending the corresponding Shipment event.
- `bounded-contexts/settlement/features/payouts/api/runtime.ts` posts wallet debit, calls transfer and payout provider APIs, then records provider idempotency and marks payout in transit. Payouts are less request-opaque than Payments/Fulfillment because provider idempotency keys are deterministic by `payoutId`, but the workflow still needs durable operation state around provider calls.
- `deployables/platform-worker/src/main.ts` keeps scheduled job cadence in an in-memory `nextRunAt`.
- `infrastructure/platform-runtime/realtime-stream-limiter.ts` uses TTL-backed Postgres/Redis leases, but release depends on stream cleanup when the process exits gracefully.

## Resolved Decisions

1. Use one shared lifecycle helper for Node/Hono deployables.

   Add shared runtime support, likely under `infrastructure/platform-runtime/process-lifecycle.ts`, that starts the Hono server, tracks active requests/streams, exposes a draining flag to readiness, stops accepting new connections on `SIGTERM`/`SIGINT`, waits up to a configurable grace period, then closes background resources and pools. Deployables should pass cleanup callbacks for realtime sweepers, partition maintainers, wake signals, stream limiters, worker loops, pools, and observability.

   Recommended policy: readiness returns `503` immediately after drain starts; liveness remains `200` until the process is ready to exit.

2. Treat SSE and job-status streams as graceful-drain aware.

   The shared helper should close or stop accepting streams during drain. Existing SSE replay makes disconnection acceptable, so drain does not need to keep streams forever. Realtime clients reconnect with cursor replay; Catalog job-status clients reconnect by job ID. Use a bounded stream drain timeout shorter than the platform termination window.

3. Convert Catalog long-running request routes to durable job-first behavior.

   Keep preview endpoints synchronous because they are bounded reads. Convert the mutating `/reapply`, `/reapply/progress`, `/bulk-promote`, and `/bulk-reject` paths to enqueue durable Catalog jobs or return `202` with the job representation. The existing `*/jobs` and `*/events` endpoints should become the primary API. Backward-compatible endpoints can remain temporarily as wrappers that enqueue jobs instead of executing inline, but they should not perform unbounded work in the request.

4. Introduce a durable Catalog reapply job type rather than overloading direct request progress.

   The existing integration job supports `reapply` by scope and bulk review jobs support promote/reject. Preserve Catalog ubiquitous language by making this a Source Observation Reapply Job. It can reuse the existing integration job schema only if the route/API language remains clear and tests prove explicit-ID and scoped reapply semantics. If overloading creates ambiguous terminology, add a Source Observation job table or action dedicated to reapply under the Source Observations slice.

5. Add cancellation/cooperation to Catalog job turns.

   Extend `processNextBulkReviewJob` and `processNextIntegrationJob` to accept a worker run context or `{ signal, throwIfLeaseLost }`. Check it before claiming, between each item/expansion, before provider fetch/import work, and before marking final state. On cooperative stop, persist progress and requeue/leave claim recovery deterministic rather than marking the job failed.

6. Move external provider side effects behind durable operation state.

   Payments should persist local intent before processor session creation. The optimal shape is a Payment aggregate state such as `payment-created/pending-provider-session` plus a worker-owned provider operation that creates the processor session with the deterministic idempotency key and records `PaymentProcessorSessionCreated` or `PaymentProcessorSessionCreationFailed`. The API returns `202` or a pending payment response until the provider session is recorded; UI polls/revalidates or subscribes.

   Fulfillment should record a Shipment label operation before calling the provider. Use deterministic operation keys tied to `shipmentId` and operation kind. Provider success records label references on the Shipment; provider failure records a failure fact. A retry first checks local operation/provider-reference state and provider idempotency/replay records before calling the provider again.

   Settlement payout provider work should follow the same durable provider-operation pattern for transfer and payout steps. The existing deterministic keys are a good base; record the intended transfer/payout operation before calling Stripe Connect, and make reconciliation safe when the process dies after provider success but before local completion.

7. Keep provider operation ownership context-local.

   Do not add a generic cross-context provider-operation table that owns business facts. Shared infrastructure may provide small helpers for leased dispatch or idempotency mechanics, but Payments, Fulfillment, and Settlement must own their operation rows/events, provider references, retry policy, and API/UI language.

8. Persist scheduled worker cadence in the control plane.

   Replace in-memory `nextRunAt` with a durable scheduled-runner table or control-plane API keyed by runner name. A runner claims only when `next_run_at <= now()`, updates `last_started_at`, then writes `next_run_at` after completion or failure. Use the existing worker lease as the concurrent execution guard, but keep cadence in Postgres so deploy restarts do not reset schedules.

9. Make realtime stream leases deployment-friendly.

   During graceful drain, stop accepting new streams and release known stream leases by letting handlers finish/abort. Add tests around forced-abort cleanup. Keep TTL fallback, but tune production TTL/renewal so reconnect 429 windows are short. Consider client behavior for `429` to retry with backoff without treating it as fatal.

10. Prefer explicit transition observability.

    Add structured logs and metrics for `process.draining_started`, active request count, active SSE count, drain timeout exits, worker stop duration, cooperative job cancellation, scheduled runner skipped/claimed, and provider operation resumed/reconciled.

## Implementation Checklist

1. Shared graceful lifecycle

   - Add a shared lifecycle module in `infrastructure/platform-runtime`.
   - Track active requests and stream responses around Hono `fetch`.
   - Add drain state that readiness can include via `createHealthRoutes`.
   - Retain and close the Node server handle returned by `serve`.
   - Support configurable `SHUTDOWN_GRACE_MS`, `STREAM_DRAIN_GRACE_MS`, and forced-exit fallback.
   - Update `platform-api`, `admin-support-api`, `platform-worker`, and `admin-support-worker` composition roots to use it.
   - Tests: lifecycle helper unit tests, deployable signal handler tests if feasible, readiness returns 503 while draining, cleanup order closes pools after server drain.

2. Realtime/SSE transition behavior

   - Ensure `/api/realtime/*` observes drain state and stops accepting new streams.
   - On drain, allow existing SSE streams to close with a short grace because replay handles recovery.
   - Ensure stream limiter lease release runs on stream abort/close and is covered by tests.
   - Add retry/backoff behavior for client `429` if not already sufficient.
   - Tests: reconnect from cursor after simulated stream close; limiter lease release on abort; 429 retry/backoff path.

3. Catalog Source Observation durable jobs

   - Update route tests to expect job enqueue for long-running mutating endpoints.
   - Keep preview endpoints synchronous.
   - Route legacy direct endpoints to job creation and job status, or intentionally remove them as a breaking cleanup if callers can be updated in the same slice.
   - Update Catalog shell/client support to consume job endpoints and reconnect by job ID.
   - Add or clarify a Source Observation Reapply Job model.
   - Pass worker cancellation context through Catalog job runners in both `platform-worker` and `admin-support-worker`.
   - Tests: route tests for 202/job response, status stream reconnect, worker signal requeues/preserves progress, explicit-ID and scoped reapply idempotence.

4. Payments provider operation hardening

   - Add Payment state/events for processor-session pending/succeeded/failed, or a Payments-owned operation table with events for durable truth.
   - Persist intent before calling Stripe/fake gateway.
   - Add a worker runner for pending payment provider operations, leased through the existing worker loop.
   - Keep provider idempotency key deterministic and persisted before the provider call.
   - Update route/UI/client behavior to handle pending provider session if needed.
   - Tests: crash-window simulation where intent is persisted but provider not called; provider success before local completion resumes without duplicate session; failed provider call records failure and can retry.

5. Fulfillment label operation hardening

   - Add Shipment label purchase/void operation state owned by Fulfillment.
   - Persist operation intent before calling postage provider.
   - Add deterministic provider idempotency if the provider supports it; otherwise store enough request fingerprint/reference data to prevent duplicate labels and guide reconciliation.
   - Add worker runner or bounded operation dispatcher for label purchase/void execution.
   - Tests: provider success before event append recovery, duplicate retry prevention, void replay, address override audit preserved.

6. Settlement payout operation hardening

   - Persist transfer and connected-account payout operation intent before provider calls.
   - Use existing deterministic idempotency keys and provider idempotency read model, but make it authoritative for resume/reconcile.
   - Add step-level resume for wallet debit, transfer create, payout create, mark-in-transit.
   - Tests: process death after wallet debit, after transfer, after payout; idempotent retry does not duplicate ledger debit or provider movement.

7. Durable scheduled cadence

   - Add control-plane schema/API for scheduled runner state.
   - Replace `createScheduledJobRunner` in-memory `nextRunAt`.
   - Keep worker lease around execution and use schedule state for cadence.
   - Tests: restart simulation preserves next run; two workers do not both run; failure schedules next attempt using policy.

8. Verification and rollout

   - Run focused unit tests for changed modules.
   - Run `pnpm run typecheck`.
   - Run `pnpm run test:fast`.
   - Run `pnpm run check:structure`.
   - With Postgres: run platform runtime realtime/control-plane DB tests and any new provider-operation recovery tests.
   - Roll out behind conservative grace/TTL env defaults in staging first.
   - During staging deployment, keep an SSE client connected and a Catalog job running, then deploy and confirm reconnect/resume.
   - During production deployment, monitor active/rejected realtime streams, sync.required rate, worker heartbeats, claim TTL age, scheduled runner last/next run, and provider-operation backlog.

## Implementation Progress

- Added shared platform runtime lifecycle support with drain state, active request/stream tracking, server close handling, stream abort after grace, phased cleanup callbacks, and readiness integration.
- Updated platform API, admin support API, platform worker, and admin support worker to use the shared lifecycle helper instead of direct signal handlers that close pools and exit immediately.
- Added realtime drain behavior so new SSE streams receive `503 process_draining` while deployables are draining.
- Converted Catalog Source Observation legacy `/reapply`, `/reapply/progress`, `/bulk-promote`, and `/bulk-reject` paths to enqueue durable jobs instead of running scope work inside the request.
- Added Catalog bulk `reapply` jobs for explicit observation-id reapply work and retained integration `reapply` jobs for scope-based reapply.
- Threaded worker lease cancellation context into Catalog bulk and integration job turns and release running claims without marking jobs failed when cancellation is deployment-driven.
- Persisted scheduled runner cadence in the platform control plane and updated platform-worker scheduled jobs to claim due runs from durable state instead of process-local `nextRunAt`.
- Added context-owned provider operation state for Payments, Fulfillment, and Settlement. Each context now records a durable pending operation before payment processor, postage label, transfer, or payout provider calls and marks the operation succeeded or failed afterward without moving business ownership into shared infrastructure.
- Added `docs/runbooks/deployment-transitions.md` and linked deployment drain guidance into realtime and projection operations runbooks.
- Focused verification passing:
  - `pnpm --filter @chase-sets/platform-runtime test`
  - `pnpm --filter @chase-sets/catalog test -- source-observations/api/route.test.ts source-observations/api/runtime.test.ts`
  - `pnpm --filter @chase-sets/payments test -- payments/api/runtime.test.ts`
  - `pnpm --filter @chase-sets/fulfillment test -- shipments/api/runtime.test.ts`
  - `pnpm --filter @chase-sets/settlement test -- payouts/api/runtime.test.ts`
  - `pnpm --filter @chase-sets/app-platform-api test -- app.test.ts`
  - `pnpm --filter @chase-sets/app-platform-api run typecheck`
  - `pnpm run check:structure` passed with existing structure warnings.
- Broad verification passing:
  - `pnpm run sync:workspace-metadata`
  - `pnpm run verify:metadata`
  - `pnpm run typecheck`
  - `pnpm run test:fast`
  - `pnpm run verify:static` passed with existing structure warnings.
  - `pnpm run build` passed with existing Vite chunk-size warnings.
- Remaining implementation scope: PR/CI/merge/deployment verification and cleanup. DB-profile fast tests are covered by `pnpm run test:fast`; any deeper sandbox/staging crash-window drills should run during rollout.

## Documentation To Promote

- Add a runtime runbook such as `docs/runbooks/deployment-transitions.md` documenting graceful shutdown, readiness/liveness behavior, SSE reconnect expectations, worker stop behavior, and operational checks.
- Update `docs/runbooks/realtime-sse.md` with deployment drain and stream lease TTL behavior.
- Update `docs/runbooks/projection-operations.md` with cooperative worker job cancellation expectations beyond projection operations.
- Add context-owned notes if provider operation models become non-obvious:
  - `bounded-contexts/payments/docs/provider-operation-recovery.md`
  - `bounded-contexts/fulfillment/docs/postage-label-operation-recovery.md`
  - `bounded-contexts/settlement/docs/payout-operation-recovery.md`
- Update `docs/README.md` for any new durable docs.

## Stress Tests

- Normal flow: HTTP write starts and finishes before deployment; response unchanged.
- Request drain: readiness flips to degraded, load balancer stops sending new work, in-flight bounded request completes, then pools close.
- SSE transition: connection closes during deployment; browser reconnects with cursor and receives retained patches or `sync.required`.
- Catalog partial job: worker exits halfway through a batch; progress is preserved and next worker skips completed outcomes.
- Catalog cancellation: worker lease signal aborts during a job; job is requeued or claim expires without being marked failed.
- Payment provider success before local completion: retry/resume uses deterministic idempotency key and records the same provider reference.
- Fulfillment label success before local completion: retry does not buy a second label.
- Settlement payout transfer success before payout creation: resume continues at payout step without second wallet debit or transfer.
- Schedule restart: worker restarts repeatedly; scheduled jobs do not run more often than configured cadence.
- Stream lease overcount: process exits without cleanup; lease expires quickly enough that reconnect backoff clears the condition.

## Open Questions

None blocking. Recommended defaults:

- Keep breaking cleanup acceptable for admin-only Catalog long-running endpoints if same-slice clients are updated in the PR.
- Use a shared lifecycle helper rather than per-deployable bespoke signal handling.
- Use context-owned provider operation state rather than one generic provider-operation service.
- Return `202` for newly durable provider/session flows when the provider result is not immediately available.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
