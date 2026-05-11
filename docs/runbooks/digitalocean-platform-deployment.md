# DigitalOcean Platform Deployment Runbook

This runbook covers the staging full-system platform deployment and the current production landing deployment on DigitalOcean App Platform.

## Architecture

- Region: `nyc3`.
- Infrastructure: Terraform root at `infrastructure/digitalocean/platform`.
- State: DigitalOcean Spaces bucket through Terraform's S3 backend with `use_lockfile=true`.
- Compatibility: remote state keys remain `landing/staging.tfstate` and `landing/production.tfstate` until a deliberate state-key migration is scheduled.
- DNS: `chasesets.com` must exist as a DigitalOcean DNS domain before this root runs; staging and production share the same zone.
- Deploy orchestration: GitHub Actions is the canonical deploy owner. Workflows build one platform container image in GitHub Actions, push it to DigitalOcean Container Registry, and point App Platform components at that immutable image tag. This avoids App Platform source builds for each component during Terraform app updates.
- Database connections: App Platform API, worker, and bootstrap components cap each per-context Postgres client pool at one connection. Full-system staging stays on the smallest managed Postgres tier and routes runtime traffic through one managed PgBouncer transaction pool per context database. Production can use a larger database tier when production marketplace promotion needs more headroom.
- Production branch: `production` is a smoke-verified deployed release marker. The production workflow fast-forwards it only after App Platform deployment and production smoke pass.
- Image retention: the `chase-sets-platform` DOCR repository uses immutable commit tags. During weekly operations, keep the images for the currently deployed staging commit, the currently deployed production release commit, the intended rollback window, and recent staging commits needed for active investigation; delete older tags and run DigitalOcean registry garbage collection after confirming no App Platform spec references them.
- Staging hosts:
  - `landing-staging.chasesets.com`: landing `public-web`.
  - `marketplace-staging.chasesets.com`: marketplace web.
  - `admin-staging.chasesets.com`: admin web.
  - `staging.chasesets.com`: temporary redirect to `landing-staging.chasesets.com`.
- Staging app components:
  - `public-web`, `marketplace`, `admin-web`.
  - `platform-api`: same-origin `/api/*` for landing, admin, and marketplace.
  - `platform-worker`: full-system background workers and worker health.
  - `platform-bootstrap`: `PRE_DEPLOY` schema, seed, control-plane, and platform-admin reconciliation.
- Production remains on the landing/admin-support component set until production marketplace promotion is planned.

## Required GitHub Environment Secrets

Configure these in both `staging` and `production` GitHub Environments:

- `DIGITALOCEAN_ACCESS_TOKEN`
- `SPACES_ACCESS_ID`
- `SPACES_SECRET_KEY`
- `PLATFORM_INTERNAL_AUTH_SECRET`
- `PLATFORM_ADMIN_EMAIL`
- `PLATFORM_ADMIN_PASSWORD`
- `CHASE_SETS_DISCORD_INVITE_URL`

Additional `staging` secrets for the full platform:

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CONNECT_RETURN_URL`
- `STRIPE_CONNECT_REFRESH_URL`
- `EASYPOST_API_KEY`

Optional `staging` variables:

- `STRIPE_API_BASE_URL`
- `EASYPOST_API_BASE_URL`
- `EASYPOST_MODE`
- `PLATFORM_ADMIN_DISPLAY_NAME`

Staging Terraform validation requires test-mode provider values:

- `STRIPE_SECRET_KEY` starts with `sk_test`
- `STRIPE_PUBLISHABLE_KEY` starts with `pk_test`
- `STRIPE_CONNECT_RETURN_URL` is `https://marketplace-staging.chasesets.com/account/payouts`
- `STRIPE_CONNECT_REFRESH_URL` is `https://marketplace-staging.chasesets.com/account/payouts/setup`
- `EASYPOST_API_KEY` starts with `EZTK`
- `EASYPOST_MODE` is `test`

## Required GitHub Protection

Deployment safety depends on GitHub repository settings as well as workflow code:

- Protect `main` with required pull requests and a required `PR Required` status check from `.github/workflows/platform-pr.yml`.
- Protect or ruleset-match `production` before the first production deploy so only the production workflow can move the deployed-release marker.
- Restrict the `staging` and `production` GitHub Environments to deployments from `main`.
- Require approval on the `production` GitHub Environment before secrets are released to the job.

The Platform PR workflow validates static checks, typecheck, unit tests, DB-profile tests, workspace builds, Docker image builds, workflow syntax with Actionlint, staging Terraform shape, production Terraform shape, and state-bootstrap Terraform before reporting `PR Required`.

## One-Time State Bootstrap

Create the Spaces bucket before the first platform Terraform init:

```bash
cd infrastructure/digitalocean/state-bootstrap
terraform init
terraform apply
```

Then run `terraform init` in `infrastructure/digitalocean/platform` using `landing/staging.tfstate` or `landing/production.tfstate` as the backend key. The CI workflows use the same backend settings.

Run `pnpm install --frozen-lockfile` before Terraform apply. The platform Terraform root creates per-context database users and runs the repo-local DigitalOcean grant script so those users receive database and public-schema privileges before App Platform deploys. In staging, Terraform also creates one managed Postgres transaction pool per context database and points runtime `DATABASE_URL_*` variables at the pool URIs instead of App Platform database bindables.

## Staging Deployment

Staging deploys from `main` through `.github/workflows/platform-staging.yml`.

The workflow serializes staging runs so an in-progress DigitalOcean App Platform deployment can finish before the next run touches the app.

