# DigitalOcean Platform Infrastructure

This Terraform root manages staging and production platform infrastructure plus legacy preview validation state. Live PR previews deploy to Kubernetes namespaces through the platform Helm chart. The operational deployment workflow lives in [DigitalOcean Platform Deployment Runbook](../../../docs/runbooks/digitalocean-platform-deployment.md). [ADR 0018](../../../docs/adr/0018-doks-compute-runtime.md) records the accepted pre-launch decision to move compute/runtime orchestration from App Platform to DOKS after #101 deploy stabilization and #97 beta-clock start.

This root owns:

- DigitalOcean App Platform composition for staging and production landing, admin, and marketplace web surfaces.
- Staging and production profiled `platform-api`, private `platform-worker`, and platform bootstrap job.
- DigitalOcean managed PostgreSQL with per-context databases plus a control database for staging and production. PR previews use disposable in-cluster Postgres in their Kubernetes namespace and must not create per-PR DigitalOcean managed database clusters.
- DigitalOcean App Platform domain attachments for App Platform hosts. Stable staging mail/delegation/assets and environment-scoped DOKS shadow DNS live in the sibling `environment-dns` Terraform root. In production, App Platform owns live CNAMEs while attached and Terraform owns live A records while DOKS serves. `prepare-doks` first adds `app-platform.chasesets.com` as a zone-backed alias alongside every live attachment, waits for its certificate and exact HTTPS 200, and records that warm target in Terraform state. DOKS mode promotes the retained parking attachment to primary and removes only the live attachments; rollback destroys the DOKS A records before restoring the live attachments while retaining parking.
- App Platform environment wiring for the Catalog asset buckets and CDN domains owned by the sibling `catalog-assets` Terraform root.

Initialize this root only after the state bucket has been created by [state-bootstrap](../state-bootstrap/README.md). Use `platform/previews/pr-<number>.tfstate` for PR previews, `landing/staging.tfstate` for staging, and `landing/production.tfstate` for production.

Staging keeps the `db-s-2vcpu-4gb` cluster size for the checked-in connection budget, but its create-time storage allocation is pinned to `staging_database_storage_size_mib = 25600`. The database resource ignores subsequent `storage_size_mib` drift so normal staging deploys do not attempt a destructive storage/profile mutation against the existing cluster. The smaller storage allocation activates on the next `Platform Staging Reset`, which destroys and recreates staging Postgres in the approved rebuild window.

Run `pnpm install --frozen-lockfile` from the repo root before applying this Terraform root.

The target App Platform component contract is tested offline by `scripts/digitalocean-runtime-topology.mjs`. Production runtime modes are `production-landing`, `production-proof`, and `production-public`; `admin-support-api`, `admin-support-worker`, and `admin-support-bootstrap` are retired component names and should not reappear outside a reviewed rollback.

Production cutover defaults are deliberately inert: `production_app_serving=app-platform`, `production_serving_dns_phase=steady`, `production_doks_certificate_ready=false`, and an empty `doks_ingress_target`. The DOKS switch fails closed until the dedicated production target is set, the DNS-01 certificate covering every applicable live and shadow host is recorded ready, and the separate `prepare-doks` invocation has both aged the lowered live TTL and attached/probed the App Platform parking hostname. `prepare-app-platform` applies the same state-backed TTL wait before rollback. The workflow round-trips both preparation markers, re-probes parking immediately before the forward release, and only then releases the imported App Platform CNAME state identities. Marketplace host records remain conditional on the existing public-exposure gate.
