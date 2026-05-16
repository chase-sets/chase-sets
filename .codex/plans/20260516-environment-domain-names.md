# Environment Domain Names

## Intent

Adopt an environment-namespaced domain convention for Chase Sets so production stays polished and non-production hosts are grouped under explicit environment boundaries.

The preferred direction from the request is:

- Production uses clean application hosts such as `marketplace.chasesets.com`, `admin.chasesets.com`, and eventually `api.chasesets.com`.
- Staging uses nested environment hosts such as `marketplace.staging.chasesets.com`, `admin.staging.chasesets.com`, and eventually `api.staging.chasesets.com`.
- Development and preview hosts should stay under environment namespaces such as `dev.chasesets.com` or `preview.chasesets.com`.
- Dash-based staging hosts such as `marketplace-staging.chasesets.com` and `admin-staging.chasesets.com` should be retired.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-environment-domains`
- Branch: `codex/environment-domains`
- Base commit: `8cc4f1e6 Add notifications database to staging platform (#72)`
- Sandbox id: `d5f54fcd`
- Sandbox status: `node ./scripts/sandbox.mjs doctor` succeeded and wrote ignored `.env.sandbox.local`.
- Dependency setup status: `pnpm run deps:install` succeeded.
- Setup blockers: none.

## Owning Contexts

This is a cross-cutting operations/platform naming decision, not bounded-context behavior.

- Primary documentation home: `docs/architecture/` for the naming convention, plus `docs/runbooks/` for deployment/operator procedures.
- Implementation homes later: `infrastructure/digitalocean/platform`, `.github/workflows`, smoke scripts/tests, and any deployable tests that assert canonical origins.
- Auth is domain-adjacent because it owns browser session cookie conventions and host-specific auth journeys.
- Public Presence is domain-adjacent because the current landing/public-web surface is the production and staging public entrypoint.
- Marketplace is domain-adjacent because seller/buyer workflows currently use staging marketplace URLs in provider callback configuration and tests.

## Repo Evidence

- `bounded-contexts/README.md` says deployables are thin composition roots and bounded contexts own behavior, read models, UI, and tests.
- `docs/architecture/bounded-context-structure.md` says deployables own host routes, layout, auth wiring, and runtime bootstrap; `infrastructure/platform-runtime` owns manifest-driven route and shell composition.
- `bounded-contexts/auth/README.md` says Auth owns browser session cookie conventions, session-cookie behavior, and host-facing auth route modules.
- `bounded-contexts/auth/support/auth-support/http.ts` currently serializes auth cookies without a `Domain` attribute, producing host-only cookies with `Path=/`, `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS.
- MDN documents that omitting cookie `Domain` creates a host-only cookie, while setting `Domain` makes it available to the named domain and subdomains.
- DigitalOcean's wildcard DNS guidance notes a wildcard only matches one hostname label, so `*.chasesets.com` covers `admin.chasesets.com` but not `admin.staging.chasesets.com`; staging needs its own `*.staging.chasesets.com` coverage.
- `docs/runbooks/digitalocean-platform-deployment.md` currently documents dash-based staging hosts: `landing-staging.chasesets.com`, `marketplace-staging.chasesets.com`, and `admin-staging.chasesets.com`, with `staging.chasesets.com` redirecting to `landing-staging.chasesets.com`.
- `infrastructure/digitalocean/platform/locals.tf` currently generates dash-based non-production hosts: `landing-${var.environment}.${var.root_domain}`, `marketplace-${var.environment}.${var.root_domain}`, and `admin-${var.environment}.${var.root_domain}`.
- `infrastructure/digitalocean/platform/variables.tf`, `.github/workflows/platform-pr.yml`, `deployables/platform-worker/__tests__/config.test.ts`, `deployables/marketplace/app/root.test.tsx`, and `deployables/marketplace/app/routes/ssr.test.tsx` assert `marketplace-staging.chasesets.com`.
- `docs/runbooks/remote-dev.md` already models disposable HTTPS sessions under `dev.chasesets.com`, producing `portal.<slug>.<REMOTE_DEV_DOMAIN>`, `marketplace.<slug>.<REMOTE_DEV_DOMAIN>`, `admin.<slug>.<REMOTE_DEV_DOMAIN>`, and `api.<slug>.<REMOTE_DEV_DOMAIN>`.

## Resolved Decisions

- Use nested environment namespaces for non-production application hosts.
- Keep production out of a `production.chasesets.com` namespace.
- Use `staging.chasesets.com` as the canonical staging public-web/landing host; optionally redirect `landing.staging.chasesets.com` to it.
- Prefer host-only cookies for Auth sessions unless a specific cross-application auth requirement is accepted later.
- Treat `api.<environment>.chasesets.com` as reserved until the platform needs a public API/webhook host; the current platform uses same-origin `/api/*` routing for landing, admin, and marketplace.
- Keep `dev.chasesets.com` as the remote-dev namespace unless a separate preview namespace is introduced for PR/platform previews.
- Use `marketplace.pr-123.preview.chasesets.com` and `admin.pr-123.preview.chasesets.com` as the canonical product language for future PR preview environments, while allowing provider-specific host adapters only when a managed routing or certificate model requires it.

## Open Questions

None.

## Implementation Checklist

- Add or update cross-cutting architecture documentation for environment domain names. Done in `docs/architecture/environment-domain-names.md`.
- Update `docs/README.md` to include the new architecture reference. Done.
- Update `docs/runbooks/digitalocean-platform-deployment.md` to replace dash-based staging hosts with nested environment hosts and document legacy redirects. Done.
- Update `infrastructure/digitalocean/platform/locals.tf` so staging domains are nested under `staging.chasesets.com`. Done.
- Update Terraform validation in `infrastructure/digitalocean/platform/variables.tf` for Stripe Connect return/refresh URLs. Done.
- Update `.github/workflows/platform-pr.yml` staging Terraform shape values. Done.
- Update deployable and worker tests that assert staging origins. Done.
- Update smoke expectations for the chosen staging public-web host and any legacy redirects. Done through Terraform outputs consumed by `.github/workflows/platform-staging.yml`; `legacy_public_redirect_domains` now exposes `landing-staging.chasesets.com` as the smoke legacy URL.
- Decide whether preview environments continue using remote-dev session hosts under `dev.chasesets.com` or gain `preview.chasesets.com`. Done: remote dev stays under `dev.chasesets.com`; PR previews now use `pr-<number>.preview.chasesets.com`, `marketplace.pr-<number>.preview.chasesets.com`, and `admin.pr-<number>.preview.chasesets.com`.
- Verify static checks, relevant unit tests, Terraform shape checks, and smoke argument behavior.

## Verification

- `pnpm run deps:install` succeeded after implementation work began.
- `terraform fmt -check -recursive` and `terraform validate` passed in `infrastructure/digitalocean/platform`.
- PR-style Terraform plan with fake staging variables passed with `-refresh=false -lock=false`; evaluated outputs showed:
  - `landing_domain = "staging.chasesets.com"`
  - `admin_domain = "admin.staging.chasesets.com"`
  - `marketplace_domains = ["marketplace.staging.chasesets.com"]`
  - `legacy_public_redirect_domains = ["landing-staging.chasesets.com"]`
  - redirect rules for `landing-staging`, `marketplace-staging`, and `admin-staging` point to their nested replacements.
- PR-style Terraform plan with fake preview variables passed with `-refresh=false -lock=false`; evaluated outputs showed:
  - `landing_domain = "pr-0.preview.chasesets.com"`
  - `admin_domain = "admin.pr-0.preview.chasesets.com"`
  - `marketplace_domains = ["marketplace.pr-0.preview.chasesets.com"]`
  - `legacy_public_redirect_domains = []`
- `pnpm --filter @chase-sets/app-marketplace-web exec vitest run --config ./vitest.config.ts app/auth.server.test.ts app/root.test.tsx app/routes/ssr.test.tsx` passed.
- `pnpm --filter @chase-sets/app-platform-worker exec vitest run --config ./vitest.config.ts __tests__/config.test.ts` passed.
- `pnpm run test:platform-smoke` passed.
- `pnpm run verify:static` passed after rebasing onto `origin/main`.
- `pnpm --filter @chase-sets/app-marketplace-web run typecheck` passed.
- `pnpm --filter @chase-sets/app-platform-worker run typecheck` passed.
- `git diff --check` passed.
- No desktop/mobile visual checks were needed because the change alters hostnames, infrastructure routing, docs, and tests, but not rendered layout or visual behavior.

## Documentation To Promote

- `docs/architecture/environment-domain-names.md` added as the cross-cutting canonical convention.
- `docs/README.md` updated to include the architecture reference.
- `docs/runbooks/digitalocean-platform-deployment.md`
- `docs/runbooks/remote-dev.md` if preview terminology changes beyond current remote-dev sessions.

## Goal Completion Criteria

The later implementation goal must:

- Continue from this worktree and branch.
- Promote durable docs for the accepted environment domain convention.
- Update infrastructure, CI, runbooks, smoke checks, and tests to the accepted hostnames.
- Preserve explicit legacy redirects for old dash-based staging hosts where supported by the platform.
- Verify cookie/session behavior remains host-only unless a cross-host auth decision is explicitly made.
- Run automated checks covering Terraform shape, staging URL validation, smoke URL arguments, and affected deployable tests.
- Perform desktop and mobile visual checks only if user-facing routes or rendered canonical URLs change.
- Submit a PR, wait for passing CI, merge it, verify staging deploy on the new hosts, and retain this `.codex/plans/20260516-environment-domain-names.md` plan in the implementation branch.
