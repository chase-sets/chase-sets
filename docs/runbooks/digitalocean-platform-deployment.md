# DigitalOcean Platform Deployment Runbook

This runbook covers DigitalOcean App Platform preview, staging, and production deployments.

## Architecture

- Region: `nyc3`.
- Infrastructure: Terraform root at `infrastructure/digitalocean/platform`.
- State: DigitalOcean Spaces bucket through Terraform's S3 backend with `use_lockfile=true`.
- State keys:
  - PR previews: `platform/previews/pr-<number>.tfstate`.
  - Staging: `landing/staging.tfstate`.
  - Production: `landing/production.tfstate`.
- DNS: `chasesets.com` must exist as a DigitalOcean DNS domain before Terraform runs.
- Deploy orchestration: GitHub Actions is the canonical deploy owner. Label-gated PR previews and staging build one platform container image in GitHub Actions with bounded Docker Buildx cache, push it to DigitalOcean Container Registry, record the digest, and point App Platform components at that immutable image tag. Production verifies and promotes the staging-built commit image instead of rebuilding a second artifact.
- Preview and staging environments run the full platform shape. Production currently remains on the landing/admin-support component set until marketplace production promotion is planned.
- Database connections: non-production API, worker, and bootstrap components cap each per-context Postgres client pool at one connection and route runtime traffic through one managed PgBouncer transaction pool per context database.
- Production branch: `production` is a smoke-verified deployed release marker. The production workflow fast-forwards it only after App Platform deployment and production smoke pass. It also creates an annotated `release-<yyyymmddHHMMSS>-<sha>` Git tag and a matching DOCR image tag for audit and rollback.
- Image retention: the `chase-sets-platform` DOCR repository uses immutable commit, PR, and release tags. `.github/workflows/platform-registry-cleanup.yml` preserves App Platform-referenced tags, release-prefixed image tags, and images updated in the last 30 days; it deletes older unreferenced tags and then starts DigitalOcean registry garbage collection.

## Preview Hosts

Each pull request receives its own `pr-<number>` preview environment:

- `landing-pr-<number>.chasesets.com`: landing `public-web`.
- `marketplace-pr-<number>.chasesets.com`: marketplace web.
- `admin-pr-<number>.chasesets.com`: admin web.

Preview app components:

- `public-web`, `marketplace`, `admin-web`.
- `platform-api`: same-origin `/api/*` for landing, admin, and marketplace.
- `platform-worker`: full-system background workers and worker health.
- `platform-bootstrap`: `PRE_DEPLOY` schema, seed, control-plane, and platform-admin reconciliation.

Preview environments are disposable and intentionally `noindex,nofollow` for landing and marketplace.

## Staging Hosts

The long-lived staging environment uses the same full-platform shape as PR previews, but keeps stable hostnames and state across merges:

- `landing-staging.chasesets.com`: landing `public-web`.
- `marketplace-staging.chasesets.com`: marketplace web.
- `admin-staging.chasesets.com`: admin web.

`staging.chasesets.com` is reserved for the staging mail identity and Google Workspace records. Do not attach it as an App Platform web domain.

Staging is intentionally `noindex,nofollow` for landing and marketplace. Use it to test incremental merge changes against durable state after the fresh PR preview has already passed.

## Required GitHub Environment Secrets

Configure these in `preview`, `staging`, and `production` GitHub Environments:

- `DIGITALOCEAN_ACCESS_TOKEN`
- `SPACES_ACCESS_ID`
- `SPACES_SECRET_KEY`
- `PLATFORM_INTERNAL_AUTH_SECRET`
- `PLATFORM_ADMIN_EMAIL`
- `PLATFORM_ADMIN_PASSWORD`
- `CHASE_SETS_DISCORD_INVITE_URL`
- `SES_SOURCE_ARN`

Additional `preview` and `staging` secrets for the full platform:

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `EASYPOST_API_KEY`

Optional `preview` and `staging` variables:

- `STRIPE_API_BASE_URL`
- `EASYPOST_API_BASE_URL`
- `EASYPOST_MODE`
- `PLATFORM_ADMIN_DISPLAY_NAME`
- `NOTIFICATION_EMAIL_PROVIDER`
- `SES_AWS_REGION`
- `SES_FROM_EMAIL`
- `SES_CONFIGURATION_SET_NAME`