The workflow:

1. Validates required staging secrets and variables before dependency install.
2. Waits for the full `PR Required` gate on the pushed `main` commit.
3. Runs the staging gate: generated metadata check, static checks, and workspace builds.
4. Builds and pushes `registry.digitalocean.com/<account-registry>/chase-sets-platform:${GITHUB_SHA}`.
5. Runs Terraform fmt and plan for `environment=staging` with the pushed image tag, and records whether `digitalocean_app.platform` will change.
6. Waits for any prior DigitalOcean App Platform deployment to reach a terminal phase before Terraform apply.
7. Runs Terraform apply for `environment=staging`.
8. Waits for the Terraform-created App Platform deployment to reach a terminal phase when the app spec changed.
9. Creates a forced DigitalOcean App Platform deployment only when Terraform did not change the app spec, waits for completion, and fails unless the deployment phase is `ACTIVE`.
10. Runs `pnpm run smoke:platform` against landing, admin, marketplace, and the temporary redirect with strict staging smoke requirements.

The App Platform components share the same runtime image and differ only by run command, environment, scaling, health checks, and ingress routing.

Staging is persistent and intentionally `noindex,nofollow` for landing and marketplace; production is the only indexed public origin.

When migrating an existing staging app from direct database URLs to pool-backed URLs, delete or temporarily scale down the existing staging App Platform app before the first pool-backed apply if direct connections are still exhausting the small database tier. The deploy workflow tolerates a missing stale app ID during the pre-apply deployment wait, and Terraform recreates the app from state/config.

## Production Deployment

Production deploys through `.github/workflows/platform-production.yml` with a release tag input.

The workflow:

1. Validates required production secrets and variables before release tag or branch mutation.
2. Resolves the release commit from the existing release tag, or from the requested release ref when the tag does not exist.
3. Verifies the release commit has a completed successful `PR Required` check from the Platform PR workflow. The workflow runs on pull requests and on pushes to `main`, so the merge or squash commit selected for release carries its own deploy gate result.
4. Creates the release tag when it does not already exist.
5. Checks out the resolved release commit.
6. Builds and pushes `registry.digitalocean.com/<account-registry>/chase-sets-platform:${release_commit}`.
7. Runs Terraform fmt and plan for `environment=production` with the pushed image tag, and records whether `digitalocean_app.platform` will change.
8. Waits for any prior DigitalOcean App Platform deployment to reach a terminal phase before Terraform apply.
9. Runs Terraform apply for `environment=production`.
10. Waits for the Terraform-created App Platform deployment to reach a terminal phase when the app spec changed.
11. Creates a forced DigitalOcean App Platform deployment only when Terraform did not change the app spec, waits for completion, and fails unless the deployment phase is `ACTIVE`.
12. Runs `pnpm run smoke:platform` with required admin authentication, `ops+smoke@chasesets.com`, and smoke UTM markers.
13. Fast-forwards the protected `production` branch to the smoke-verified deployed release commit.

## Smoke Coverage

The platform smoke script checks:

- landing home page loads
- landing API readiness passes through the deployed API component
- admin home page loads
- admin API readiness passes through the deployed API component
- marketplace home and search pages load when a marketplace URL is supplied
- `staging.chasesets.com` returns a temporary HTTPS `302` redirect to `landing-staging.chasesets.com` when a legacy URL is supplied
- waitlist signup accepts a tagged synthetic lead
- admin password sign-in works when admin credentials are supplied
- waitlist admin endpoint can find the synthetic lead

Set `SMOKE_REQUIRE_ADMIN=true`, `SMOKE_REQUIRE_MARKETPLACE=true`, and `SMOKE_REQUIRE_LEGACY_REDIRECT=true` for staging CI. Production also sets `SMOKE_REQUIRE_ADMIN=true`. Set `SMOKE_WRITE_WAITLIST=false` for a read-only smoke check.

`platform-worker` has no public ingress rule. Its `/health/ready` endpoint is covered by the App Platform component health check, and the workflow verifies that the deployment reaches `ACTIVE` after DigitalOcean evaluates component health.

## Refreshing Staging Data

Staging data is persistent. Refresh it from production only through a sanitized process:

1. Export production context databases.
2. Remove or transform personal data, auth credentials, passkey material, tokens, sessions, feedback bodies, and operational secrets.
3. Restore into staging context databases.
4. Re-run `platform-bootstrap`.
5. Run staging smoke.

Do not copy production auth credential rows into staging without explicit sanitization.

## Recovering Staging Connection Exhaustion

If staging deployment fails in `platform-bootstrap` with PostgreSQL `53300` / `remaining connection slots are reserved for roles with the SUPERUSER attribute`, the active staging app or bootstrap job exceeded the database tier's connection budget.

1. Confirm the Terraform spec includes `DATABASE_POOL_MAX=1` for `platform-api`, `platform-worker`, and `platform-bootstrap`.
2. Confirm staging has one `digitalocean_database_connection_pool.contexts` pool per context database, each in `transaction` mode with size `1`.
3. Confirm runtime `PLATFORM_CONTROL_DATABASE_URL` and `DATABASE_URL_*` variables resolve to connection pool URIs, not direct database URLs.
4. Re-run the staging workflow.
5. If the previous active app is still holding too many direct connections while the new pool-backed spec starts, destroy or temporarily scale down the staging App Platform app and re-run staging. Staging is disposable; Terraform will recreate the App Platform app from state/config, while the managed database remains the persistent data boundary unless deliberately destroyed.
