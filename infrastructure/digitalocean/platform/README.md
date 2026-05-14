# DigitalOcean Platform Infrastructure

This Terraform root manages preview and production platform infrastructure. The operational deployment workflow lives in [DigitalOcean Platform Deployment Runbook](../../../docs/runbooks/digitalocean-platform-deployment.md).

This root owns:

- DigitalOcean App Platform composition for landing, admin, and preview marketplace web surfaces.
- Preview full-system `platform-api`, `platform-worker`, and platform bootstrap job.
- Production landing/admin-support components until production marketplace promotion is ready.
- DigitalOcean managed PostgreSQL with per-context databases plus a control database. Preview also creates managed PgBouncer transaction pools for those databases so the full-system app can fit on the smallest database tier.
- DigitalOcean DNS domain attachment for preview and production hostnames.

Initialize this root only after the state bucket has been created by [state-bootstrap](../state-bootstrap/README.md). Use `platform/previews/pr-<number>.tfstate` for PR previews and `landing/production.tfstate` for production.

Run `pnpm install --frozen-lockfile` from the repo root before applying this Terraform root.
