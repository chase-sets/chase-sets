# DigitalOcean Platform Deployment Runbook

This runbook covers DigitalOcean App Platform preview and production deployments.

## Architecture

- Region: `nyc3`.
- Infrastructure: Terraform root at `infrastructure/digitalocean/platform`.
- State: DigitalOcean Spaces bucket through Terraform's S3 backend with `use_lockfile=true`.
- State keys:
  - PR previews: `platform/previews/pr-<number>.tfstate`.
  - Production: `landing/production.tfstate`.
- DNS: `chasesets.com` must exist as a DigitalOcean DNS domain before Terraform runs.
- Deploy orchestration: GitHub Actions is the canonical deploy owner. Workflows build one platform container image in GitHub Actions, push it to DigitalOcean Container Registry, and point App Platform components at that immutable image tag.
- Preview environments run the full platform shape. Production currently remains on the landing/admin-support component set until marketplace production promotion is planned.
- Database connections: non-production API, worker, and bootstrap components cap each per-context Postgres client pool at one connection and route runtime traffic through one managed PgBouncer transaction pool per context database.
- Production branch: `production` is a smoke-verified deployed release marker. The production workflow fast-forwards it only after App Platform deployment and production smoke pass.
- Image retention: the `chase-sets-platform` DOCR repository uses immutable commit and PR tags. During weekly operations, keep the images for the currently deployed production commit, active PR previews, the intended rollback window, and recent commits needed for active investigation; delete older tags and run DigitalOcean registry garbage collection after confirming no App Platform spec references them.

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

## Required GitHub Environment Secrets

Configure these in both `preview` and `production` GitHub Environments:

- `DIGITALOCEAN_ACCESS_TOKEN`
- `SPACES_ACCESS_ID`
- `SPACES_SECRET_KEY`
- `PLATFORM_INTERNAL_AUTH_SECRET`
- `PLATFORM_ADMIN_EMAIL`
- `PLATFORM_ADMIN_PASSWORD`
- `CHASE_SETS_DISCORD_INVITE_URL`

Additional `preview` secrets for the full platform:

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `EASYPOST_API_KEY`

Optional `preview` variables:

- `STRIPE_API_BASE_URL`
- `EASYPOST_API_BASE_URL`
- `EASYPOST_MODE`
- `PLATFORM_ADMIN_DISPLAY_NAME`

Preview Terraform validation requires test-mode provider values:

- `STRIPE_SECRET_KEY` starts with `sk_test`.
- `STRIPE_PUBLISHABLE_KEY` starts with `pk_test`.
- `STRIPE_CONNECT_RETURN_URL` is `https://marketplace-pr-<number>.chasesets.com/account/payouts`.
- `STRIPE_CONNECT_REFRESH_URL` is `https://marketplace-pr-<number>.chasesets.com/account/payouts/setup`.
- `EASYPOST_API_KEY` starts with `EZTK`.
- `EASYPOST_MODE` is `test`.

## Required GitHub Protection

Deployment safety depends on GitHub repository settings as well as workflow code:

- Protect `main` with required pull requests and a required `PR Required` status check from `.github/workflows/platform-pr.yml`.
- Protect or ruleset-match `production` so only the production workflow can move the deployed-release marker.
- Restrict the `production` GitHub Environment to deployments from `main`.
- Require approval on the `production` GitHub Environment before secrets are released to the job if production should stay human-gated after merge.
- Allow the `preview` GitHub Environment to deploy from pull requests created in this repository. Fork PRs do not receive preview secrets under the `pull_request` event.

The Platform PR workflow validates static checks, typecheck, unit tests, DB-profile tests, workspace builds, Docker image builds, workflow syntax with Actionlint, preview Terraform shape, production Terraform shape, state-bootstrap Terraform, and a live preview smoke check before reporting `PR Required` on pull requests.

On pushes to `main`, the same `PR Required` workflow validates the merge commit without creating a preview environment. Production waits for that merge-commit gate before deploying.

## One-Time State Bootstrap

Create the Spaces bucket before the first platform Terraform init:

```bash
cd infrastructure/digitalocean/state-bootstrap
terraform init
terraform apply
```

Then run `terraform init` in `infrastructure/digitalocean/platform` using the appropriate backend key. The CI workflows use the same backend settings.

Run `pnpm install --frozen-lockfile` before Terraform apply. The platform Terraform root creates per-context database users and runs the repo-local DigitalOcean grant script so those users receive database and public-schema privileges before App Platform deploys. In preview, Terraform also creates one managed Postgres transaction pool per context database and points runtime `DATABASE_URL_*` variables at the pool URIs.

