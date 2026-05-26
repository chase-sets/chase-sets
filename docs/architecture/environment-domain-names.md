# Environment Domain Names

This document owns Chase Sets application domain naming across production, staging, dev, and future preview environments.

## Convention

Production uses the clean customer-facing namespace. Do not add a `production` label to production hosts.

| Surface | Production | Staging |
| --- | --- | --- |
| Public web / landing | `chasesets.com` | `www.staging.chasesets.com` |
| Marketplace | `marketplace.chasesets.com` | `marketplace.staging.chasesets.com` |
| Admin | `admin.chasesets.com` | `admin.staging.chasesets.com` |
| Public API, if exposed later | `api.chasesets.com` | `api.staging.chasesets.com` |

Dash-based non-production names such as `landing-staging.chasesets.com`, `marketplace-staging.chasesets.com`, and `admin-staging.chasesets.com` are legacy names. Keep them only as redirects or compatibility inputs during migration.

## Environment Boundaries

Non-production environments carry the environment label directly under `chasesets.com`.

- Staging: `*.staging.chasesets.com`
- Remote dev sessions: `*.dev.chasesets.com`
- Future PR previews, if created: `*.preview.chasesets.com` plus any deeper wildcard or provider-managed hostnames needed by the preview platform

This keeps routing, logs, WAF rules, DNS records, certificate ownership, and monitoring grouped by environment.

## Cookies And Auth

Auth owns browser session cookie conventions. Session cookies should remain host-only unless a cross-application auth requirement is explicitly accepted.

Current Auth cookie serialization omits the `Domain` attribute, which keeps the session cookie scoped to the exact host that set it. That fits the environment namespace because production, staging, dev, and preview hosts do not accidentally share sessions.

If Chase Sets intentionally introduces cross-host authentication later, document the exact hosts, accepted risk, cookie domain, and logout/session revocation behavior before changing cookie scope.

## API Hosts

The platform currently routes `/api/*` same-origin from public-web, marketplace, and admin hosts. Reserve `api.chasesets.com` and `api.<environment>.chasesets.com` for future public API, webhook, or provider callback needs; do not introduce them only for internal composition.

## Staging

`www.staging.chasesets.com` is the canonical staging public-web host.

The environment root, `staging.chasesets.com`, is the launch-facing staging marketplace entry point. It is attached to App Platform as a DigitalOcean-managed alias in the `chasesets.com` zone and must resolve to the current staging App Platform ingress.

On May 17, 2026, attaching `staging.chasesets.com` as a DigitalOcean-managed App Platform alias left the domain in `CONFIGURING` and prevented staging deployment from reaching smoke checks. A follow-up attempt to make it the staging App Platform primary domain also left `staging.chasesets.com` in `CONFIGURING` with no certificate. A later self-managed alias attempt proved the app shape, but DigitalOcean reported `DomainCNAMEMismatch` while exact-name A/AAAA, MX, and TXT records were still present at `staging.chasesets.com`. Exact-name mail records have since been moved off `staging.chasesets.com`; use child records such as `bounce.staging.chasesets.com`, `_dmarc.staging.chasesets.com`, and provider DKIM records for staging mail identity. Staging deployment workflows wait for the root alias so DNS drift blocks deployment before smoke checks.

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

Future PR preview environments should prefer product language that groups all apps for one preview instance under the preview environment, such as:

- `pr-123.preview.chasesets.com`
- `marketplace.pr-123.preview.chasesets.com`
- `admin.pr-123.preview.chasesets.com`

If a hosting platform requires app-specific wildcard routing, an adapter may use names such as `pr-123.marketplace.preview.chasesets.com`, but the docs and operator language should still describe the preview as `pr-123` in the `preview` environment.

## Implementation Notes

DigitalOcean App Platform, Terraform, GitHub environment variables, provider callback URLs, smoke checks, and tests must use the same canonical hostnames. Legacy host redirects should be explicit so old staging links fail closed or redirect predictably instead of silently becoming a second canonical namespace.
