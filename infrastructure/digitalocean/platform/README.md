# DigitalOcean Platform Infrastructure

This Terraform root manages staging and production platform infrastructure plus legacy preview validation state. Live PR previews deploy to Kubernetes namespaces through the platform Helm chart. The operational deployment workflow lives in [DigitalOcean Platform Deployment Runbook](../../../docs/runbooks/digitalocean-platform-deployment.md). [ADR 0018](../../../docs/adr/0018-doks-compute-runtime.md) records the accepted pre-launch decision to move compute/runtime orchestration from App Platform to DOKS after #101 deploy stabilization and #97 beta-clock start.

This root owns:

- DigitalOcean App Platform composition for staging and production landing, admin, and marketplace web surfaces.
- Staging and production profiled `platform-api`, private `platform-worker`, and platform bootstrap job.
- DigitalOcean managed PostgreSQL with per-context databases plus a control database for staging and production. PR previews use disposable in-cluster Postgres in their Kubernetes namespace and must not create per-PR DigitalOcean managed database clusters.
- DigitalOcean App Platform domain attachments for App Platform hosts. Stable staging mail, delegation, assets, and DOKS shadow DNS live in the sibling `environment-dns` Terraform root. Live staging DNS stays here with the App Platform attachment graph: each leaf record keeps one Terraform identity across CNAME/A replacement, and the DOKS apex A depends on releasing the App Platform apex attachment.
- App Platform environment wiring for the Catalog asset buckets and CDN domains owned by the sibling `catalog-assets` Terraform root.

Initialize this root only after the state bucket has been created by [state-bootstrap](../state-bootstrap/README.md). Use `platform/previews/pr-<number>.tfstate` for PR previews, `landing/staging.tfstate` for staging, and `landing/production.tfstate` for production.

Staging keeps the `db-s-2vcpu-4gb` cluster size for the checked-in connection budget, but its create-time storage allocation is pinned to `staging_database_storage_size_mib = 25600`. The database resource ignores subsequent `storage_size_mib` drift so normal staging deploys do not attempt a destructive storage/profile mutation against the existing cluster. The smaller storage allocation activates on the next `Platform Staging Reset`, which destroys and recreates staging Postgres in the approved rebuild window.

Run `pnpm install --frozen-lockfile` from the repo root before applying this Terraform root.

The target App Platform component contract is tested offline by `scripts/digitalocean-runtime-topology.mjs`. Production runtime modes are `production-landing`, `production-proof`, and `production-public`; `admin-support-api`, `admin-support-worker`, and `admin-support-bootstrap` are retired component names and should not reappear outside a reviewed rollback.
