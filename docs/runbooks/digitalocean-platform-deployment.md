# DigitalOcean Platform Deployment Runbook

This runbook covers DigitalOcean App Platform preview, staging, and production deployments.

## Architecture

- Regions: App Platform runs in `nyc`; managed Postgres and Spaces stay in `nyc3`.
- Infrastructure: Terraform root at `infrastructure/digitalocean/platform`.
- State: DigitalOcean Spaces bucket through Terraform's S3 backend with `use_lockfile=true`.
- State keys:
  - PR previews: `platform/previews/pr-<number>.tfstate`.
  - Staging: `landing/staging.tfstate`.
  - Production: `landing/production.tfstate`.
- Environment DNS state keys:
  - Staging: `environment-dns/staging.tfstate`.
- Catalog asset state keys:
  - Preview assets: `catalog-assets/preview.tfstate`.
  - Staging assets: `catalog-assets/staging.tfstate`.
  - Production assets: `catalog-assets/production.tfstate`.
- DNS: `chasesets.com` must exist as a DigitalOcean DNS domain before Terraform runs. Staging also uses `infrastructure/digitalocean/environment-dns` to delegate and populate the stable `staging.chasesets.com` child zone before App Platform deploy/reset operations. The platform Terraform root owns App Platform domain attachments and staging nested alias CNAMEs; App Platform owns the apex A/AAAA routing records for primary domains.
- Catalog asset storage: preview, staging, and production each have a dedicated DigitalOcean Spaces bucket with a CDN-backed custom domain. PR previews share `assets.preview.chasesets.com` instead of creating per-PR buckets or CDNs.
- Deploy orchestration: GitHub Actions is the canonical deploy owner. Label-gated PR previews and staging build one platform container image in GitHub Actions with bounded Docker Buildx cache, push it to DigitalOcean Container Registry, record the digest, and point App Platform components at that immutable image tag. Production verifies and promotes the staging-built commit image instead of rebuilding a second artifact. A change-scope classifier gates CI and CD work so documentation-only, workflow-only, and non-deployable changes do not build images or deploy App Platform.
- Preview and staging environments run the full platform shape. Production currently remains on the landing/admin-support component set until marketplace production promotion is planned.
- Database connections: App Platform components use component-specific per-context Postgres client pool budgets. API components keep enough clients for concurrent route loaders, workers keep enough clients for their configured runner groups plus control-plane work, and bootstrap jobs keep a smaller bounded pool. Preview and staging route runtime traffic through managed PgBouncer transaction pools. Preview stays on the smallest database tier with size-1 context pools; staging runs the full shared platform on `db-s-2vcpu-4gb` so hot contexts such as Catalog, Control, Auth, Identity, Public Presence, Discovery, and Marketplace can use larger managed pools without exhausting server connections. Production also uses `db-s-2vcpu-4gb` as the baseline for its component pool budgets. Managed pool `size` consumes database server connection capacity; scale the database tier before increasing managed PgBouncer pool sizes further.
- Production branch: `production` is a smoke-verified deployed release marker. The production workflow fast-forwards it only after App Platform deployment and production smoke pass. It also creates an annotated `release-<yyyymmddHHMMSS>-<sha>` Git tag and a matching DOCR image tag for audit and rollback.
- Image retention: the `chase-sets-platform` DOCR repository uses immutable commit, PR, and release tags. `.github/workflows/platform-registry-cleanup.yml` preserves App Platform-referenced tags, release-prefixed image tags, and images updated in the last 7 days; it deletes older unreferenced tags and then starts DigitalOcean registry garbage collection.
- Availability checks: Terraform creates DigitalOcean uptime checks for public, admin, and canonical marketplace endpoints. Uptime alert emails are created only when `PLATFORM_ALERT_EMAILS` is configured for the GitHub environment.
- Image groups are intentionally deferred. The platform still deploys one shared image across App Platform components because splitting deployables into separate image groups would add Docker, registry, Terraform, promotion, rollback, and smoke-test complexity before there is enough deployment data to justify it.

## Preview Hosts

