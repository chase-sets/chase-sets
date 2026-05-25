# Projection Operations Route Fix

## Intent

Fix the operations admin projections page returning 404 by ensuring the projection operations API exists on the API host used by the admin web same-origin `/api` path in each deployment topology.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260525-projection-operations-route-fix`
- Branch: `codex/projection-operations-route-fix`
- Sandbox id: `2b14fc31`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: default embedded worktree store
- Setup blockers: none

## Owning Contexts

- `infrastructure/platform-runtime`: shared platform operational route factory for projection monitoring and repair.
- `deployables/platform-api`: full-platform composition root used by non-production same-origin admin API calls.
- `deployables/admin-support-api`: split production support API composition root.

## Resolved Decisions

- The admin web route exists at `/operations/projections`; the 404 comes from its loader calling `/api/platform/projections` against an API host that did not mount the new operational API.
- The projection operations route should not remain owned by one deployable because both `platform-api` and `admin-support-api` need the same operational surface.
- The route factory belongs in `@chase-sets/platform-runtime/projection-operations-routes`; deployables only attach auth middleware and mount it.
- `platform-api` should pass the platform control plane to this route so worker status, runner status, and operation leases work in full-platform environments.

## Implementation Checklist

- Move projection operations route factory into platform runtime.
- Export the new platform-runtime subpath and declare its dependencies.
- Rewire `admin-support-api` to import the shared route.
- Mount `/api/platform/projections` in `platform-api` with platform actor auth and control-plane access.
- Add platform-api coverage for permission gating and successful route mounting.
- Update runbook topology language.

## Goal Completion Criteria

- PR submitted for the completed implementation.
- CI passing on the PR before merge.
- PR merged after passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
