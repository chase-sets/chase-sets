# Admin Bulk Job Streaming

## Intent

Move long-running Catalog admin bulk actions out of request-bound progress streams. Operators should be able to start bulk Source Observation promotion or rejection, disconnect or reload the client, and reconnect to streamed server status while the server-side job continues.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-admin-bulk-job-streaming`
- Branch: `codex/admin-bulk-job-streaming`
- Sandbox id: `6780de16`
- Dependency setup status: complete (`pnpm run deps:install`, `pnpm run sandbox:doctor`)
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Catalog owns Source Observations, their bulk review workflow, request contracts, progress state, worker execution, and admin UI status.
- The admin-support worker is a thin composition root that hosts Catalog-owned background job runners.

## Resolved Decisions

- The current `/bulk-promote/progress` and `/bulk-reject/progress` endpoints run the operation inside the streaming request. That makes the operation vulnerable to client/proxy disconnects.
- Persist admin job state in the Catalog schema so any API instance can serve status streams and the worker can claim work horizontally.
- Add a Catalog-owned job runner for pending bulk Source Observation review jobs. The worker loop already supports leased `kind: "job"` runners; the deployable only wires Catalog services into that loop.
- Keep domain invariants unchanged: jobs orchestrate the existing per-observation promotion/rejection behavior and still report mixed `promoted`, `rejected`, `skipped`, and `failed` outcomes.
- Stream job status as server-sent events from the API by polling the persisted job record. A status stream disconnect does not cancel processing.
- Keep the existing immediate bulk endpoints for compatibility, but move progress-capable client calls to enqueue + stream job completion.

## Implementation Checklist

- Completed: Add Catalog Source Observation job tables/types/queries in the source-observations slice.
- Completed: Add service methods to enqueue, claim, process, read, and stream-compatible status for bulk review jobs.
- Completed: Add API routes for starting bulk promotion/rejection jobs, reading job status, and streaming job status.
- Completed: Wire Catalog job processing into admin-support-worker and platform-worker as leased worker runners.
- Completed: Update the Catalog admin API client to use enqueue + status stream for progress-capable bulk actions.
- Completed: Add focused tests for route contracts and retain package coverage.
- Completed: Install dependencies and run `sandbox:doctor` before verification.

## Documentation To Promote

- Completed: Update `bounded-contexts/catalog/docs/admin-bulk-workflows.md` with the persisted job/streaming contract.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
