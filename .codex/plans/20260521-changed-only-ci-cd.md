# Changed-Only CI/CD

## Intent

Reduce CI/CD waste by checking and deploying only the surfaces affected by a change, without introducing deployable image groups yet.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-changed-only-ci-cd`
- Branch: `codex/changed-only-ci-cd`
- Sandbox id: `fdaac9f5`
- Dependency setup status: `pnpm run deps:install` completed; `pnpm run sandbox:doctor` completed
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Infrastructure/operations owns GitHub Actions workflow behavior, deploy classification, Docker image deploy decisions, and DigitalOcean deployment runbook updates.
- No bounded-context product behavior changes are in scope.

## Resolved Decisions

- Defer deployable image groups. The current platform image remains the release artifact because splitting images would increase Docker, registry, promotion, Terraform, and smoke orchestration complexity before there is evidence that component-level redeploy is the limiting bottleneck.
- Add a first-class change classifier that maps changed files to workspace, runtime, Docker image, Terraform, workflow, and deployment scopes.
- Gate expensive PR jobs from classifier outputs. The required aggregate check should accept skipped jobs only when the classifier says that surface was not affected.
- Gate staging and production deployment from release-commit change scope. Documentation-only and workflow-only merges should not build a platform image, apply Terraform, smoke staging, or promote production.
- Preserve the existing safety behavior for runtime changes: the single platform image still deploys all App Platform components together.
- Workflow-only changes run Actionlint and `PR Required`, but do not trigger deployment or Terraform validation by default.
- Terraform validation and deployment scope are reserved for `infrastructure/digitalocean/**` and deployment helper script changes.

## Implementation Checklist

- [x] Add a tested change-scope classifier script.
- [x] Extend workspace runner filtering so CI can run affected workspace scripts and dependents only.
- [x] Update `platform-pr.yml` to add change-scope outputs and conditional jobs.
- [x] Update `platform-production.yml` to skip CD for release commits with no deployable runtime or Terraform surface.
- [x] Update DigitalOcean deployment runbook with the new changed-only behavior and image-group deferral.
- [x] Verify formatting, targeted tests, workflow syntax, static checks, and typecheck locally.

## Documentation To Promote

- `docs/runbooks/digitalocean-platform-deployment.md`

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge, or intentionally skipped by changed-only deploy classification.
- Production deployment verified green after promotion or rollout, or intentionally skipped by changed-only deploy classification.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
