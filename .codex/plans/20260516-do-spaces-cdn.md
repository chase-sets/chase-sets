# DigitalOcean Spaces CDN

## Intent

Provision production-like Catalog asset storage for preview, staging, and production using DigitalOcean Spaces Standard Storage with CDN enabled and custom asset domains. Local development keeps its filesystem-backed fake CDN behavior.

The change must keep Catalog as the owner of provider asset storage behavior, keep deployables thin, and keep DigitalOcean/App Platform wiring in infrastructure and workflow surfaces.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-do-spaces-cdn`
- Branch: `codex/do-spaces-cdn`
- Base: current source repo `HEAD` at `db6d5a27`; source `main` was 6 commits behind `origin/main` when this worktree was created.
- Sandbox id: `79986d5d`
- Dependency setup: `pnpm run deps:install` completed successfully.
- Sandbox doctor: `pnpm run sandbox:doctor` completed successfully.
- Setup caveats:
  - `doctl version` is `1.155.0-release`; `1.159.0` is available.
  - `gh auth status` is authenticated as `todd-skelton` with `repo` and `workflow` scopes.
  - Installed `doctl` exposes `spaces keys` and `compute cdn` commands, but does not expose `spaces bucket create/list` commands. Bucket creation may need Terraform or an S3-compatible CLI/API step unless a newer `doctl` adds bucket commands.

## Owning Contexts

- Catalog owns the canonical provider asset storage decision because `bounded-contexts/catalog/context.json` declares the `catalogAssetStorage` host port, provided by `admin-support-api` and `platform-api`, to store Catalog-owned provider asset bytes and return public URLs for Source Observations.
- Discovery owns browse/detail presentation and may consume Catalog-projected image URLs, but it does not own the provider asset storage decision.
- Checkout currently has a local fake-CDN fallback image path for cart UI. That is UI fallback behavior, not production Catalog asset storage.
- `infrastructure/digitalocean/platform` owns DigitalOcean App Platform and environment wiring for preview, staging, and production.

## Resolved Decisions

- Local development remains filesystem-backed. Existing API defaults use `CATALOG_ASSET_STORAGE_KIND=filesystem`, local roots under `artifacts/catalog-assets`, and `/catalog-assets` public routes.
- Production-like environments must use `CATALOG_ASSET_STORAGE_KIND=s3`.
- DigitalOcean Spaces region remains `nyc3` unless a later decision changes the platform region.
- Preview uses one shared bucket/domain for all PR preview environments rather than one bucket/domain per PR.
- Canonical bucket/domain names:
  - Preview: `chase-sets-preview-catalog-assets`, `https://assets.preview.chasesets.com`
  - Staging: `chase-sets-staging-catalog-assets`, `https://assets.staging.chasesets.com`
  - Production: `chase-sets-production-catalog-assets`, `https://assets.chasesets.com`
- GitHub repository: `todd-skelton/chase-sets`.
- GitHub environments `preview`, `staging`, and `production` already exist and contain shared `SPACES_ACCESS_ID` and `SPACES_SECRET_KEY` secrets.
- Current Terraform already passes Catalog asset storage env into production `admin-support-api` and production bootstrap, but preview/staging `platform-api`, `platform-worker`, and preview/staging bootstrap do not yet receive Catalog asset storage env.
- Existing Terraform currently has a single `catalog_asset_s3_bucket` default of `chase-sets-catalog-assets` and a single `catalog_asset_public_base_url`, so it does not satisfy separate preview/staging/production buckets and custom domains.
- Implemented resource ownership: stable shared Catalog asset resources live in `infrastructure/digitalocean/catalog-assets`; per-environment platform states consume bucket/domain names but do not own shared asset infrastructure.
- DigitalOcean CDN custom-domain creation creates the matching `assets*` DNS records, so the Terraform root owns the CDN custom domain rather than a separate `digitalocean_record`.
- Created a dedicated Spaces key named `chase-sets-catalog-assets` with `doctl spaces keys create` and updated `SPACES_ACCESS_ID` plus `SPACES_SECRET_KEY` in `preview`, `staging`, and `production` GitHub environments with `gh secret set`.
- Created live DigitalOcean Spaces buckets, managed certificates, CDN endpoints, and custom asset domains for preview, staging, and production.
- Verified the live `catalog-assets` Terraform states plan with no drift for `preview`, `staging`, and `production`.
- Verified DNS and HTTPS for:
  - `assets.preview.chasesets.com`
  - `assets.staging.chasesets.com`
  - `assets.chasesets.com`

## Open Questions

### 1. Custom asset domain pattern

Status: resolved on 2026-05-16. Use the recommended shared preview bucket/domain pattern.

