# CI/CD Best Practices Hardening

## Intent

Address the CI/CD review findings across local development, remote preview, staging, and production while staying within DigitalOcean and GitHub Actions rate, storage, and compute limits.

The target outcome is a simpler promotion path: local and preview use the same pinned runtime expectations as CI, CI builds and validates one immutable platform image, staging deploys that image automatically after the full gate passes, production promotes the same validated image automatically after staging validation, and cleanup keeps DigitalOcean resources bounded.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-cicd-best-practices`
- Branch: `codex/cicd-best-practices`
- Base: current local `main` at `8cc4f1e6` (`origin/main` was 22 commits ahead in the source checkout at review time)
- Dependency setup: `pnpm run deps:install` completed successfully with shared store `D:\Users\ToddS\Source\Repos\.chase-sets-pnpm-store`
- Setup caveat: dependency install reported existing cyclic workspace dependencies
- Sandbox id: `73a7a224`
- Sandbox compose project: `chase-sets-73a7a224`
- Sandbox ports: portal `9200`, admin web `9202`, marketplace `9203`, public web `9204`, platform API `9212`, platform worker `9213`, Postgres `9220`

## Owning Contexts

This is not a business bounded-context feature. No bounded context owns CI/CD behavior.

Primary ownership should stay in platform operations and infrastructure:

- `.github/workflows` for PR, staging, production, and future preview/cleanup orchestration
- `.github/actions/setup-pnpm-workspace` for the pinned Node/pnpm CI setup contract
- `Dockerfile` for runtime image construction and dependency/build boundaries
- `infrastructure/digitalocean/platform` for App Platform, DOCR image references, Terraform state, and managed database shape
- `infrastructure/remote-dev` and `scripts/remote-dev.mjs` for preview Droplet lifecycle
- `scripts/digitalocean-app-deployment.mjs` and smoke scripts for deploy wait, forced deployment, and health validation
- `docs/runbooks/digitalocean-platform-deployment.md`, `docs/runbooks/remote-dev.md`, and `README.md` for operational source of truth

No glossary updates are expected unless a new cross-cutting operational term is introduced.

## Repo Evidence

- PR gate aggregates static checks, typecheck, unit tests, DB-profile tests, build, Docker image build, workflow lint, and Terraform shape checks before reporting `PR Required`.
- Staging deploys from `main` and can also run manually.
- Production deploys manually by release tag or release ref, checks `PR Required`, creates the tag if needed, deploys, smokes, then fast-forwards `production`.
- Terraform uses DigitalOcean Spaces remote state with `use_lockfile=true`.
- App Platform components use one DOCR repository/tag and `deploy_on_push` is disabled.
- Staging already serializes deploys and waits for DigitalOcean App Platform deployment completion.
- Remote preview is currently a manual disposable Droplet flow with TTL tags, Basic Auth, and prune support.

## Resolved Decisions

- Keep deployables thin. CI/CD changes must not move deployment behavior into deployable packages or bounded contexts.
- Treat `docs/runbooks/digitalocean-platform-deployment.md` as the canonical deploy runbook and keep infrastructure READMEs slim.
- Keep DigitalOcean App Platform and GitHub Actions as the operating envelope; do not plan a provider migration.
- Preserve the production branch as the smoke-verified deployed release marker unless a later decision explicitly replaces it.
- Use one immutable platform image digest for release promotion. CI should build the image once after the full gate, staging should deploy that digest, and production should promote the exact same digest rather than rebuilding.
- Add label-gated PR preview automation rather than previewing every PR. A PR label or manual workflow dispatch should create one remote-dev preview; PR close should destroy it; a scheduled prune should remain as the cost/rate-limit backstop.
- Trigger staging from `workflow_run` after `Platform PR` succeeds on `main`. This removes the current staging polling loop and avoids rerunning duplicate staging static/build checks after the aggregate gate has already passed.
- Production should not require human approval. Production deployment should be automated after merge to `main`, with all blocking checks pre-merge and staging acting as the long-lived deployed validation environment before production promotion.
- Production should promote immediately after staging deploy and staging smoke pass for the same immutable image digest.
- Standardize local, CI, Docker, and remote preview on Node 24 LTS. Node 24 is already declared in `package.json` and used by the production Dockerfile; README and remote preview should stop claiming/installing Node 26 Current.
- Automated production should keep both release markers: fast-forward the `production` branch after production smoke and create an annotated timestamp/SHA release tag for audit and rollback.
- DOCR cleanup should preserve deployed staging and production digests, rollback release tags, active preview tags, and recent images from the last 30 days; older unreferenced tags can be deleted before registry garbage collection.
- Remote preview creation should require an explicit SSH CIDR through `REMOTE_DEV_SSH_CIDR` or `--ssh-cidr`; it should not silently fall back to opening SSH to the internet.
- Automated production should block destructive Terraform/App Platform changes by default. Deletes/replacements should require an explicit pre-merge override marker so the approval happens in code review, not during deployment.

## Open Questions

- None.

## Implementation Plan

1. Runtime alignment
   - Keep `package.json` engines on Node 24.
   - Keep the Docker base on Node 24.
   - Change remote preview cloud-init from Node 26 setup to Node 24 setup.
   - Update README language so local, CI, Docker, and preview all name Node 24 LTS.

2. CI gate and image creation
   - Keep `Platform PR` as the aggregate required check.
   - Add a post-gate image build/push path for `main` that produces a DOCR image tagged by commit and records the immutable digest.
   - Use BuildKit/buildx cache conservatively to reduce GitHub Actions compute without growing cache usage unpredictably.
   - Add job `timeout-minutes` values sized to current waits: short checks, Docker build, Terraform plan, App Platform deploy waits, smoke checks.

3. Staging automation
   - Trigger staging from `workflow_run` after `Platform PR` succeeds on `main`.
   - Remove the current check-polling loop.
   - Deploy the validated digest to staging.
   - Keep staging serialized with `cancel-in-progress: false` so DigitalOcean App Platform deployments do not overlap.
   - Keep staging smoke strict for landing, admin, marketplace, and legacy redirect.

4. Production automation
   - Trigger production only after staging deploy and staging smoke pass for the same digest.
   - Deploy the same digest, not a rebuilt image.
   - Keep production serialized.
   - Block destructive Terraform/App Platform deletes/replacements unless an explicit pre-merge override marker is present.
   - Run production smoke.
   - After production smoke passes, create an annotated release tag and fast-forward `production`.

5. Preview automation
   - Preserve manual `pnpm run remote-dev` commands.
   - Add label-gated PR preview creation.
   - Ensure only one preview session exists per PR.
   - Destroy preview resources on PR close.
   - Keep scheduled prune as a backstop.
   - Require explicit SSH CIDR for preview creation.

6. DOCR cleanup
   - Add scheduled cleanup that preserves deployed staging/prod digests, production release tags, active preview tags, and the last 30 days of images.
   - Delete older unreferenced tags first, then run DigitalOcean registry garbage collection.
   - Keep dry-run output available for local/operator verification.

7. Documentation and tests
   - Update deployment and remote-dev runbooks.
   - Add/adjust tests for changed deployment helper, remote-dev CIDR validation, retention selection, and destructive-change detection.
   - Update `docs/README.md` only if a new durable doc is added; otherwise existing runbook links are sufficient.

## Pressure Tests

- Normal flow: merge to `main` after `PR Required` passes; image builds once; staging deploys and smokes; production deploys the same digest; production branch and release tag update after smoke.
- Manual rerun: rerunning staging or production for the same commit should reuse the existing digest instead of rebuilding.
- Stale/missing artifact: production must fail clearly if the expected digest is missing rather than rebuilding an unvalidated image.
- Concurrent merges: staging and production concurrency groups should serialize deploys and only promote the digest associated with the completed staging run.
- DigitalOcean rate pressure: workflows should avoid polling GitHub checks, use bounded App Platform polling, reuse one image, and keep preview creation label-gated.
- Registry pressure: cleanup should never delete deployed staging/prod digests or active rollback tags; garbage collection runs only after safe tag deletion.
- Destructive infrastructure change: production promotion should fail before apply unless the PR carried an explicit reviewed override marker.
- Preview failure/cancellation: PR close and scheduled prune should clean Droplet, firewall, DNS records, and tags; failed create should leave enough state for retry or cleanup.
- Rollback: operator can redeploy a preserved digest or release tag within the 30-day retention window; production branch identifies the live smoke-verified commit.
- Low-value card economics: no direct domain effect; the plan protects marketplace margin indirectly by reducing wasteful compute, stale preview resources, and duplicate builds.

## Implementation Checklist

- [x] Align runtime versions across local docs, CI setup, Dockerfile, and remote preview.
- [x] Ensure manual staging dispatch cannot bypass the same full CI gate required for `main` pushes.
- [x] Rework image flow so staging and production use a validated immutable artifact or digest.
- [x] Replace manual production approval with an automated production promotion path gated by successful CI, staging deploy, and staging smoke.
- [x] Add destructive-change policy checks for automated production.
- [x] Add targeted GitHub Actions timeouts and cache controls.
- [x] Add DOCR image retention automation and docs.
- [x] Harden remote preview defaults, especially SSH CIDR requirements.
- [x] Add label-gated PR preview create/destroy/prune automation while preserving manual remote-dev commands.
- [x] Add/adjust tests for deployment helper scripts and remote-dev behavior where the implementation changes logic.
- [x] Update deployment, remote-dev, and root README documentation.

## Implementation Progress

- `platform-pr.yml` now adds bounded job timeouts and BuildKit cache for the PR image validation build.
- `platform-production.yml` now starts from `workflow_run` after a successful `Platform PR` workflow on `main`, keeps staging and production in one serialized deploy workflow, validates manual release refs against `PR Required`, builds one DOCR image tagged by the full commit SHA, records the digest, and deploys that tag to staging.
- The production job in `platform-production.yml` now verifies the staging-built image exists instead of rebuilding, blocks destructive Terraform plans unless a reviewed marker exists, smokes production, creates a matching DOCR release tag, creates an annotated Git release tag, and fast-forwards `production`.
- `platform-pr.yml` now keeps Terraform/App Platform PR previews same-repository and label-gated with the `preview` label, while unlabeled PRs still run the local and Terraform validation gate.
- `platform-registry-cleanup.yml` adds weekly and manual DOCR cleanup with dry-run support.
- `scripts/digitalocean-app-deployment.mjs` now detects destructive Terraform changes and exposes `assert-no-destructive-changes`.
- `scripts/digitalocean-registry-cleanup.mjs` selects old unprotected DOCR tags for deletion while preserving app-referenced tags, explicit protected tags, protected digests, and release-prefixed image tags.
- `scripts/remote-dev.mjs` now requires explicit `REMOTE_DEV_SSH_CIDR` or `--ssh-cidr` for preview creation and uses that CIDR in the SSH firewall rule.
- The deployment and remote-dev runbooks now describe the automated staging-to-production path, immutable image promotion, release markers, cleanup, same-repo preview automation, and explicit SSH CIDR requirement.

## Verification

- `pnpm run test:digitalocean-app-deployment` passed.
- `pnpm run test:digitalocean-registry-cleanup` passed.
- `pnpm run test:remote-dev` passed.
- `pnpm run verify:static` passed.
- `docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:1.7.12 -color` passed after workflow hardening.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:build` passed.
- `pnpm run verify:test` passed.
- `docker build --pull --tag chase-sets-platform:local-validation .` passed and produced image ID `sha256:afa5998933f000fe12987c6e120491603103955ea1b861189f582052ec95e2ac`.
- `git diff --check` passed.

## Remaining Rollout Work

- Submit the PR.
- Wait for GitHub CI to pass.
- Merge after review.
- Verify staging deployment after merge.
- Verify automated production deployment and production release markers after staging passes.

## Documentation To Promote

- `docs/runbooks/digitalocean-platform-deployment.md`: final staging/production flow, image promotion, cleanup, automated production model, and rollback guidance.
- `docs/runbooks/remote-dev.md`: preview lifecycle and security defaults.
- `README.md`: local/CI runtime version alignment.
- Potential ADR: only if the final image promotion strategy creates a durable release policy that would be surprising without context.

## Goal Completion Criteria

The implementation goal should complete only after:

- The branch implements the settled plan in this worktree.
- Durable docs are promoted and the plan file is retained.
- Automated verification runs for affected workflow/script logic.
- Any frontend-facing deploy smoke or preview URL behavior receives desktop/mobile visual verification if UI changes are introduced.
- A PR is submitted.
- GitHub CI passes.
- The PR merges.
- Staging deployment is verified after merge.
- Production deployment automation is verified after staging passes, unless deliberately disabled in repo settings during rollout.
- No temporary cleanup deletes this planning artifact.
