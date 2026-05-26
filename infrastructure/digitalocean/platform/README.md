# DigitalOcean Platform Infrastructure

This Terraform root manages preview, staging, and production platform infrastructure. The operational deployment workflow lives in [DigitalOcean Platform Deployment Runbook](../../../docs/runbooks/digitalocean-platform-deployment.md).

This root owns:

- DigitalOcean App Platform composition for landing, admin, and non-production marketplace web surfaces.
- Preview and staging full-system `platform-api`, `platform-worker`, and platform bootstrap job.
- Production landing/admin-support components until production marketplace promotion is ready.
- DigitalOcean managed PostgreSQL with per-context databases plus a control database. Preview and staging also create managed PgBouncer transaction pools for those databases so the full-system app can fit on the smallest database tier.
- DigitalOcean DNS domain attachment for App Platform hosts plus temporary redirects from legacy dash-based staging hosts to their nested replacements. Stable staging mail, delegation, and asset DNS live in the sibling `environment-dns` Terraform root; staging App Platform apex A/AAAA and nested alias CNAME records live here because they depend on the app ingress.
- App Platform environment wiring for the Catalog asset buckets and CDN domains owned by the sibling `catalog-assets` Terraform root.

Initialize this root only after the state bucket has been created by [state-bootstrap](../state-bootstrap/README.md). Use `platform/previews/pr-<number>.tfstate` for PR previews, `landing/staging.tfstate` for staging, and `landing/production.tfstate` for production.

Run `pnpm install --frozen-lockfile` from the repo root before applying this Terraform root.