Each pull request receives its own `pr-<number>` preview environment:

- `pr-<number>.preview.chasesets.com`: landing `public-web`.
- `marketplace.pr-<number>.preview.chasesets.com`: marketplace web.
- `admin.pr-<number>.preview.chasesets.com`: admin web.

Preview app components:

- `public-web`, `marketplace`, `admin-web`.
- `platform-api`: same-origin `/api/*` for landing, admin, and marketplace.
- `platform-worker`: full-system background workers and worker health.
- `platform-bootstrap`: `PRE_DEPLOY` schema, seed, control-plane, and platform-admin reconciliation.

In staging and production, `platform-bootstrap` runs only the long-lived data profiles: `critical-bootstrap` and `catalog-integration-bootstrap`. Bootstrap reconciles schemas, required operating data, and Catalog integration structure. It does not run host-level projection, subscription, outbox, job, or Catalog seed projector drains in these long-lived environments; worker components own that catch-up after deployment. Preview keeps the full bootstrap drain because `scenario-seed` depends on cross-context scenario projections and local Catalog read models. Staging representative marketplace data is handled separately through the `representative-commerce-state` operator flow described in [Staging Representative Commerce State](./staging-representative-commerce-state.md); it is not part of ordinary deployment bootstrap and is blocked in production.

Preview environments are disposable and intentionally `noindex,nofollow` for landing and marketplace.

## Staging Hosts

The long-lived staging environment uses the same full-platform shape as PR previews, but keeps stable hostnames and state across merges:

- `www.staging.chasesets.com`: canonical staging landing `public-web`.
- `staging.chasesets.com`: launch-facing staging marketplace entry point, routed to `marketplace`.
- `marketplace.staging.chasesets.com`: marketplace web.
- `admin.staging.chasesets.com`: admin web.
- Legacy dash-based staging hosts temporarily redirect to their nested replacements.

The staging environment root, `staging.chasesets.com`, is delegated from `chasesets.com` into its own DigitalOcean DNS zone and attached to App Platform as the staging app's primary domain in that child zone. This mirrors production apex ownership by making the staging root a real apex: App Platform-managed A/AAAA routing records coexist with exact-name Google Workspace MX/TXT records at the same owner name. A managed App Platform subdomain alias or self-managed alias is not correct for this host because those modes expect CNAME ownership and conflict with exact-name mail.

When Google Workspace mail is enabled for an environment root, configure that root like the production apex. For staging, the parent zone owns only the `NS staging` delegation; the child zone owns Gmail MX/SPF, optional Google DKIM, SES bounce/DKIM/DMARC, and the asset CDN CNAME. App Platform owns the apex A/AAAA records for the staging primary domain. The platform Terraform root owns the child-zone CNAME records for `www`, `marketplace`, and `admin` because those hosts depend on the app's generated ingress hostname. No CNAME exists at the environment root.

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
- `SES_AWS_ACCESS_KEY_ID`
- `SES_AWS_SECRET_ACCESS_KEY`
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

Optional `preview`, `staging`, and `production` variables:

- `PLATFORM_ALERT_EMAILS`: JSON list of alert recipients, for example `["ops@example.com"]`.

Optional `staging` variable:

- `GOOGLE_WORKSPACE_DKIM_TXT_VALUE`: the Google Admin Console-provided DKIM TXT value for `google._domainkey.staging.chasesets.com`. Leave unset until Google generates the key; MX and SPF remain managed without it.

SES values configured for platform environments:

| Environment | `NOTIFICATION_EMAIL_PROVIDER` | `SES_AWS_REGION` | `SES_FROM_EMAIL` | `SES_CONFIGURATION_SET_NAME` | `SES_SOURCE_ARN` |
| --- | --- | --- | --- | --- | --- |
| `preview` | `amazon-ses` | `us-east-2` | `notifications@preview.chasesets.com` | `transactional-preview` | `arn:aws:ses:us-east-2:812517519777:identity/preview.chasesets.com` |
| `staging` | `amazon-ses` | `us-east-2` | `notifications@staging.chasesets.com` | `transactional-staging` | `arn:aws:ses:us-east-2:812517519777:identity/staging.chasesets.com` |
| `production` | `amazon-ses` | `us-east-2` | `notifications@chasesets.com` | `transactional-production` | `arn:aws:ses:us-east-2:812517519777:identity/chasesets.com` |