SES values configured for platform environments:

| Environment | `NOTIFICATION_EMAIL_PROVIDER` | `SES_AWS_REGION` | `SES_FROM_EMAIL` | `SES_CONFIGURATION_SET_NAME` | `SES_SOURCE_ARN` |
| --- | --- | --- | --- | --- | --- |
| `preview` | `amazon-ses` | `us-east-2` | `notifications@preview.chasesets.com` | `transactional-preview` | `arn:aws:ses:us-east-2:812517519777:identity/preview.chasesets.com` |
| `staging` | `amazon-ses` | `us-east-2` | `notifications@staging.chasesets.com` | `transactional-staging` | `arn:aws:ses:us-east-2:812517519777:identity/staging.chasesets.com` |
| `production` | `amazon-ses` | `us-east-2` | `notifications@chasesets.com` | `transactional-production` | `arn:aws:ses:us-east-2:812517519777:identity/chasesets.com` |

The `platform-worker` component consumes these values in preview and staging. Production stores and validates the production SES values now, but production currently runs the landing/admin-support component set until marketplace production promotion adds the full `platform-worker`.

Preview and staging Terraform validation requires test-mode provider values:

- `STRIPE_SECRET_KEY` starts with `sk_test`.
- `STRIPE_PUBLISHABLE_KEY` starts with `pk_test`.
- `STRIPE_CONNECT_RETURN_URL` is `https://marketplace-pr-<number>.chasesets.com/account/payouts`.
- `STRIPE_CONNECT_REFRESH_URL` is `https://marketplace-pr-<number>.chasesets.com/account/payouts/setup`.
- Staging uses `https://marketplace-staging.chasesets.com/account/payouts` and `https://marketplace-staging.chasesets.com/account/payouts/setup`.
- `EASYPOST_API_KEY` starts with `EZTK`.
- `EASYPOST_MODE` is `test`.

## Required GitHub Protection

Deployment safety depends on GitHub repository settings as well as workflow code:

- Protect `main` with required pull requests and a required `PR Required` status check from `.github/workflows/platform-pr.yml`.
- Protect or ruleset-match `production` so only the production workflow can move the deployed-release marker.
- Restrict the `staging` GitHub Environment to deployments from `main`.
- Restrict the `production` GitHub Environment to deployments from `main`.
- Do not require approval on the `production` GitHub Environment for the normal release path. Production deploys automatically after the `main` merge check, staging migration/bootstrap, and staging smoke check succeed.
- Allow the `preview` GitHub Environment to deploy from pull requests created in this repository. Fork PRs do not receive preview secrets under the `pull_request` event.

The Platform PR workflow validates static checks, typecheck, unit tests, DB-profile tests, workspace builds, Docker image builds, workflow syntax with Actionlint, preview Terraform shape, staging Terraform shape, production Terraform shape, and state-bootstrap Terraform before reporting `PR Required`. When a same-repository pull request has the `preview` label, it also deploys and smokes a live preview before `PR Required` can pass. DB-profile tests run against an explicit GitHub Actions PostgreSQL service. The workflow also fails if generated Terraform working directories under `.terraform/` are tracked; keep only `.terraform.lock.hcl` in git.

On pushes to `main`, the same `PR Required` workflow validates the merge commit without creating a preview environment. The deployment workflow starts from `workflow_run` after that merge-commit gate succeeds, deploys staging as an automated migration/bootstrap and smoke-test check, then automatically deploys production only after staging succeeds.

## One-Time State Bootstrap

Create the Spaces bucket before the first platform Terraform init:

```bash
cd infrastructure/digitalocean/state-bootstrap
terraform init
terraform apply
```

Then run `terraform init` in `infrastructure/digitalocean/platform` using the appropriate backend key. The CI workflows use the same backend settings.

Run `pnpm install --frozen-lockfile` before Terraform apply. The platform Terraform root creates per-context database users and runs the repo-local DigitalOcean grant script so those users receive database and public-schema privileges before App Platform deploys. In preview and staging, Terraform also creates one managed Postgres transaction pool per context database and points runtime `DATABASE_URL_*` variables at the pool URIs.

