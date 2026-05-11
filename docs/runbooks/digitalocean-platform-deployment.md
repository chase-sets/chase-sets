# DigitalOcean Platform Deployment Runbook

This runbook covers the staging full-system platform deployment and the current production landing deployment on DigitalOcean App Platform.

## Architecture

- Region: `nyc3`.
- Infrastructure: Terraform root at `infrastructure/digitalocean/platform`.
- State: DigitalOcean Spaces bucket through Terraform's S3 backend with `use_lockfile=true`.
- Compatibility: remote state keys remain `landing/staging.tfstate` and `landing/production.tfstate` until a deliberate state-key migration is scheduled.
- DNS: `chasesets.com` must exist as a DigitalOcean DNS domain before this root runs; staging and production share the same zone.
- Deploy orchestration: GitHub Actions is the canonical deploy owner. Workflows build one platform container image in GitHub Actions, push it to DigitalOcean Container Registry, and point App Platform components at that immutable image tag. This avoids App Platform source builds for each component during Terraform app updates.
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

## One-Time State Bootstrap

Create the Spaces bucket before the first platform Terraform init:

```bash
cd infrastructure/digitalocean/state-bootstrap
terraform init
terraform apply
```

Then run `terraform init` in `infrastructure/digitalocean/platform` using `landing/staging.tfstate` or `landing/production.tfstate` as the backend key. The CI workflows use the same backend settings.

Run `pnpm install --frozen-lockfile` before Terraform apply. The platform Terraform root creates per-context database users and runs the repo-local DigitalOcean grant script so those users receive database and public-schema privileges before App Platform deploys.

## Staging Deployment

Staging deploys from `main` through `.github/workflows/platform-staging.yml`.

The workflow serializes staging runs so an in-progress DigitalOcean App Platform deployment can finish before the next run touches the app.

The workflow:

1. Validates required staging secrets and variables before dependency install.
2. Runs the staging gate: generated metadata check, static checks, and workspace builds.
3. Builds and pushes `registry.digitalocean.com/<account-registry>/chase-sets-platform:${GITHUB_SHA}`.
4. Runs Terraform fmt and plan for `environment=staging` with the pushed image tag.
5. Waits for any prior DigitalOcean App Platform deployment to reach a terminal phase before Terraform apply.
6. Runs Terraform apply for `environment=staging`.
7. Creates a DigitalOcean App Platform deployment when Terraform did not already change and deploy `digitalocean_app.platform`, waits for completion, and fails unless the deployment phase is `ACTIVE`.
8. Runs `pnpm run smoke:platform` against landing, admin, marketplace, and the temporary redirect with strict staging smoke requirements.

The App Platform components share the same runtime image and differ only by run command, environment, scaling, health checks, and ingress routing.

Staging is persistent and intentionally `noindex,nofollow` for landing and marketplace; production is the only indexed public origin.

## Production Deployment

Production deploys through `.github/workflows/platform-production.yml` with a release tag input.

The workflow:

1. Creates the release tag from the requested release ref when it is missing, or verifies the existing tag.
2. Fast-forwards the protected `production` branch to that tag.
3. Verifies the release commit has a successful `PR Required` check.
4. Builds and pushes `registry.digitalocean.com/<account-registry>/chase-sets-platform:${release_commit}`.
5. Runs Terraform fmt and plan for `environment=production` with the pushed image tag.
6. Waits for any prior DigitalOcean App Platform deployment to reach a terminal phase before Terraform apply.
7. Runs Terraform apply for `environment=production`.
8. Creates a DigitalOcean App Platform deployment when Terraform did not already change and deploy `digitalocean_app.platform`, waits for completion, and fails unless the deployment phase is `ACTIVE`.
9. Runs `pnpm run smoke:platform` with `ops+smoke@chasesets.com` and smoke UTM markers.

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

Set `SMOKE_REQUIRE_ADMIN=true`, `SMOKE_REQUIRE_MARKETPLACE=true`, and `SMOKE_REQUIRE_LEGACY_REDIRECT=true` for staging CI. Set `SMOKE_WRITE_WAITLIST=false` for a read-only smoke check.

`platform-worker` has no public ingress rule. Its `/health/ready` endpoint is covered by the App Platform component health check, and the workflow verifies that the deployment reaches `ACTIVE` after DigitalOcean evaluates component health.

## Refreshing Staging Data

Staging data is persistent. Refresh it from production only through a sanitized process:

1. Export production context databases.
2. Remove or transform personal data, auth credentials, passkey material, tokens, sessions, feedback bodies, and operational secrets.
3. Restore into staging context databases.
4. Re-run `platform-bootstrap`.
5. Run staging smoke.

Do not copy production auth credential rows into staging without explicit sanitization.
