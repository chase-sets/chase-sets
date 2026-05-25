# Projection Operations Console

## Intent

Give operators a first-class way to monitor projection health, inspect poison events, retry one blocked stream, and rebuild one or all projection groups without ad hoc scripts.

The surface must preserve the event-driven model: publishers append facts, projector consumers own catch-up and repair, and bounded contexts own handlers/read models. Operational repair should use generic runtime capabilities and must not teach publishers or deployables projection-specific business rules.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260525-projection-operations`
- Branch: `codex/projection-operations`
- Base: `origin/main` at `28f35ad9` (`Isolate projection poison events by stream (#274)`)
- Sandbox id: `569462e6`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: passed
- Product/runtime edits during planning: none
- Setup blockers: none

## Owning Contexts

- `@chase-sets/event-core` owns generic projector contracts, projection error vocabulary, and stream-order repair semantics.
- `@chase-sets/event-core-postgres` owns durable poison-event and blocked-stream storage access.
- `@chase-sets/bounded-context-runtime` owns generic projection group status, replay, rebuild, stream repair, and reset semantics.
- `@chase-sets/platform-runtime` owns the operational control-plane API contract and leasing/fencing primitives.
- `admin-support-api` owns authenticated operator API composition for this platform control surface.
- `admin-web` owns the operator UI composition route.
- Individual bounded contexts own projection declarations, handlers, read models, and whether a projection group is safe to rebuild. They do not own the generic operator console.

## Repo Evidence

- `bounded-contexts/README.md` says contexts own read models and cross-context interaction happens through stable IDs and published integration events.
- `docs/architecture/bounded-context-structure.md` reserves shared infrastructure for reusable technical adapters and keeps deployables as thin composition roots.
- `docs/architecture/stream-isolated-projection-errors.md` says runtime records poison/block state and repair can replay blocked streams in stream-version order.
- `docs/runbooks/projection-poison-events.md` currently requires operators to list degraded projections, inspect poison metadata, retry blocked streams, and rebuild groups, but there is no first-class API/UI for that.
- `contracts/event-core/projector.ts` exposes blocked-stream and poison summary primitives, but repair is not an operator surface.
- `infrastructure/event-core-postgres/projection-store.ts` can list and resolve blocked streams by projection key, but it does not expose poison-event details or retry leases.
- `infrastructure/bounded-context-runtime/index.ts` can list/refresh projection group statuses and rebuild projection groups. It also records subscription poison state and clears stale poison state during reset.
- `infrastructure/platform-runtime/control-plane.ts` already has worker heartbeats, runner statuses, and lease/fencing primitives that fit repair/rebuild operations.
- `deployables/admin-support-api/src/app.ts` mounts health and bounded-context APIs, but has no projection operations routes.
- `deployables/admin-web/app/routes.ts` composes admin routes from context manifests plus deployable-owned layouts; a platform operations route is appropriate as deployable composition because it is a cross-context operational surface, not a business context feature.
- `bounded-contexts/catalog/context.json` has `drainProjectorsOnWrite: false`, so the high-volume Catalog symptom depends on workers and operator repair, not page-local projection drains.

## Resolved Decisions

- Add a platform projection operations surface instead of scripts. Scripts remain useful for emergencies, but normal repair should be audited, bounded, and available through admin tools.
- Keep publishers unaware of projection operations. No command handler, bulk promotion job, or integration import should call repair/rebuild APIs.
- Treat `projection_key + stream_id` as the retry boundary for poisoned stream repair. This preserves per-stream ordering and leaves unrelated streams unaffected.
- Treat projection group rebuild as an asynchronous, lease-guarded operation triggered through the existing revision-aware `rebuildContextProjectionGroup` and `rebuildAllContextProjectionGroups` paths.
- Do not implement an unsafe “skip event” button in this pass. Ignoring poison events needs a stricter context-owner policy and audit trail; retry and rebuild cover the production recovery need.
- Use the existing control-plane lease table for fencing rebuild and retry commands so two operators or workers cannot repair the same projection concurrently.
- Expose high-cardinality stream/event IDs only in paginated operator detail views and structured API responses, not metrics labels.
- Keep local projector stream retry as an explicit follow-up unless the existing generic projector contract can apply handlers by stream without context-specific composition. Cross-context subscription repair is the critical scalable path for projection groups.

## Implementation Checklist

1. [x] Extend event-core projection operations contracts.
   - Add poison-event detail DTOs to the projection store contract.
   - Add retry result types that report applied, deferred, resolved, or still blocked.

2. [x] Extend Postgres projection storage.
   - List active poison events by projection key with bounded pagination.
   - Mark blocked stream and poison events as `retrying` during repair and `resolved` after successful same-stream replay.
   - Preserve existing reset cleanup behavior.

3. [x] Add bounded-context runtime repair operations.
   - Find a subscription runner by `checkpointKey`.
   - Replay one blocked stream from `firstBlockedStreamVersion` using source `readStream`.
   - Apply only events relevant to that subscription, in stream-version order.
   - Stop and keep state blocked if a later event on the same stream fails.
   - Provide rebuild one group and rebuild all groups commands through existing rebuild functions.

4. [x] Add platform operations API.
   - `GET /api/platform/projections` returns refreshed group, subscription, worker, runner, blocked-stream, and poison summaries.
   - `GET /api/platform/projections/:projectionKey/blocked-streams` returns paginated blocked stream details.
   - `POST /api/platform/projections/:projectionKey/blocked-streams/:streamId/retry` retries one stream with a lease.
   - `POST /api/platform/projection-groups/:contextName/:projectionName/rebuild` rebuilds one projection group with a lease.
   - `POST /api/platform/projection-groups/:contextName/rebuild` rebuilds all projection groups for one context with a lease.

5. [x] Add admin web UI.
   - Add an Operations section or route visible to signed-in admins.
   - Show projection group health, runner health, worker heartbeats, blocked stream counts, poison counts, and stale revisions.
   - Provide detail rows for blocked streams and poison errors.
   - Provide confirmation forms for retry stream and rebuild group/all groups.

6. [x] Update docs.
   - Update `docs/runbooks/projection-poison-events.md` with the API/UI workflow.
   - Add durable API notes if the route contract is not self-evident.

7. [x] Verify.
   - Add focused runtime tests for stream retry success/failure and rebuild command routing.
   - Add admin-support API tests for status, retry, and rebuild endpoints.
   - Add admin-web route/component tests for rendering degraded states and command forms.
   - Run focused package tests, `pnpm run typecheck`, `pnpm run verify:static`, and `pnpm run verify:build`.

## Implementation Progress

- Added projection poison event detail contracts and Postgres listing/retrying helpers.
- Added bounded-context runtime blocked-stream retry for subscription projection keys.
- Added generic projection operations endpoints under `/api/platform/projections` with `security.manage` authorization and control-plane lease fencing.
- Added an admin web Projection Operations route with projection group status, runner/worker status, blocked stream retry, and projection group rebuild actions.
- Updated the projection poison runbook with the UI/API workflow.
- Verification passed:
  - `pnpm --filter @chase-sets/bounded-context-runtime test`
  - `pnpm --filter @chase-sets/event-core-postgres test`
  - `pnpm --filter @chase-sets/app-admin-support-api test`
  - `pnpm --filter @chase-sets/app-admin-web test`
  - `pnpm --filter @chase-sets/app-admin-web typecheck`
  - `pnpm --filter @chase-sets/app-admin-support-api typecheck`
  - `pnpm run verify:static`
  - `pnpm run typecheck`
  - `pnpm run verify:build`

## Operations And Best-Practice Notes

- Repair commands must be idempotent. Retrying an already-resolved stream should return a no-op success.
- Long-running rebuilds must not run inside a request without fencing. If the existing runtime cannot complete within request limits, the route should create a durable operation record and workers should drain it.
- Retry one blocked stream should be synchronous only while it is bounded by stream history and batch size. If a stream is large, return partial progress and let the operator repeat or queue a repair operation.
- Rebuilds are destructive to owned read-model tables and require explicit confirmation in UI copy and request payload.
- API responses should include exact projection keys, stream IDs, event IDs, event types, global positions, retry counts, and errors for targeted diagnosis.
- Metrics must stay low-cardinality: projection kind/name, context, operation, state, and result are acceptable; stream ID and event ID are not.

## Open Questions

No blocking product/domain question. The recommended default is to ship a generic platform operations API and admin UI with retry and rebuild. Explicit poison-event ignore stays out of scope until there is a documented context-owner approval policy.

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