Deploy workflows install dependencies before `doctl` authentication and scope provider/admin secrets to validation, Terraform, smoke, and release-marker steps. Dependency installation, local verification, and Docker image construction should not receive provider, database, or admin secrets.

## PR Preview Deployment

Pull requests deploy through `.github/workflows/platform-pr.yml` only when the `preview` label is present on a same-repository PR.

The preview deployment job runs only after the local CI jobs and Terraform validation jobs pass. Unlabeled PRs still run the full local and Terraform validation gate without spending DigitalOcean deploy capacity.

The workflow:

1. Validates required preview secrets and variables before any deploy step uses them.
2. Builds and pushes `registry.digitalocean.com/<account-registry>/chase-sets-platform:pr-<number>-<head-sha>` with Docker Buildx cache and records the pushed digest in the workflow output.
3. Initializes Terraform with backend key `platform/previews/pr-<number>.tfstate`.
4. Runs Terraform fmt and plan for `environment=preview` and `preview_identifier=pr-<number>`.
5. Waits for any prior App Platform deployment in that PR environment to finish.
6. Applies the preview Terraform plan.
7. Waits for the Terraform-created App Platform deployment to reach a terminal phase.
8. Creates a forced DigitalOcean App Platform deployment only when Terraform did not change the app spec, waits for completion, and fails unless the deployment phase is `ACTIVE`.
9. Runs `pnpm run smoke:platform` against landing, admin, and marketplace with strict preview smoke requirements.

The App Platform components share the same runtime image and differ only by run command, environment, scaling, health checks, and ingress routing.

## Staging Deployment

Staging deploys through `.github/workflows/platform-production.yml` after the `Platform PR` workflow succeeds for a `main` push, before production. Staging is a pre-production verification check, not the release destination: it proves the release image can run Terraform-managed migrations/bootstrap and pass smoke checks against durable staging state. Manual dispatch is retained as a redeploy escape hatch for a ref already contained in `origin/main`; manual dispatch also runs staging before production.

The staging job:

1. Uses the release commit resolved by the deployment workflow.
2. Waits for the release commit to have a completed successful `PR Required` check from the Platform PR workflow.
3. Checks out the release commit.
4. Fails stale automatic deployments when the release commit is no longer the current `origin/main`.
5. Validates required staging secrets and variables before any deploy step uses them.
6. Builds and pushes `registry.digitalocean.com/<account-registry>/chase-sets-platform:<release_commit>` with bounded Docker Buildx cache and records the pushed digest in the workflow output.
7. Initializes Terraform with backend key `landing/staging.tfstate`.
8. Runs Terraform fmt and plan for `environment=staging` with the pushed image tag, and records whether `digitalocean_app.platform` will change.
9. Waits for any prior DigitalOcean App Platform deployment to reach a terminal phase before Terraform apply.
10. Runs Terraform apply for `environment=staging`, which runs the App Platform `PRE_DEPLOY` bootstrap and migration path before runtime traffic is validated.
11. Waits for the Terraform-created App Platform deployment to reach a terminal phase when the app spec changed.
12. Creates a forced DigitalOcean App Platform deployment only when Terraform did not change the app spec, waits for completion, and fails unless the deployment phase is `ACTIVE`.
13. Waits for landing, admin, and marketplace domains.
14. Runs `pnpm run smoke:platform` against landing, admin, and marketplace with strict staging smoke requirements.

Production starts automatically after this staging job succeeds. Staging and production use separate GitHub Actions concurrency groups so a queued or paused production deployment cannot block the next staging check.

## Preview Cleanup

Closed and merged pull requests destroy their preview environment through `.github/workflows/platform-preview-cleanup.yml`.

The cleanup workflow runs with the trusted base workflow definition, checks out the PR base commit, initializes Terraform with `platform/previews/pr-<number>.tfstate`, waits for any active App Platform deployment to finish, and runs `terraform destroy -auto-approve`.

If cleanup fails, rerun the cleanup workflow for the closed PR. If the state key exists but the App Platform app has already been deleted manually, the DigitalOcean deployment helper treats the missing app as no active deployment to wait for.

