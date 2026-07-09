# Environment Domain Names

This document owns Chase Sets application domain naming across production, staging, dev, and preview environments.

## Convention

Production uses the clean customer-facing namespace. Do not add a `production` label to production hosts.

| Surface | Production | Staging |
| --- | --- | --- |
| Public web / landing | `chasesets.com` | `www.staging.chasesets.com` |
| Marketplace | `marketplace.chasesets.com` | `marketplace.staging.chasesets.com` |
| Admin | `admin.chasesets.com` | `admin.staging.chasesets.com` |
| Public API, if exposed later | `api.chasesets.com` | `api.staging.chasesets.com` |

Dash-based non-production names such as `landing-staging.chasesets.com`, `marketplace-staging.chasesets.com`, and `admin-staging.chasesets.com` are legacy names. Keep them only as redirects or compatibility inputs during migration.

Pre-launch conditional: production proof mode may attach `marketplace.chasesets.com` while `chasesets.com` still serves the landing site. In that posture, `marketplace.chasesets.com` is an operator proof host gated by marketplace sign-in and the configured proof access permission; it is not public marketplace promotion. Public launch changes the `chasesets.com` routing posture only after launch evidence gates pass.

## Environment Boundaries

Non-production environments carry the environment label directly under `chasesets.com`.

- Staging: `*.staging.chasesets.com`
- Remote dev sessions: `*.dev.chasesets.com`
- PR previews: `*.preview.chasesets.com`

This keeps routing, logs, WAF rules, DNS records, certificate ownership, and monitoring grouped by environment.

## Cookies And Auth

Auth owns browser session cookie conventions. Session cookies should remain host-only unless a cross-application auth requirement is explicitly accepted.

Current Auth cookie serialization omits the `Domain` attribute, which keeps the session cookie scoped to the exact host that set it. That fits the environment namespace because production, staging, dev, and preview hosts do not accidentally share sessions.

If Chase Sets intentionally introduces cross-host authentication later, document the exact hosts, accepted risk, cookie domain, and logout/session revocation behavior before changing cookie scope.

## API Hosts

The platform currently routes `/api/*` same-origin from public-web, marketplace, and admin hosts. Reserve `api.chasesets.com` and `api.<environment>.chasesets.com` for future public API, webhook, or provider callback needs; do not introduce them only for internal composition.

## Staging

`www.staging.chasesets.com` is the canonical staging public-web host.

The environment root, `staging.chasesets.com`, is the launch-facing staging marketplace entry point. It is delegated from the parent `chasesets.com` zone into its own DigitalOcean DNS zone and attached to App Platform as the staging app's primary domain in that child zone.

When an environment root also receives mail through Google Workspace, it must not be a CNAME and must not be an App Platform subdomain alias mode that expects a CNAME. Delegate the environment root as a child DNS zone, then use an App Platform primary-domain attachment in that child zone with apex A/AAAA records so platform routing and certificates can coexist with exact-name Gmail MX/TXT records. This is the same DNS rule used by the production apex, applied to staging by making `staging.chasesets.com` a real apex.

The Gmail-compatible environment-root record shape is:

- Parent zone: `NS staging` delegation to DigitalOcean nameservers.
- Child zone apex: App Platform-managed A/AAAA routing records for `staging.chasesets.com`, created from the platform Terraform App Platform domain attachment.
- Child zone apex: `MX @` to Google Workspace and `TXT @` for Google Workspace SPF.
- Child zone: provider records such as SES bounce/DKIM, DMARC, optional Google Workspace DKIM, and the catalog asset CDN CNAME.
- Child zone nested App Platform hosts: platform Terraform-managed CNAME records for `www`, `marketplace`, and `admin`, because those host records depend on the app's generated ingress hostname.
- No `CNAME @` in the child zone and no `CNAME staging` in the parent zone.

Staging deployment workflows wait on both `marketplace.staging.chasesets.com` and `staging.chasesets.com`. DNS incident history and DigitalOcean recovery steps live in the [DigitalOcean Platform Deployment runbook](../runbooks/digitalocean-platform-deployment.md#staging-dns-operations).

Staging application hosts are:

- `www.staging.chasesets.com`
- `staging.chasesets.com`
- `marketplace.staging.chasesets.com`
- `admin.staging.chasesets.com`
- `api.staging.chasesets.com`, only if a public staging API host is needed later

During migration, legacy dash-based hosts should redirect to their nested equivalents when the hosting platform supports those redirects.

## Dev And Preview

Remote dev sessions currently use `dev.chasesets.com` and create hosts such as:

- `marketplace.<slug>.dev.chasesets.com`
- `admin.<slug>.dev.chasesets.com`
- `api.<slug>.dev.chasesets.com`

PR preview environments group all apps for one preview instance under the preview environment:

- `pr-123.preview.chasesets.com`
- `marketplace.pr-123.preview.chasesets.com`
- `admin.pr-123.preview.chasesets.com`

If a hosting platform requires app-specific wildcard routing later, an adapter may use names such as `pr-123.marketplace.preview.chasesets.com`, but the docs and operator language should still describe the preview as `pr-123` in the `preview` environment.

## Implementation Notes

DigitalOcean App Platform, environment DNS Terraform, GitHub environment variables, provider callback URLs, smoke checks, and tests must use the same canonical hostnames. Legacy host redirects should be explicit so old staging links fail closed or redirect predictably instead of silently becoming a second canonical namespace.
