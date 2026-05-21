# Fix Staging And Production Deployments

## Intent

Restore reliable staging and production deployment after App Platform deploys began taking much longer than usual and failing before production promotion could run.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-fix-staging-production-deployments`
- Branch: `codex/fix-staging-production-deployments`
- Base: freshly fetched `origin/main` at `ebcd67e4`
- Sandbox id: `e3b44c4c`
- Dependency setup status: complete via `pnpm run deps:install`; `pnpm run sandbox:doctor` passed
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Operational owner: GitHub Actions deployment workflow and DigitalOcean App Platform Terraform root.
- Bounded-context impact: none expected. Deployables and infrastructure remain thin composition/operations roots; no product context behavior should change.

## Resolved Decisions

- Keep the fix scoped to deployment/infrastructure surfaces unless logs prove a product/runtime defect is causing health checks to fail.
- Treat the live `Platform Deploy` run for commit `ebcd67e4` as current evidence. Its staging job reached `Terraform apply` after successful image build, Terraform init/format/plan, and previous-deployment wait.
- The earlier merged wait-extension changed job timeouts and added a `digitalocean_app.platform` create timeout, but staging still spends its time inside Terraform apply. The next fix must improve the Terraform/App Platform handoff rather than only extending post-apply waits.
- Preserve production promotion semantics: production promotes the staging-built commit image after staging succeeds.
- Completed run `26232186836` shows a stale automatic deploy waited roughly two hours behind the staging environment and then failed at `Confirm automatic deploy is latest main` because commit `77ae5a65` was no longer `origin/main`.
- Stale automatic deploys should skip deployment work successfully instead of failing the workflow after a long queue. Production promotion must remain gated on staging actually deploying and smoking the release commit.

## Open Questions

- None currently blocking. Latest GitHub Actions logs are enough to continue investigation.

## Implementation Checklist

- Inspect the latest failed or in-progress staging logs and identify the exact App Platform phase/failure.
- Inspect Terraform App Platform resource behavior for update/create timeout coverage and lifecycle behavior.
- Implement scoped workflow/Terraform/helper changes that either avoid the long failing apply path or surface actionable deployment failure details sooner.
- Update deployment runbook if the deployment sequence changes.
- Run focused tests for deployment helper logic and Terraform/workflow formatting.
- Submit PR, wait for CI, merge, and verify staging then production green.

## Verification Notes

- `pnpm run deps:install` passed.
- `pnpm run sandbox:doctor` passed.
- `pnpm exec prettier --check .github/workflows/platform-production.yml docs/runbooks/digitalocean-platform-deployment.md .codex/plans/20260521-fix-staging-production-deployments.md` passed.
- `pnpm run test:digitalocean-app-deployment` passed.
- `docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:1.7.12 .github/workflows/platform-production.yml` passed.
- `pnpm run verify:static` passed.
- Live run `26242427307` for commit `ebcd67e4` is still in staging `Terraform apply` as of the planning pass; logs are unavailable until the job completes.

## Documentation To Promote

- Update `docs/runbooks/digitalocean-platform-deployment.md` if workflow behavior, timeout policy, or recovery steps change.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
