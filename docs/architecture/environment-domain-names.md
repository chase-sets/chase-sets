# Environment Domain Names

This document owns Chase Sets application domain naming across production, staging, dev, and future preview environments.

## Convention

Production uses the clean customer-facing namespace. Do not add a `production` label to production hosts.

| Surface | Production | Staging |
| --- | --- | --- |
| Public web / landing | `chasesets.com` | `landing-staging.chasesets.com` |
| Marketplace | `marketplace.chasesets.com` | `marketplace.staging.chasesets.com` |
| Admin | `admin.chasesets.com` | `admin.staging.chasesets.com` |
| Public API, if exposed later | `api.chasesets.com` | `api.staging.chasesets.com` |

Dash-based non-production names such as `marketplace-staging.chasesets.com` and `admin-staging.chasesets.com` are legacy names. Keep them only as redirects or compatibility inputs during migration. Staging landing is the exception: keep `landing-staging.chasesets.com` as the deployable App Platform host while `staging.chasesets.com` carries staging mail identity DNS.

## Environment Boundaries

Non-production environments carry the environment label directly under `chasesets.com`, except for the staging landing host while it is separated from staging mail DNS.

- Staging: `landing-staging.chasesets.com` plus `*.staging.chasesets.com`
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

`landing-staging.chasesets.com` is the canonical staging public-web host until the staging mail identity no longer shares the `staging.chasesets.com` record name with App Platform DNS.

Staging application hosts are:

- `landing-staging.chasesets.com`
- `marketplace.staging.chasesets.com`
- `admin.staging.chasesets.com`
- `api.staging.chasesets.com`, only if a public staging API host is needed later

During migration, legacy marketplace and admin dash-based hosts should redirect to their nested equivalents when the hosting platform supports those redirects.

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