`SES_AWS_ACCESS_KEY_ID` and `SES_AWS_SECRET_ACCESS_KEY` are environment secrets for the IAM principal allowed to send through those SES identities and configuration sets.

The `platform-worker` component consumes these values in preview and staging. Production stores and validates the production SES values now, but production currently runs the landing/admin-support component set until marketplace production promotion adds the full `platform-worker`.

Catalog asset storage also depends on `SPACES_ACCESS_ID` and `SPACES_SECRET_KEY` in all three environments. The Spaces key must be able to read/write the Terraform state bucket and the environment asset buckets:

| Environment | Bucket | CDN domain |
| --- | --- | --- |
| `preview` | `chase-sets-preview-catalog-assets` | `assets.preview.chasesets.com` |
| `staging` | `chase-sets-staging-catalog-assets` | `assets.staging.chasesets.com` |
| `production` | `chase-sets-production-catalog-assets` | `assets.chasesets.com` |

Preview and staging Terraform validation requires test-mode provider values:

- `STRIPE_SECRET_KEY` starts with `sk_test`.
- `STRIPE_PUBLISHABLE_KEY` starts with `pk_test`.
- Preview uses `https://marketplace.pr-<number>.preview.chasesets.com/account/payouts` and `https://marketplace.pr-<number>.preview.chasesets.com/account/payouts/setup`.
- Staging uses `https://marketplace.staging.chasesets.com/account/payouts` and `https://marketplace.staging.chasesets.com/account/payouts/setup`.
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

The Platform PR workflow first resolves change scope. It then runs only the affected surfaces before reporting `PR Required`: local static checks, affected workspace typecheck/test/build jobs, DB-profile tests when an affected DB-profile workspace is present, marketplace Playwright e2e suites for affected user journeys, Docker image validation when a deployable image could change, workflow syntax with Actionlint when workflows/actions changed, and Terraform validation when DigitalOcean deployment infrastructure changed. Skipped jobs are accepted by `PR Required` only when the classifier marked that surface unaffected. When a same-repository pull request has the `preview` label and the change is deployable, it also deploys and smokes a live preview before `PR Required` can pass. DB-profile tests run against an explicit GitHub Actions PostgreSQL service. Playwright e2e tests start the sandbox marketplace stack once for the selected suites and upload browser artifacts when they fail. Coverage remains non-blocking, but the workflow merges first-party LCOV files and writes a Markdown coverage summary with command statuses. The workflow also fails if generated Terraform working directories under `.terraform/` are tracked; keep only `.terraform.lock.hcl` in git.

On pushes to `main`, the same `PR Required` workflow validates the merge commit without creating a preview environment. The deployment workflow starts from `workflow_run` after that merge-commit gate succeeds, resolves deployment scope for the release commit, deploys staging as an automated migration/bootstrap, smoke-test, marketplace critical-flow, and Stripe money check only when the release changed deployable runtime or Terraform surfaces, then automatically deploys production only after staging succeeds. If the release is documentation-only, workflow-only, or otherwise non-deployable, staging and production remain skipped by design.

## One-Time State Bootstrap

Create the Spaces bucket before the first platform Terraform init:

```bash
cd infrastructure/digitalocean/state-bootstrap
terraform init
terraform apply
```

Then run `terraform init` in `infrastructure/digitalocean/platform` using the appropriate backend key. The CI workflows use the same backend settings.

## One-Time Catalog Asset Bootstrap

Create or update the stable Catalog asset buckets, CDN endpoints, managed certificates, and CDN custom domains before deploying platform environments that write Catalog provider imagery:

```bash
cd infrastructure/digitalocean/catalog-assets

terraform init \
  -backend-config=bucket=chase-sets-terraform-state \
  -backend-config=key=catalog-assets/<environment>.tfstate \
  -backend-config=region=us-east-1 \
  -backend-config='endpoints={s3="https://nyc3.digitaloceanspaces.com"}' \
  -backend-config=skip_credentials_validation=true \
  -backend-config=skip_metadata_api_check=true \
  -backend-config=skip_region_validation=true \
  -backend-config=skip_requesting_account_id=true \
  -backend-config=use_path_style=true \
  -backend-config=use_lockfile=true

terraform apply -var=environment=<environment>
```

Run once for `preview`, `staging`, and `production`. `doctl spaces keys create` can create or rotate the Spaces key used by Terraform and App Platform, and `gh secret set --env <environment>` should then update `SPACES_ACCESS_ID` and `SPACES_SECRET_KEY` for each GitHub environment.

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

Staging deploys through `.github/workflows/platform-production.yml` after the `Platform PR` workflow succeeds for a `main` push, before production, when the release commit changed deployable runtime or Terraform surfaces. Staging is a pre-production verification check, not the release destination: it proves the release image can run Terraform-managed migrations/bootstrap and pass smoke checks against durable staging state. Manual dispatch is retained as a redeploy escape hatch for a ref already contained in `origin/main`; manual dispatch compares the requested ref with the `production` marker when available and runs staging before production only when deployment is required. If a queued automatic deployment finally starts after a newer `origin/main` commit exists, the staging job skips deployment work without marking the workflow failed, and production promotion stays skipped because staging did not deploy that stale commit.

The staging job:

1. Uses the release commit resolved by the deployment workflow.
2. Waits for the release commit to have a completed successful `PR Required` check from the Platform PR workflow.
3. Checks out the release commit.
4. Skips stale automatic deployments when the release commit is no longer the current `origin/main`.
5. Validates required staging secrets and variables before any deploy step uses them.
6. Builds and pushes `registry.digitalocean.com/<account-registry>/chase-sets-platform:<release_commit>` with bounded Docker Buildx cache and records the pushed digest in the workflow output.
7. Initializes Terraform with backend key `landing/staging.tfstate`.
8. Runs Terraform fmt and plan for `environment=staging` with the pushed image tag, and records whether `digitalocean_app.platform` will change.
9. Waits for any prior DigitalOcean App Platform deployment to reach a terminal phase before Terraform apply.
10. Runs Terraform apply for `environment=staging`, which runs the App Platform `PRE_DEPLOY` bootstrap and migration path before runtime traffic is validated.
11. Waits for the Terraform-created App Platform deployment to reach a terminal phase when the app spec changed.
12. Creates a forced DigitalOcean App Platform deployment only when Terraform did not change the app spec, waits for completion, and fails unless the deployment phase is `ACTIVE`.
13. Resets only the `staging.chasesets.com` App Platform domain attachment when DigitalOcean reports the stale `DomainZoneInvalid` or `DomainCNAMEMismatch` state left by an earlier subdomain/CNAME configuration.
14. Waits for landing, admin, marketplace, staging root marketplace, and legacy redirect domains. Staging root is deployment-gated because it is the launch-facing marketplace root and App Platform routing/certificate validation depends on child-zone records while Gmail MX/TXT records coexist at the same owner name.
15. Runs `pnpm run smoke:platform` against landing, admin, marketplace, and the staging marketplace root with strict staging smoke requirements, including marketplace UCP discovery at `/.well-known/ucp`, REST profile discovery at `/ucp/v1`, and MCP tool discovery at `/ucp/mcp`.
16. Runs Playwright marketplace critical flows against the deployed staging marketplace with `PLAYWRIGHT_SKIP_WEB_SERVER=true`. The browser gate signs in with `MARKETPLACE_E2E_EMAIL`/`MARKETPLACE_E2E_PASSWORD` when configured, otherwise it registers a synthetic staging account, and verifies search plus critical account commerce surfaces across Buy Cart, Sell List, Listings, Submitted Offers, Offer Matches, Inventory, Purchases, Sales, Wallet, and Payouts.
17. Runs `pnpm run stripe:money-smoke -- --edge-check --seller-flow` against staging with Stripe test-mode keys and a synthetic staging account. Optional GitHub environment variables `STAGING_SMOKE_ORDER_IDS`, `STAGING_SMOKE_BALANCE_CREDIT_AMOUNT`, `STAGING_SMOKE_PAYMENT_METHOD_CATEGORY`, `STAGING_SMOKE_CREATE_PAYMENT`, `STAGING_SMOKE_PAYOUT_AMOUNT`, and `STAGING_SMOKE_REQUEST_PAYOUT` can deepen the payment and payout probes when staging has known safe orders or payout-ready balances.

