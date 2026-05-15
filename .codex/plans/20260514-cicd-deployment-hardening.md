# CI/CD Deployment Hardening

## Intent

Harden the local, preview, staging, and production deployment process so releases are safer, faster, and cheaper within GitHub Actions and DigitalOcean constraints.

The implementation should reduce duplicated CI work, narrow secret exposure, promote the exact staged image to production, make DB-backed CI deterministic, and keep DigitalOcean App Platform deployments compatible with current App Platform, API, and Container Registry limits.

## Worktree

- Path: `D:/Users/ToddS/Source/Repos/chase-sets-20260514-cicd-deployment-hardening`
- Branch: `codex/cicd-deployment-hardening`
- Base: current local `main` at `8cc4f1e6cff8c07820fe00bd88651e74d74fa83d`; source repo was behind `origin/main` and was not pulled.
- Sandbox id: `09bee6fd`
- Sandbox port base: `7050`
- Dependency setup: `pnpm run deps:install` succeeded with existing cyclic workspace dependency warnings.
- Setup blockers: none.

## Owning Contexts

- Primary owner: cross-cutting delivery and operations.
- Durable docs owner: `docs/runbooks/digitalocean-platform-deployment.md` and `docs/runbooks/remote-dev.md`.
- Code owners by location:
  - GitHub workflow orchestration: `.github/workflows/`
  - Shared GitHub setup: `.github/actions/setup-pnpm-workspace/`
  - DigitalOcean deployment helpers: `scripts/digitalocean-app-deployment.mjs`
  - Terraform platform infrastructure: `infrastructure/digitalocean/platform/`

No bounded context owns this work. Deployables should remain thin composition roots; deployment behavior belongs in workflows, scripts, infrastructure, and runbooks.

## Resolved Decisions

- Harden the automatic PR preview workflow already present on `origin/main`; keep remote-dev Droplets as an additional explicit branch-level review path with TTL cleanup.
- Keep the combined `Platform Deploy` workflow from `origin/main`: it resolves a release commit, waits for the merge-commit `PR Required` gate, deploys staging, and allows production only after staging deployment and smoke succeed.
- Build the platform image once for a commit, push it to DigitalOcean Container Registry, and promote the same immutable tag/digest from staging to production.
- Keep DigitalOcean App Platform image deployments externally built in GitHub Actions. DigitalOcean currently recommends external builds when App Platform build resources are insufficient and recommends images below 1 GiB when possible.
- Scope deploy secrets to the minimum steps that require them. Dependency install, static checks, local build checks, and Docker build should not receive provider/admin secrets.
- Keep provider locks tracked, but remove tracked `.terraform/providers/**` binaries and guard against committing them again.
- Make DB-profile tests deterministic by providing a GitHub Actions Postgres service and explicit `TEST_DATABASE_URL`.
- Preserve the existing `PR Required` aggregate status check so branch protection remains simple.
- Keep `pnpm install --frozen-lockfile` in staging and production deploy workflows because Terraform apply runs `scripts/apply-digitalocean-database-grant.mjs`, which imports `pg`. Install now runs before `doctl` credential setup and without deploy secrets in the step environment.

## Open Questions

None currently blocking. If preview cost becomes a problem, add label gating or a hard active-preview cap as a separate policy change.

## Implementation Checklist

- [x] Add a workflow path/guard that fails when `.terraform/**` provider/cache files are tracked.
- [x] Add a Postgres service and explicit `TEST_DATABASE_URL` to the DB profile CI job.
- [x] Keep the current combined staging/production deploy workflow while making the release gate, staging gate, and production promotion explicit.
- [x] Split preview and staging deployment into low-secret validation/build/image steps and high-secret Terraform/deploy/smoke steps.
- [x] Add Docker BuildKit/buildx layer caching and image digest capture where useful.
- [x] Make production verify and reuse the existing commit image instead of rebuilding it.
- [x] Narrow production deploy secrets to the steps that require them.
- [x] Update the DigitalOcean deployment runbook to document the new artifact promotion, secret scoping, staging trigger, DB CI, registry retention, and preview boundaries.
- [x] Verify workflow syntax with actionlint if available, package/script tests for touched deployment helpers, and relevant Terraform formatting/validation where possible.

## Documentation To Promote

- Updated `docs/runbooks/digitalocean-platform-deployment.md`.
- Updated `docs/runbooks/remote-dev.md` to distinguish automatic PR previews from explicit remote-dev sessions.
- Updated `README.md` to align local Node guidance with `package.json`.
- Add an ADR only if artifact promotion changes become surprising or hard to reverse. At this stage, runbook documentation is enough.

## Verification

- `pnpm run deps:install`
- `pnpm run sandbox:doctor`
- `docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:1.7.12 -color`
- `pnpm run verify:static`
- `terraform -chdir=infrastructure/digitalocean/platform fmt -check -recursive`
- `terraform -chdir=infrastructure/digitalocean/state-bootstrap fmt -check -recursive`
- `terraform -chdir=infrastructure/digitalocean/platform init -backend=false`
- `terraform -chdir=infrastructure/digitalocean/state-bootstrap init`
- `terraform -chdir=infrastructure/digitalocean/platform validate`
- `terraform -chdir=infrastructure/digitalocean/state-bootstrap validate`
- `pnpm run verify:typecheck`
- `pnpm run verify:build`
- `pnpm run verify:test`
- `docker buildx build --pull --load --tag chase-sets-platform:local-validation .`

Live DigitalOcean staging and production deployments still require pushing this branch, merging through `main`, and letting GitHub Actions run with environment secrets.

## Goal Completion Criteria

The implementation goal must:

- Keep this plan committed with the implementation.
- Implement CI/CD workflow and runbook changes in the dedicated worktree.
- Verify changed workflow scripts and deployment helpers locally.
- Validate Terraform formatting/shape where possible without touching live DigitalOcean state.
- Avoid product runtime, domain, schema, or UI changes.
- Submit a PR from `codex/cicd-deployment-hardening`.
- Ensure CI passes.
- Merge the PR.
- Confirm the next staging deployment succeeds and promotes the intended image artifact.
- Confirm the automatic PR preview deployment succeeds for this PR and the next staging deployment promotes the intended image artifact.
