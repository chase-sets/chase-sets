# Staging Root Marketplace

## Intent

Make `https://staging.chasesets.com/` behave like the launch-facing marketplace entry point while preserving the existing staging landing host at `https://www.staging.chasesets.com/`.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-staging-root-marketplace`
- Branch: `codex/staging-root-marketplace`
- Sandbox id: `03399e6c`
- Dependency setup status: `pnpm run deps:install` completed with shared pnpm store.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none. `pnpm run sandbox:doctor` passed.

## Owning Contexts

- Infrastructure owns the external host/domain routing decision because the requested behavior changes which deployable answers a staging hostname.
- Discovery owns the marketplace browse/search page that already backs the marketplace-web root route through `deployables/marketplace/app/routes/index.tsx`.
- Marketplace owns listing and offer workflows reached after marketplace entry, but it does not own browse/search or the host-level routing.
- Public Presence owns the landing/waitlist public-web surface and should remain available at `www.staging.chasesets.com`.

## Resolved Decisions

- Route `staging.chasesets.com` to the marketplace deployable in staging only, instead of moving Public Presence route modules or adding Marketplace UI to Public Presence.
- Keep `marketplace.staging.chasesets.com` as an explicit marketplace host for existing links and operations.
- Keep `www.staging.chasesets.com` as the staging landing host so waitlist and public policy smoke checks remain stable.
- Include the staging root marketplace host in same-origin `/api` routing and UCP ingress routing so the root host is a complete marketplace surface, not only a static page alias.
- Update documentation that previously reserved `staging.chasesets.com` only for environment-level DNS. Live DNS already has A, MX, and SPF records, while HTTPS currently fails before app routing, so the repository should now describe the root as a staging marketplace alias that coexists with mail identity DNS.

## Implementation Checklist

- Completed: Add a staging-only marketplace root domain in DigitalOcean platform Terraform locals.
- Completed: Include the root marketplace domain in App Platform domain declarations, marketplace ingress routing, and UCP ingress routing.
- Completed: Add smoke configuration and checks for `staging.chasesets.com` as a marketplace root host.
- Completed: Align staging smoke with the existing legacy landing redirect requirement while waiting on all staging web domains.
- Completed: Update environment domain architecture docs and the DigitalOcean deployment runbook.
- Completed: Run focused Terraform/static tests and smoke URL tests.

## Verification

- `pnpm run test:platform-smoke`
- `pnpm run test:digitalocean-app-deployment`
- `pnpm run verify:static`
- `terraform fmt -check -recursive infrastructure/digitalocean/platform`
- `git diff --check`

## Documentation To Promote

- `docs/architecture/environment-domain-names.md`
- `docs/runbooks/digitalocean-platform-deployment.md`

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
