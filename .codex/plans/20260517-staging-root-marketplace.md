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

- Route `staging.chasesets.com` through DigitalOcean App Platform as the staging primary domain, not as a marketplace alias. Production proves a primary apex-style App Platform domain can coexist with Google MX and SPF TXT records, while the previous alias attempt left the staging root stuck in `CONFIGURING`.
- Route staging root marketplace paths to the marketplace component and same-origin `/api`, `/.well-known`, and `/ucp` paths to `platform-api`.
- Keep `marketplace.staging.chasesets.com` as an explicit marketplace host for existing links and operations.
- Keep `www.staging.chasesets.com` as the staging landing host so waitlist and public policy smoke checks remain stable.
- Preserve the staging legacy landing redirect smoke requirement; it is already represented by App Platform child/legacy hosts.

## Implementation Checklist

- Completed: Make `staging.chasesets.com` the staging App Platform primary domain while keeping `www.staging.chasesets.com` as the public-web landing alias.
- Completed: Add staging root to marketplace and same-origin API/UCP ingress routing.
- Completed: Add staging root marketplace smoke coverage.
- Completed: Align staging smoke with the existing legacy landing redirect requirement while waiting on all staging web domains.
- Completed: Update environment domain architecture docs and the DigitalOcean deployment runbook with the primary-domain root strategy.
- Completed: Run focused Terraform/static tests and smoke URL tests.

## Deployment Finding

- PR #164 merged on May 17, 2026 and triggered staging deployment for merge commit `400d5e61`.
- Staging deployment applied the App Platform spec, then waited on `staging.chasesets.com`.
- DigitalOcean reported `staging.chasesets.com: CONFIGURING` until the run was canceled before smoke checks.
- Live checks after cancellation still showed HTTPS failure for `https://staging.chasesets.com/` and HTTP `409`, confirming the root was not serving marketplace traffic.
- Corrective PR #169 removed the alias attachment so staging/prod deployment could resume.
- Follow-up finding: production `chasesets.com` is an App Platform primary domain with Google MX and SPF TXT records, so the safer staged path is to make `staging.chasesets.com` the staging primary domain instead of attaching it as an alias.

## Verification

- `pnpm run test:platform-smoke`
- `pnpm run test:digitalocean-app-deployment`
- `pnpm run verify:static`
- `terraform fmt -check -recursive infrastructure/digitalocean/platform`
- `terraform -chdir=infrastructure/digitalocean/platform validate`
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
