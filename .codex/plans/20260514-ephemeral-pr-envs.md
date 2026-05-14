# Ephemeral PR Environments

## Intent

Replace the single persistent staging gate with per-PR ephemeral DigitalOcean environments that deploy during CI, run platform smoke checks against the deployed preview, destroy the preview environment when the PR closes or merges, and deploy production automatically on every merge to `main`.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260514-ephemeral-pr-envs`
- Branch: `codex/ephemeral-pr-envs`
- Base: current `main` worktree HEAD `8cc4f1e6` (`main` is behind `origin/main` by 11 commits in the source checkout)
- Sandbox id: `53c31586`
- Dependency setup: `pnpm run deps:install` completed successfully
- Sandbox status: `pnpm run sandbox:doctor` passed; local port base `9100`
- Setup caveats: none for local verification; live DigitalOcean apply/destroy requires repository secrets and cannot be exercised locally

## Owning Contexts

- No business bounded context owns this change. It is an infrastructure/operations change.
- Runtime ownership belongs in `infrastructure/digitalocean/platform`, GitHub Actions workflows, deploy scripts, and the DigitalOcean deployment runbook.
- Deployables remain thin composition roots; the Terraform app spec composes existing deployables and context-owned behavior without moving product code into deployables.

## Resolved Decisions

- Use the canonical term `preview environment` for ephemeral PR deployments. `Staging` should no longer describe PR validation.
- Add `preview` as a Terraform environment beside `production`, with per-PR names, domains, database users, and Terraform state keys.
- Preview environments should run the full platform shape that staging currently runs: landing, marketplace, admin, platform API, worker, bootstrap, all context databases, and provider test-mode configuration.
- Preview Terraform state should be keyed by PR number so the close/merge cleanup workflow can destroy exactly the environment created for that PR.
- Production deployment should run on every push to `main` after the `PR Required` gate succeeds, using the merge commit SHA as the immutable image tag.
- Production should still smoke test before moving the `production` branch marker.
- The retained planning artifact belongs in `.codex/plans/` and should be committed with the implementation.
- The old persistent staging workflow is removed; `Platform PR` now owns preview validation and `Platform Production` owns merge-to-main deployment.
- Preview cleanup runs from `pull_request_target` on PR close using the trusted base workflow and the PR-specific Terraform state key.

## Open Questions

- None currently blocking. Existing CI, Terraform, and runbook evidence supports the implementation path.

## Implementation Checklist

- [x] Update Terraform environment validation and naming for `preview`.
- [x] Parameterize preview identifier, preview state key, preview domains, and preview test provider callback URLs.
- [x] Update PR workflow so pull requests deploy a preview environment to DigitalOcean and smoke test it as part of required checks.
- [x] Add PR cleanup workflow that destroys the preview environment on PR close/merge.
- [x] Replace the persistent staging workflow with automatic production deployment on `main` pushes.
- [x] Update production workflow from manual tag promotion to merge-triggered production deploy while keeping manual dispatch as a redeploy escape hatch.
- [x] Update deployment runbook and curated docs map as needed.
- [x] Update the `plan-with-context` skill cleanup wording so final cleanup matches the new non-staging preview/production flow.
- [x] Add or update script/unit coverage for workflow helper behavior where local tests can validate it. Existing deployment/smoke helper coverage still exercises the changed workflow helpers.
- [x] Run focused script tests, Terraform fmt/validate/plan without backend where possible, workflow lint if available, and repository static checks if feasible.

## Verification

- `pnpm run deps:install`
- `pnpm run sandbox:doctor`
- `terraform -chdir=infrastructure/digitalocean/platform fmt -check -recursive`
- `terraform -chdir=infrastructure/digitalocean/state-bootstrap fmt -check -recursive`
- `terraform -chdir=infrastructure/digitalocean/platform init -backend=false`
- `terraform -chdir=infrastructure/digitalocean/platform validate`
- `terraform -chdir=infrastructure/digitalocean/state-bootstrap init`
- `terraform -chdir=infrastructure/digitalocean/state-bootstrap validate`
- Preview Terraform plan with backend removed and fake `preview` validation inputs: passed, creating `landing-pr-0`, `marketplace-pr-0`, and `admin-pr-0` outputs.
- Production Terraform plan with backend removed and fake `production` validation inputs: passed.
- `pnpm run test:digitalocean-app-deployment`
- `pnpm run test:platform-smoke`
- `pnpm run verify:metadata`
- `pnpm run test:structure`
- `docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:1.7.12 -color`
- `pnpm run verify:static`
- `pnpm run test:digitalocean-app-deployment` after adding App Platform domain readiness waiting.
- `docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:1.7.12 -color` after adding the preview domain wait step.
- `pnpm run verify:metadata` after adding the preview domain wait step.
- `pnpm run verify:static` after adding the preview domain wait step.
- `node scripts/digitalocean-app-deployment.mjs wait-domains 758c4d1e-a753-4ae4-b35c-3c6f38ced9e4 landing-pr-85.chasesets.com admin-pr-85.chasesets.com marketplace-pr-85.chasesets.com --timeout-seconds=600 --poll-seconds=30`
- `pnpm run smoke:platform -- "https://landing-pr-85.chasesets.com" "https://admin-pr-85.chasesets.com" "https://marketplace-pr-85.chasesets.com"` locally passed without admin credentials; CI still verifies authenticated admin smoke with environment secrets.
- `pnpm run test:platform-smoke` after adding eventual-consistency polling for the authenticated admin waitlist check.
- `pnpm run verify:static` after adding eventual-consistency polling for the authenticated admin waitlist check.

## PR And Live Environment Status

- Draft PR: https://github.com/todd-skelton/chase-sets/pull/85
- Branch pushed: `origin/codex/ephemeral-pr-envs`
- Commits: `354bbf37 Add ephemeral PR preview deployments`, `18d41629 Record preview environment secret blocker`, `be51370f Disable Terraform wrapper for deploy output parsing`.
- PR CI result as of 2026-05-14: static checks, typecheck, unit tests, DB tests, build, Docker build, workflow lint, preview Terraform plan, and production Terraform plan passed.
- `Deploy Preview and Smoke` reached DigitalOcean and created `chase-sets-pr-85-platform`; the next failure was a smoke timing race while new App Platform custom domains were still configuring DNS/TLS.
- Added an explicit App Platform domain readiness wait before preview smoke so CI waits for DigitalOcean-managed certificates before direct HTTPS smoke tests.
- The next CI smoke reached authenticated admin verification and failed because the event-driven waitlist read model had not caught up to the synthetic signup yet; the smoke script now polls that admin read assertion for eventual consistency.
- PR #85 merged after preview smoke passed in CI.
- The first merge cleanup run failed because the `pull_request_target` workflow checked out the base SHA from before the workflow and Terraform changes existed.
- Follow-up PR #86 fixes cleanup checkout to use the merge commit for merged PRs, adds manual preview cleanup dispatch for orphan cleanup, and fixes preview runtime database URLs to build explicit DigitalOcean pool URLs with the pool name as the path.
- PR #86 preview deploy reached smoke; the waitlist signup and admin sign-in succeeded, but the tiny preview environment needed a longer read-model polling window before the synthetic waitlist signup appeared. Preview and production CI smoke now use a two-minute polling window for event-driven read-model catch-up.
- PR #86 preview cleanup and manual PR #85 cleanup both destroyed their DigitalOcean preview environments successfully.
- The first production apply created the production App Platform app and database resources, but smoke raced first-time TLS certificate provisioning for `chasesets.com`; production now waits for App Platform domain activation before smoke.
- Production smoke must still be confirmed after the production domain wait is merged and the latest main deployment reruns.

## Documentation To Promote

- `docs/runbooks/digitalocean-platform-deployment.md`: updated with preview environment lifecycle, required secrets, branch protection, production-on-main flow, and cleanup.
- `.codex/skills/plan-with-context/SKILL.md`: updated cleanup and goal wording to say preview cleanup and production deploy verification instead of staging deploy verification.

## Goal Completion Criteria

- Implementation stays in the feature worktree and branch listed above.
- Durable docs are promoted and retained with the implementation.
- Automated checks verify workflow/script changes and Terraform formatting/validation locally as far as secrets-free tooling allows.
- PR workflow deploys and smokes a preview environment for each PR.
- PR close/merge cleanup destroys the matching preview environment.
- Production deployment runs for each merge to `main` after the `PR Required` gate succeeds.
- The retained plan file remains committed.
- A PR is submitted, CI passes, the PR merges, and live preview cleanup plus production deploy are confirmed.