Production starts automatically only after this staging job deploys the release commit and passes all staging gates. Staging and production use separate GitHub Actions concurrency groups so a queued or paused production deployment cannot block the next staging check.

Representative commerce state is intentionally outside this normal staging deploy path. Run `.github/workflows/platform-staging-representative-commerce-state.yml` after staging reset or after Catalog integration imports when staging needs fresh internal accounts, inventory, listings, offers, and accepted-offer purchase/sale coverage over newly imported Catalog Items.

## Preview Cleanup

Closed and merged pull requests destroy their preview environment through `.github/workflows/platform-preview-cleanup.yml`.

The cleanup workflow runs with the trusted base workflow definition, checks out the PR base commit, initializes Terraform with `platform/previews/pr-<number>.tfstate`, waits for any active App Platform deployment to finish, and runs `terraform destroy -auto-approve`.

If cleanup fails, rerun the cleanup workflow for the closed PR. If the state key exists but the App Platform app has already been deleted manually, the DigitalOcean deployment helper treats the missing app as no active deployment to wait for.

## Production Deployment

Production deploys automatically through `.github/workflows/platform-production.yml` after the staging job succeeds. It promotes the same immutable commit-tagged image that staging just deployed, instead of rebuilding a second artifact. Non-deployable release commits do not reach production promotion because staging is intentionally skipped.

Production is intentionally gated to landing and admin-support by default. The marketplace, full platform API, platform worker, and commerce bounded-context databases are deployed to production only when the production GitHub Environment sets `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true` and the separate launch, Marketplace Checkout Fee, Support operations, Fulfillment postage, transactional email, and Tax evidence variables approve the launch posture. Keep `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED` unset or `false` until the [marketplace production promotion](./marketplace-production-promotion.md) gates are complete.

The workflow:

1. Checks out the release commit that already passed `PR Required` and staging deployment.
2. Skips stale automatic deployments when the release commit is no longer the current `origin/main`.
3. Validates required production secrets and variables. When `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true`, validation also requires `PRODUCTION_MARKETPLACE_PROMOTION_APPROVED=true`, a non-empty `PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE`, approved Marketplace Checkout Fee evidence, approved Stripe money operations evidence, approved Support operations evidence, approved Fulfillment postage evidence, approved transactional email evidence, approved Tax readiness evidence, Stripe live-mode keys, Stripe webhook secret, EasyPost production configuration, production Connect return/refresh URLs, and complete Amazon SES transactional email configuration.
4. Verifies `registry.digitalocean.com/<account-registry>/chase-sets-platform:<release_commit>` already exists in DigitalOcean Container Registry. If it is missing, run a successful staging deployment for that commit before production promotion.
5. Runs Terraform fmt and plan for `environment=production` with the staging-promoted image tag, blocks destructive changes unless `.github/deployment/production-destructive-change-approved.md` exists in the reviewed commit, and records whether `digitalocean_app.platform` will change.
6. Waits for any prior DigitalOcean App Platform deployment to reach a terminal phase before Terraform apply.
7. Runs Terraform apply for `environment=production`.
8. Waits for the Terraform-created App Platform deployment to reach a terminal phase when the app spec changed.
9. Creates a forced DigitalOcean App Platform deployment only when Terraform did not change the app spec, waits for completion, and fails unless the deployment phase is `ACTIVE`.
10. Runs `pnpm run smoke:platform` with required admin authentication, `ops+smoke@chasesets.com`, and smoke UTM markers. When marketplace promotion is enabled, production smoke also requires the production marketplace domain.
11. Adds a matching `release-<yyyymmddHHMMSS>-<sha>` DOCR tag to the promoted image, creates the annotated Git release tag, and fast-forwards the protected `production` branch to the smoke-verified deployed release commit.