## PR Preview Deployment

Pull requests deploy through `.github/workflows/platform-pr.yml`.

The preview deployment job runs only after the local CI jobs and Terraform validation jobs pass.

The workflow:

1. Builds and pushes `registry.digitalocean.com/<account-registry>/chase-sets-platform:pr-<number>-<head-sha>`.
2. Initializes Terraform with backend key `platform/previews/pr-<number>.tfstate`.
3. Runs Terraform fmt and plan for `environment=preview` and `preview_identifier=pr-<number>`.
4. Waits for any prior App Platform deployment in that PR environment to finish.
5. Applies the preview Terraform plan.
6. Waits for the Terraform-created App Platform deployment to reach a terminal phase.
7. Creates a forced DigitalOcean App Platform deployment only when Terraform did not change the app spec, waits for completion, and fails unless the deployment phase is `ACTIVE`.
8. Runs `pnpm run smoke:platform` against landing, admin, and marketplace with strict preview smoke requirements.

The App Platform components share the same runtime image and differ only by run command, environment, scaling, health checks, and ingress routing.

## Preview Cleanup

Closed and merged pull requests destroy their preview environment through `.github/workflows/platform-preview-cleanup.yml`.

The cleanup workflow runs with the trusted base workflow definition, checks out the PR base commit, initializes Terraform with `platform/previews/pr-<number>.tfstate`, waits for any active App Platform deployment to finish, and runs `terraform destroy -auto-approve`.

If cleanup fails, rerun the cleanup workflow for the closed PR. If the state key exists but the App Platform app has already been deleted manually, the DigitalOcean deployment helper treats the missing app as no active deployment to wait for.

## Production Deployment

Production deploys through `.github/workflows/platform-production.yml` on every push to `main`. Manual dispatch is retained as a redeploy escape hatch for a ref already contained in `origin/main`.

The workflow:

1. Validates required production secrets and variables.
2. Resolves the release commit from the pushed merge commit or the manual dispatch ref.
3. Waits for the release commit to have a completed successful `PR Required` check from the Platform PR workflow.
4. Checks out the release commit.
5. Builds and pushes `registry.digitalocean.com/<account-registry>/chase-sets-platform:<release_commit>`.
6. Runs Terraform fmt and plan for `environment=production` with the pushed image tag, and records whether `digitalocean_app.platform` will change.
7. Waits for any prior DigitalOcean App Platform deployment to reach a terminal phase before Terraform apply.
8. Runs Terraform apply for `environment=production`.
9. Waits for the Terraform-created App Platform deployment to reach a terminal phase when the app spec changed.
10. Creates a forced DigitalOcean App Platform deployment only when Terraform did not change the app spec, waits for completion, and fails unless the deployment phase is `ACTIVE`.
11. Runs `pnpm run smoke:platform` with required admin authentication, `ops+smoke@chasesets.com`, and smoke UTM markers.
12. Fast-forwards the protected `production` branch to the smoke-verified deployed release commit.

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

Set `SMOKE_REQUIRE_ADMIN=true` and `SMOKE_REQUIRE_MARKETPLACE=true` for preview CI. Production sets `SMOKE_REQUIRE_ADMIN=true`. Set `SMOKE_WRITE_WAITLIST=false` only for an intentionally read-only smoke check.

`platform-worker` has no public ingress rule. Its `/health/ready` endpoint is covered by the App Platform component health check, and the workflow verifies that the deployment reaches `ACTIVE` after DigitalOcean evaluates component health.

## Recovering Preview Connection Exhaustion

If preview deployment fails in `platform-bootstrap` with PostgreSQL `53300` / `remaining connection slots are reserved for roles with the SUPERUSER attribute`, the active preview app or bootstrap job exceeded the database tier's connection budget.

1. Confirm the Terraform spec includes `DATABASE_POOL_MAX=1` for `platform-api`, `platform-worker`, and `platform-bootstrap`.
2. Confirm preview has one `digitalocean_database_connection_pool.contexts` pool per context database, each in `transaction` mode with size `1`.
3. Confirm runtime `PLATFORM_CONTROL_DATABASE_URL` and `DATABASE_URL_*` variables resolve to connection pool URIs, not direct database URLs.
4. Re-run the PR workflow.
5. If the previous active app is still holding too many direct connections, rerun the preview cleanup workflow and then rerun the PR workflow.
