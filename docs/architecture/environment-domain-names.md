# Environment Domain Names

[`environment-hosts.json`](../../scripts/environment-hosts.json) is the machine-readable authority for host status
across production, staging, dev, and preview environments. This document explains that topology for humans; the
static environment-topology guard verifies that the rendered block below is exact.

<!-- environment-hosts:start -->
| Host | Status | Environment | Class | Authority / disposition |
| --- | --- | --- | --- | --- |
| `*.preview.chasesets.com` | current | preview | service | A11 |
| `pr-N-admin.preview.chasesets.com` | current | preview | application | A12 |
| `pr-N-marketplace.preview.chasesets.com` | current | preview | application | A12 |
| `pr-N.preview.chasesets.com` | current | preview | application | A12 |
| `admin.chasesets.com` | current | production | application | A3 |
| `admin.doks.chasesets.com` | current | production | diagnostic | A6 |
| `chasesets.com` | current | production | application | A4 |
| `doks.chasesets.com` | current | production | diagnostic | A6 |
| `grafana.chasesets.com` | current | production | service | A10 |
| `marketplace.chasesets.com` | current | production | application | A3 |
| `marketplace.doks.chasesets.com` | current | production | diagnostic | A6 |
| `otel.chasesets.com` | current | production | service | A10 |
| `prometheus.chasesets.com` | current | production | service | A10 |
| `www.chasesets.com` | current | production | application | A3 |
| `www.doks.chasesets.com` | current | production | diagnostic | A6 |
| `api.chasesets.com` | reserved | production | application | Future public API and provider callbacks; docs/architecture/environment-domain-names.md#api-hosts |
| `admin.doks.staging.chasesets.com` | current | staging | diagnostic | A6 |
| `admin.staging.chasesets.com` | current | staging | application | A3 |
| `assets.staging.chasesets.com` | current | staging | service | A9 |
| `doks.staging.chasesets.com` | current | staging | diagnostic | A6 |
| `grafana.staging.chasesets.com` | current | staging | service | A10 |
| `marketplace.doks.staging.chasesets.com` | current | staging | diagnostic | A6 |
| `marketplace.staging.chasesets.com` | current | staging | application | A3 |
| `otel.staging.chasesets.com` | current | staging | service | A10 |
| `prometheus.staging.chasesets.com` | current | staging | service | A10 |
| `staging.chasesets.com` | current | staging | application | A4 |
| `www.doks.staging.chasesets.com` | current | staging | diagnostic | A6 |
| `www.staging.chasesets.com` | current | staging | application | A3 |
| `api.staging.chasesets.com` | reserved | staging | application | Future staging public API; docs/architecture/environment-domain-names.md#api-hosts |
| `admin-staging.chasesets.com` | retired | staging | application | https://github.com/chase-sets/chase-sets/pull/5782 (2026-07-19T14:10:58-05:00) |
| `landing-staging.chasesets.com` | retired | staging | application | https://github.com/chase-sets/chase-sets/pull/5782 (2026-07-19T14:10:58-05:00) |
| `marketplace-staging.chasesets.com` | retired | staging | application | https://github.com/chase-sets/chase-sets/pull/5782 (2026-07-19T14:10:58-05:00) |
<!-- environment-hosts:end -->

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

The environment root, `staging.chasesets.com`, is the launch-facing staging marketplace entry point. It is delegated from the parent `chasesets.com` zone into its own DigitalOcean DNS zone and routed to the staging DOKS ingress load balancer.

When an environment root also receives mail through Google Workspace, it must not be a CNAME. Delegate the environment root as a child DNS zone, then use an apex A record for the DOKS ingress target so platform routing and certificates can coexist with exact-name Gmail MX/TXT records. This is the same DNS rule used by the production apex, applied to staging by making `staging.chasesets.com` a real apex.

The Gmail-compatible environment-root record shape is:

- Parent zone: `NS staging` delegation to DigitalOcean nameservers.
- Child zone apex: platform Terraform-managed A routing for `staging.chasesets.com` to the DOKS ingress load balancer.
- Child zone apex: `MX @` to Google Workspace and `TXT @` for Google Workspace SPF.
- Child zone: provider records such as SES bounce/DKIM, DMARC, optional Google Workspace DKIM, and the catalog asset CDN CNAME.
- Child zone nested hosts: platform Terraform-managed A records for `www`, `marketplace`, and `admin`, targeting the same DOKS ingress load balancer.
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

PR preview environments group all apps for one preview instance under the preview environment. Every preview host is a single label under `preview.chasesets.com` on purpose (#4857): a single shared `*.preview.chasesets.com` wildcard certificate then covers every preview's every app host, so no preview deploy ever asks cert-manager to issue its own certificate.

- `pr-123.preview.chasesets.com`
- `pr-123-marketplace.preview.chasesets.com`
- `pr-123-admin.preview.chasesets.com`

Do not introduce two-label preview hosts (for example `marketplace.pr-123.preview.chasesets.com`) even if a hosting platform's routing would make them convenient: a wildcard certificate only matches one label, so a second label would put that host back on the per-preview-certificate path that exhausted Let's Encrypt's quota and caused a multi-hour outage. The docs and operator language should describe the preview as `pr-123` in the `preview` environment.

## Implementation Notes

DOKS ingress, environment DNS Terraform, GitHub environment variables, provider callback URLs, smoke checks, and tests must use the same canonical hostnames. Legacy host redirects should be explicit so old staging links fail closed or redirect predictably instead of silently becoming a second canonical namespace.