Decision: choose the canonical custom domains and preview bucket lifetime.

Why it matters: DigitalOcean CDN custom domains need DNS and TLS certificate names. Preview environments can be either one shared preview bucket/domain or one bucket/domain per PR preview; the latter needs cleanup in `platform-preview-cleanup.yml` and can create many buckets/CDNs over time.

Accepted answer: Use one bucket/domain per environment class, not one per preview PR:

- Preview bucket: `chase-sets-preview-catalog-assets`
- Preview domain: `assets.preview.chasesets.com`
- Staging bucket: `chase-sets-staging-catalog-assets`
- Staging domain: `assets.staging.chasesets.com`
- Production bucket: `chase-sets-production-catalog-assets`
- Production domain: `assets.chasesets.com`

Repo evidence:

- `infrastructure/digitalocean/platform/README.md` says the platform root manages preview, staging, and production infrastructure.
- `infrastructure/digitalocean/platform/locals.tf` already uses environment-aware hostnames such as `marketplace.pr-<number>.preview.chasesets.com`, `marketplace.staging.chasesets.com`, and `admin.chasesets.com`.
- `docs/runbooks/catalog-asset-storage.md` documents `https://assets.chasesets.com` as the S3 public base URL example.

Consequence of choosing differently:

- Per-PR preview buckets/domains better isolate asset writes, but require CDN and bucket cleanup on PR close and either wildcard/custom certificate support or per-preview certificate churn. That adds operational entropy and failure modes for low-value preview environments.
- A shared preview bucket/domain can retain preview-imported assets across PRs, but it keeps preview asset storage simple, cheap, and consistent with the current shared preview GitHub environment secrets.

## Stress Test

- Normal flow: Catalog Source Observation import writes provider imagery to environment-owned Spaces storage and stores a CDN URL on the observation.
- Partial flow: if a provider asset request fails, existing Catalog import error handling still rejects the observation import before a broken URL is stored.
- Stale data/replay: replayed Catalog projections should preserve stored image URLs; changing environment domains only affects newly imported assets unless migration is explicitly added later.
- Cross-context handoff: Discovery consumes Catalog-projected image URLs and remains downstream of Catalog.
- Failure/cancellation: if DigitalOcean CDN/DNS provisioning fails, App Platform deploy validation should fail before production-like writes point at an unserved public base URL.
- Low-value card economics: shared preview storage avoids per-PR CDN/bucket cost and cleanup churn while still giving staging/production dedicated storage for durable asset margins.

## Implementation Checklist

- Add environment-aware Catalog asset bucket/public-base locals in `infrastructure/digitalocean/platform`.
- Add Terraform-owned DigitalOcean Spaces bucket resources with Standard Storage and CDN enabled if provider support is available; otherwise document and script the `doctl`/S3-compatible creation flow.
- Add DigitalOcean CDN resources with custom domains and managed TLS certificates.
- Let DigitalOcean CDN custom-domain creation manage the asset DNS records under `chasesets.com`.
- Wire preview/staging `platform-api` and bootstrap jobs with `CATALOG_ASSET_*` env vars.
- Keep asset env on API/bootstrap components only; Catalog declares `catalogAssetStorage` as provided by `admin-support-api` and `platform-api`, not workers.
- Update GitHub Actions validation and Terraform env blocks to pass bucket/domain variables if they remain configurable.
- Use `gh` to set any new environment variables/secrets required by the workflows.
- Update `docs/runbooks/catalog-asset-storage.md` and `docs/runbooks/digitalocean-platform-deployment.md`.
- Verify Terraform format/validate/plan for preview, staging, and production.
- Verify targeted config tests and object-storage tests.
- If UI asset fallback wiring changes, verify desktop/mobile rendering through Browser screenshots.

## Documentation To Promote

- Updated `docs/runbooks/catalog-asset-storage.md` with environment bucket/domain names, CDN behavior, and local fake-CDN boundary.
- Updated `docs/runbooks/digitalocean-platform-deployment.md` with the stable Catalog asset bootstrap, `doctl`/GitHub CLI setup steps, and shared preview asset behavior.
- Consider an ADR only if the final decision chooses manual `doctl` resources outside Terraform state.

## Goal Completion Criteria

- Implementation goal must reference this worktree, branch, and plan path.
- Live resources are created or imported according to the resolved operational approach.
- Required GitHub Actions environment variables/secrets are set with `gh`.
- Infrastructure/code/docs changes are committed with this retained plan.
- Automated checks pass locally for Terraform format/validate/plan and targeted tests.
- PR is opened and CI passes.
- Preview deploy is verified, then preview cleanup is verified if per-preview resources are created.
- Staging deploy is verified.
- Production deploy is verified after merge reaches `main`.
