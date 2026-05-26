# Force Platform Deploy

## Intent

Add a manual Platform Deploy control that lets operators reconcile staging and production runtime configuration when the release commit has not changed. This is needed for environment-only repairs such as Google Workspace SSO provider secrets and hosted-domain variables.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-force-platform-deploy`
- Branch: `codex/force-platform-deploy`
- Sandbox id: not created
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Platform Operations owns internal operator workflows for cross-context platform runtime health.
- The deploy workflow is an operational composition surface, not product behavior or a bounded-context runtime API.

## Resolved Decisions

- Add a workflow-dispatch-only `force_deploy` boolean input to `Platform Deploy`.
- Keep automatic `workflow_run` deployments governed by `scripts/change-scope.mjs` so normal mainline deploy behavior remains unchanged.
- When `force_deploy` is true, the resolve job should emit `deploy=true` after validating the requested release commit and required PR check.
- Use the manual force path to redeploy the already-approved SSO production release rather than promoting unrelated newer `main` changes.

## Open Questions

- None.

## Implementation Checklist

- [x] Add manual `force_deploy` input to `.github/workflows/platform-production.yml`.
- [x] Short-circuit deployment scope only for manual dispatches with `force_deploy=true`.
- [x] Validate workflow syntax and focused deployment-scope behavior.
- [ ] Open PR, wait for CI, merge, and run forced deployment for the SSO release. PR #313 opened.
- [ ] Verify staging and production Google social login start routes no longer report an unconfigured provider.

## Documentation To Promote

- No durable docs are needed; this is a small operational workflow control.

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
