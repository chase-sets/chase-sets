# DigitalOcean Landing Deployment Runbook

This runbook covers the staging and production landing deployment on DigitalOcean App Platform.

## Architecture

- Region: `nyc3`.
- Infrastructure: Terraform root at `infrastructure/digitalocean/landing`.
- State: DigitalOcean Spaces bucket through Terraform's S3 backend with `use_lockfile=true`.
- DNS: `chasesets.com` must exist as a DigitalOcean DNS domain before the landing root runs; staging and production share the same zone.
- Apps:
  - `public-web`: `chasesets.com`, `www.chasesets.com`, and staging public host.
  - `admin-web`: `admin.chasesets.com` and staging admin host.
  - `admin-support-api`: same-origin `/api/*` for public and admin hosts.
  - `admin-support-worker`: projection/subscription worker for the landing admin-support slice.
  - `admin-support-bootstrap`: `PRE_DEPLOY` job for schema, control plane, catalog reference data, and platform admin bootstrap.
- Data: managed Postgres cluster with one control database and per-context databases for `auth`, `identity`, `catalog`, `experience`, and `public-presence`.

## Required GitHub Environment Secrets

Configure these in both `staging` and `production` GitHub Environments:

- `DIGITALOCEAN_ACCESS_TOKEN`
- `SPACES_ACCESS_ID`
- `SPACES_SECRET_KEY`
- `PLATFORM_INTERNAL_AUTH_SECRET`
- `PLATFORM_ADMIN_EMAIL`
- `PLATFORM_ADMIN_PASSWORD`
- `CHASE_SETS_DISCORD_INVITE_URL`

Optional environment variable:

- `PLATFORM_ADMIN_DISPLAY_NAME`

The bootstrap job creates or reconciles only the configured platform admin account. Production self-registration is disabled by default, and the platform admin should register a passkey after first password sign-in.

## One-Time State Bootstrap

Create the Spaces bucket before the first landing Terraform init:

```bash
cd infrastructure/digitalocean/state-bootstrap
terraform init
terraform apply
```

Then run `terraform init` in `infrastructure/digitalocean/landing` using `landing/staging.tfstate` or `landing/production.tfstate` as the backend key. The CI workflows use the same backend settings.

Run `pnpm install --frozen-lockfile` before Terraform apply. The landing Terraform root creates per-context database users and then runs the repo-local DigitalOcean grant script so those users receive database and public-schema privileges before App Platform deploys.

## Staging Deployment

Staging deploys from `main` through `.github/workflows/landing-staging.yml`.

The workflow:

1. Runs `pnpm run verify`.
2. Runs Terraform fmt, plan, and apply for `environment=staging`.
3. Creates a DigitalOcean App Platform deployment and waits for completion.
4. Runs `pnpm run smoke:landing`.

Staging is persistent and intentionally `noindex,nofollow`; production is the only indexed public origin.

## Production Deployment

Production deploys through `.github/workflows/landing-production.yml` with a release tag input.

The workflow:

1. Creates the release tag from the requested release ref when it is missing, or verifies the existing tag.
2. Fast-forwards the protected `production` branch to that tag.
3. Runs `pnpm run verify`.
4. Runs Terraform fmt, plan, and apply for `environment=production`.
5. Creates a DigitalOcean App Platform deployment and waits for completion.
6. Runs `pnpm run smoke:landing` with `ops+smoke@chasesets.com` and smoke UTM markers.

## Smoke Coverage

The smoke script checks:

- public home page loads
- public API readiness passes
- admin home page loads
- waitlist signup accepts a tagged synthetic lead
- admin password sign-in works when admin credentials are supplied
- waitlist admin endpoint can find the synthetic lead

Set `SMOKE_WRITE_WAITLIST=false` for a read-only smoke check.

## Refreshing Staging Data

Staging data is persistent. Refresh it from production only through a sanitized process:

1. Export production context databases.
2. Remove or transform personal data, auth credentials, passkey material, tokens, sessions, feedback bodies, and any operational secrets.
3. Restore into staging context databases.
4. Re-run `admin-support-bootstrap`.
5. Run staging smoke.

Do not copy production auth credential rows into staging without explicit sanitization.