Production destructive-change overrides must be explicit in the pull request. Add `.github/deployment/production-destructive-change-approved.md` only for a deliberately reviewed infrastructure migration, and remove it in the same PR or an immediate follow-up when the migration is complete.

## Smoke Coverage

The platform smoke script checks:

- landing home page loads
- landing API readiness passes through the deployed API component
- admin home page loads
- admin API readiness passes through the deployed API component
- marketplace home and search pages load when a marketplace URL is supplied
- legacy dash-based staging URLs return temporary HTTPS `302` redirects to their nested equivalents when supplied, including `landing-staging.chasesets.com` to `www.staging.chasesets.com`
- waitlist signup accepts a tagged synthetic lead
- admin password sign-in works when admin credentials are supplied
- waitlist admin endpoint can find the synthetic lead when the smoke wrote one

Catalog asset CDN smoke verifies that each environment's `CATALOG_ASSET_PUBLIC_BASE_URL` resolves over HTTPS after the `catalog-assets` Terraform root applies and during staging/production platform smoke. A full asset write smoke is covered by importing a provider Source Observation that has an image and confirming the stored URL starts with the environment CDN base URL.

Set `SMOKE_REQUIRE_ADMIN=true` and `SMOKE_REQUIRE_MARKETPLACE=true` for preview CI and staging. Staging also sets `SMOKE_REQUIRE_LEGACY_REDIRECT=true` and `SMOKE_WRITE_WAITLIST=false`. Production sets `SMOKE_REQUIRE_ADMIN=true`. Set `SMOKE_WRITE_WAITLIST=false` only for an intentionally read-only smoke check.

Production sets `SMOKE_REQUIRE_MARKETPLACE=true` only when `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true` after launch, Marketplace Checkout Fee, Support operations, Fulfillment postage, transactional email, and Tax approval evidence has passed validation. The current production posture should not include a marketplace URL in smoke output.

Production secrets are scoped to validation, Terraform, smoke, and Git release-marker steps. The production workflow must not run dependency installation, workspace builds, or Docker builds with production provider/admin secrets in scope.

`platform-worker` has no public ingress rule. Its `/health/ready` endpoint is covered by the App Platform component health check, and the workflow verifies that the deployment reaches `ACTIVE` after DigitalOcean evaluates component health.

## Recovering Preview Connection Exhaustion

If preview or staging deployment fails in `platform-bootstrap` with PostgreSQL `53300` / `remaining connection slots are reserved for roles with the SUPERUSER attribute`, the active non-production app or bootstrap job exceeded the database tier's connection budget.

1. Confirm the Terraform spec includes component-specific `DATABASE_POOL_MAX` values and does not let a single worker process exceed the database tier's connection budget.
   Worker startup now fails when configured runner concurrency exceeds `DATABASE_POOL_MAX`, unless `ALLOW_WORKER_OVER_POOL_CAPACITY=true` is explicitly set for local testing. Do not set that override in staging or production.
2. Confirm preview has one `digitalocean_database_connection_pool.contexts` pool per context database in `transaction` mode with size `1`, and staging uses the explicit hot-context pool sizes on a `db-s-2vcpu-4gb` or larger database tier.
3. Confirm runtime `PLATFORM_CONTROL_DATABASE_URL` and `DATABASE_URL_*` variables resolve to connection pool URIs, not direct database URLs.
4. Re-run the PR workflow for preview or the deployment workflow for staging.
5. If a preview app is still holding too many direct connections, rerun the preview cleanup workflow and then rerun the PR workflow. If staging is affected, wait for the active staging deployment to finish or manually scale down the staging app before rerunning deployment.
