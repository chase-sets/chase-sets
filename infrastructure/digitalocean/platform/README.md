# DigitalOcean Platform Infrastructure

This Terraform root manages staging and production platform infrastructure. The operational deployment workflow lives in [DigitalOcean Platform Deployment Runbook](../../../docs/runbooks/digitalocean-platform-deployment.md).

This root owns:

- DigitalOcean App Platform composition for landing, admin, and staging marketplace web surfaces.
- Staging full-system `platform-api`, `platform-worker`, and platform bootstrap job.
- Production landing/admin-support components until production marketplace promotion is ready.
- DigitalOcean managed PostgreSQL with per-context databases plus a control database.
- DigitalOcean DNS domain attachment and the temporary staging redirect from `staging.chasesets.com` to `landing-staging.chasesets.com`.

Initialize this root only after the state bucket has been created by [state-bootstrap](../state-bootstrap/README.md). Use `landing/staging.tfstate` for staging and `landing/production.tfstate` for production until the remote state keys are intentionally migrated.

Run `pnpm install --frozen-lockfile` from the repo root before applying this Terraform root.
