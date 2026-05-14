# Deploy Staging Before Production

## Intent
Change the merge deployment path so pull requests keep their current CI and disposable preview deployment, while pushes to `main` first deploy the merge commit into a long-lived staging environment and only proceed to production after staging deployment and smoke checks pass.

## Worktree
- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260514-deploy-staging-then-production`
- Branch: `codex/deploy-staging-then-production`
- Base: `origin/main` at `708c2a10 Finish preview workflow cleanup`
- Sandbox id: not generated; this change only validates GitHub Actions/Terraform workflow files and does not need a local app sandbox.
- Dependency setup: existing workspace dependency state reused initially; no dev server needed.
- Setup blockers: none.

## Owning Contexts
- No bounded context owns this behavior. Deployment orchestration belongs to `.github/workflows/`, with durable operator documentation in `docs/runbooks/digitalocean-platform-deployment.md` and reusable platform infrastructure in `infrastructure/digitalocean/platform`.
- Bounded context rules still apply indirectly: deployables remain thin composition roots, and the Terraform root composes infrastructure without moving context-owned behavior.

## Resolved Decisions
- Preserve `.github/workflows/platform-pr.yml` as the PR CI and disposable preview environment workflow.
- Reintroduce `staging` as a valid non-production Terraform environment, using the same full-platform shape as PR previews but with a stable `staging` slug.
- Convert `.github/workflows/platform-production.yml` into a staged deployment pipeline: resolve and gate the release commit, deploy staging, then deploy production only after staging succeeds.
- Build and push the immutable commit-tagged container image once in staging, then promote the same tag into production instead of rebuilding a second artifact.
- Keep the `production` branch as the smoke-verified production release marker.
- Use `landing/staging.tfstate` for the long-lived staging state key to remain compatible with earlier staging state.

## Open Questions
- None blocking; the requested sequencing is explicit and the repository already has preview and production workflow patterns to compose.

## Implementation Checklist
- [x] Update the plan-with-context skill so implementation requests for operational workflow/doc changes do not conflict with the skill's previous planning-only wording.
- [x] Allow Terraform `environment = staging` and document non-production database sizing as preview/staging.
- [x] Add staging deployment job to the merge deployment workflow and make production depend on it.
- [x] Update runbook secrets, protection rules, state keys, and deployment sequence.
- [x] Validate workflow syntax and Terraform formatting/shape where available locally.

## Verification
- `docker run --rm -v <worktree>:/repo -w /repo rhysd/actionlint:1.7.12 -color`
- `terraform fmt -check -recursive` in `infrastructure/digitalocean/platform`
- `terraform init -backend=false` in `infrastructure/digitalocean/platform`
- `terraform validate` in `infrastructure/digitalocean/platform`
- Temp-copy `terraform plan -refresh=false -lock=false -out=tfplan` for `environment=preview`
- Temp-copy `terraform plan -refresh=false -lock=false -out=tfplan` for `environment=staging`
- Temp-copy `terraform plan -refresh=false -lock=false -out=tfplan` for `environment=production`
- `git diff --check`

## Documentation To Promote
- `docs/runbooks/digitalocean-platform-deployment.md` should describe PR preview, long-lived staging, and production promotion.

## Goal Completion Criteria
- Implementation exists in the feature worktree and branch.
- Deployment docs are updated and retained with `.codex/plans/20260514-deploy-staging-then-production.md`.
- Automated checks cover workflow syntax and Terraform validation as far as local tooling permits.
- PR preview behavior remains unchanged.
- Pushes to `main` deploy staging first and production only after staging succeeds.
- Production branch marker still advances only after production smoke passes.
- A future PR should merge only after CI passes, then staging deploy should be verified before production promotion completes.
