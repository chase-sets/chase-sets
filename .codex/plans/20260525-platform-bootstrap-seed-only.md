# Platform Bootstrap Seed Only

## Intent

Stop long-lived DigitalOcean `platform-bootstrap` deployments from draining Catalog projectors during Catalog integration seed. Staging and production bootstrap should reconcile schema and idempotent seed data only; workers own projection catch-up.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260525-platform-bootstrap-seed-only`
- Branch: `codex/platform-bootstrap-seed-only`
- Base: fresh `origin/main` at `83d795e6`
- Sandbox id: not created
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: default worktree store
- Setup blockers: none

## Owning Contexts

- Catalog owns provider integration seed behavior and Catalog projectors.
- Platform deployment/runbook owns the DigitalOcean bootstrap contract.

## Resolved Decisions

- Long-lived profiles (`critical-bootstrap`, `catalog-integration-bootstrap`) must not drain Catalog projectors in `PRE_DEPLOY`.
- `scenario-seed` keeps projector drains because scenario seed data can depend on projected Catalog read models in disposable preview/local flows.
- No projection or job work should be hidden inside staging/production deploy bootstrap.

## Implementation Checklist

- [x] Patch Catalog seed to drain projectors only when `scenario-seed` is enabled.
- [x] Add regression tests for the seed drain policy.
- [x] Update deployment runbook to call out Catalog seed behavior explicitly.
- [x] Run focused tests and static/type verification.
- [ ] Open PR, wait for CI, merge, and verify staging/production deployment.

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
