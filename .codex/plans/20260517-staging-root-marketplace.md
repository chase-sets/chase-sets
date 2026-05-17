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

- Do not route `staging.chasesets.com` as a DigitalOcean-managed App Platform domain while the root carries mail identity DNS. The managed alias and managed primary-domain attachments were attempted, merged, and then blocked staging deployment with the domain stuck in `CONFIGURING`.
- Try the remaining App Platform shape as a self-managed root domain: omit `zone` for `staging.chasesets.com`, keep the root A/AAAA, MX, and TXT records in DigitalOcean DNS, and route the hostname to the marketplace component with same-origin API and UCP paths.
- Keep `marketplace.staging.chasesets.com` as an explicit marketplace host for existing links and operations.
- Keep `www.staging.chasesets.com` as the staging landing host so waitlist and public policy smoke checks remain stable.
- Preserve the staging legacy landing redirect smoke requirement; it is already represented by App Platform child/legacy hosts.

## Implementation Checklist

- Completed: Add `staging.chasesets.com` as a self-managed staging marketplace App Platform domain.
- Completed: Route staging root `/`, `/api`, `/.well-known`, and `/ucp` through the marketplace/platform API paths.
- Completed: Add deployment wait and smoke coverage for the staging root marketplace URL.
- Completed: Update environment domain architecture docs and the DigitalOcean deployment runbook with the self-managed root-domain pattern and the two failed managed-domain findings.
- Completed: Run focused Terraform/static tests and smoke URL tests.

## Deployment Finding

- PR #164 merged on May 17, 2026 and triggered staging deployment for merge commit `400d5e61`.
- Staging deployment applied the App Platform spec, then waited on `staging.chasesets.com`.
- DigitalOcean reported `staging.chasesets.com: CONFIGURING` until the run was canceled before smoke checks.
- Live checks after cancellation still showed HTTPS failure for `https://staging.chasesets.com/` and HTTP `409`, confirming the root was not serving marketplace traffic.
- PR #173 tried a second DigitalOcean App Platform shape by making `staging.chasesets.com` the staging primary domain instead of a marketplace alias.
- Staging deployment for PR #173 merge commit `9e07089c` also timed out waiting on `staging.chasesets.com: CONFIGURING`, and DigitalOcean reported no certificate for that domain.
- PR #175 reverted the managed primary-domain shape. Staging and production deployments returned to green for merge commit `cd026811`.
- Current follow-up scope: test the self-managed root-domain shape that omits App Platform DNS-zone ownership while preserving same-origin marketplace routing.

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
