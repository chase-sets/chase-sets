# DigitalOcean Landing Infrastructure

This Terraform root manages staging and production landing infrastructure. The operational deployment workflow lives in [DigitalOcean Landing Deployment Runbook](../../../docs/runbooks/digitalocean-landing-production.md).

This root owns:

- DigitalOcean App Platform app composition for public web, admin web, admin-support API, admin-support worker, and bootstrap job.
- DigitalOcean managed PostgreSQL with per-context databases plus a control database.
- DigitalOcean DNS domain attachment through App Platform domains.

Initialize this root only after the state bucket has been created by [state-bootstrap](../state-bootstrap/README.md). Use `landing/staging.tfstate` for staging and `landing/production.tfstate` for production.

Run `npm ci` from the repo root before applying this Terraform root.