## Production Deployment

Production deploys automatically through `.github/workflows/platform-production.yml` after the staging job succeeds. It promotes the same immutable commit-tagged image that staging just deployed, instead of rebuilding a second artifact.

The workflow:

1. Checks out the release commit that already passed `PR Required` and staging deployment.
2. Fails stale automatic deployments when the release commit is no longer the current `origin/main`.
3. Validates required production secrets and variables.
4. Verifies `registry.digitalocean.com/<account-registry>/chase-sets-platform:<release_commit>` already exists in DigitalOcean Container Registry. If it is missing, run a successful staging deployment for that commit before production promotion.
5. Runs Terraform fmt and plan for `environment=production` with the staging-promoted image tag, blocks destructive changes unless `.github/deployment/production-destructive-change-approved.md` exists in the reviewed commit, and records whether `digitalocean_app.platform` will change.
6. Waits for any prior DigitalOcean App Platform deployment to reach a terminal phase before Terraform apply.
7. Runs Terraform apply for `environment=production`.
8. Waits for the Terraform-created App Platform deployment to reach a terminal phase when the app spec changed.
9. Creates a forced DigitalOcean App Platform deployment only when Terraform did not change the app spec, waits for completion, and fails unless the deployment phase is `ACTIVE`.
10. Runs `pnpm run smoke:platform` with required admin authentication, `ops+smoke@chasesets.com`, and smoke UTM markers.
11. Adds a matching `release-<yyyymmddHHMMSS>-<sha>` DOCR tag to the promoted image, creates the annotated Git release tag, and fast-forwards the protected `production` branch to the smoke-verified deployed release commit.

Production destructive-change overrides must be explicit in the pull request. Add `.github/deployment/production-destructive-change-approved.md` only for a deliberately reviewed infrastructure migration, and remove it in the same PR or an immediate follow-up when the migration is complete.

## Smoke Coverage

The platform smoke script checks:

- landing home page loads
- landing API readiness passes through the deployed API component
- admin home page loads
- admin API readiness passes through the deployed API component
- marketplace home and search pages load when a marketplace URL is supplied
- waitlist signup accepts a tagged synthetic lead
- admin password sign-in works when admin credentials are supplied
- waitlist admin endpoint can find the synthetic lead when the smoke wrote one

Set `SMOKE_REQUIRE_ADMIN=true` and `SMOKE_REQUIRE_MARKETPLACE=true` for preview CI and staging. Staging also sets `SMOKE_REQUIRE_LEGACY_REDIRECT=true` and `SMOKE_WRITE_WAITLIST=false`. Production sets `SMOKE_REQUIRE_ADMIN=true`. Set `SMOKE_WRITE_WAITLIST=false` only for an intentionally read-only smoke check.

Production secrets are scoped to validation, Terraform, smoke, and Git release-marker steps. The production workflow must not run dependency installation, workspace builds, or Docker builds with production provider/admin secrets in scope.

`platform-worker` has no public ingress rule. Its `/health/ready` endpoint is covered by the App Platform component health check, and the workflow verifies that the deployment reaches `ACTIVE` after DigitalOcean evaluates component health.

## Recovering Preview Connection Exhaustion

If preview or staging deployment fails in `platform-bootstrap` with PostgreSQL `53300` / `remaining connection slots are reserved for roles with the SUPERUSER attribute`, the active non-production app or bootstrap job exceeded the database tier's connection budget.

1. Confirm the Terraform spec includes `DATABASE_POOL_MAX=1` for `platform-api`, `platform-worker`, and `platform-bootstrap`.
2. Confirm the non-production environment has one `digitalocean_database_connection_pool.contexts` pool per context database, each in `transaction` mode with size `1`.
3. Confirm runtime `PLATFORM_CONTROL_DATABASE_URL` and `DATABASE_URL_*` variables resolve to connection pool URIs, not direct database URLs.
4. Re-run the PR workflow for preview or the deployment workflow for staging.
5. If a preview app is still holding too many direct connections, rerun the preview cleanup workflow and then rerun the PR workflow. If staging is affected, wait for the active staging deployment to finish or manually scale down the staging app before rerunning deployment.
